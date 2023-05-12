"use strict";

module.exports = {
  EventProcessingStatus: {
    Open: 0,
    InProgress: 1,
    Done: 2,
    Error: 3,
    Exceeded: 4,
  },
  TenantModes: {
    single: "SINGLE",
  },
  RunningModes: {
    singleInstance: "SINGLE_INSTANCE",
    multiInstance: "MULTI_INSTANCE",
  },
};
