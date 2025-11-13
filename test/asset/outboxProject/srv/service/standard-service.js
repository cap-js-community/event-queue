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
  }
}

module.exports = StandardService;
