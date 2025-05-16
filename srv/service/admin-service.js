"use strict";

const cds = require("@sap/cds");
const cdsHelper = require("../../src/shared/cdsHelper");
const { EventProcessingStatus } = require("../../src");

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { Event: EventService, Tenant } = this.entities();
    const { Event: EventDb } = cds.db.entities("sap.eventqueue");
    const { landscape, space } = this.getLandscapeAndSpace();

    this.before("*", async (req) => {
      if (req.target.name === Tenant.name) {
        return;
      }
      const headers = Object.assign({}, req.headers, req.req?.headers);
      const tenant = headers["z-id"] ?? req.data.tenant;

      if (tenant == null) {
        req.reject(400, "Missing tenant ID in request header (z-id)");
      }
      req.headers ??= {};
      req.headers["z-id"] = tenant;
    });

    this.on("READ", EventService, async (req) => {
      const tenant = req.headers["z-id"];
      return await cds.tx({ tenant: tenant }, async (tx) => {
        if (req.query.SELECT.from.ref[0].id) {
          req.query.SELECT.from.ref[0].id = EventDb.name;
        } else {
          req.query.SELECT.from.ref[0] = EventDb.name;
        }
        const events = await tx.run(req.query);
        return events.map((event) => {
          event.landscape = landscape;
          event.space = space;
          event.tenant = tenant;
          return event;
        });
      });
    });

    this.on("READ", Tenant, async () => {
      const tenants = await cdsHelper.getAllTenantWithSubdomain();
      return tenants ?? [];
    });

    this.on("setStatusAndAttempts", async (req) => {
      const tenant = req.headers["z-id"];
      cds.log("eventQueue").info("Restarting processing for event queue");
      const updateData = {};

      if (Number.isInteger(req.data.attempts)) {
        updateData.attempts = req.data.attempts;
      }

      if (Object.values(EventProcessingStatus).includes(req.data.status)) {
        updateData.status = req.data.status;
      }

      if (!Object.keys(updateData).length) {
        return req.reject(400, "No status or attempts provided");
      }

      await cds.tx({ tenant, headers: { "z-id": tenant } }, async () => {
        await UPDATE.entity(EventDb)
          .set(updateData)
          .where({ ID: req.params[0].ID ?? req.params[0] });
      });
      return await this.send(new cds.Request({ query: req.query, headers: req.headers }));
    });

    await super.init();
  }

  getLandscapeAndSpace() {
    const url = cds.requires.db.credentials.url;
    const match = url.match(/https?:\/\/[^.]+\.authentication\.([^.]+)\.hana\.ondemand\.com/);
    const landscape = (match?.[1] ?? "sap") === "sap" ? "eu10-canary" : match?.[1];
    let space = "local-dev";
    try {
      space = JSON.parse(process.env.VCAP_APPLICATION)?.space_name;
    } catch {
      /* empty */
    }
    return { landscape, space };
  }
};
