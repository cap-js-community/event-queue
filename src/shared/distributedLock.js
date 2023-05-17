"use strict";

const redisWrapper = require("@sap/btp-feature-toggles/src/redisWrapper");

const config = require("../config");
const { executeInNewTransaction } = require("./cdsHelper");

const acquireLock = async (
  context,
  key,
  {
    tenantScoped = true,
    expiryTime = config.getConfigInstance().globalTxTimeout,
  } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.getConfigInstance().isOnCF) {
    return await _acquireLockRedis(context, fullKey, expiryTime);
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime);
  }
};

const setValueWithExpire = async (
  context,
  key,
  value,
  {
    tenantScoped = true,
    expiryTime = config.getConfigInstance().globalTxTimeout,
  } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.getConfigInstance().isOnCF) {
    return await _acquireLockRedis(context, fullKey, expiryTime, value);
  } else {
    return await _acquireLockDB(context, fullKey, expiryTime, value);
  }
};

const releaseLock = async (context, key, { tenantScoped = true } = {}) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.getConfigInstance().isOnCF) {
    return await _releaseLockRedis(context, fullKey);
  } else {
    return await _releaseLockDb(context, fullKey);
  }
};

const checkLockExistsAndReturnValue = async (
  context,
  key,
  { tenantScoped = true } = {}
) => {
  const fullKey = _generateKey(context, tenantScoped, key);
  if (config.getConfigInstance().isOnCF) {
    return await _checkLockExistsRedis(context, fullKey);
  } else {
    return await _checkLockExistsDb(context, fullKey);
  }
};

const _acquireLockRedis = async (
  context,
  fullKey,
  expiryTime,
  value = "true"
) => {
  const client = await redisWrapper._._createMainClientAndConnect();
  const result = await client.set(fullKey, value, {
    PX: expiryTime,
    NX: true,
  });
  return result === "OK";
};

const _checkLockExistsRedis = async (context, fullKey) => {
  const client = await redisWrapper._._createMainClientAndConnect();
  return await client.get(fullKey);
};

const _checkLockExistsDb = async (context, fullKey) => {
  let result;
  await executeInNewTransaction(
    context,
    "distributedLock-checkExists",
    async (tx) => {
      result = await tx.run(
        SELECT.one.from("sap.core.EventLock").where("code =", fullKey)
      );
    }
  );
  return result?.value;
};

const _releaseLockRedis = async (context, fullKey) => {
  const client = await redisWrapper._._createMainClientAndConnect();
  await client.del(fullKey);
};

const _releaseLockDb = async (context, fullKey) => {
  await executeInNewTransaction(
    context,
    "distributedLock-release",
    async (tx) => {
      await tx.run(DELETE.from("sap.core.EventLock").where("code =", fullKey));
    }
  );
};

const _acquireLockDB = async (context, fullKey, expiryTime, value = true) => {
  let result;
  await executeInNewTransaction(
    context,
    "distributedLock-acquire",
    async (tx) => {
      try {
        await tx.run(
          INSERT.into("sap.core.EventLock").entries({
            code: fullKey,
            value,
          })
        );
        result = true;
      } catch (err) {
        const currentEntry = await tx.run(
          SELECT.one
            .from("sap.core.EventLock")
            .forUpdate({ wait: config.getConfigInstance().forUpdateTimeout })
            .where("code =", fullKey)
        );
        if (
          !currentEntry ||
          new Date(currentEntry.createdAt).getTime() + expiryTime <= Date.now()
        ) {
          await tx.run(
            UPDATE.entity("sap.core.EventLock")
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
    }
  );
  return result;
};

const _generateKey = (context, tenantScoped, key) => {
  const keyParts = [];
  tenantScoped && keyParts.push(context.tenant);
  keyParts.push(key);
  return keyParts.join("##");
};

module.exports = {
  acquireLock,
  releaseLock,
  checkLockExistsAndReturnValue,
  setValueWithExpire,
};
