"use strict";

const SetIntervalDriftSafe = require("../src/shared/SetIntervalDriftSafe");
const { Logger: mockLogger } = require("./mocks/logger");

describe("SetIntervalDriftSafe", () => {
  let loggerMock, runner;

  beforeAll(() => {
    loggerMock = mockLogger();
  });

  afterEach(() => {
    runner?.stop();
    jest.clearAllMocks();
  });

  it("a rejecting function must be logged and must not reject unhandled", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);

    runner = new SetIntervalDriftSafe(10);
    runner.run(async () => {
      throw new Error("db is down");
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(loggerMock.callsLengths().error).toBeGreaterThanOrEqual(1);
    expect(loggerMock.calls().error[0][0]).toEqual("scheduled function failed");
  });

  it("a synchronously throwing function must be logged and must not reject unhandled", async () => {
    const unhandled = jest.fn();
    process.on("unhandledRejection", unhandled);

    runner = new SetIntervalDriftSafe(10);
    runner.run(() => {
      throw new Error("boom");
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(loggerMock.callsLengths().error).toBeGreaterThanOrEqual(1);
  });

  it("stop must prevent further executions", async () => {
    const fn = jest.fn().mockResolvedValue();
    runner = new SetIntervalDriftSafe(10);
    runner.run(fn);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const callsAfterStop = fn.mock.calls.length;
    runner.stop();

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fn.mock.calls.length).toEqual(callsAfterStop);
  });
});
