"use strict";

const _resilientRequire = (module) => {
  try {
    return require(module);
  } catch {
    // ignore
  }
};

const cds = require("@sap/cds");
const otel = _resilientRequire("@opentelemetry/api");

const config = require("../config");
const eventQueueStats = require("./eventQueueStats");

const COMPONENT_NAME = "/shared/openTelemetry";

let _statsSnapshot = null;
let _metricsInitialized = false;

const trace = async (context, label, fn, { attributes = {}, newRootSpan = false, traceContext } = {}) => {
  if (!config.enableTelemetry || !otel) {
    return fn();
  }

  const tracerProvider = otel.trace.getTracerProvider();
  if ((!tracerProvider || tracerProvider === otel.trace.NOOP_TRACER_PROVIDER) && !process.env.DT_NODE_PRELOAD_OPTIONS) {
    return fn();
  }

  const tracer = otel.trace.getTracer("@cap-js-community/event-queue");
  const extractedContext = traceContext
    ? otel.propagation.extract(otel.context.active(), traceContext)
    : otel.context.active();
  const span = tracer.startSpan(
    `eventqueue-${label}`,
    {
      kind: otel.SpanKind.INTERNAL,
      root: newRootSpan,
    },
    extractedContext
  );
  _setAttributes(context, span, attributes);
  const ctxWithSpan = otel.trace.setSpan(extractedContext, span);

  return await _startOtelTrace(ctxWithSpan, traceContext, span, fn);
};

const _startOtelTrace = async (ctxWithSpan, traceContext, span, fn) => {
  return otel.context.with(ctxWithSpan, async () => {
    const onSuccess = (res) => {
      span.setStatus({ code: otel.SpanStatusCode.OK });
      return res;
    };
    const onFailure = (e) => {
      span.recordException(e);
      span.setStatus(
        Object.assign({ code: otel.SpanStatusCode.ERROR }, e.message ? { message: e.message } : undefined)
      );
      throw e;
    };
    const onDone = () => {
      try {
        if (span.status?.code !== otel.SpanStatusCode.UNSET && !span.ended) {
          span.end?.();
        }
      } catch (err) {
        cds.log(COMPONENT_NAME).error("error in tracing", err, {
          span,
        });
      }
    };

    try {
      const res = fn();
      if (res instanceof Promise) {
        return res.then(onSuccess).catch(onFailure).finally(onDone);
      }
      return onSuccess(res);
    } catch (e) {
      onFailure(e);
    } finally {
      onDone();
    }
  });
};

const _setAttributes = (context, span, attributes) => {
  span.setAttribute("sap.tenancy.tenant_id", context.tenant);
  span.setAttribute("sap.correlation_id", context.id);
  _sanitizeAttributes(attributes);
  for (const attributeKey in attributes) {
    span.setAttribute(attributeKey, attributes[attributeKey]);
  }
};

const _sanitizeAttributes = (attributes = {}) => {
  for (const attributeKey in attributes) {
    attributes[attributeKey] =
      typeof attributes[attributeKey] !== "string"
        ? JSON.stringify(attributes[attributeKey])
        : attributes[attributeKey];
  }
  return attributes;
};

const getCurrentTraceContext = () => {
  if (!otel) {
    return null;
  }
  const carrier = {};
  otel.propagation.inject(otel.context.active(), carrier);
  return carrier;
};

const _refreshStats = async () => {
  try {
    const namespaces = await eventQueueStats.getAllNamespaceStats();
    _statsSnapshot = { namespaces, lastRefreshedAt: Date.now() };
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to refresh queue stats for metrics", err);
  }
};

const initMetrics = () => {
  if (_metricsInitialized || !config.enableTelemetry || !config.redisEnabled || !otel?.metrics) {
    return;
  }
  const meterProvider = otel.metrics.getMeterProvider?.();
  if (!meterProvider) {
    return;
  }

  _metricsInitialized = true;

  eventQueueStats
    .resetInProgressCounters()
    .catch((err) => cds.log(COMPONENT_NAME).error("failed to reset inProgress counters", err));

  const meter = otel.metrics.getMeter("@cap-js-community/event-queue");

  const pendingGauge = meter.createObservableGauge("cap.event_queue.jobs.pending", {
    description: "Current number of jobs waiting to be processed.",
    unit: "1",
  });
  const inProgressGauge = meter.createObservableGauge("cap.event_queue.jobs.in_progress", {
    description: "Current number of jobs actively being processed by workers.",
    unit: "1",
  });
  const refreshAgeGauge = meter.createObservableGauge("cap.event_queue.stats.refresh_age", {
    description: "Age of the most recent queue statistics snapshot.",
    unit: "s",
  });

  _statsSnapshot = {
    lastRefreshedAt: Date.now(),
    namespaces: Object.fromEntries(
      config.processingNamespaces.map((namespace) => [namespace, { pending: 0, inProgress: 0 }])
    ),
  };
  _refreshStats();

  meter.addBatchObservableCallback(
    (observableResult) => {
      if (!_statsSnapshot) {
        return;
      }
      observableResult.observe(refreshAgeGauge, (Date.now() - _statsSnapshot.lastRefreshedAt) / 1000);
      for (const [namespace, stats] of Object.entries(_statsSnapshot.namespaces)) {
        const attrs = { "queue.namespace": namespace };
        observableResult.observe(pendingGauge, stats.pending, attrs);
        observableResult.observe(inProgressGauge, stats.inProgress, attrs);
      }
    },
    [pendingGauge, inProgressGauge, refreshAgeGauge]
  );

  setInterval(_refreshStats, 30_000).unref();
};

module.exports = { trace, getCurrentTraceContext, initMetrics };
