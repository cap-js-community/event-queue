"use strict";

const { getSubdomainForTenantId } = require("./shared/cdsHelper");
const { getWorkerPoolInstance } = require("./shared/WorkerQueue");
const { processEventQueue } = require("./processEventQueue");

const COMPONENT_NAME = "eventQueue/runEventCombinationForTenant";

module.exports = async (tenantId, type, subType) => {
  try {
    const subdomain = await getSubdomainForTenantId(tenantId);
    const context = new cds.EventContext({
      tenant: tenantId,
      // NOTE: we need this because of logging otherwise logs would not contain the subdomain
      http: { req: { authInfo: { getSubdomain: () => subdomain } } },
    });
    cds.context = context;
    getWorkerPoolInstance().addToQueue(async () => processEventQueue(context, type, subType));
  } catch (err) {
    const logger = cds.log(COMPONENT_NAME);
    logger.error("error executing event combination for tenant", err, {
      tenantId,
      type,
      subType,
    });
  }
};
