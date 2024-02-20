"use strict";

module.exports = {
  EventProcessingStatus: {
    Open: 0,
    InProgress: 1,
    Done: 2,
    Error: 3,
    Exceeded: 4,
  },
  TransactionMode: {
    isolated: "isolated",
    alwaysCommit: "alwaysCommit",
    alwaysRollback: "alwaysRollback",
  },
  Priorities: {
    Low: "LOW",
    Medium: "MEDIUM",
    High: "HIGH",
    VeryHigh: "VERY_HIGH",
  },
};
