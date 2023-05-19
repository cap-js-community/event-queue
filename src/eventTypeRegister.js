"use strict";

const { getConfigInstance } = require("./config");

// NOTE: retryAttempts:             for infinite retries maintain -1 as 'config.retryAttempts'
//                                  default retry attempts is 3
//       runOnEventQueueTickHandler if true the events will automatically process on the eventQueue tick handler
//       load                       the load passed to the funnel - value needs to be between 1 - 100
//                                  this property is only allowed if runOnEventQueueTickHandler is true
//       parallelEventProcessing    how many events of the same type and subType are parallel processed after clustering
//                                  default value is 1 and limit is 10
//       eventOutdatedCheck         checks if the db record for the event has been modified since the selection and right
//                                  before the processing of the event. default is true
//
//       commitOnEventLevel         after process event the associated transaction is committed and the associated status
//                                  is committed with the same transaction. This should be used if events should be
//                                  processed atomically. default is false
//       selectMaxChunkSize         Number of events which are selected at once. Default is 100. If it should be checked
//                                  if there are more open events available set the parameter checkForNextChunk to true
//       checkForNextChunk          Determines if after processing a chunk (the size depends on the value of selectMaxChunkSize)
//                                  a next chunk is being processed if there are more open events and the processing
//                                  time has not already exceeded 5 minutes. Default is false

const getAllEvents = () => {
  return getConfigInstance().fileContent.events;
};

module.exports = {
  getAllEvents,
};
