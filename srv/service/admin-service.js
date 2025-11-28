"use strict";

const cds = require("@sap/cds");

const eventQueue = require("../../src");
const distributedLock = require("../../src/shared/distributedLock");
const redisPub = require("../../src/redis/redisPub");
const publishEventHelper = require("./publishEventHelper");
const commonHelper = require("../../src/shared/common");

const COMPONENT_NAME = "/eventQueue/admin";

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { Event: EventService, Lock: LockService } = this.entities;
    const { Event: EventDb } = cds.db.entities("sap.eventqueue");
    const { publishEvent } = this.actions;

    this.before("*", (req) => {
      if (!eventQueue.config.enableAdminService) {
        req.reject(403, "Admin service is disabled by configuration");
      }

      if (req.event === publishEvent.name.split(".")[1]) {
        return;
      }

      if (req.target === LockService) {
        return;
      }

      const headers = Object.assign({}, req.headers, req.req?.headers);
      const tenant = headers["z-id"] ?? req.data.tenant;

      if (eventQueue.config.isMultiTenancy && tenant == null) {
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
        return events?.map((event) => {
          event.tenant = tenant;
          return event;
        });
      });
    });

    this.on("READ", LockService, async () => {
      if (!eventQueue.config.redisEnabled) {
        return [];
      }
      return await distributedLock.getAllLocksRedis();
    });

    this.on("setStatusAndAttempts", async (req) => {
      const tenant = req.headers["z-id"];
      cds.log(COMPONENT_NAME).info("Restarting processing for event queue");
      const updateData = {};

      if (Number.isInteger(req.data.attempts)) {
        updateData.attempts = req.data.attempts;
      }

      if (Object.values(eventQueue.EventProcessingStatus).includes(req.data.status)) {
        updateData.status = req.data.status;
      }

      if (!Object.keys(updateData).length) {
        return req.reject(400, "No status or attempts provided");
      }

      const event = await cds.tx({ tenant, headers: { "z-id": tenant } }, async () => {
        const event = await SELECT.one.from(EventDb).where({ ID: req.params[0].ID ?? req.params[0] });
        await UPDATE.entity(EventDb)
          .set(updateData)
          .where({ ID: req.params[0].ID ?? req.params[0] });
        return event;
      });
      redisPub.broadcastEvent(tenant, event).catch(() => {
        /* ignore errors */
      });
      return await this.send(new cds.Request({ query: req.query, headers: req.headers }));
    });

    this.on("releaseLock", async (req) => {
      cds.log("eventQueue").info("Releasing event-queue lock", req.data);
      const { tenant, type, subType, namespace } = req.data;
      return await cds.tx({ tenant }, async (tx) => {
        return await distributedLock.releaseLock(tx.context, [namespace, type, subType].join("##"), {
          skipNamespace: true,
        });
      });
    });

    this.on(publishEvent, async (req) => {
      const logger = cds.log(COMPONENT_NAME);
      try {
        const { type, subType, referenceEntity, referenceEntityKey, payload, startAfter, namespace } = req.data;
        const tenants = await publishEventHelper.resolveTenantInfos(req);
        const eventOptions = commonHelper.cleanUndefined({
          type,
          subType,
          referenceEntity,
          referenceEntityKey,
          payload,
          startAfter,
          namespace,
        });
        const publishInfo = { count: tenants.length, type, subType, namespace, tenants: req.data.tenants };
        logger.info("publishing event for tenant(s)", publishInfo);
        for (const tenant of tenants) {
          await cds.tx({ tenant }, async (tx) => {
            await eventQueue.publishEvent(tx, { ...eventOptions });
          });
        }
        logger.info("finished publishing event for tenant(s)", publishInfo);
      } catch (err) {
        logger.error("error publishing event", err);
        req.reject(400, "Error publishing event: " + err.toString());
      }
    });

    await super.init();
  }
};
