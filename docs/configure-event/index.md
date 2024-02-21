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

| Property                      | Description                                                                                                                                                                                                             | Default Value |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| impl                          | impl                                                                                                                                                                                                                    | -             |
| type                          | type                                                                                                                                                                                                                    | -             |
| subType                       | subType                                                                                                                                                                                                                 | -             |
| load                          | load                                                                                                                                                                                                                    | 1             |
| retryAttempts                 | For infinite retries, maintain -1.                                                                                                                                                                                      | 3             |
| processAfterCommit            | Indicates whether an event is processed immediately after the transaction, in which the event was written, has been committed.                                                                                          | true          |
| parallelEventProcessing       | How many events of the same type and subType are parallel processed after clustering. Limit is 10.                                                                                                                      | 1             |
| eventOutdatedCheck            | Checks if the db record for the event has been modified since the selection and right before the processing of the event.                                                                                               | true          |
| transactionMode               | Specifies the transaction mode for the periodic event. For allowed values refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes)                                                         | isolated      |
| selectMaxChunkSize            | Number of events which are selected at once. If it should be checked if there are more open events available, set the parameter checkForNextChunk to true.                                                              | 100           |
| checkForNextChunk             | Determines if after processing a chunk (the size depends on the value of selectMaxChunkSize), a next chunk is being processed if there are more open events and the processing time has not already exceeded 5 minutes. | false         |
| deleteFinishedEventsAfterDays | This parameter determines the number of days after which events are deleted, regardless of their status. A value of 0 signifies that event entries are never deleted from the database table.                           | 7             |

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

| Property                      | Description                                                                                                                                                                                   | Default Value |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| type                          | Type of the periodic event                                                                                                                                                                    | -             |
| subType                       | SubType of the periodic event                                                                                                                                                                 | -             |
| impl                          | Implementation file path for the periodic event                                                                                                                                               | -             |
| load                          | Load value for the periodic event                                                                                                                                                             | 1             |
| transactionMode               | Transaction mode for the periodic event. For allowed values refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes)                                             | isolated      |
| interval                      | Interval in seconds at which the periodic event should occur                                                                                                                                  | -             |
| deleteFinishedEventsAfterDays | This parameter determines the number of days after which events are deleted, regardless of their status. A value of 0 signifies that event entries are never deleted from the database table. | 7             |

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

# Blocking Events

In certain scenarios, it may be necessary to prevent specific events from executing. This could be due to various
reasons such as:

- An event causing the application to crash
- A specific event leading to performance issues
- Other reasons specific to a project

You can block events for all or just for certain tenants. The example below demonstrates how this can be
accomplished.

### Blocking/Unblocking based on configuration

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

### Blocking/Unblocking based on callback

For greater flexibility, the decision to block an event can be determined based on the result of a callback.
The example below shows how to register the callback.

```js
const { config } = require("@cap-js-community/event-queue");

config.isEventBlockedCb = async (type, subType, isPeriodicEvent, tenant) => {
  // Perform custom check and return true or false
};
```

### Limitation

The current implementation of config does not persistently store the information. This means that the block/unblock
list is only available until the next restart of the application. If you want this information to be persistent,
it is recommended to use the callback API. This allows for accessing persistent information.

# Delete Processed Events

The parameter `deleteFinishedEventsAfterDays` defines the number of days after which processed events are automatically
deleted from the system, regardless of their processing status. Here, "processed" refers to events that have been
processed, whether successfully or unsuccessfully. If this parameter is set to 0, it indicates that processed events
will not be deleted from the database table.

From a technical standpoint, the event queue utilizes its own periodic event to conduct a daily check for events that
are eligible for deletion.
