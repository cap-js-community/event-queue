"use strict";

const eventQueueConfig = require("./config");
const cdsHelper = require("./shared/cdsHelper");
const { eventQueueRunner } = require("./processEventQueue");
const { publishEvent } = require("./redisPubSub");

const singleInstanceAndTenant = () => {
  _singleInstanceAndTenant();
};

const _singleInstanceAndTenant = async () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  await _executeRunForTenant();
  setTimeout(_singleInstanceAndTenant, configInstance.betweenRuns);
};

// TODO: control concurrency
const singleInstanceAndMultiTenancy = () => {
  _singleInstanceAndMultiTenancy();
};

const _singleInstanceAndMultiTenancy = async () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    const tenantIds = await cdsHelper.getAllTenantIds();
    for (const tenantId of tenantIds) {
      await _executeRunForTenant(tenantId);
    }
  } catch (err) {
    // TODO: error handling
  }
  setTimeout(_singleInstanceAndMultiTenancy, configInstance.betweenRuns);
};

const multiInstanceAndTenancy = () => {
  _multiInstanceAndTenancy();
};

const multiInstanceAndSingleTenancy = () => {
  _multiInstanceAndSingleTenancy();
};

const _multiInstanceAndTenancy = async () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    const tenantIds = await cdsHelper.getAllTenantIds();
    for (const tenantId of tenantIds) {
      await _executeRunForTenantWithRedis(tenantId);
    }
  } catch (err) {
    // TODO: error handling
  }
  setTimeout(_multiInstanceAndTenancy, configInstance.betweenRuns);
};

const _multiInstanceAndSingleTenancy = async () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  try {
    await _executeRunForTenant();
  } catch (err) {
    // TODO: error handling
  }
  setTimeout(_multiInstanceAndSingleTenancy, configInstance.betweenRuns);
};

const _executeRunForTenant = async (tenantId) => {
  try {
    const configInstance = eventQueueConfig.getConfigInstance();
    const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns();
    const subdomain = await cdsHelper.getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    await eventQueueRunner(context, eventsForAutomaticRun);
  } catch (err) {
    // TODO: error handling
  }
};

const _executeRunForTenantWithRedis = async (tenantId) => {
  try {
    const configInstance = eventQueueConfig.getConfigInstance();
    const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns();
    for (const { type, subType } of eventsForAutomaticRun) {
      await publishEvent(tenantId, type, subType);
    }
  } catch (err) {
    // TODO: error handling
  }
};

module.exports = {
  singleInstanceAndTenant,
  singleInstanceAndMultiTenancy,
  multiInstanceAndTenancy,
  multiInstanceAndSingleTenancy,
};
