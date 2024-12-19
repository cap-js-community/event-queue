"use strict";

const redis = require("./redis");
const config = require("../config");
const cdsHelper = require("./cdsHelper");

const KEY_PREFIX = "EVENT_QUEUE";
const existingLocks = {};
const REDIS_COMMAND_OK = "OK";
const COMPONENT_NAME = "/eventQueue/distributedLock";

const acquireLock = async (context, key, { tenantScoped = true, expiryTime = config.globalTxTimeout } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime);
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime);
  }
};

const setValueWithExpire = async (
  context,
  key,
  value,
  { tenantScoped = true, expiryTime = config.globalTxTimeout, overrideValue = false } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _acquireLockRedis(context, fullKey, expiryTime, {
      value,
      overrideValue,
    });
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, {
      value,
      overrideValue,
    });
  }
};

const releaseLock = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _releaseLockRedis(context, fullKey);
  } else {
    return await _releaseLockDb(context, fullKey);
  }
};

const checkLockExistsAndReturnValue = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.redisEnabled) {
    return await _checkLockExistsRedis(context, fullKey);
  } else {
    return await _checkLockExistsDb(context, fullKey);
  }
};

const _acquireLockRedis = async (context, fullKey, expiryTime, { value = "true", overrideValue = false } = {}) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  const result = await client.set(fullKey, value, {
    PX: Math.round(expiryTime),
    ...(overrideValue ? null : { NX: true }),
  });
  const isOk = result === REDIS_COMMAND_OK;
  if (isOk) {
    existingLocks[fullKey] = 1;
  }
  return isOk;
};

const _checkLockExistsRedis = async (context, fullKey) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  return await client.get(fullKey);
};

const _checkLockExistsDb = async (context, fullKey) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-checkExists", async (tx) => {
    result = await tx.run(SELECT.one.from(config.tableNameEventLock).where("code =", fullKey));
  });
  return result?.value;
};

const _releaseLockRedis = async (context, fullKey) => {
  const client = await redis.createMainClientAndConnect(config.redisOptions);
  await client.del(fullKey);
  delete existingLocks[fullKey];
};

const _releaseLockDb = async (context, fullKey) => {
  await cdsHelper.executeInNewTransaction(context, "distributedLock-release", async (tx) => {
    await tx.run(DELETE.from(config.tableNameEventLock).where("code =", fullKey));
  });
};

const _acquireLockDB = async (context, fullKey, expiryTime, { value = "true", overrideValue = false } = {}) => {
  let result;
  await cdsHelper.executeInNewTransaction(context, "distributedLock-acquire", async (tx) => {
    try {
      await tx.run(
        INSERT.into(config.tableNameEventLock).entries({
          code: fullKey,
          value,
        })
      );
      result = true;
    } catch (err) {
      let currentEntry;

      if (!overrideValue) {
        currentEntry = await tx.run(
          SELECT.one
            .from(config.tableNameEventLock)
            .forUpdate({ wait: config.forUpdateTimeout })
            .where("code =", fullKey)
        );
      }
      if (
        overrideValue ||
        (currentEntry && new Date(currentEntry.createdAt).getTime() + Math.round(expiryTime) <= Date.now())
      ) {
        await tx.run(
          UPDATE.entity(config.tableNameEventLock)
            .set({
              createdAt: new Date().toISOString(),
              value,
            })
            .where("code =", currentEntry.code)
        );
        result = true;
      } else {
        result = false;
      }
    }
  });
  return result;
};

const _generateKey = (context, tenantScoped, key) => {
  const keyParts = [];
  tenantScoped && keyParts.push(context.tenant);
  keyParts.push(key);
  return `${KEY_PREFIX}_${keyParts.join("##")}`;
};

const shutdownHandler = async () => {
  const logger = cds.log(COMPONENT_NAME);
  logger.info("received shutdown event, trying to release all locks", {
    numberOfLocks: Object.keys(existingLocks).length,
  });
  await Promise.allSettled(
    Object.keys(existingLocks).map(async (key) => {
      await _releaseLockRedis(null, key);
      logger.info("lock released", { key });
    })
  );
};

module.exports = {
  acquireLock,
  releaseLock,
  checkLockExistsAndReturnValue,
  setValueWithExpire,
  shutdownHandler,
};
