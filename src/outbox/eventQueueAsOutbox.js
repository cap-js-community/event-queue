"use strict";

const cds = require("@sap/cds");

const { publishEvent } = require("../publishEvent");
const config = require("../config");

const OUTBOXED = Symbol("outboxed");
const UNBOXED = Symbol("unboxed");
const CDS_EVENT_TYPE = "CAP_OUTBOX";
const COMPONENT_NAME = "/eventQueue/eventQueueAsOutbox";
const EVENT_QUEUE_SPECIFIC_FIELDS = ["startAfter", "referenceEntity", "referenceEntityKey"];

function outboxed(srv, customOpts) {
  // outbox max. once
  const logger = cds.log(COMPONENT_NAME);
  const outboxOpts = Object.assign(
    {},
    (typeof cds.requires.outbox === "object" && cds.requires.outbox) || {},
    (typeof srv.options?.outbox === "object" && srv.options.outbox) || {},
    customOpts || {}
  );

  if (!new.target) {
    const former = srv[OUTBOXED];
    if (former) {
      if (outboxOpts.kind === "persistent-outbox") {
        config.addCAPOutboxEvent(srv.name, outboxOpts);
      }
      return former;
    }
  }

  const originalSrv = srv[UNBOXED] || srv;
  const outboxedSrv = Object.create(originalSrv);
  outboxedSrv[UNBOXED] = originalSrv;

  if (!new.target) {
    Object.defineProperty(srv, OUTBOXED, { value: outboxedSrv });
  }

  if (outboxOpts.kind === "persistent-outbox") {
    config.addCAPOutboxEvent(srv.name, outboxOpts);
  }
  outboxedSrv.handle = async function (req) {
    const context = req.context || cds.context;
    if (outboxOpts.kind === "persistent-outbox") {
      config.addCAPOutboxEvent(srv.name, outboxOpts);
      await _mapToEventAndPublish(context, srv.name, req);
      return;
    }
    context.on("succeeded", async () => {
      try {
        if (req.reply) {
          await originalSrv.send(req);
        } else {
          await originalSrv.emit(req);
        }
      } catch (err) {
        logger.error("In memory processing failed", { event: req.event, cause: err });
        if (isUnrecoverable(originalSrv, err) && outboxOpts.crashOnError !== false) {
          cds.exit(1);
        }
      }
    });
  };

  return outboxedSrv;
}

function unboxed(srv) {
  return srv[UNBOXED] || srv;
}

const _mapToEventAndPublish = async (context, name, req) => {
  const eventQueueSpecificValues = {};
  for (const header in req.headers ?? {}) {
    for (const field of EVENT_QUEUE_SPECIFIC_FIELDS) {
      if (header.toLocaleLowerCase() === `x-eventqueue-${field.toLocaleLowerCase()}`) {
        eventQueueSpecificValues[field] = req.headers[header];
        delete req.headers[header];
        break;
      }
    }
  }
  const event = {
    contextUser: context.user.id,
    ...(req._fromSend || (req.reply && { _fromSend: true })), // send or emit
    ...(req.inbound && { inbound: req.inbound }),
    ...(req.event && { event: req.event }),
    ...(req.data && { data: req.data }),
    ...(req.headers && { headers: req.headers }),
    ...(req.query && { query: req.query }),
  };

  await publishEvent(cds.tx(context), {
    type: CDS_EVENT_TYPE,
    subType: name,
    payload: JSON.stringify(event),
    ...eventQueueSpecificValues,
  });
};

const isUnrecoverable = (service, error) => {
  let unrecoverable = service.isUnrecoverableError && service.isUnrecoverableError(error);
  if (unrecoverable === undefined) {
    unrecoverable = error.unrecoverable;
  }
  return unrecoverable || isStandardError(error);
};

const isStandardError = (err) => {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof RangeError ||
    err instanceof URIError
  );
};

module.exports = {
  outboxed,
  unboxed,
};
