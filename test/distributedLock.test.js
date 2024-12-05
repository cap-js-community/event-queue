"use strict";

const cds = require("@sap/cds/lib");

const mockRedis = require("./mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);
const cdsHelper = require("../src/shared/cdsHelper");
const executeInNewTransactionSpy = jest.spyOn(cdsHelper, "executeInNewTransaction");

const { acquireLock, releaseLock } = require("../src/shared/distributedLock");
const path = require("path");
const eventQueue = require("../src");
const config = require("../src/config");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("distributedLock", () => {
  let context, tx;

  executeInNewTransactionSpy.mockImplementation(
    // eslint-disable-next-line no-unused-vars
    async (context = {}, transactionTag, fn) => {
      try {
        return await fn(tx);
      } catch (err) {
        if (!(err instanceof cdsHelper.TriggerRollback)) {
          throw err;
        }
      }
    }
  );

  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
  });

  beforeEach(async () => {
    config.redisEnabled = false;
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.eventqueue.Lock"));
  });

  afterEach(async () => {
    await tx.rollback();
  });

  afterAll(() => cds.shutdown);

  it("straight forward - acquire and release", async () => {
    const lockAcquired = await acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    const afterAcquire = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
    expect(afterAcquire).toBeDefined();

    await releaseLock(context, "key");

    const afterRelease = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
    expect(afterRelease).toEqual(undefined);
  });

  it("redis only accepts integer as lock time", async () => {
    config.redisEnabled = true;
    await acquireLock(context, "key", { expiryTime: 5.5 });
    expect(mockRedis.getState()).toMatchSnapshot();
  });

  it("acquire should return false if already exists", async () => {
    const lockAcquired = await acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    const lockAcquiredSecond = await acquireLock(context, "key");
    expect(lockAcquiredSecond).toEqual(false);
  });

  it("two concurrent acquire", async () => {
    const lockAcquiredPromise = acquireLock(context, "key");
    const lockAcquiredSecondPromise = acquireLock(context, "key");
    const [lockAcquired, lockAcquiredSecond] = await Promise.all([lockAcquiredPromise, lockAcquiredSecondPromise]);

    expect(lockAcquiredSecond).toEqual(!lockAcquired);
  });

  it("lock should acquire after 30 min", async () => {
    const lockAcquired = await acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    await tx.run(
      UPDATE.entity("sap.eventqueue.Lock")
        .set({
          createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        })
        .where("code LIKE '%key%'")
    );

    const lockAcquiredSecond = await acquireLock(context, "key");
    expect(lockAcquiredSecond).toEqual(true);
  });
});
