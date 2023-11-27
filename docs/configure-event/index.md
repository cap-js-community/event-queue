---
layout: default
title: Configure Event
nav_order: 4
---

<!-- prettier-ignore-start -->

# Configure Events
{: .no_toc}
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
| deleteFinishedEventsAfterDays | This parameter determines the number of days after which events are deleted, regardless of their status. A value of 0 signifies that event entries are never deleted from the database table.                           | 0             |

## Configuration

Below are two examples of ad-hoc event configurations. The first example demonstrates a simple configuration, while the
second example showcases the full complexity of the configuration.

```yaml
events:
  - type: Notification
    subType: EMail
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

Periodic events in the Event-Queue framework are events processed at pre-defined intervals, similar to cron jobs.
This feature is particularly useful for regular business processes such as checking if a task is overdue. Just like
ad-hoc events, these events are managed efficiently across all available application instances, ensuring no single
instance is overloaded.

## Parameters

| Property        | Description                                                                                                                                                     | Default Value |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| type            | Specifies the type of the periodic event.                                                                                                                       | -             |
| subType         | Specifies the subType of the periodic event.                                                                                                                    | -             |
| impl            | Specifies the implementation file path for the periodic event.                                                                                                  | -             |
| load            | Specifies the load value for the periodic event.                                                                                                                | 1             |
| transactionMode | Specifies the transaction mode for the periodic event. For allowed values refer to [Transaction Handling](/event-queue/transaction-handling/#transaction-modes) | isolated      |
| interval        | Specifies the interval in seconds at which the periodic event should occur.                                                                                     | -             |

## Configuration

The following demonstrates a configuration for a periodic event with a default load of 1 and an interval of 30 seconds.
This means the periodic event is scheduled to execute every 30 seconds, provided there is sufficient capacity on any
application instance. If capacity is unavailable, execution is delayed, but subsequent attempts will aim to adhere to
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
