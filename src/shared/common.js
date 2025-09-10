"use strict";

const crypto = require("crypto");

const cds = require("@sap/cds");
const xssec = require("@sap/xssec");
const VError = require("verror");

const config = require("../config");
const { TenantIdCheckTypes } = require("../constants");
const { ExpiringLazyCache } = require("./lazyCache");

const MARGIN_AUTH_INFO_EXPIRY = 60 * 1000;
const COMPONENT_NAME = "/eventQueue/common";

const arrayToFlatMap = (array, key = "ID") => {
  return array.reduce((result, element) => {
    result[element[key]] = element;
    return result;
  }, {});
};

/**
 * Defines a promise that resolves when all payloads are processed by the iterator, but limits
 * the number concurrent executions.
 *
 * @param limit     number of concurrent executions
 * @param payloads  array where each element is an array of arguments passed to the iterator
 * @param iterator  (async) function to process a payload
 * @returns {Promise<[]>} promise for an array of iterator results
 */
const limiter = async (limit, payloads, iterator) => {
  const returnPromises = [];
  const runningPromises = [];
  for (const payload of payloads) {
    const p =
      iterator.constructor.name === "AsyncFunction"
        ? iterator(payload)
        : Promise.resolve().then(() => iterator(payload));
    returnPromises.push(p);

    if (limit <= payloads.length) {
      const e = p.catch(() => {}).finally(() => runningPromises.splice(runningPromises.indexOf(e), 1));
      runningPromises.push(e);
      if (limit <= runningPromises.length) {
        await Promise.race(runningPromises);
      }
    }
  }
  return promiseAllDone(returnPromises);
};

const promiseAllDone = async (iterable) => {
  const results = await Promise.allSettled(iterable);
  const rejects = results.filter((entry) => {
    return entry.status === "rejected";
  });
  if (rejects.length === 1) {
    return Promise.reject(rejects[0].reason);
  } else if (rejects.length > 1) {
    return Promise.reject(new VError.MultiError(rejects.map((reject) => reject.reason)));
  }
  return results.map((entry) => {
    return entry.value;
  });
};

const isValidDate = (value) => {
  if (typeof value === "string") {
    const date = Date.parse(value);
    return !isNaN(date);
  } else if (value instanceof Date) {
    return !isNaN(value.getTime());
  } else {
    return false;
  }
};

const processChunkedSync = (inputs, chunkSize, chunkHandler) => {
  let start = 0;
  while (start < inputs.length) {
    let end = start + chunkSize > inputs.length ? inputs.length : start + chunkSize;
    const chunk = inputs.slice(start, end);
    chunkHandler(chunk);
    start = end;
  }
};

const hashStringTo32Bit = (value) => crypto.createHash("sha256").update(String(value)).digest("base64").slice(0, 32);

const _getNewTokenInfo = async (tenantId) => {
  const tokenInfoCache = getTokenInfo._tokenInfoCache;
  tokenInfoCache[tenantId] = tokenInfoCache[tenantId] ?? {};
  try {
    if (!_getNewTokenInfo._xsuaaService) {
      _getNewTokenInfo._xsuaaService = new xssec.XsuaaService(cds.requires.auth.credentials);
    }
    const authService = _getNewTokenInfo._xsuaaService;
    const token = await authService.fetchClientCredentialsToken({ zid: tenantId });
    const tokenInfo = new xssec.XsuaaToken(token.access_token);
    tokenInfoCache[tenantId].expireTs = tokenInfo.getExpirationDate().getTime() - MARGIN_AUTH_INFO_EXPIRY;
    return tokenInfo;
  } catch (err) {
    tokenInfoCache[tenantId] = null;
    cds.log(COMPONENT_NAME).warn("failed to request tokenInfo", {
      err: err.message,
      responseCode: err.responseCode,
      responseText: err.responseText,
    });
  }
};

const getTokenInfo = async (tenantId) => {
  if (!(await isTenantIdValidCb(TenantIdCheckTypes.getTokenInfo, tenantId))) {
    return null;
  }

  if (!cds.requires?.auth?.credentials) {
    return null; // no credentials not tokenInfo
  }

  if (!config.isMultiTenancy) {
    return null; // does only make sense for multi tenancy
  }

  if (!cds.requires?.auth.kind.match(/jwt|xsuaa/i)) {
    return null;
  }

  getTokenInfo._cache = getTokenInfo._tokenInfoCache ?? {};
  const tokenInfoCache = getTokenInfo._tokenInfoCache;
  // not existing or existing but expired
  if (
    !tokenInfoCache[tenantId] ||
    (tokenInfoCache[tenantId] && tokenInfoCache[tenantId].expireTs && Date.now() > tokenInfoCache[tenantId].expireTs)
  ) {
    tokenInfoCache[tenantId] ??= {};
    tokenInfoCache[tenantId].value = _getNewTokenInfo(tenantId);
    tokenInfoCache[tenantId].expireTs = null;
  }
  return await tokenInfoCache[tenantId].value;
};

const isTenantIdValidCb = async (checkType, tenantId) => {
  let cb;
  switch (checkType) {
    case TenantIdCheckTypes.getTokenInfo:
      cb = config.tenantIdFilterTokenInfo;
      break;
    case TenantIdCheckTypes.eventProcessing:
      cb = config.tenantIdFilterEventProcessing;
      break;
    default:
      cb = async () => true;
  }

  try {
    return cb ? await cb(tenantId) : true;
  } catch (err) {
    cds.log(COMPONENT_NAME).error("failed in custom tenant id filter callback. Returning true.", err);
    return true;
  }
};

module.exports = {
  arrayToFlatMap,
  limiter,
  isValidDate,
  processChunkedSync,
  hashStringTo32Bit,
  getTokenInfo,
  isTenantIdValidCb,
  promiseAllDone,
  __: {
    clearTokenInfoCache: () => (getTokenInfo._tokenInfoCache = {}),
  },
};
