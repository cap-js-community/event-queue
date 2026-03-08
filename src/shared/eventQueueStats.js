"use strict";

const cds = require("@sap/cds");

const redis = require("./redis");
const config = require("../config");

const COMPONENT_NAME = "/eventQueue/eventQueueStats";

const StatusField = {
  Pending: "pending",
  InProgress: "inProgress",
};

const _tenantKey = (tenantId) => `${config.redisNamespace(true)}##stats##tenant##${tenantId}`;
const _globalKey = () => `${config.redisNamespace(true)}##stats##global`;
const _keyPrefix = (namespace) => `${config.redisNamespace(false)}##${namespace}`;

/**
 * Atomically adjusts a tenant's event counter for the given status field.
 *
 * @param {string} tenantId
 * @param {string} field - one of StatusField.*
 * @param {number} increment - positive to increment, negative to decrement
 */
const adjustTenantCounter = async (tenantId, field, increment) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.hIncrBy(_tenantKey(tenantId), field, increment);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to adjust tenant stats counter", err, { tenantId, field, increment });
  }
};

/**
 * Atomically adjusts the global event counter for the given status field.
 * Also updates the `updatedAt` timestamp on the global hash.
 *
 * @param {string} field - one of StatusField.*
 * @param {number} increment - positive to increment, negative to decrement
 */
const adjustGlobalCounter = async (field, increment) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.hIncrBy(_globalKey(), field, increment);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to adjust global stats counter", err, { field, increment });
  }
};

/**
 * Increments a tenant counter and the matching global counter in a single call.
 *
 * @param {string} tenantId
 * @param {string} field - one of StatusField.*
 * @param {number} [increment=1]
 */
const incrementCounters = async (tenantId, field, increment = 1) => {
  await Promise.allSettled([adjustTenantCounter(tenantId, field, increment), adjustGlobalCounter(field, increment)]);
};

/**
 * Decrements a tenant counter and the matching global counter in a single call.
 *
 * @param {string} tenantId
 * @param {string} field - one of StatusField.*
 * @param {number} [decrement=1]
 */
const decrementCounters = async (tenantId, field, decrement = 1) => {
  await Promise.allSettled([adjustTenantCounter(tenantId, field, -decrement), adjustGlobalCounter(field, -decrement)]);
};

/**
 * Returns the current stats hash for a single tenant.
 * All counter values are returned as integers; missing fields default to 0.
 *
 * @param {string} tenantId
 * @returns {Promise<{pending: number, inProgress: number}>}
 */
const getTenantStats = async (tenantId) => {
  try {
    const client = await redis.createMainClientAndConnect();
    const raw = await client.hGetAll(_tenantKey(tenantId));
    return _parseCounterHash(raw);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to read tenant stats", err, { tenantId });
    return _emptyCounters();
  }
};

/**
 * Returns the current global stats hash.
 * All counter values are returned as integers; missing fields default to 0.
 *
 * @returns {Promise<{pending: number, inProgress: number}>}
 */
const getGlobalStats = async () => {
  try {
    const client = await redis.createMainClientAndConnect();
    const raw = await client.hGetAll(_globalKey());
    return _parseCounterHash(raw);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to read global stats", err);
    return _emptyCounters();
  }
};

/**
 * Deletes the stats hash for a specific tenant.
 * Intended for use during tenant offboarding. It does not adjust the global stats still will be fixed with the next global run
 *
 * @param {string} tenantId
 */
const setTenantCounter = async (tenantId, namespace, field, value) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.hSet(`${_keyPrefix(namespace)}##stats##tenant##${tenantId}`, field, value);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to set tenant stats counter", err, { tenantId, namespace, field, value });
  }
};

const setGlobalCounter = async (namespace, field, value) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.hSet(`${_keyPrefix(namespace)}##stats##global`, field, value);
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to set global stats counter", err, { namespace, field, value });
  }
};

const getAllNamespaceStats = async () => {
  const namespaces = config.processingNamespaces;
  const client = await redis.createMainClientAndConnect();
  const results = await Promise.allSettled(
    namespaces.map(async (namespace) => {
      const raw = await client.hGetAll(`${_keyPrefix(namespace)}##stats##global`);
      return { namespace, stats: _parseCounterHash(raw) };
    })
  );
  const out = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      out[result.value.namespace] = result.value.stats;
    } else {
      cds.log(COMPONENT_NAME).error("failed to read namespace stats", result.reason);
    }
  }
  return out;
};

const deleteTenantStats = async (tenantId) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.del(_tenantKey(tenantId));
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to delete tenant stats", err, { tenantId });
  }
};

/**
 * Resets the inProgress counter to 0 for all processing namespaces (global + all tenants).
 * Called on instance startup to clean up stale counts left by a previous crash.
 */
const resetInProgressCounters = async () => {
  try {
    const clientOrCluster = await redis.createMainClientAndConnect();
    const clients = redis.isClusterMode() ? clientOrCluster.masters.map((master) => master.client) : [clientOrCluster];

    const globalOps = config.processingNamespaces.map((namespace) =>
      clientOrCluster.hSet(`${_keyPrefix(namespace)}##stats##global`, StatusField.InProgress, 0)
    );
    await Promise.allSettled(globalOps);

    // NOTE: use SCAN because KEYS is not supported for cluster clients
    for (const client of clients) {
      for await (const key of client.scanIterator({ MATCH: "*##stats##tenant##*", COUNT: 1000 })) {
        await client.hSet(key, StatusField.InProgress, 0);
      }
    }
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to reset inProgress counters on startup", err);
  }
};

const _parseCounterHash = (raw) => ({
  [StatusField.Pending]: raw[StatusField.Pending] != null ? parseInt(raw[StatusField.Pending]) : 0,
  [StatusField.InProgress]: raw[StatusField.InProgress] != null ? parseInt(raw[StatusField.InProgress]) : 0,
});

const _emptyCounters = () => ({
  [StatusField.Pending]: 0,
  [StatusField.InProgress]: 0,
});

module.exports = {
  StatusField,
  incrementCounters,
  decrementCounters,
  adjustTenantCounter,
  adjustGlobalCounter,
  setTenantCounter,
  setGlobalCounter,
  getAllNamespaceStats,
  getTenantStats,
  getGlobalStats,
  deleteTenantStats,
  resetInProgressCounters,
};
