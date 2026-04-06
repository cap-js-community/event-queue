"use strict";

const cds = require("@sap/cds");

const capturedTriggerEvents = {};

class StandardService extends cds.Service {
  async init() {
    await super.init();
    this.on("saga", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      if (req.data.throw) {
        throw new Error(req.data.throw);
      }

      return {
        status: req.data.status ?? 2,
        ...(req.data.nextData && { nextData: req.data.nextData }),
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("general", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.nextData && { nextData: req.data.nextData }),
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("#succeeded", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("#failed", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("specific", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.nextData && { nextData: req.data.nextData }),
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("saga/#succeeded", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("saga/#failed", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("specific/#succeeded", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("specific/#failed", (req) => {
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
        ...(req.data.errorMessage && { error: new Error(req.data.errorMessage) }),
      };
    });

    this.on("saga/#done", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
      };
    });

    this.on("specific/#done", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
      };
    });

    this.on("#done", (req) => {
      capturedTriggerEvents[req.event] = req.eventQueue?.triggerEvent;
      cds.log(this.name).info(req.event, {
        data: req.data,
        user: req.user.id,
        error: req.data.error,
      });

      return {
        status: req.data.status ?? 2,
      };
    });
  }
}

StandardService.capturedTriggerEvents = capturedTriggerEvents;
module.exports = StandardService;
