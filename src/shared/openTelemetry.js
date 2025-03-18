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

const COMPONENT_NAME = "/shared/openTelemetry";

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

module.exports = { trace, getCurrentTraceContext };
