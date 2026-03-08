"use strict";

const path = require("path");

const cds = require("@sap/cds/lib");

const mockRedis = require("./mocks/redisMock");
jest.mock("../src/shared/redis", () => mockRedis);

const eventQueue = require("../src");
const {
  StatusField,
  incrementCounters,
  decrementCounters,
  adjustTenantCounter,
  adjustGlobalCounter,
  getTenantStats,
  getGlobalStats,
  deleteTenantStats,
} = require("../src/shared/eventQueueStats");

const project = __dirname + "/..";
cds.test(project);

describe("eventQueueStats", () => {
  beforeAll(async () => {
    const configFilePath = path.join(__dirname, "asset", "config.yml");
    await eventQueue.initialize({
      configFilePath,
      processEventsAfterPublish: false,
      registerAsEventProcessor: false,
    });
  });

  beforeEach(() => {
    mockRedis.clearState();
  });

  afterAll(() => cds.shutdown);

  describe("incrementCounters / decrementCounters", () => {
    it("increments tenant and global counters", async () => {
      await incrementCounters("t1", StatusField.Pending, 3);

      const tenant = await getTenantStats("t1");
      expect(tenant.pending).toBe(3);
      expect(tenant.inProgress).toBe(0);

      const global = await getGlobalStats();
      expect(global.pending).toBe(3);
    });

    it("decrements tenant and global counters", async () => {
      await incrementCounters("t1", StatusField.Pending, 5);
      await decrementCounters("t1", StatusField.Pending, 2);

      const tenant = await getTenantStats("t1");
      expect(tenant.pending).toBe(3);

      const global = await getGlobalStats();
      expect(global.pending).toBe(3);
    });

    it("multiple tenants are tracked independently", async () => {
      await incrementCounters("t1", StatusField.Pending, 2);
      await incrementCounters("t2", StatusField.Pending, 5);

      expect((await getTenantStats("t1")).pending).toBe(2);
      expect((await getTenantStats("t2")).pending).toBe(5);
    });

    it("global counter aggregates across all tenants", async () => {
      await incrementCounters("t1", StatusField.InProgress, 1);
      await incrementCounters("t2", StatusField.InProgress, 4);

      const global = await getGlobalStats();
      expect(global.inProgress).toBe(5);
    });
  });

  describe("adjustTenantCounter", () => {
    it("creates hash with zero base when first incremented", async () => {
      await adjustTenantCounter("t1", StatusField.InProgress, 1);

      const stats = await getTenantStats("t1");
      expect(stats.inProgress).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it("supports negative increments", async () => {
      await adjustTenantCounter("t1", StatusField.Pending, 10);
      await adjustTenantCounter("t1", StatusField.Pending, -3);

      expect((await getTenantStats("t1")).pending).toBe(7);
    });
  });

  describe("adjustGlobalCounter", () => {
    it("increments the global counter for the given field", async () => {
      await adjustGlobalCounter(StatusField.Pending, 7);

      const global = await getGlobalStats();
      expect(global.pending).toBe(7);
    });
  });

  describe("getTenantStats", () => {
    it("returns all-zero object for unknown tenant", async () => {
      const stats = await getTenantStats("unknown-tenant");
      expect(stats).toEqual({ pending: 0, inProgress: 0 });
    });
  });

  describe("getGlobalStats", () => {
    it("returns all-zero object when no data exists", async () => {
      const stats = await getGlobalStats();
      expect(stats).toEqual({ pending: 0, inProgress: 0 });
    });
  });

  describe("deleteTenantStats", () => {
    it("removes the tenant hash", async () => {
      await incrementCounters("t1", StatusField.Pending, 5);
      await deleteTenantStats("t1");

      const stats = await getTenantStats("t1");
      expect(stats).toEqual({ pending: 0, inProgress: 0 });
    });

    it("does not throw when tenant does not exist", async () => {
      await expect(deleteTenantStats("nonexistent")).resolves.toBeUndefined();
    });
  });
});
