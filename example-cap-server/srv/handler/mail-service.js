"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@sap/cds-event-queue");

const sendMail = async (context) => {
  await eventQueue.publishEvent(cds.tx(context), {
    type: "Notification",
    subType: "Mail",
    payload: JSON.stringify(context.data),
  });
};

module.exports = async (srv) => {
  const { send } = srv.operations("MailService");
  srv.on(send, sendMail);
};
