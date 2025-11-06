"use strict";

const cds = require("@sap/cds");

const { publishEvent } = require("../publishEvent");
const config = require("../config");

const OUTBOXED = Symbol("outboxed");
const UNBOXED = Symbol("unboxed");
const CDS_EVENT_TYPE = "CAP_OUTBOX";
const COMPONENT_NAME = "/eventQueue/eventQueueAsOutbox";
const EVENT_QUEUE_SPECIFIC_FIELDS = ["startAfter", "referenceEntity", "referenceEntityKey", "namespace"];

function outboxed(srv, customOpts) {
  if (!(new.target || customOpts)) {
    const former = srv[OUTBOXED];
    if (former) {
      return former;
    }
  }

  const logger = cds.log(COMPONENT_NAME);
  let outboxOpts = Object.assign(
    {},
    (typeof cds.requires.outbox === "object" && cds.requires.outbox) || {},
    (typeof cds.requires.queue === "object" && cds.requires.queue) || {},
    (typeof srv.options?.outbox === "object" && srv.options.outbox) || {},
    (typeof srv.options?.queued === "object" && srv.options.queued) || {},
    customOpts || {}
  );

  config.addCAPOutboxEventBase(srv.name, outboxOpts);

  const originalSrv = srv[UNBOXED] || srv;
  const outboxedSrv = Object.create(originalSrv);
  outboxedSrv[UNBOXED] = originalSrv;

  if (!new.target) {
    if (!srv[OUTBOXED]) {
      Object.defineProperty(srv, OUTBOXED, { value: outboxedSrv });
    }
  }
  outboxedSrv.handle = async function (req) {
    const context = req.context || cds.context;
    outboxOpts = Object.assign(
      {},
      (typeof cds.requires.outbox === "object" && cds.requires.outbox) || {},
      (typeof cds.requires.queue === "object" && cds.requires.queue) || {},
      (typeof srv.options?.outbox === "object" && srv.options.outbox) || {},
      (typeof srv.options?.queued === "object" && srv.options.queued) || {},
      customOpts || {}
    );
    config.addCAPOutboxEventBase(srv.name, outboxOpts);
    const specificSettings = config.getCdsOutboxEventSpecificConfig(srv.name, req.event);
    if (specificSettings) {
      outboxOpts = config.addCAPOutboxEventSpecificAction(srv.name, req.event);
    }

    const namespace = (specificSettings ?? outboxOpts).namespace ?? config.namespace;
    if (["persistent-outbox", "persistent-queue"].includes(outboxOpts.kind)) {
      await _mapToEventAndPublish(context, srv.name, req, !!specificSettings, namespace);
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

const _mapToEventAndPublish = async (context, name, req, actionSpecific, namespace) => {
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

  await publishEvent(
    cds.tx(context),
    {
      type: CDS_EVENT_TYPE,
      subType: actionSpecific ? [name, req.event].join(".") : name,
      payload: JSON.stringify(event),
      namespace: eventQueueSpecificValues.namespace ?? namespace,
      ...eventQueueSpecificValues,
    },
    { allowNotExistingConfiguration: !!eventQueueSpecificValues.namespace }
  );
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
