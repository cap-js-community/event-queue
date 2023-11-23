---
layout: default
title: Load Balancing
nav_order: 5
---

<!-- prettier-ignore-start -->
# Configure Event
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## Ad-Hoc events

### Configuration

The configuration YAML file is where all the required information regarding event processing should be maintained.

### Parameters

| Property                      | Description                                                                                                                                                                                                             | Default Value |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| impl                          | impl                                                                                                                                                                                                                    | -             |
| type                          | type                                                                                                                                                                                                                    | -             |
| subType                       | subType                                                                                                                                                                                                                 | -             |
| load                          | load                                                                                                                                                                                                                    | -             |
| retryAttempts                 | For infinite retries, maintain -1.                                                                                                                                                                                      | 3             |
| processAfterCommit            | Indicates whether an event is processed immediately after the transaction, in which the event was written, has been committed.                                                                                          | true          |
| parallelEventProcessing       | How many events of the same type and subType are parallel processed after clustering. Limit is 10.                                                                                                                      | 1             |
| eventOutdatedCheck            | Checks if the db record for the event has been modified since the selection and right before the processing of the event.                                                                                               | true          |
| commitOnEventLevel            | After processing an event, the associated transaction is committed and the associated status is committed with the same transaction. This should be used if events should be processed atomically.                      | false         |
| selectMaxChunkSize            | Number of events which are selected at once. If it should be checked if there are more open events available, set the parameter checkForNextChunk to true.                                                              | 100           |
| checkForNextChunk             | Determines if after processing a chunk (the size depends on the value of selectMaxChunkSize), a next chunk is being processed if there are more open events and the processing time has not already exceeded 5 minutes. | false         |
| deleteFinishedEventsAfterDays | This parameter determines the number of days after which events are deleted, regardless of their status. A value of 0 signifies that event entries are never deleted from the database table.                           | 0             |

### Configuration

// TODO: add explanation

```yaml
events:
  - type: Notification
    subType: EMail
    impl: ./srv/util/mail-service/EventQueueNotificationProcessor
    load: 10
    parallelEventProcessing: 5

  - type: Process
    subType: SyncClosingTask
    impl: ./srv/common/process/EventQueueClosingTaskSync
    load: 40
    parallelEventProcessing: 2
    selectMaxChunkSize: 20
    checkForNextChunk: true
    commitOnEventLevel: true
    retryAttempts: 1
```

## Periodic events

### Parameters

### Configuration
