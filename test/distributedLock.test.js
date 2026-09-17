"use strict";

const cds = require("@sap/cds/lib");

const mockRedis = require("./mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);
const cdsHelper = require("../src/shared/cdsHelper");
const executeInNewTransactionSpy = jest.spyOn(cdsHelper, "executeInNewTransaction");

const distributedLock = require("../src/shared/distributedLock");
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
      return await fn(tx);
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
    const lockAcquired = await distributedLock.acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    const afterAcquire = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
    expect(afterAcquire).toBeDefined();

    await distributedLock.releaseLock(context, "key");

    const afterRelease = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
    expect(afterRelease).toEqual(undefined);
  });

  it("redis only accepts integer as lock time", async () => {
    config.redisEnabled = true;
    await distributedLock.acquireLock(context, "key", { expiryTime: 5.5 });
    const state = mockRedis.getState();
    delete Object.values(state)[0].value;
    expect(state).toMatchSnapshot();
  });

  it("acquire should return false if already exists", async () => {
    const lockAcquired = await distributedLock.acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    const lockAcquiredSecond = await distributedLock.acquireLock(context, "key");
    expect(lockAcquiredSecond).toEqual(false);
  });

  it("two concurrent acquire", async () => {
    const lockAcquiredPromise = distributedLock.acquireLock(context, "key");
    const lockAcquiredSecondPromise = distributedLock.acquireLock(context, "key");
    const [lockAcquired, lockAcquiredSecond] = await Promise.all([lockAcquiredPromise, lockAcquiredSecondPromise]);

    expect(lockAcquiredSecond).toEqual(!lockAcquired);
  });

  it("lock should acquire after 30 min", async () => {
    const lockAcquired = await distributedLock.acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    await tx.run(
      UPDATE.entity("sap.eventqueue.Lock")
        .set({
          createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        })
        .where("code LIKE '%key%'")
    );

    const lockAcquiredSecond = await distributedLock.acquireLock(context, "key");
    expect(lockAcquiredSecond).toEqual(true);
  });

  it("takeover of an existing lock must not run in the transaction of the failed insert", async () => {
    await distributedLock.acquireLock(context, "key");
    await tx.run(
      UPDATE.entity("sap.eventqueue.Lock")
        .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })
        .where("code LIKE '%key%'")
    );
    executeInNewTransactionSpy.mockClear();

    expect(await distributedLock.acquireLock(context, "key")).toEqual(true);

    expect(executeInNewTransactionSpy.mock.calls.map(([, tag]) => tag)).toEqual([
      "distributedLock-acquire",
      "distributedLock-acquire-takeover",
    ]);
  });

  describe("event processing lock", () => {
    const NAMESPACE = "default";
    const TYPE = "Notifications";
    const SUB_TYPE = "Task";
    const lockKey = () => distributedLock.generateEventLockKey(NAMESPACE, TYPE, SUB_TYPE);
    const acquireOptions = (token) => ({ skipNamespace: true, value: token });

    const allLocks = async () => (await tx.run(SELECT.from("sap.eventqueue.Lock").orderBy("code"))).map((l) => l.code);

    it("renew must refresh the lock which has been acquired and must not create a second one", async () => {
      const token = distributedLock.generateLockToken();
      expect(await distributedLock.acquireLock(context, lockKey(), acquireOptions(token))).toEqual(true);
      const [acquired] = await tx.run(SELECT.from("sap.eventqueue.Lock"));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token })).toEqual(true);

      expect(await allLocks()).toEqual([acquired.code]);
      const [renewed] = await tx.run(SELECT.from("sap.eventqueue.Lock"));
      expect(new Date(renewed.createdAt).getTime()).toBeGreaterThan(new Date(acquired.createdAt).getTime());

      await distributedLock.releaseLock(context, lockKey(), { skipNamespace: true, token });
      expect(await allLocks()).toEqual([]);
    });

    it("renew must fail if the lock is owned by another instance", async () => {
      const token = distributedLock.generateLockToken();
      await distributedLock.acquireLock(context, lockKey(), acquireOptions(token));

      const otherToken = distributedLock.generateLockToken();
      expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token: otherToken })).toEqual(
        false
      );
    });

    it("release must not delete a lock which is owned by another instance", async () => {
      const token = distributedLock.generateLockToken();
      await distributedLock.acquireLock(context, lockKey(), acquireOptions(token));

      await distributedLock.releaseLock(context, lockKey(), {
        skipNamespace: true,
        token: distributedLock.generateLockToken(),
      });

      expect(await allLocks()).toHaveLength(1);
    });

    it("renew must take the lock again if it expired and nobody else acquired it", async () => {
      const token = distributedLock.generateLockToken();
      await distributedLock.acquireLock(context, lockKey(), acquireOptions(token));
      await tx.run(DELETE.from("sap.eventqueue.Lock"));

      expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token })).toEqual(true);
      expect(await allLocks()).toHaveLength(1);
    });

    describe("redis", () => {
      beforeEach(() => {
        config.redisEnabled = true;
        mockRedis.clearState();
      });

      it("renew must refresh the lock which has been acquired and must not create a second one", async () => {
        const token = distributedLock.generateLockToken();
        expect(await distributedLock.acquireLock(context, lockKey(), acquireOptions(token))).toEqual(true);

        expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token })).toEqual(true);
        expect(Object.keys(mockRedis.getState())).toHaveLength(1);

        await distributedLock.releaseLock(context, lockKey(), { skipNamespace: true, token });
        expect(Object.keys(mockRedis.getState())).toHaveLength(0);
      });

      it("renew must fail if the lock is owned by another instance", async () => {
        await distributedLock.acquireLock(context, lockKey(), acquireOptions(distributedLock.generateLockToken()));

        const otherToken = distributedLock.generateLockToken();
        expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token: otherToken })).toEqual(
          false
        );
      });

      it("renew must take the lock again if it expired and nobody else acquired it", async () => {
        const token = distributedLock.generateLockToken();
        await distributedLock.acquireLock(context, lockKey(), { ...acquireOptions(token), expiryTime: 10 });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await distributedLock.renewLock(context, lockKey(), { skipNamespace: true, token })).toEqual(true);
      });

      it("getAllLocksRedis must report namespace and tenant of the acquired lock", async () => {
        const token = distributedLock.generateLockToken();
        await distributedLock.acquireLock(context, lockKey(), acquireOptions(token));

        const locks = await distributedLock.getAllLocksRedis();

        expect(locks).toHaveLength(1);
        expect(locks[0]).toMatchObject({
          namespace: NAMESPACE,
          tenant: String(context.tenant),
          type: TYPE,
          subType: SUB_TYPE,
        });
      });
    });
  });

  describe("keep track of locks", () => {
    it("should keep track of lock and delete during shutdown", async () => {
      const lockAcquired = await distributedLock.acquireLock(context, "key", { keepTrackOfLock: true });
      expect(lockAcquired).toEqual(true);
      const afterAcquire = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
      expect(afterAcquire).toBeDefined();

      await distributedLock.shutdownHandler();

      const afterRelease = await tx.run(SELECT.one.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
      expect(afterRelease).toEqual(undefined);
    });

    it("should keep track of multiple locks and delete during shutdown", async () => {
      await distributedLock.acquireLock(context, "key", { keepTrackOfLock: true });
      await distributedLock.acquireLock(context, "key1", { keepTrackOfLock: true });

      await distributedLock.shutdownHandler();

      const afterRelease = await tx.run(SELECT.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
      expect(afterRelease).toHaveLength(0);
    });

    it("keep track of locks false should not delete the lock", async () => {
      await distributedLock.acquireLock(context, "key", { keepTrackOfLock: false });
      await distributedLock.acquireLock(context, "key1", { keepTrackOfLock: true });

      await distributedLock.shutdownHandler();

      const afterRelease = await tx.run(SELECT.from("sap.eventqueue.Lock").where("code LIKE '%key%'"));
      expect(afterRelease).toHaveLength(1);
    });
  });
});
