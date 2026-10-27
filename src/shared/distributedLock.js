"use strict";

const redis = require("./redis");
const config = require("../config");
const cdsHelper = require("./cdsHelper");

const existingLocks = {};
const REDIS_COMMAND_OK = "OK";
const COMPONENT_NAME = "/eventQueue/distributedLock";
const EVENT_LOCK_KEY_PARTS = 5;
const RELEASED_AT = new Date(0).toISOString();

const generateEventLockKey = (namespace, type, subType) => [namespace, type, subType].join("##");

const generateLockToken = () => [Date.now(), cds.utils.uuid()].join("##");

const _isSameToken = (value, token) => String(value) === String(token);

const acquireLock = async (
  context,
  key,
  {
    tenantScoped = true,
    expiryTime = config.globalTxTimeout,
    keepTrackOfLock = false,
    skipNamespace = false,
    value,
  } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key, skipNamespace);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime, { keepTrackOfLock, ...(value && { value }) });
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, { keepTrackOfLock, ...(value && { value }) });
  }
};

const renewLock = async (
  context,
  key,
  { tenantScoped = true, expiryTime = config.globalTxTimeout, skipNamespace = false, token } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key, skipNamespace);
  if (config.redisEnabled) {
    return await _renewLockRedis(context, fullKey, expiryTime, { token });
  } else {
    return await _renewLockDb(context, fullKey, { token });
  }
};

const setValueWithExpire = async (
  context,
  key,
  value,
  { tenantScoped = true, expiryTime = config.globalTxTimeout, overrideValue = false, keepTrackOfLock = false } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime, {
      value,
      overrideValue,
      keepTrackOfLock,
    });
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, {
      value,
      overrideValue,
    });
  }
};

const releaseLock = async (context, key, { tenantScoped = true, skipNamespace = false, token } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key, skipNamespace);
  if (config.redisEnabled) {
    return await _releaseLockRedis(context, fullKey, { token });
  } else {
    return await _releaseLockDb(context, fullKey, { token });
  }
};

const checkLockExists = async (context, key, { tenantScoped = true, skipNamespace = false } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key, skipNamespace);
  if (config.redisEnabled) {
    return !!(await _getLockValueRedis(context, fullKey));
  } else {
    return !!(await _getLockValueDb(context, fullKey));
  }
};

const getValue = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _getLockValueRedis(context, fullKey);
  } else {
    return await _getLockValueDb(context, fullKey);
  }
};

const _acquireLockRedis = async (
  context,
  fullKey,
  expiryTime,
  { value = Date.now(), overrideValue = false, keepTrackOfLock } = {}
) => {
  const client = await redis.createMainClientAndConnect();
  const result = await client.set(fullKey, value, {
    PX: Math.round(expiryTime),
    ...(overrideValue ? null : { NX: true }),
  });
  const isOk = result === REDIS_COMMAND_OK;
  if (isOk && keepTrackOfLock) {
    existingLocks[fullKey] = { tenant: context.tenant, token: value };
  }
  return isOk;
};

const _renewLockRedis = async (context, fullKey, expiryTime, { token } = {}) => {
  const client = await redis.createMainClientAndConnect();
  const value = token ?? "true";
  const currentValue = await client.get(fullKey);

  if (currentValue === null) {
    const result = await client.set(fullKey, value, { PX: Math.round(expiryTime), NX: true });
    return result === REDIS_COMMAND_OK;
  }

  if (token && !_isSameToken(currentValue, token)) {
    return false;
  }

  const result = await client.set(fullKey, value, { PX: Math.round(expiryTime), XX: true });
  return result === REDIS_COMMAND_OK;
};

const _getLockValueRedis = async (context, fullKey) => {
  const client = await redis.createMainClientAndConnect();
  return await client.get(fullKey);
};

const _getLockValueDb = async (context, fullKey) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-checkExists", async (tx) => {
    result = await tx.run(SELECT.one.from(config.tableNameEventLock).where("code =", fullKey, "AND value IS NOT NULL"));
  });
  return result?.value;
};

const _releaseLockRedis = async (context, fullKey, { token } = {}) => {
  const client = await redis.createMainClientAndConnect();
  delete existingLocks[fullKey];
  if (token) {
    const currentValue = await client.get(fullKey);
    if (currentValue !== null && !_isSameToken(currentValue, token)) {
      return false;
    }
  }
  const result = await client.del(fullKey);
  return result === 1;
};

const _releaseLockDb = async (context, fullKey, { token } = {}) => {
  await cdsHelper.executeInNewTransaction(context, "distributedLock-release", async (tx) => {
    // NOTE: keep the row so that the next acquire is a single UPDATE without a unique constraint violation
    await tx.run(
      UPDATE.entity(config.tableNameEventLock)
        .set({ createdAt: RELEASED_AT, value: null })
        .where(...(token ? ["code =", fullKey, "AND value =", token] : ["code =", fullKey]))
    );
  });
  delete existingLocks[fullKey];
  return true;
};

const _renewLockDb = async (context, fullKey, { token } = {}) => {
  const value = token ?? "true";
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-renew", async (tx) => {
    const currentEntry = await tx.run(
      SELECT.one.from(config.tableNameEventLock).forUpdate({ wait: config.forUpdateTimeout }).where("code =", fullKey)
    );

    if (!currentEntry) {
      await tx.run(INSERT.into(config.tableNameEventLock).entries({ code: fullKey, value }));
      result = true;
      return;
    }

    if (token && currentEntry.value !== null && !_isSameToken(currentEntry.value, token)) {
      result = false;
      return;
    }

    await tx.run(
      UPDATE.entity(config.tableNameEventLock)
        .set({ createdAt: new Date().toISOString(), value })
        .where("code =", fullKey)
    );
    result = true;
  });
  return result;
};

const _acquireLockDB = async (
  context,
  fullKey,
  expiryTime,
  { value = "true", overrideValue = false, keepTrackOfLock } = {}
) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-acquire", async (tx) => {
    // NOTE: released locks carry RELEASED_AT and are therefore always expired
    const expiredBefore = new Date(Date.now() - Math.round(expiryTime)).toISOString();
    const updateCqn = UPDATE.entity(config.tableNameEventLock)
      .set({ createdAt: new Date().toISOString(), value })
      .where(...(overrideValue ? ["code =", fullKey] : ["code =", fullKey, "AND createdAt <=", expiredBefore]));
    if (await tx.run(updateCqn)) {
      result = true;
      return;
    }
    if (!overrideValue) {
      const existingEntry = await tx.run(
        SELECT.one.from(config.tableNameEventLock).columns("code").where("code =", fullKey)
      );
      if (existingEntry) {
        result = false;
      }
    }
  });

  if (result === undefined) {
    result = await _insertLockDb(context, fullKey, value);
  }
  if (result && keepTrackOfLock) {
    existingLocks[fullKey] = { tenant: context.tenant, token: value };
  }
  return result;
};

const _insertLockDb = async (context, fullKey, value) => {
  try {
    await cdsHelper.executeInNewTransaction(context, "distributedLock-acquire-insert", async (tx) => {
      await tx.run(INSERT.into(config.tableNameEventLock).entries({ code: fullKey, value }));
    });
    return true;
  } catch (err) {
    // NOTE: only reachable on the first use of a key, another instance inserted the same key in parallel
    cds.log(COMPONENT_NAME).debug("lock row was inserted concurrently, lock not acquired", { key: fullKey, err });
    return false;
  }
};

const _generateKey = (context, tenantScoped, key, skipNamespace) => {
  const keyParts = [config.redisNamespace(!skipNamespace)];
  tenantScoped && keyParts.push(context.tenant);
  keyParts.push(key);
  return `${keyParts.join("##")}`;
};

const getAllLocksRedis = async () => {
  const clientOrCluster = await redis.createMainClientAndConnect();
  const output = [];
  const results = [];

  let clients;
  if (redis.isClusterMode()) {
    clients = clientOrCluster.masters.map((master) => master.client);
  } else {
    clients = [clientOrCluster];
  }

  // NOTE: use SCAN because KEYS is not supported for cluster clients
  for (const client of clients) {
    for await (const key of client.scanIterator({ MATCH: "EVENT*", COUNT: 1000 })) {
      const keyParts = key.split("##");
      if (keyParts.length !== EVENT_LOCK_KEY_PARTS) {
        continue;
      }
      const [, tenant, namespace, type, subType] = keyParts;

      const pipeline = client.multi();
      output.push({
        namespace,
        tenant,
        type,
        subType,
      });
      pipeline.ttl(key).get(key);
      const replies = await pipeline.exec();
      results.push(...replies);
    }
  }

  let counter = 0;
  for (const row of output) {
    const ttl = results[counter];
    const createdAt = _extractLockTimestamp(results[counter + 1]);
    Object.assign(row, { ttl, createdAt });
    counter = counter + 2;
  }
  return output;
};

const _extractLockTimestamp = (value) => Number(String(value ?? "").split("##")[0]) || null;

const shutdownHandler = async () => {
  const logger = cds.log(COMPONENT_NAME);
  logger.info("received shutdown event, trying to release all locks", {
    numberOfLocks: Object.keys(existingLocks).length,
  });
  const result = await Promise.allSettled(
    Object.entries(existingLocks).map(async ([key, { tenant, token }]) => {
      if (config.redisEnabled) {
        await _releaseLockRedis({ tenant }, key, { token });
      } else {
        await _releaseLockDb({ tenant }, key, { token });
      }
      logger.info("lock released", { key });
    })
  );
  const errors = result.filter((promise) => promise.reason);
  logger.info("releasing locks finished ", {
    numberOfErrors: errors.length,
    ...(errors.length && { firstError: errors[0] }),
  });
};

module.exports = {
  generateEventLockKey,
  generateLockToken,
  acquireLock,
  releaseLock,
  checkLockExists,
  getValue,
  setValueWithExpire,
  shutdownHandler,
  renewLock,
  getAllLocksRedis,
};
