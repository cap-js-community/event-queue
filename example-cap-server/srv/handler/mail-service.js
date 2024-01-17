"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

const single = async (context) => {
  await eventQueue.publishEvent(cds.tx(context), {
    type: "Mail",
    subType: "Single",
    payload: JSON.stringify(context.data),
    ...(context.data.startAfter && { startAfter: new Date(Date.now() + context.data.startAfter * 1000).toISOString() }),
  });
  const audit = await cds.connect.to("audit-log");
  const crypto = await cds.connect.to("CryptoService");
  const mail = await cds.connect.to("MailService");
  const cryptoOutbox = cds.outboxed(crypto);
  const t1 = await cryptoOutbox.send("hash", {
    duration: 10,
  });
  const t2 = await cryptoOutbox.emit("hash", {
    duration: 10,
  });

  debugger;
};

const cluster = async (context) => {
  await eventQueue.publishEvent(cds.tx(context), {
    type: "Mail",
    subType: "Cluster",
    payload: JSON.stringify(context.data),
  });
};

module.exports = async (srv) => {
  const { sendSingle, sendClustered } = srv.operations("MailService");
  srv.on(sendSingle, single);
  srv.on(sendClustered, cluster);
};
