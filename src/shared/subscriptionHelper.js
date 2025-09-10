"use strict";

const xssec = require("@sap/xssec");

const { limiter } = require("./common");
const _getSaaSRegistryTenantMap = async (tenantIds) => {
  if (!_getSaaSRegistryTenantMap._) {
    _getSaaSRegistryTenantMap._ = {};
    _getSaaSRegistryTenantMap._.authService = new xssec.XsuaaService(cds.requires["sms-eventQueue"].credentials);
  }

  const jwt = await test.fetchClientCredentialsToken();

  limiter();
};

module.exports = { _getSaaSRegistryTenantMap };
