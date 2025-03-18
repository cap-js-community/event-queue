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
const dynatraceSdk = _resilientRequire("@dynatrace/oneagent-sdk");

const config = require("../config");

const COMPONENT_NAME = "/shared/openTelemetry";

const DT_SYSTEM_INFO = {
  destinationName: "@cap-js-community/event-queue",
  destinationType: "TOPIC",
  vendorName: "@cap-js-community/event-queue",
};

const trace = async (context, label, fn, { attributes = {}, newRootSpan = false, traceContext } = {}) => {
  const tracerProvider = otel?.trace.getTracerProvider();
  // TODO: extend check to validate if DT oneagent is available AND active
  if (!config.enableCAPTelemetry || !tracerProvider || tracerProvider === otel.trace.NOOP_TRACER_PROVIDER) {
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

  if (newRootSpan && !traceContext) {
    return await _instrumentViaDynatrace(context, async () => _startOtelTrace(ctxWithSpan, traceContext, span, fn));
  } else {
    return await _startOtelTrace(ctxWithSpan, traceContext, span, fn);
  }
};

const _startOtelTrace = async (ctxWithSpan, traceContext, span, fn) => {
  return otel.context.with(ctxWithSpan, async () => {
    if (traceContext) {
      cds.log("/eventQueue/telemetry").info("Linked span:", span.spanContext());
      const carrier = {};
      otel.propagation.inject(ctxWithSpan, carrier);
      cds.log("/eventQueue/telemetry").info("Extracted trace context by inject", carrier);
    }
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
  for (const attributeKey in attributes) {
    span.setAttribute(attributeKey, attributes[attributeKey]);
  }
};

const getCurrentTraceContext = () => {
  if (!otel) {
    return null;
  }
  const carrier = {};
  otel.propagation.inject(otel.context.active(), carrier);
  return carrier;
};

const _instrumentViaDynatrace = async (context, cb) => {
  const dynatraceApi = _getDynatraceAPIInstance();
  if (!dynatraceApi) {
    return cb();
  }

  if (dynatraceApi.getCurrentState() !== dynatraceSdk.SDKState.ACTIVE) {
    return cb();
  }

  const startData = { ...DT_SYSTEM_INFO };
  const tracer = dynatraceApi.traceIncomingMessage(startData);
  return new Promise((resolve, reject) => {
    tracer.start(async () => {
      tracer.setCorrelationId(context.id);
      try {
        const result = await cb();
        resolve(result);
      } catch (err) {
        tracer.error(err);
        reject(err);
      } finally {
        tracer.end();
      }
    });
  });
};

const _getDynatraceAPIInstance = () => {
  if (Object.hasOwnProperty.call(_getDynatraceAPIInstance, "__api")) {
    return _getDynatraceAPIInstance.__api;
  }

  if (dynatraceSdk) {
    try {
      _getDynatraceAPIInstance.__api = dynatraceSdk.createInstance();
    } catch {
      _getDynatraceAPIInstance.__api = null;
    }
  } else {
    _getDynatraceAPIInstance.__api = null;
  }
};

module.exports = { trace, getCurrentTraceContext };
