"use strict";

const eventQueueConfig = require("./config");
const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { eventQueueRunner } = require("./processEventQueue");

const singleInstanceRunner = () => {
  const configInstance = eventQueueConfig.getConfigInstance();
  setTimeout(executeRunForTenantAndScheduleNext, configInstance.betweenRuns);
};

const executeRunForTenantAndScheduleNext = async (tenantId) => {
  const configInstance = eventQueueConfig.getConfigInstance();
  // NOTE: schedule next run immediately to avoid time shifts due to event execution
  setTimeout(executeRunForTenantAndScheduleNext, configInstance.betweenRuns);
  const eventsForAutomaticRun = configInstance.getEventsForAutomaticRuns;

  // TODO: think about adding switch for that
  const subdomain = await getSubdomainForTenantId(tenantId);
  const context = new cds.EventContext({
    tenant: tenantId,
    // NOTE: we need this because of logging otherwise logs would not contain the subdomain
    http: { req: { authInfo: { getSubdomain: () => subdomain } } },
  });
  await eventQueueRunner(context, eventsForAutomaticRun);
};

module.exports = {
  singleInstanceRunner,
};
