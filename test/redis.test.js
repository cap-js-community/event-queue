"use strict";

const redis = require("redis");
const cds = require("@sap/cds");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

const { getEnvInstance } = require("../src/shared/env");
const redisEventQueue = require("../src/shared/redis");
const { Logger: mockLogger } = require("./mocks/logger");

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
    jest.spyOn(cds, "log").mockImplementation((layer) => {
      return mockLogger(layer);
    });
    loggerMock = mockLogger();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
  });

  afterAll(() => cds.shutdown);

  test("should call connect and on without any error for cf", async () => {
    const env = getEnvInstance();
    env.isOnCF = true;
    env.vcapServices = {
      "redis-cache": [{ credentials: { uri: "123" } }],
    };
    const connectSpy = jest.spyOn(redis, "createClient");
    const client = await redisEventQueue.createClientAndConnect();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({ url: "123" });
    env.isOnCF = false;
  });
});
