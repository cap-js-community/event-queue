---
layout: default
title: Event Status Handling
nav_order: 6
---

<!-- prettier-ignore-start -->

# Event Status Handling

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## Overview

This pages describes the status handling of the event-queue. The status describes the state in which an event currently
is.
The available status values are shown in the table below.

| EventProcessingStatus | Value | Description                                                |
| --------------------- | ----- | ---------------------------------------------------------- |
| Open                  | 0     | The event has been created and is waiting to be processed. |
| InProgress            | 1     | The event is currently being processed.                    |
| Done                  | 2     | The event has been processed successfully.                 |
| Error                 | 3     | An error occurred while processing the event.              |
| Exceeded              | 4     | The event exceeded the maximum processing attempts.        |

### Open

Usually events are processed with very short delay after the transaction, in which the event was written, has been
committed.
This differs if the event is configured to not run directly after the commit of the event data. For this please refer to
the dedicated chapter on [event configuration](/event-queue/configure-event). If no events are processed please check
that at least one app has been initialized as event processor. For this check the chapter [setup](/event-queue/setup).

### InProgress

During processing of an event the associated status is `InProgress`. During that time events are not selected and
processed again. The assumption is that the processing of an event never takes longer than 30 minutes. After 30 minutes
the event is considered as "stuck" and will be processed again with the next processing of the event-queue. This will
increase the retry attempt counter of the event.

### Done

When an event has been processed successfully, its status changes to `Done`. This indicates that the event has been
handled and there's no need for further processing. This status is final and once an event reaches this status, it does
not get picked up again for processing.

### Error

An event is marked as `Error` when there's a problem during its processing. This could be due to a variety of reasons,
such as an exception being thrown or some other type of unexpected error. When an event is in the `Error` status,
it may be picked up again for reprocessing, depending on the event configuration.

### Exceeded

An event's status changes to `Exceeded` when it has failed to process successfully after a certain number of attempts.
This status is used to prevent the system from getting stuck in a loop trying to process an event that continually fails.
When an event's status is `Exceeded`, it typically requires manual intervention to resolve the issue causing the
processing failure. Once resolved, the event can be reset and reprocessed.
