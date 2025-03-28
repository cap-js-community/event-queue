---
layout: default
title: Event Status Handling
nav_order: 9
---

<!-- prettier-ignore-start -->

# Event Status Handling

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

# Overview

This page describes the status handling of the event-queue. The status represents the current state of an event.
The available status values are listed in the table below.

| EventProcessingStatus | Value | Description                                                |
| --------------------- | ----- | ---------------------------------------------------------- |
| Open                  | 0     | The event has been created and is waiting to be processed. |
| InProgress            | 1     | The event is currently being processed.                    |
| Done                  | 2     | The event has been processed successfully.                 |
| Error                 | 3     | An error occurred while processing the event.              |
| Exceeded              | 4     | The event exceeded the maximum processing attempts.        |
| Suspended             | 5     | The event is suspended for processing.                     |

## Open

Events are generally processed with a very short delay after the transaction in which the event was written is
committed.
This may differ if the event is configured not to run directly after the event data is committed. For more information,
please refer to the dedicated chapter on [event configuration](/event-queue/configure-event).

If no events are processed, please ensure that at least one app has been initialized as an event processor. For more
information, check the chapter [setup](/event-queue/setup).

## InProgress

During the processing of an event, the associated status is `InProgress`. Events are not selected and processed again
during this time. The system assumes that processing an event never takes longer than 30 minutes. If processing exceeds
30 minutes, the event is considered "stuck" and will be processed again with the next processing of the event-queue,
increasing the retry attempt counter of the event.

## Done

When an event has been processed successfully, its status changes to `Done`. This indicates that the event has been
handled, and there's no need for further processing. This status is final. Once an event reaches this status, it does
not get picked up again for processing.

## Error

An event is marked as `Error` if a problem arises during its processing. This could be due to a variety of reasons,
such as an exception being thrown or some other type of unexpected error. When an event is in the `Error` status, it
may be picked up again for reprocessing, depending on the event configuration.

## Exceeded

An event's status changes to `Exceeded` when it fails to process successfully after a certain number of attempts.
This status is used to prevent the system from getting stuck in a loop trying to process an event that continually
fails.
When an event's status is `Exceeded`, it typically requires manual intervention to resolve the issue causing the
processing failure. Once resolved, the event can be reset and reprocessed.

## Suspended

The `Suspended` status indicates an event is temporarily on hold and excluded from processing. This can be set manually
or programmatically.

### Key Points

- **No Processing:** Suspended events are skipped in the processing cycle and do not increment retry counters.
- **Resumption:** Events can be resumed by updating their status to `Open`.
- **Use Cases:** Useful for aligning with dependencies, issue resolution, or administrative control.

Suspending events ensures flexibility in managing workflows without removing events from the queue.
