"use strict";

const cds = require("@sap/cds");

class StandardService extends cds.Service {
  async init() {
    await super.init();
    this.on("main", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        headers: req.headers,
      });
    });

    this.on("timeBucketAction", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });
    });

    this.on("callNextOutbox", async (req) => {
      const outboxedService = cds.outboxed(this).tx(req);
      await outboxedService.send(
        "main",
        {
          to: "to",
          subject: "subject",
          body: "body",
        },
        {
          "x-eventqueue-startAfter": new Date(),
        }
      );
    });

    this.on("callNextOutboxMix", async (req) => {
      const outboxedService = cds.outboxed(this).tx(req);
      await outboxedService.send(
        "main",
        {
          to: "to",
          subject: "subject",
          body: "body",
        },
        {
          customHeader: 456,
          myNextHeader: 123,
        }
      );
    });

    this.on("plainStatus", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
      });

      return req.data.status ?? 3;
    });

    this.on("returnStatusAsArray", (req) => {
      return [[req.eventQueue.queueEntries[0].ID, req.data.status]];
    });

    this.on("asObject", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        startAfter: req.data.startAfter,
        error: req.data.error,
      });

      if (req.data.startAfter) {
        req.data.startAfter = new Date(req.data.startAfter);
      }

      return req.data.returnData
        ? req.data
        : {
            status: req.data.status ?? 3,
            startAfter: req.data.startAfter,
            ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
          };
    });

    this.on("asArrayTuple", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return req.eventQueue.queueEntries.map(({ ID }) => [
        ID,
        req.data.returnData
          ? req.data
          : {
              startAfter: req.data.startAfter,
              status: 3 ?? req.data.status,
              ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
            },
      ]);
    });

    this.on("asArrayWithId", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return req.eventQueue.queueEntries.map(({ ID }) => ({
        ID,
        ...(req.data.returnData
          ? req.data
          : {
              ...((req.data.status || req.data.status === 0) && { status: req.data.status }),
              startAfter: req.data.startAfter,
              ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
            }),
      }));
    });
  }
}

module.exports = StandardService;
