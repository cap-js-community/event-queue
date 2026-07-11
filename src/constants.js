"use strict";

module.exports = {
  EventProcessingStatus: {
    Open: 0,
    InProgress: 1,
    Done: 2,
    Error: 3,
    Exceeded: 4,
    Suspended: 5,
  },
  TransactionMode: {
    isolated: "isolated",
    alwaysCommit: "alwaysCommit",
    alwaysRollback: "alwaysRollback",
  },
  Priorities: {
    Low: "low",
    Medium: "medium",
    High: "high",
    VeryHigh: "veryHigh",
  },
  TenantIdCheckTypes: {
    eventProcessing: "eventProcessing",
    getAuthContext: "getAuthContext",
  },
  // events whose createdAt and startAfter are both older than this are no longer selected for processing
  EVENT_PROCESSING_WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
};
