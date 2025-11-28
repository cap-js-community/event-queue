"use strict";

const { promisify } = require("util");

const cds = require("@sap/cds");
const redisMock = require("../test/mocks/redisMock");

const CHANNELS = {};

const mockRedisClientInstance = {
  createMainClientAndConnect: redisMock.createMainClientAndConnect,
  subscribeChannel: jest.fn().mockImplementation((...args) => {
    const [, channel, cb] = args;
    CHANNELS[channel] = cb;
  }),
  publishMessage: jest.fn().mockImplementation((...args) => {
    const [, channel, data] = args;
    setTimeout(() => {
      const cb = CHANNELS[channel];
      if (!cb) {
        throw new Error("missing channel subscribe!");
      }
      cb(data);
    }, 1);
  }),
  connectionCheck: jest.fn(),
  isCluster: false,
  beforeCloseHandler: null,
};

jest.mock("@cap-js-community/common", () => ({
  RedisClient: {
    create: jest.fn().mockReturnValue(mockRedisClientInstance),
  },
}));

const eventQueue = require("../src");
const processor = require("../src/processEventQueue");
const { EventProcessingStatus } = require("../src");
const periodicEvents = require("../src/periodicEvents");
const path = require("path");
const { Logger: mockLogger } = require("../test/mocks/logger");
const { checkAndInsertPeriodicEvents } = require("../src/periodicEvents");
const runner = require("../src/runner/runner");
const testHelper = require("../test/helper");

cds.test(__dirname + "/_env");

const basePath = path.join(__dirname, "..", "test", "asset", "outboxProject");
cds.env.requires.StandardService = {
  impl: path.join(basePath, "srv/service/standard-service.js"),
  outbox: {
    kind: "persistent-outbox",
    events: {
      mainPeriodic: {
        interval: 20 * 60,
      },
      main: {
        transactionMode: "alwaysRollback",
      },
    },
  },
};

let loggerMock;

describe("end-to-end", () => {
  beforeAll(async () => {
    loggerMock = mockLogger();
    jest.spyOn(periodicEvents, "checkAndInsertPeriodicEvents").mockResolvedValue();
    eventQueue.config.initialized = false;
    await eventQueue.initialize({
      useAsCAPOutbox: true,
      processEventsAfterPublish: true,
      isEventQueueActive: true,
    });
    eventQueue.config.redisEnabled = true;

    cds.emit("connect", await cds.connect.to("db"));
  });

  beforeEach(async () => {
    await DELETE.from("sap.eventqueue.Lock");
    await DELETE.from("sap.eventqueue.Event");
    await DELETE.from("cds.outbox.Messages");
    jest.clearAllMocks();
    redisMock.clearState();
    redisMock.clearTestState();
  });

  describe("redis broadcast", () => {
    it("insert entry: redis broadcast + process", async () => {
      const srv = await cds.connect.to("StandardService");
      await srv.emit("main");
      await waitAtLeastOneEntryIsDone();
      expect(Object.keys(redisMock.getTestState())).toMatchSnapshot();
      expect(Object.keys(redisMock.getState())).toMatchSnapshot();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it("checkAndInsertPeriodicEvents should insert new events and runner should broadcast + process events", async () => {
      await cds.tx((tx) => checkAndInsertPeriodicEvents(tx.context));
      await runner.__._singleTenantRedis();
      await waitAtLeastOneEntryIsDone();
      expect(Object.keys(redisMock.getTestState())).toMatchSnapshot();
      expect(Object.keys(redisMock.getState())).toMatchSnapshot();
      expect(loggerMock.callsLengths().error).toEqual(0);
    });
  });

  describe("runner", () => {
    it("should select open events and process + validate skip broadcast", async () => {
      const processSpy = jest.spyOn(processor, "processEventQueue");
      await cds.tx({}, async (tx) => {
        await eventQueue.publishEvent(
          tx,
          {
            type: "CAP_OUTBOX",
            subType: "StandardService.main",
            payload: { event: "main", data: {}, headers: {} },
          },
          { skipBroadcast: true }
        );
      });

      await runner.__._singleTenantDb();
      await cds.tx({}, (tx) => testHelper.selectEventQueueAndExpectDone(tx, { expectedLength: 1 }));
      expect(Object.keys(redisMock.getTestState())).toMatchSnapshot();
      expect(Object.keys(redisMock.getState())).toMatchSnapshot();
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(loggerMock.callsLengths().error).toEqual(0);
    });

    it.skip("payload must be a string!!", () => {
      throw new Error("missing test");
    });
  });
});

const waitAtLeastOneEntryIsDone = async () => {
  let startTime = Date.now();
  while (true) {
    const row = await cds.tx({}, (tx2) => tx2.run(SELECT.one.from("sap.eventqueue.Event").where({ status: 2 })));
    if (row?.status === EventProcessingStatus.Done) {
      await promisify(setTimeout)(1000); // NOTE: wait a bit longer for all locks to be released
      break;
    }
    if (Date.now() - startTime > 180 * 1000) {
      throw new Error("entry not completed");
    }
    await promisify(setTimeout)(50);
  }
  return false;
};
