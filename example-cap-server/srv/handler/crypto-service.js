"use strict";

const cds = require("@sap/cds");
const eventQueue = require("@cap-js-community/event-queue");

const hashTrigger = async (context) => {
  await eventQueue.publishEvent(cds.tx(context), {
    type: "Crypto",
    subType: "Hash",
    payload: JSON.stringify(context.data),
  });
};

module.exports = async (srv) => {
  const { hash } = srv.operations("CryptoService");
  srv.on(hash, hashTrigger);
};
