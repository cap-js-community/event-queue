"use strict";

const EventQueueError = require("../src/EventQueueError");

describe("EventQueueError", () => {
  describe("wrongTxUsage", () => {
    it("should create an error with the correct name and message", () => {
      const error = EventQueueError.wrongTxUsage("type", "subType");
      expect(error.name).toBe("WRONG_TX_USAGE");
      expect(error.message).toBe(
        "Usage of this.tx|this.context is not allowed if parallel event processing is enabled"
      );
      expect(error.jse_info).toEqual({ type: "type", subType: "subType" });
    });
  });

  describe("unknownEventType", () => {
    it("should create an error with the correct name and message", () => {
      const error = EventQueueError.unknownEventType("type", "subType");
      expect(error.name).toBe("UNKNOWN_EVENT_TYPE");
      expect(error.message).toBe(
        "The event type and subType configuration is not configured! Maintain the combination in the config file."
      );
      expect(error.jse_info).toEqual({ type: "type", subType: "subType" });
    });
  });

  describe("notInitialized", () => {
    it("should create an error with the correct name and message", () => {
      const error = EventQueueError.notInitialized();
      expect(error.name).toBe("NOT_INITIALIZED");
      expect(error.message).toBe(
        "The event-queue is not initialized yet. The initialization needs to be completed before the package is used."
      );
      expect(error.info).toBeUndefined();
    });
  });
});
