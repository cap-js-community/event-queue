---
layout: default
title: Configure Event
nav_order: 4
---

<!-- prettier-ignore-start -->

{: .no_toc}

# Configure Events

- TOC
{: toc}

<!-- prettier-ignore-end -->

# Where to Define Events?

Events can be configured either via `cds.env` or by passing them during the `eventQueue.initialize` call. Both options
are described below. Choose the right option depending on your initialization method (
see [here](/event-queue/setup/#ways-of-initialization)).

## Configuration

The easiest way is to use `cds.env`. This configuration method supports all parameters compatible with the YAML format.
The event `type` and `subType` are derived from the key in the object. Based on the example below, these would be
`Notification` and `Email`.

This approach allows full flexibility with `cds.env`, enabling techniques like `.cdsrc.json` and CDS profiles to adjust
and extend event settings.

```json
{
  "cds": {
    "eventQueue": {
      "events": {
        "Notification/Email": {
          "impl": "./srv/util/mail-service/EventQueueNotificationProcessor",
          "load": 1,
          "parallelEventProcessing": 5
        }
      },
      "periodicEvents": {
        "HealthCheck/DB": {
          "impl": "./test/asset/EventQueueHealthCheckDb",
          "load": 1,
          "transactionMode": "alwaysRollback",
          "interval": 30
        }
      }
    }
  }
}
```

## YAML File

Examples are shown in the sections below. See [here](#configuration-1) and [here](#configuration-2).

# Ad-Hoc events

Ad-hoc events are one-time events that are either processed directly or with a defined delay. The purpose of such events
is to process asynchronous loads, such as sending email notifications or compressing uploaded attachments, where you
don't want the user to wait until the process is finished. These events have various configurations to determine how
they should be processed.

## Parameters

| Property                      | Description                                                                                                                                                                                                                                                                                                                          | Default Value   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| impl                          | Path of the implementation class associated with the event.                                                                                                                                                                                                                                                                          | -               |
| type                          | Specifies the type of the event.                                                                                                                                                                                                                                                                                                     | -               |
| subType                       | Specifies the subtype of the event, further categorizing the event type.                                                                                                                                                                                                                                                             | -               |
| load                          | Indicates the load of the event, affecting the processing concurrency.                                                                                                                                                                                                                                                               | 1               |
| retryAttempts                 | Number of retry attempts for failed events. Set to `-1` for infinite retries.                                                                                                                                                                                                                                                        | 3               |
| processAfterCommit            | Indicates whether an event is processed immediately after the transaction, in which the event was written, has been committed.                                                                                                                                                                                                       | true            |
| parallelEventProcessing       | Number of events of the same type and subType that can be processed in parallel. The maximum limit is 10.                                                                                                                                                                                                                            | 1               |
| transactionMode               | Specifies the transaction mode for the event. For allowed values, refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes).                                                                                                                                                                             | isolated        |
| selectMaxChunkSize            | Number of events selected in a single batch. Set `checkForNextChunk` to `true` if you want to check for more available events after processing a batch.                                                                                                                                                                              | 100             |
| checkForNextChunk             | Determines if after processing a chunk (based on `selectMaxChunkSize`), the next chunk is processed if there are more open events.                                                                                                                                                                                                   | false           |
| priority                      | Specifies the priority level of the event. More details can be found [here](#priority-of-events).                                                                                                                                                                                                                                    | Medium          |
| timeBucket                    | This property allows events of the same type to be grouped in time batches (e.g. every 30 seconds) and processed in batches. The value of this property must be a cron pattern. It makes sense to combine this functionality with the implementation of the [clustering feature](/event-queue/implement-event/#clusterqueueentries). | null            |
| deleteFinishedEventsAfterDays | Specifies the number of days after which finished events are deleted, regardless of their status. A value of `0` indicates that event entries are never deleted from the database.                                                                                                                                                   | 7               |
| appNames                      | Specifies the application names on which the event should be processed. The application name is extracted from the environment variable `VCAP_APPLICATION`. If not defined, the event is processed on all connected applications.                                                                                                    | null            |
| appInstances                  | Specifies the application instance numbers on which the event should be processed. The instance number is extracted from the environment variable `CF_INSTANCE_INDEX`. If not defined, the event is processed on all instances of the connected applications.                                                                        | null            |
| retryFailedAfter              | The duration (in milliseconds) after which failed events should be retried, provided the retry limit has not been exceeded.                                                                                                                                                                                                          | `5 * 60 * 1000` |
| multiInstanceProcessing       | (Currently applicable only for Single Tenant) Allows processing of the same event type and subtype across multiple application instances.                                                                                                                                                                                            | false           |
| increasePriorityOverTime      | After three minutes, the priority of unprocessed events is increased by one. This behavior can be disabled with this option. The behavior is documented [here](#priority-of-events).                                                                                                                                                 | true            |
| keepAliveInterval             | Specifies the interval (in seconds) at which keep-alive signals are sent during event processing to monitor system health.                                                                                                                                                                                                           | 60              |

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

| Property                      | Description                                                                                                                                                                                                                                                   | Default Value |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| impl                          | Path of the implementation class associated with the event.                                                                                                                                                                                                   | -             |
| type                          | Specifies the type of the periodic event.                                                                                                                                                                                                                     | -             |
| subType                       | Specifies the subtype of the periodic event, further categorizing the event type.                                                                                                                                                                             | -             |
| load                          | Indicates the load of the event, affecting the processing concurrency.                                                                                                                                                                                        | 1             |
| transactionMode               | Specifies the transaction mode for the periodic event. For allowed values, refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes).                                                                                             | isolated      |
| interval                      | The interval, in seconds, at which the periodic event should be triggered.                                                                                                                                                                                    | -             |
| cron                          | Defines the schedule of the periodic event using a cron expression. This allows for precise scheduling options like specific days, hours, or minutes.                                                                                                         | -             |
| utc                           | Specifies whether the cron expression should be interpreted in UTC time. If set to true, the schedule will follow UTC; otherwise, it will use the server's local time zone.                                                                                   | true          |
| useCronTimezone               | Is only considered if the property `utc` is not set to true. Determines whether the global `cronTimezone` setting should be applied to the event. If set to `true`, the event will follow the `cronTimezone`.                                                 | true          |
| deleteFinishedEventsAfterDays | Specifies the number of days after which finished events are deleted, regardless of their status. A value of `0` indicates that event entries are never deleted from the database.                                                                            | 7             |
| priority                      | Specifies the priority level of the event. More details can be found [here](#priority-of-events).                                                                                                                                                             | Medium        |
| appNames                      | Specifies the application names on which the event should be processed. The application name is extracted from the environment variable `VCAP_APPLICATION`. If not defined, the event is processed on all connected applications.                             | null          |
| appInstances                  | Specifies the application instance numbers on which the event should be processed. The instance number is extracted from the environment variable `CF_INSTANCE_INDEX`. If not defined, the event is processed on all instances of the connected applications. | null          |
| keepAliveInterval             | Specifies the interval (in seconds) at which keep-alive signals are sent during event processing to monitor system health.                                                                                                                                    | 60            |
| inheritTraceContext           | Determines whether the trace context is propagated during event publishing and processing. If set to `false`, trace context propagation is disabled for the event.                                                                                            | true          |

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

## Why are retries not supported for periodic events and how can this be achieved?

Retries are not supported for periodic events because allowing retries can cause them to overlap with their next
scheduled execution. The resolution of overlapping is not currently handled in the event-queue, which is why it's
recommended to combine ad-hoc and periodic events if retries are needed for periodic events.

### How to achieve retry logic

To implement retry functionality for periodic events, you can publish an ad-hoc event from within the periodic event.
This ad-hoc event can have configured retries and retry intervals:

1. **Publish Ad-Hoc Events**: During the execution of a periodic event, trigger an ad-hoc event if a retry is needed.
2. **Configure Retries**: Set parameters like `retryAttempts` and `retryFailedAfter` on the ad-hoc event to manage its
   retry logic independently of the periodic schedule.

This approach separates retry logic from the periodic execution, preventing scheduling conflicts and ensuring efficient
resource usage.

## Example

```yaml
events:
  - type: MasterData
    subType: Sync
    impl: ./test/asset/EventQueuePeriodicWithRetries
    load: 34 # two MD Syncs in parallel - but leave room for smaller other events
    retryAttempts: 5

periodicEvents:
  - type: MasterData
    subType: Sync
    impl: ./test/asset/EventQueuePeriodicWithRetries
    load: 1
    cron: 0 0 * * * # Runs at midnight every day
```

```js
class EventQueuePeriodicWithRetries extends EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key, eventEntry) {
    try {
      await eventQueue.publishEvent(cds.tx(processContext), {
        // event data goes here
      });
    } catch {
      this.logger.error("Error during processing periodic event!", err);
    }
  }

  async processEvent(processContext, key, queueEntries, payload) {
    let eventStatus = EventProcessingStatus.Done;
    try {
      await doHeavyProcessing(queueEntries, payload);
    } catch {
      eventStatus = EventProcessingStatus.Error;
    }
    return queueEntries.map((queueEntry) => [queueEntry.ID, eventStatus]);
  }
}
```

## Cron Schedule

Periodic events in the Event-Queue framework can now be scheduled using cron expressions for greater precision and
flexibility. When a cron expression is used (with the cron and utc parameters defined), the interval parameter cannot
be specified, and vice versa. Cron jobs in the framework support granular scheduling down to seconds (
e.g., \* \* \* \* \* \*),
allowing for highly specific timing control. However, to prevent system overload, the minimum allowed interval between
two executions is 10 seconds.

The event's next execution time is calculated only after the current event has been executed. This approach ensures that
the system dynamically adapts to real-world conditions but also means that the execution might not strictly follow the
cron schedule. For example, if the CAP application is not running or if there is a high load on the system causing
delays,
the event might not execute exactly as scheduled.

### Timezone Configuration

The Event-Queue framework provides flexibility in handling timezones for periodic events. A central setting,
[cronTimezone](/event-queue/setup/#initialization-parameters), can be configured to define the global timezone used when
calculating the cron schedule for all events.
This allows events to execute according to specific local time zones rather than Coordinated Universal Time (UTC), which
is useful for applications operating across different regions.

#### Event-Specific Timezone Control

In addition to the global `cronTimezone` setting, each event can independently control its timezone behavior using two
parameters:

1. **useCronTimezone**: This parameter controls whether the global `cronTimezone` should be applied to an event. If
   `useCronTimezone` is set to `true` (the default), the event will use the global `cronTimezone`. If set to `false`,
   the event will ignore the global setting and fall back to its own configuration.

2. **UTC**: If no timezone is set, the `UTC` parameter on an event level determines whether the event should run in
   Coordinated Universal Time (UTC) or in the server's local time. When `UTC` is set to `true`, the event will execute
   based on UTC time.

#### Example

If `cronTimezone` is set to `Europe/Berlin` and `useCronTimezone` is `true` for an event, a cron expression like
`0 8 * * *` will trigger at 8:00 AM in Berlin time. If `useCronTimezone` is set to `false`, the event will either use
its own timezone (if defined) or revert to the `UTC` setting to decide whether it should follow UTC time or the server's
local time.

### Common Examples

The following table provides examples of cron expressions that can be used to schedule periodic events. These
expressions
offer flexibility in specifying when and how often events should occur, ranging from precise intervals to specific days
or months. Please note that the minimum interval allowed between two executions is 10 seconds, ensuring that the system
maintains stability and avoids overloading.

| Cron Expression     | Description                                                               |
| ------------------- | ------------------------------------------------------------------------- |
| `0 * * * *`         | Runs at the start of every hour.                                          |
| `* * * * *`         | Runs every minute.                                                        |
| `0 0 * * *`         | Runs at midnight every day.                                               |
| `0 0 * * 0`         | Runs at midnight every Sunday.                                            |
| `30 8 * * 1-5`      | Runs at 8:30 AM, Monday through Friday.                                   |
| `0 9,17 * * *`      | Runs at 9:00 AM and 5:00 PM every day.                                    |
| `0 12 * * 1`        | Runs at 12:00 PM every Monday.                                            |
| `15 14 1 * *`       | Runs at 2:15 PM on the 1st of every month.                                |
| `0 22 * * 5`        | Runs at 10:00 PM every Friday.                                            |
| `0 5 1 1 *`         | Runs at 5:00 AM on January 1st each year.                                 |
| `*/15 * * * *`      | Runs every 15 minutes.                                                    |
| `0 0 1-7 * 0`       | Runs at midnight on the first Sunday of every month.                      |
| `0 8-17/2 * * *`    | Runs every 2 hours between 8:00 AM and 5:00 PM.                           |
| `0 0 1 * *`         | Runs at midnight on the first day of every month.                         |
| `0 0 1 1 *`         | Runs at midnight on January 1st every year.                               |
| `0 3 * * 2`         | Runs at 3:00 AM every Tuesday.                                            |
| `45 23 * * *`       | Runs at 11:45 PM every day.                                               |
| `5,10,15 10 * * *`  | Runs at 10:05, 10:10, and 10:15 every day.                                |
| `0 0 * 5 *`         | Runs at midnight every day in May.                                        |
| `0 6 * * 2-4`       | Runs at 6:00 AM every Tuesday, Wednesday, and Thursday.                   |
| `0 8,12,16 * * 1-5` | Runs at 8:00 AM, 12:00 PM, and 4:00 PM, Monday through Friday.            |
| `10 * 9-17 * *`     | Runs every day at 10 minutes past every hour between 9:00 AM and 5:00 PM. |
| `*/10 * * * * *`    | Runs every 10 seconds (minimum allowed interval).                         |
| `0 0 25 12 *`       | Runs at midnight on Christmas Day, December 25th.                         |
| `0 0 L * *`         | Runs at midnight on the last day of every month.                          |
| `0 6,18 * * *`      | Runs at 6:00 AM and 6:00 PM every day.                                    |

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
Additionally, the event-queue federates the unsubscribe event to all application instances bound to the same Redis
instance.
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

This ensures that your application can handle tenant unsubscription events consistently, even in a distributed
environment.

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

# Keep Alive During Event Processing

The "Keep Alive During Event Processing" feature ensures system reliability by monitoring event processing activities.

## Overview

During the processing of ad-hoc and periodic events, a keep-alive signal is sent to detect application crashes or
unresponsiveness. This enables prompt redirection or restarting of events on different instances if needed.

## Functionality

- Keep-alive signals are periodically sent during event processing, based on event configurations.
- If a keep-alive signal is not received, the system identifies a potential crash.
- Events are restarted on available instances to minimize downtime and ensure continuity.

## Configuration

This parameter specifies the interval, in seconds, at which keep-alive signals are emitted during event processing. The
default value is 60 seconds. Adjusting this parameter can tailor the system's responsiveness to potential failures.
