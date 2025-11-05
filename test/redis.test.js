"use strict";

const redis = require("redis");
const cds = require("@sap/cds");
const { RedisClient } = require("@cap-js-community/common");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

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
    cds.requires["redis-eventQueue"].credentials = {
      hostname: "remoteHost",
      port: 3991,
      tls: true,
      password: 123,
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
    const client = await RedisClient.create("eventQueue").createClientAndConnect();
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 123,
      socket: {
        host: "remoteHost",
        port: 3991,
        tls: true,
      },
    });
  });

  test("should spread custom options to create client", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { pingInterval: 100 };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      pingInterval: 100,
      password: 123,
      socket: {
        host: "remoteHost",
        port: 3991,
        tls: true,
      },
    });
  });

  test("should convert tls object to boolean", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { socket: { host: "localhost" } };
    cds.requires["redis-eventQueue"].credentials = {
      hostname: "remoteHost",
      port: 3991,
      tls: { ca: "dummyCert" },
      password: 123,
    };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 123,
      socket: {
        host: "localhost",
        port: 3991,
        tls: true,
      },
    });
    expect(config.redisOptions).toMatchObject({ socket: { host: "localhost" } });
  });

  test("should not modify the config.redisOptions object", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { socket: { host: "localhost" } };
    cds.requires["redis-eventQueue"].credentials = {
      hostname: "remoteHost",
      port: 3991,
      tls: true,
      password: 123,
    };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 123,
      socket: {
        host: "localhost",
        port: 3991,
        tls: true,
      },
    });
    expect(config.redisOptions).toMatchObject({ socket: { host: "localhost" } });
  });

  test("should override default values", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { socket: { host: "localhost" }, password: 456 };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 456,
      socket: {
        host: "localhost",
        port: 3991,
        tls: true,
      },
    });
  });

  test("redisOptions for service always wins", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { socket: { host: "localhost", port: 4092 }, password: 456 };
    cds.requires["redis-eventQueue"].options = { socket: { port: 4091 }, password: 789 };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 456,
      socket: {
        host: "localhost",
        port: 4092,
        tls: true,
      },
    });
  });

  test("subscribe - should add redis namespace to channel", async () => {
    const connectSpy = jest.spyOn(redis, "createClient");
    config.redisOptions = { socket: { host: "localhost", port: 4092 }, password: 456 };
    cds.requires["redis-eventQueue"].options = { socket: { port: 4091 }, password: 789 };
    const client = await RedisClient.create("eventQueue").createClientAndConnect(config.redisOptions);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.on).toHaveBeenCalledTimes(2);
    expect(loggerMock.callsLengths().error).toEqual(0);
    expect(connectSpy).toHaveBeenCalledWith({
      password: 456,
      socket: {
        host: "localhost",
        port: 4092,
        tls: true,
      },
    });
  });
});
