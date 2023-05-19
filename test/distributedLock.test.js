"use strict";

const cds = require("@sap/cds/lib");
const { acquireLock, releaseLock } = require("../src/shared/distributedLock");

const project = __dirname + "/.."; // The project's root folder
cds.test(project);

describe("distributedLock", () => {
  let context, tx;
  beforeEach(async () => {
    context = new cds.EventContext({ user: "testUser", tenant: 123 });
    tx = cds.tx(context);
    await tx.run(DELETE.from("sap.core.EventLock"));
  });

  afterEach(async () => {
    await tx.rollback();
  });

  afterAll(() => cds.shutdown);

  it("straight forward - acquire and release", async () => {
    const lockAcquired = await acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    const afterAcquire = await tx.run(
      SELECT.one.from("sap.core.EventLock").where("code LIKE '%key%'")
    );
    expect(afterAcquire).toBeDefined();

    await releaseLock(context, "key");

    const afterRelease = await tx.run(
      SELECT.one.from("sap.core.EventLock").where("code LIKE '%key%'")
    );
    expect(afterRelease).toEqual(null);
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
    const [lockAcquired, lockAcquiredSecond] = await Promise.all([
      lockAcquiredPromise,
      lockAcquiredSecondPromise,
    ]);
    if (lockAcquired) {
      expect(lockAcquired).toEqual(true);
      expect(lockAcquiredSecond).toEqual(false);
    } else {
      expect(lockAcquired).toEqual(false);
      expect(lockAcquiredSecond).toEqual(true);
    }
  });

  it("lock should acquire after 30 min", async () => {
    const lockAcquired = await acquireLock(context, "key");
    expect(lockAcquired).toEqual(true);
    await tx.run(
      UPDATE.entity("sap.core.EventLock")
        .set({
          createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        })
        .where("code LIKE '%key%'")
    );

    const lockAcquiredSecond = await acquireLock(context, "key");
    expect(lockAcquiredSecond).toEqual(true);
  });
});
