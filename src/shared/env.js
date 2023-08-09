"use strict";

const isLocal = process.env.USER !== "vcap";
const isOnCF = !isLocal;
let vcapServices;

const _getVcapServices = () => {
  if (!vcapServices) {
    try {
      vcapServices = JSON.parse(process.env.VCAP_SERVICES);
    } catch {
      vcapServices = {};
    }
  }
  return vcapServices;
};

const getRedisCredentialsFromEnv = () => {
  return _getVcapServices()["redis-cache"]?.[0]?.credentials;
};

module.exports = {
  isOnCF,
  isLocal,
  getRedisCredentialsFromEnv,
};
