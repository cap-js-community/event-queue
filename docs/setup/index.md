---
layout: default
title: Getting started
nav_order: 3
---

<!-- prettier-ignore-start -->
# Setup
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## Ways of Initialization

- Run `npm add @cap-js-community/event-queue` in `@sap/cds` project
- Initialize the event queue as CAP-Plugin or manually in your server.js

### As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
[cds-plugin concept](https://cap.cloud.sap/docs/releases/march23#new-cds-plugin-technique).

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

### in server.js

Call the initialize function in your server.js. Check here the available settings for the initialization.
```js
eventQueue.initialize({
  configFilePath: "./srv/eventConfig.yml",
});
```

## Initialization parameters

| Name                      | Description                                                | Default             |
|:--------------------------|:-----------------------------------------------------------|:--------------------|
| configFilePath            | Path to the configuration file.                            | `null`              |
| registerAsEventProcessor  | Whether or not to register as an event processor.          | `true`              |
| processEventsAfterPublish | Whether or not to process events after they are published. | `true`              |
| isRunnerDeactivated       | Whether or not the runner is deactivated.                  | `false`             |
| runInterval               | The interval in milliseconds at which the runner runs.     | `5 * 60 * 1000`     |
| instanceLoadLimit         | The number of tenants that can be processed in parallel.   | `5`                 |
| tableNameEventQueue       | The name of the event queue table.                         | `BASE_TABLES.EVENT` |
| tableNameEventLock        | The name of the event lock table.                          | `BASE_TABLES.LOCK`  |
| disableRedis              | Whether or not to disable Redis.                           | `false`             |
| skipCsnCheck              | Whether or not to skip the CSN check.                      | `false`             |
| updatePeriodicEvents      | Whether or not to update periodic events.                  | `true`              |
