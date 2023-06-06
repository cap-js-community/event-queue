# @cap-community/event-queue

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers,
the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

## Getting started

- Run `npm add @cap-community/event-queue` in `@sap/cds` project
- Initialize the event queue for example in the CAP server.js
- Enhance or create `./srv/server.js`:

### By Code

```js
const cds = require("@sap/cds");
const eventQueue = require("@sap/cds-event-queue");

cds.on("bootstrap", () => {
  eventQueue.initialize({
    configFilePath: "./srv/eventConfig.yml",
  });
});

module.exports = cds.server;
```

### As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
cds-plugin concept.
https://cap.cloud.sap/docs/releases/march23#new-cds-plugin-technique

```json
{
  "cds": {
    "eventQueue": {
      "plugin": true,
      "configFilePath": "./srv/eventQueueConfig.yml"
    }
  }
}
```

## Features

- load balancing of event processing throughout app instances
- managed transactions for event processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)

## Initialize event queue configuration

| Property                 | Description                                                                                                                                                                                           |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| configFilePath           | Filepath as string for the event configuration file. Base path is the root directory of the project.                                                                                                  |
| registerAsEventProcessor | Allows to enable/disable register event processor. The interval is based on the parameter `runInterval`.<br/> Based on this interval all events for all tenants will be processed. Default is `true`. |
| runInterval              | The interval specifies how often events are processed for all tenants. If `registerDbHandler` is true                                                                                                                               |
| registerDbHandler        |                                                                                                                                                                                                       |                                                                                                      |
| tableNameEventQueue      |                                                                                                                                                                                                       |
| tableNameEventLock       |                                                                                                                                                                                                       |
| skipCsnCheck             |                                                                                                                                                                                                       |
| parallelTenantProcessing |                                                                                                                                                                                                       |

## Configure your events

Events are configured in a configuration yml file. In this file all relevant information about how events should be
processed
can be maintained.

```yaml
events:
  - type: Notifications
    subType: Email
    impl: ./test/asset/EventQueueTest
```


## Event Configurations

| Property                | Description                                                                                                                                                                                                                               |
|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| retryAttempts           | For infinite retries, maintain -1 as 'retryAttempts'. <br/>Default retry attempts is 3.                                                                                                                                                   |
| runAutomatically        | If true, the event will automatically process based on the run interval. Load the load passed to the funnel - value needs to be between 1 - 100. This property is only allowed if runOnEventQueueTickHandler is true.                     |
| parallelEventProcessing | How many events of the same type and subType are parallel processed after clustering. Default value is 1 and limit is 10.                                                                                                                 |
| eventOutdatedCheck      | Checks if the db record for the event has been modified since the selection and right before the processing of the event. Default is true.                                                                                                |
| commitOnEventLevel      | After processing an event, the associated transaction is committed and the associated status is committed with the same transaction. This should be used if events should be processed atomically. Default is false.                      |
| selectMaxChunkSize      | Number of events which are selected at once. Default is 100. If it should be checked if there are more open events available, set the parameter checkForNextChunk to true.                                                                |
| checkForNextChunk       | Determines if after processing a chunk (the size depends on the value of selectMaxChunkSize), a next chunk is being processed if there are more open events and the processing time has not already exceeded 5 minutes. Default is false. |

## Examples

## Architecture
