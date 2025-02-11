"use strict";

const cds = require("@sap/cds");
let otel, telemetry;
try {
  otel = require("@opentelemetry/api");
} catch {
  // ignore
}

const config = require("../config");

const COMPONENT_NAME = "/shared/openTelemetry";

const trace = async (context, label, fn, { attributes = {}, newRootSpan = false } = {}) => {
  if (!config.enableCAPTelemetry || !otel || !telemetry) {
    return fn();
  }

  const tracer = otel.trace.getTracer("eventqueue");

  const span = tracer.startSpan(`eventqueue-${label}`, {
    kind: otel.SpanKind.INTERNAL,
    root: newRootSpan,
  });
  _setAttributes(context, span, attributes);
  const ctxWithSpan = otel.trace.setSpan(otel.context.active(), span);
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
  for (const attributeKey in attributes) {
    span.setAttribute(attributeKey, attributes[attributeKey]);
  }
};

module.exports = trace;
