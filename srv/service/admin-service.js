"use strict";

const cds = require("@sap/cds");
const cdsHelper = require("../../src/shared/cdsHelper");
const common = require("../../src/shared/common");

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { Event: EventService } = this.entities();
    const { Event: EventDb } = cds.db.entities("sap.eventqueue");

    // TODO: extract landscape and space from env service-manager
    // const credentials = cds.requires.db.credentials.url; // https://skyfin.authentication.sap.hana.ondemand.com

    this.on("READ", EventService, async (req, next) => {
      if (cds.requires.multitenancy) {
        const tenantId = req.req.headers["z-id"];
        const tenants = tenantId === "*" ? await cdsHelper.getAllTenantIds() : tenantId.split(",");
        const resultRaw = [];
        await common.limiter(10, tenants, async (tenant) => {
          await cds.tx({ tenant }, async (tx) => {
            const events = await tx.run(req.query);
            resultRaw.push(
              events.map((event) => {
                event.landscape = "eu10";
                event.space = "quality";
                event.tenantId = tenant;
                return event;
              })
            );
          });
        });
        const result = resultRaw.flat();
        return result;
      }

      const events = await next();
      return events.map((event) => {
        event.landscape = "eu10";
        event.space = "quality";
        event.tenantId = "cca55d1a-ec3d-4761-8b68-0a82c2a20fc3";
        return event;
      });
    });

    this.on("setStatusAndAttempts", async (req) => {
      cds.log("eventQueue").info("Restarting processing for event queue");
      const updateData = {};

      if (Number.isInteger(req.data.attempts)) {
        updateData.attempts = req.data.attempts;
      }

      if (req.data.status) {
        updateData.status = req.data.status;
      }

      if (!Object.keys(updateData).length) {
        return req.reject(400, "No status or attempts provided");
      }

      await UPDATE.entity(EventDb)
        .set(updateData)
        .where({ ID: req.params[0].ID ?? req.params[0] });

      return await req.query;
    });

    await super.init();
  }
};
