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
};
