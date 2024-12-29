"use strict";

const redis = require("redis");
const cds = require("@sap/cds");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const { getEnvInstance } = require("../src/shared/env");
const redisEventQueue = require("../src/shared/redis");
const { Logger: mockLogger } = require("./mocks/logger");
const { initialize } = require("../src/initialize");
const config = require("../src/config");

jest.mock("redis", () => {
  return {
    createClient: jest.fn().mockImplementation(() => {
      return {
        on: jest.fn(),
        connect: jest.fn(),
      };
    }),
  };
});

describe("redis layer", () => {
  let loggerMock;
  beforeAll(async () => {
    cds.requires["eventqueue-redis-cache"].credentials = {
      uri: "123",
    };
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
    loggerMock = mockLogger();
    await initialize({ useAsCAPOutbox: true });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  test("should call connect and on without any error for cf", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    const client = await redisEventQueue.createClientAndConnect();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({ url: "123" });
  });

  test("should spread custom options to create client", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { pingInterval: 100 };
    const client = await redisEventQueue.createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({ url: "123", pingInterval: 100 });
  });

  test("should override default values", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { url: "1234", pingInterval: 100 };
    const client = await redisEventQueue.createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({ url: "1234", pingInterval: 100 });
  });
});
