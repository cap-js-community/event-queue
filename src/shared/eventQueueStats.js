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

const deleteTenantStats = async (tenantId) => {
  try {
    const client = await redis.createMainClientAndConnect();
    await client.del(_tenantKey(tenantId));
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed to delete tenant stats", err, { tenantId });
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
  getTenantStats,
  getGlobalStats,
  deleteTenantStats,
};
