---
layout: default
title: Getting started
nav_order: 3
---

<!-- prettier-ignore-start -->


{: .no_toc}

# Setup

<!-- prettier-ignore -->
- TOC
{: toc}

<!-- prettier-ignore-end -->

# Ways of Initialization

- Run `npm add @cap-js-community/event-queue` in `@sap/cds` project
- Initialize the event queue as CAP-Plugin or manually in your server.js

## Using CDS Outbox with config.yaml

The simplest way to utilize the event-queue is by allowing it to manage the CDS outbox and outbox services via the
outbox method in conjunction with the event-queue. To accomplish this, the event-queue needs to be set up as a CDS
outbox. Refer to the following guides
on [how to configure the event-queue](/event-queue/use-as-cap-outbox/#how-to-enable-the-event-queue-as-outbox-mechanism-for-cap)
and [how to implement a CDS service](/event-queue/use-as-cap-outbox/#example-of-a-custom-outboxed-service)..

## As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
[cds-plugin concept](https://cap.cloud.sap/docs/node.js/cds-plugins).

```json
{
  "cds": {
    "eventQueue": {
      "configFilePath": "./srv/eventQueueConfig.yml"
    }
  }
}
```

## in server.js

Call the initialize function in your server.js. Check here the available settings for the initialization.

```js
eventQueue.initialize({
  configFilePath: "./srv/eventConfig.yml",
});
```

# Initialization parameters

The table below lists the initialization parameters that can be used to configure how the event-queue operates.
These parameters allow you to customize various aspects of the event processing,
such as the configuration file path, event processing behavior, load balancing, and more.
The table includes the parameter name, a description of its purpose, and the default value if not specified.

| Name                                 | Description                                                                                                                                                                                                                                                                                                                                      | Default        | Can be changed at runtime |
| :----------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------- | :------------------------ |
| configFilePath                       | Path to the configuration file.                                                                                                                                                                                                                                                                                                                  | null           | no                        |
| registerAsEventProcessor             | Whether or not to register as an event processor. If false, the app can publish events but doesn't process events.                                                                                                                                                                                                                               | true           | no                        |
| processEventsAfterPublish            | Whether or not to process events immediately after publish. Events are distributed via Redis to all available app instances.                                                                                                                                                                                                                     | true           | no                        |
| isEventQueueActive                   | Determines if the event queue is active. This property controls whether events are automatically processed. It can be modified in real-time to temporarily disable periodic runs.                                                                                                                                                                | true           | yes                       |
| runInterval [ms]                     | The interval in milliseconds at which the runner runs.                                                                                                                                                                                                                                                                                           | 25 _ 60 _ 1000 | yes                       |
| disableRedis                         | Whether or not to disable Redis.                                                                                                                                                                                                                                                                                                                 | false          | no                        |
| updatePeriodicEvents                 | Whether or not to update periodic events.                                                                                                                                                                                                                                                                                                        | true           | no                        |
| thresholdLoggingEventProcessing [ms] | Threshold after how many milliseconds the processing of a event or periodic event is logged for observability.                                                                                                                                                                                                                                   | 50             | yes                       |
| useAsCAPOutbox                       | Uses the event-queue as the [outbox](https://cap.cloud.sap/docs/node.js/outbox) of CAP. Outbox called are stored and processed in the event-queue instead of the outbox of CAP.                                                                                                                                                                  | false          | no                        |
| userId                               | User id for all created cds contexts. This influences the value for updated managed database fields like createdBy and modifiedBy.                                                                                                                                                                                                               | false          | yes                       |
| cleanupLocksAndEventsForDev          | Deletes all semantic locks and sets all events that are in progress to error during server start. This is used to clean up leftovers from server crashes or restarts during processing.                                                                                                                                                          | false          | no                        |
| redisOptions                         | The option is provided to customize settings when creating Redis clients. The object is spread at the root level for creating a client and within the `default` options for cluster clients.                                                                                                                                                     | {}             | no                        |
| insertEventsBeforeCommit             | If enabled, this feature allows events (including those for outboxed services) to be inserted in bulk using the before commit handler. This is performed to improve performance by mass inserting events instead of single insert operations. This can be disabled by the parameter `skipInsertEventsBeforeCommit` in the function publishEvent. | false          | yes                       |
| enableCAPTelemetry                   | If enabled in combination with `cap-js/telemetry`, OpenTelemetry traces about all event-queue activities are written using the `cap-js/telemetry` tracer.                                                                                                                                                                                        | false          | yes                       |
| cronTimezone                         | Determines whether to apply the central `cronTimezone` setting for scheduling events. If set to `true`, the event will use the defined `cronTimezone`. If set to `false`, the event will use UTC or the server's local time, based on the `utc` setting.                                                                                         | null           | yes                       |
| publishEventBlockList                | Determines whether the publication of events to all app instances is enabled when Redis is active. If set to true, events can be published; if set to false, the publication is disabled.                                                                                                                                                        | true           | yes                       |
| crashOnRedisUnavailable              | If enabled, the application will crash if Redis is unavailable during the connection check.                                                                                                                                                                                                                                                      | false          | false                     |

# Configure Redis

To take advantage of the event-queue capabilities that come with Redis, you simply need to bind a Redis instance to the
app where the event-queue will be used. No additional steps are required. Please note that the event-queue supports both
single and cluster Redis instances.
