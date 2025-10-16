"use strict";

const crypto = require("crypto");

const cds = require("@sap/cds");
const xssec = require("@sap/xssec");
const VError = require("verror");

const config = require("../config");
const { ExpiringLazyCache } = require("./lazyCache");
const { TenantIdCheckTypes } = require("../constants");

const EXPIRE_TIME_TENANT_404 = 10 * 60 * 1000; // 10 minutes

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

const _getNewAuthContext = async (tenantId) => {
  try {
    if (!_getNewAuthContext._xsuaaService) {
      _getNewAuthContext._xsuaaService = new xssec.XsuaaService(cds.requires["xsuaa-eventQueue"]?.credentials);
    }
    const authService = _getNewAuthContext._xsuaaService;
    const token = await authService.fetchClientCredentialsToken({ zid: tenantId });
    const tokenInfo = new xssec.XsuaaToken(token.access_token);
    const authInfo = new xssec.XsuaaSecurityContext(authService, tokenInfo);
    return [tokenInfo.getExpirationDate().getTime() - Date.now(), [null, authInfo]];
  } catch (err) {
    cds.log(COMPONENT_NAME).warn("failed to request authContext", {
      err: err.message,
      responseCode: err.responseCode,
      responseText: err.responseText,
    });

    if (err.responseCode === 404) {
      return [EXPIRE_TIME_TENANT_404, [err, null]];
    }
    return [0, null];
  }
};

const getAuthContext = async (tenantId, { returnError = false } = {}) => {
  if (!(await isTenantIdValidCb(TenantIdCheckTypes.getAuthContext, tenantId))) {
    return null;
  }

  if (!cds.requires?.auth?.credentials) {
    return null; // no credentials not authContext
  }

  if (!config.isMultiTenancy) {
    return null; // does only make sense for multi tenancy
  }

  if (!cds.requires?.auth.kind.match(/jwt|xsuaa/i) && !cds.requires?.xsuaa) {
    return null;
  }

  getAuthContext._cache = getAuthContext._cache ?? new ExpiringLazyCache();
  const result = await getAuthContext._cache.getSetCb(tenantId, async () => _getNewAuthContext(tenantId));
  if (returnError) {
    return result;
  } else {
    return result?.[1];
  }
};

const isTenantIdValidCb = async (checkType, tenantId) => {
  let cb;
  switch (checkType) {
    case TenantIdCheckTypes.getAuthContext:
      cb = config.tenantIdFilterAuthContext;
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
  getAuthContext,
  isTenantIdValidCb,
  promiseAllDone,
  __: {
    clearAuthContextCache: () => getAuthContext._cache?.clear(),
  },
};
