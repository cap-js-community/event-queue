---
layout: default
title: Getting started
nav_order: 3
---

<!-- prettier-ignore-start -->

# Setup

{: .no_toc}

- TOC
{: toc}

<!-- prettier-ignore-end -->

# Ways of Initialization

- Run `npm add @cap-js-community/event-queue` in `@sap/cds` project
- Initialize the event queue as CAP-Plugin or manually in your server.js

## As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
[cds-plugin concept](https://cap.cloud.sap/docs/node.js/cds-plugins).

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

| Name                                 | Description                                                                                                                                                                       | Default              |
|:-------------------------------------|:----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:---------------------|
| configFilePath                       | Path to the configuration file.                                                                                                                                                   | null                 |
| registerAsEventProcessor             | Whether or not to register as an event processor. If false, the app can publish events but doesn't process events.                                                                | true                 |
| processEventsAfterPublish            | Whether or not to process events immediately after publish. Events are distributed via Redis to all available app instances.                                                      | true                 |
| isEventQueueActive                   | Determines if the event queue is active. This property controls whether events are automatically processed. It can be modified in real-time to temporarily disable periodic runs. | true                 |
| runInterval [ms]                     | The interval in milliseconds at which the runner runs.                                                                                                                            | 300000               |
| tableNameEventQueue                  | The name of the event queue table.                                                                                                                                                | sap.eventqueue.Event |
| tableNameEventLock                   | The name of the event lock table.                                                                                                                                                 | sap.eventqueue.Lock  |
| disableRedis                         | Whether or not to disable Redis.                                                                                                                                                  | false                |
| skipCsnCheck                         | Whether or not to skip the CSN check. Only relevant if custom tables are supplied.                                                                                                | false                |
| updatePeriodicEvents                 | Whether or not to update periodic events.                                                                                                                                         | true                 |
| thresholdLoggingEventProcessing [ms] | Threshold after how many milliseconds the processing of a event or periodic event is logged for observability.                                                                    | 50                   |
