"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

const send = async (context) => {
  await eventQueue.publishEvent(cds.tx(context), {
    type: "Notification",
    subType: "Mail",
    payload: JSON.stringify(context.data),
  });
};

module.exports = async (srv) => {
  const { sendMail } = srv.operations("MailService");
  srv.on(sendMail, send);
};
