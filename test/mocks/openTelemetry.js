"use strict";

const tracerMock = {
  startSpan: jest.fn(() => {
    return {
      setStatus: jest.fn(),
      recordException: jest.fn(),
      setAttribute: jest.fn(),
      spanContext: jest.fn(),
    };
  }),
};

module.exports = {
  SpanKind: {},
  SpanStatusCode: {},
  context: {
    active: jest.fn(() => "mocked-context"),
    with: jest.fn((context, fn) => {
      return fn();
    }),
  },
  propagation: {
    inject: jest.fn((context, carrier) => {
      carrier["mocked-trace"] = "trace-value";
    }),
    extract: jest.fn((context, carrier) => {
      return {};
    }),
  },
  trace: {
    setSpan: jest.fn(),
    getTracer: jest.fn(() => tracerMock),
    getTracerProvider: jest.fn(() => {
      return {};
    }),
  },
};
