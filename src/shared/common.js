"use strict";

const crypto = require("crypto");
const { promisify } = require("util");

const cds = require("@sap/cds");
const xssec = require("@sap/xssec");

const getAuthTokenAsync = promisify(xssec.requests.requestClientCredentialsToken);
const getCreateSecurityContextAsync = promisify(xssec.createSecurityContext);

let authInfoCache = {};
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
  try {
    const token = await getAuthTokenAsync(null, cds.requires.auth.credentials, null, tenantId);
    const authInfo = await getCreateSecurityContextAsync(token, cds.requires.auth.credentials);
    authInfoCache[tenantId].expireTs = authInfo.getExpirationDate().getTime() - MARGIN_AUTH_INFO_EXPIRY;
    return authInfo;
  } catch (err) {
    authInfoCache[tenantId] = null;
    cds.log(COMPONENT_NAME).warn("failed to request authInfo", err);
  }
};

const getAuthInfo = async (tenantId) => {
  if (!cds.requires?.auth?.credentials) {
    return null; // no credentials not authInfo
  }

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

module.exports = {
  arrayToFlatMap,
  limiter,
  isValidDate,
  processChunkedSync,
  hashStringTo32Bit,
  getAuthInfo,
  __: {
    clearAuthInfoCache: () => (authInfoCache = {}),
  },
};
