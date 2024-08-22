---
layout: default
title: Configure Event
nav_order: 4
---

<!-- prettier-ignore-start -->


{: .no_toc}

# Configure Events

<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

# Ad-Hoc events

Ad-hoc events are one-time events that are either processed directly or with a defined delay. The purpose of such events
is to process asynchronous loads, such as sending email notifications or compressing uploaded attachments, where you
don't want the user to wait until the process is finished. These events have various configurations to determine how
they should be processed.

## Configuration

The configuration YAML file is where all the required information regarding event processing should be maintained.

## Parameters

| Property                      | Description                                                                                                                                                                                                                       | Default Value   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| impl                          | Path of the implementation class associated with the event.                                                                                                                                                                       | -               |
| type                          | Specifies the type of the event.                                                                                                                                                                                                  | -               |
| subType                       | Specifies the subtype of the event, further categorizing the event type.                                                                                                                                                          | -               |
| load                          | Indicates the load of the event, affecting the processing concurrency.                                                                                                                                                            | 1               |
| retryAttempts                 | Number of retry attempts for failed events. Set to `-1` for infinite retries.                                                                                                                                                     | 3               |
| processAfterCommit            | Indicates whether an event is processed immediately after the transaction, in which the event was written, has been committed.                                                                                                    | true            |
| parallelEventProcessing       | Number of events of the same type and subType that can be processed in parallel. The maximum limit is 10.                                                                                                                         | 1               |
| eventOutdatedCheck            | Checks if the database record for the event has been modified since it was selected and right before processing the event.                                                                                                        | true            |
| transactionMode               | Specifies the transaction mode for the event. For allowed values, refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes).                                                                          | isolated        |
| selectMaxChunkSize            | Number of events selected in a single batch. Set `checkForNextChunk` to `true` if you want to check for more available events after processing a batch.                                                                           | 100             |
| checkForNextChunk             | Determines if after processing a chunk (based on `selectMaxChunkSize`), the next chunk is processed if there are more open events.                                                                                                | false           |
| deleteFinishedEventsAfterDays | Specifies the number of days after which finished events are deleted, regardless of their status. A value of `0` indicates that event entries are never deleted from the database.                                                | 7               |
| priority                      | Specifies the priority level of the event. More details can be found [here](#priority-of-events).                                                                                                                                 | Medium          |
| appNames                      | Specifies the application names on which the event should be processed. The application name is extracted from the environment variable `VCAP_APPLICATION`. If not defined, the event is processed on all connected applications. | null            |
| retryFailedAfter              | The duration (in milliseconds) after which failed events should be retried, provided the retry limit has not been exceeded.                                                                                                       | `5 * 60 * 1000` |

## Configuration

Below are two examples of ad-hoc event configurations. The first example demonstrates a simple configuration, while the
second example showcases the full complexity of the configuration.

```yaml
events:
  - type: Notification
    subType: Email
    impl: ./srv/util/mail-service/EventQueueNotificationProcessor
    load: 1
    parallelEventProcessing: 5

  - type: Attachment
    subType: Compress
    impl: ./srv/common/process/EventQueueClosingTaskSync
    load: 3
    parallelEventProcessing: 2
    selectMaxChunkSize: 5
    checkForNextChunk: true
    transactionMode: alwaysRollback
    retryAttempts: 1
```

# Periodic Events

Periodic events in the event-queue framework are events processed at pre-defined intervals, similar to cron jobs.
This feature is particularly useful for regular business processes such as checking if a task is overdue. Just like
ad-hoc events, these events are managed efficiently across all available application instances, ensuring no single
instance is overloaded.

## Parameters

## Parameters

| Property                      | Description                                                                                                                                                                                                                       | Default Value |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| impl                          | Path of the implementation class associated with the event.                                                                                                                                                                       | -             |
| type                          | Specifies the type of the periodic event.                                                                                                                                                                                         | -             |
| subType                       | Specifies the subtype of the periodic event, further categorizing the event type.                                                                                                                                                 | -             |
| load                          | Indicates the load of the event, affecting the processing concurrency.                                                                                                                                                            | 1             |
| transactionMode               | Specifies the transaction mode for the periodic event. For allowed values, refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes).                                                                 | isolated      |
| interval                      | The interval, in seconds, at which the periodic event should be triggered.                                                                                                                                                        | -             |
| deleteFinishedEventsAfterDays | Specifies the number of days after which finished events are deleted, regardless of their status. A value of `0` indicates that event entries are never deleted from the database.                                                | 7             |
| priority                      | Specifies the priority level of the event. More details can be found [here](#priority-of-events).                                                                                                                                 | Medium        |
| appNames                      | Specifies the application names on which the event should be processed. The application name is extracted from the environment variable `VCAP_APPLICATION`. If not defined, the event is processed on all connected applications. | null          |

## Configuration

The following demonstrates a configuration for a periodic event with a default load of 1 and an interval of 30 seconds.
This means the periodic event is scheduled to execute every 30 seconds, if the provided capacity is sufficient on any
application instance. If capacity is unavailable, the execution is delayed, but subsequent attempts will aim to adhere
to
the originally planned schedule plus the defined interval.

```yaml
periodicEvents:
  - type: HealthCheck
    subType: DB
    impl: ./test/asset/EventQueueHealthCheckDb
    load: 1
    transactionMode: alwaysRollback
    interval: 30
```

# Runtime Configuration Changes

In certain scenarios, it may be necessary to change configurations during runtime. The event-queue has two main
configuration sections: one for all ad-hoc and periodic events (explained on this wiki page), and another for
the [initialization configuration](/event-queue/setup/#initialization-parameters). However, not all parameters can be
modified at runtime. To identify which parameters can be altered, please refer to the corresponding parameter tables in
the documentation. Note that any configuration change needs to be implemented for every application instance. For
instance, if a configuration change is made via an HTTP-Handler, the change will only be reflected in the instance that
processed the HTTP request.

## Changing Initialization Configuration at Runtime

The initialization configuration can be changed by setting the value of the corresponding setter parameter from the
config class instance. Here is an example:

```js
const { config } = require("@cap-js-community/event-queue");

config.runInterval = 5 * 60 * 1000; // 5 minutes
```

## Changing Event Configuration at Runtime

To change the configuration of a specific event, you can refer to the example below:

```js
const { config } = require("@cap-js-community/event-queue");

const eventConfig = config.getEventConfig("HealthCheck", "DB");
eventConfig.load = 5;
```

## Limitation

The current implementation of config does not persistently store runtime configuration changes. This means that e.g.
the block/unblock list is only available until the next restart of the application. If you want this information to be
persistent, it is recommended to use the callback API. This allows for accessing persistent information.

## Blocking Events

In certain scenarios, it may be necessary to prevent specific events from executing. This could be due to various
reasons such as:

- An event causing the application to crash
- A specific event leading to performance issues
- Other reasons specific to a project

You can block events for all or just for certain tenants. The example below demonstrates how this can be
accomplished.

## Blocking/Unblocking based on configuration

```js
const { config } = require("@cap-js-community/event-queue");

// Block type: HealthCheck and subType: DB for tenant 123
const isPeriodicEvent = true;
config.blockEvent("HealthCheck", "DB", isPeriodicEvent, 123);

// Block type: HealthCheck and subType: DB for all tenants
config.blockEvent("HealthCheck", "DB", isPeriodicEvent);

// Unblock works the same way - unblock for all tenants
config.unblockPeriodicEvent("HealthCheck", "DB", isPeriodicEvent);
```

Tenant-specific blockings/unblockings take precedence over the all-tenant blocking. This means if a certain event is
blocked for all tenants, it can still be unblocked for one or more tenants.

## Blocking/Unblocking based on callback

For greater flexibility, the decision to block an event can be determined based on the result of a callback.
The example below shows how to register the callback.

```js
const { config } = require("@cap-js-community/event-queue");

config.isEventBlockedCb = async (type, subType, isPeriodicEvent, tenant) => {
  // Perform custom check and return true or false
};
```

## Unsubscribe Handler

The event-queue listens for unsubscribe events from `cds-mtxs` and stops processing events for an unsubscribed tenant.
Additionally, the event-queue federates the unsubscribe event to all application instances bound to the same Redis instance.
To react to unsubscribe events across all application instances, the event-queue allows the registration of callbacks
that are triggered when a tenant is unsubscribed. Follow the code example below:

```javascript
const { config } = require("@cap-js-community/event-queue");

config.attachUnsubscribeHandler(async (tenantId) => {
  try {
    cds.log("server").info("received unsubscribe event via event-queue", { tenantId });
    await cds.db.disconnect(tenantId);
  } catch (err) {
    logger.error("disconnect db failed!", { tenantId }, err);
  }
});
```

This ensures that your application can handle tenant unsubscription events consistently, even in a distributed environment.

# Delete Processed Events

The parameter `deleteFinishedEventsAfterDays` defines the number of days after which processed events are automatically
deleted from the system, regardless of their processing status. Here, "processed" refers to events that have been
processed, whether successfully or unsuccessfully. If this parameter is set to 0, it indicates that processed events
will not be deleted from the database table.

From a technical standpoint, the event queue utilizes its own periodic event to conduct a daily check for events that
are eligible for deletion.

# Priority of Events

The assignment of priorities to events determines the order in which different event types are processed. The available
priority levels are as follows:

- Low
- Medium (Default)
- High
- Very High

To ensure that event types with low priorities are not left unprocessed during periods of high system load, an automatic
adjustment is made for event types in the queue for more than three minutes. The pre-defined rule is: if an event type
remains in the queue for more than three minutes, its priority is temporarily bumped up by one level (i.e., from Low to
Medium).
