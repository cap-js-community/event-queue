"use strict";

const cds = require("@sap/cds");
let otel;
try {
  otel = require("@opentelemetry/api");
} catch {
  // ignore
}

const trace = async (context, label, fn, attributes = {}) => {
  if (!cds._telemetry?.tracer) {
    return fn();
  }

  const span = cds._telemetry.tracer.startSpan(`eventqueue-${label}`);
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
      if (span.status.code !== otel.SpanStatusCode.UNSET && !span.ended) {
        span.end();
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
  span.setAttribute("correlationId", context.id);
  for (const attributeKey in attributes) {
    span.setAttribute(attributeKey, attributes[attributeKey]);
  }
};

module.exports = trace;
