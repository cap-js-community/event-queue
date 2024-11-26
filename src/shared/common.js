"use strict";

const crypto = require("crypto");

const cds = require("@sap/cds");
const xssec = require("@sap/xssec");
const config = require("../config");

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
  return Promise.allSettled(returnPromises);
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

const _getNewAuthInfo = async (tenantId) => {
  const authInfoCache = getAuthInfo._authInfoCache;
  authInfoCache[tenantId] = authInfoCache[tenantId] ?? {};
  try {
    if (!_getNewAuthInfo._xsuaaService) {
      _getNewAuthInfo._xsuaaService = new xssec.XsuaaService(cds.requires.auth.credentials);
    }
    const authService = _getNewAuthInfo._xsuaaService;
    const token = await authService.fetchClientCredentialsToken({ zid: tenantId });
    const tokenInfo = new xssec.XsuaaToken(token.access_token);
    authInfoCache[tenantId].expireTs = tokenInfo.getExpirationDate().getTime() - MARGIN_AUTH_INFO_EXPIRY;
    return tokenInfo;
  } catch (err) {
    authInfoCache[tenantId] = null;
    cds.log(COMPONENT_NAME).warn("failed to request authInfo", err);
  }
};

const getAuthInfo = async (tenantId) => {
  if (!isTenantIdValidCb(tenantId)) {
    return null;
  }

  if (!cds.requires?.auth?.credentials) {
    return null; // no credentials not authInfo
  }
  if (!cds.requires?.auth.kind.match(/jwt|xsuaa/i)) {
    cds.log(COMPONENT_NAME).warn("Only 'jwt' or 'xsuaa' are supported as values for auth.kind.");
    return null;
  }

  getAuthInfo._authInfoCache = getAuthInfo._authInfoCache ?? {};
  const authInfoCache = getAuthInfo._authInfoCache;
  // not existing or existing but expired
  if (
    !authInfoCache[tenantId] ||
    (authInfoCache[tenantId] && authInfoCache[tenantId].expireTs && Date.now() > authInfoCache[tenantId].expireTs)
  ) {
    authInfoCache[tenantId] ??= {};
    authInfoCache[tenantId].value = _getNewAuthInfo(tenantId);
    authInfoCache[tenantId].expireTs = null;
  }
  return await authInfoCache[tenantId].value;
};

const isTenantIdValidCb = (tenantId) => {
  if (config.tenantIdFilterCb) {
    return config.tenantIdFilterCb(tenantId);
  } else {
    return true;
  }
};

module.exports = {
  arrayToFlatMap,
  limiter,
  isValidDate,
  processChunkedSync,
  hashStringTo32Bit,
  getAuthInfo,
  isTenantIdValidCb,
  __: {
    clearAuthInfoCache: () => (getAuthInfo._authInfoCache = {}),
  },
};
