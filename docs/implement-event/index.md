---
layout: default
title: Implement Event
nav_order: 7
---

<!-- prettier-ignore-start -->
# Implement Event
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

# Overview

Events are implemented through an Event Processor. Each Event Processor must be a class that inherits from the 
EventQueueProcessorBase.

# Basic Implementation

The most minimalist event implementation only redefines the `processEvent` method for ad-hoc events, and 
`processPeriodicEvent` for periodic events. The interfaces for processing ad-hoc and periodic events are slightly 
different. Ad-hoc events have an additional `payload` parameter, which is the payload defined during the event's 
publication.

| Argument       | Purpose                                                                                                                                                                                            |
|:---------------|:---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| processContext | CDS event context - this context is associated with a managed transaction.                                                                                                                         |
| key            | Key used to identify the event-queue database entry                                                                                                                                                |
| queueEntries   | Array of event-queue entries. If no clustering has been implemented, the length is always 1. How to implement clustering events refer to [here](#clusterqueueentries). |
| payload        | The payload that was provided during the event's publication. This only applies to ad-hoc events.                                                                                                  |

## Minimal implementation for ad-hoc events

The `processEvent` function is utilized to process the published ad-hoc events. It is designed to
return an array of tuples, each tuple consisting of the ID of the processed eventEntry and its
respective status. Under normal circumstances, the eventEntries parameter of the `processEvent`
function is always an array with a length of one.

However, this behavior can be altered by overriding the [clusterQueueEntries](#clusterqueueentries)
function in the base class `EventQueueProcessorBase`. This adjustment becomes beneficial when
there's a requirement to process multiple events simultaneously. In these scenarios, multiple
queueEntries are provided to the `processEvent` function, which in turn must return a status for
each queueEntry.

Please note that each queueEntry can have a different status. If multiple events are processed in
one batch the transaction handling gets more complex. The event-queue uses worst status
aggregation, meaning in transaction mode `isolated` the transaction would be rolled back if one
reported event status is `error`. This is described in detail in [below](#example-if-multiple-events-are-clustered).

```js
"use strict";

const { EventQueueBaseClass, EventProcessingStatus } = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processEvent(processContext, key, eventEntries, payload) {
    let eventStatus = EventProcessingStatus.Done;
    try {
      await doHeavyProcessing(queueEntries, payload);
    } catch {
      eventStatus = EventProcessingStatus.Error;
    }
    return eventEntries.map((eventEntry) => [eventEntry.ID, eventStatus]);
  }
}

module.exports = EventQueueMinimalistic;
```

# Managed Transactions and CDS Context

During event processing, the library manages transaction handling. To gain a more comprehensive understanding of the 
scenarios in which transactions are committed or rolled back, please refer to the dedicated chapter on 
[transaction handling](/event-queue/transaction-handling).

# Advanced implementation

The following paragraph outlines the most common methods that can be overridden in the base class
(EventQueueProcessorBase). For detailed descriptions of each function, please refer to the JSDoc documentation in
the base class (EventQueueProcessorBase).

## checkEventAndGeneratePayload

The function "checkEventAndGeneratePayload" is called for each event that will be processed. This function is used to
validate whether the event still needs to be processed and to fetch additional data that cannot be fetched in bulk
(for all events at once). The data retrieved in this function is typically used in the "clusterQueueEntries" function.
Mass-enabled data reading is possible in the "beforeProcessingEvents" function.

```js
"use strict";

const { EventQueueBaseClass } = require("@cap-js-community/event-queue");

class EventQueueAdvanced extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async checkEventAndGeneratePayload(queueEntry) {
    // dummy function
    const eventStillValid = await checkEventIsStillValid(this.tx, queueEntry.payload);
    if (!eventStillValid) {
      this.logger.info("Event not valid anymore, skipping processing", {
        eventType: this.eventType,
        eventSubType: this.eventSubType,
        queueEntryId: queueEntry.ID,
      });
      return null;
    }
    return queueEntry;
  }
}

module.exports = EventQueueAdvanced;
```

## clusterQueueEntries

The function `clusterQueueEntries` is designed to bundle the processing of multiple events into a single batch. This
approach means the `processEvent` method is invoked only once for all events that have been grouped or "clustered" together.

This method is particularly beneficial in situations where multiple events of the same type have been published and need to be
processed in a unified manner. For instance, if multiple email events have been published, you could use
`clusterQueueEntries` to send a single batch email to the user, instead of triggering multiple individual emails.

Here is an example of how to use the `clusterQueueEntries` function:

```js
clusterQueueEntries(queueEntriesWithPayloadMap) {
    Object.entries(queueEntriesWithPayloadMap).forEach(([key, { queueEntry, payload }]) => {
        const clusterKey = payload.emailAddress;
        this.addEntryToProcessingMap(clusterKey, queueEntry, payload);
    });
}
```

However, it is important to note that when using this function, transaction handling can become more complex. See the
example [below](#example-if-multiple-events-are-clustered) for that.


### Example if multiple events are clustered

Given the following example where `processEvent` is processing three events: A, B, and C.
- Event A is processed successfully and returns a status of `done`.
- Event B is also processed successfully and returns a status of `done`.
- Event C encounters an error during processing and returns a status of `error`.

In this case, due to the worst status aggregation, the overall status of the batch processing would be considered as
`error` because one of the events (Event C) reported an error.

So, even though Events A and B were processed successfully, the overall transaction would be rolled back due to the
error in Event C. However, the statuses of all three events (A, B, and C) would be committed. That means the statuses of
Events A and B would be `done` and the status of Event C would be `error`.

This leads to the following situation: If the processing of these events is attempted again, Events A and B would
not be processed again because their status is `done`. But the business data associated with these events would have 
been rolled back from the previous transaction. This could potentially lead to data inconsistencies because the status
suggests that the events were processed successfully, but the business data associated with these events was not
committed due to the transaction rollback.

This scenario highlights the importance of careful error handling and status management in batch processing of events to
ensure data integrity and consistency.
