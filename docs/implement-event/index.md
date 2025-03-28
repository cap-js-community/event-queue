---
layout: default
title: Legacy - Implement Event
nav_order: 12
---

<!-- prettier-ignore-start -->


{: .no_toc}

# Implement Event

<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

{% include warning.html message="
Before event-queue version 1.10.0, it was necessary to implement EventQueue classes to take full advantage of features
such as periodic events, clustering, hooks for exceeded events, and more. Since version 1.10.0, all these features are
also available for CAP services using [event-queue as an outbox](/event-queue/use-as-cap-outbox/). Therefore, it is strongly recommended to use CAP
services instead of EventQueue classes.
" %}

# Overview

Events are implemented through an event processor. Each processor must be a class that inherits from
the `EventQueueProcessorBase`.

# Basic Implementation

The most minimalist event implementation only redefines the `processEvent` method for ad-hoc events and
`processPeriodicEvent` for periodic events. The interfaces for processing ad-hoc and periodic events are slightly
different. Ad-hoc events have an additional `payload` parameter, which is the payload defined during the event's
publication.

| Argument       | Purpose                                                                                                                                                                                |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| processContext | CDS event context - this context is associated with a managed transaction.                                                                                                             |
| key            | Key used to identify the event-queue database entry                                                                                                                                    |
| queueEntries   | Array of event-queue entries. If no clustering has been implemented, the length is always 1. For further information about clustering events have a look [here](#clusterqueueentries). |
| payload        | The payload that was provided during the event's publication. This only applies to ad-hoc events.                                                                                      |

## Minimal implementation for ad-hoc events

The `processEvent` function is utilized to process the published ad-hoc events. It is designed to
return an array of tuples. Each tuple consists of the ID of the processed event entry and its respective status.
Under normal circumstances, the `queueEntries` parameter of the `processEvent` function is always an array with a length
of one.

However, this behavior can be altered by overriding the [clusterQueueEntries](#clusterqueueentries)
function in the base class `EventQueueProcessorBase`. This adjustment becomes beneficial when
there is a requirement to process multiple events simultaneously. In this scenario, multiple
queueEntries are provided to the `processEvent` function, which in turn must return a status for
each queueEntry.

Please note that each queueEntry can have a different status. If multiple events are processed in
one batch, the transaction handling gets more complex. The event-queue uses worst status aggregation.
Meaning in transaction mode `isolated` the transaction would be rolled back if one of the reported event status
is `error`.
This is described in detail in below [section](#example-if-multiple-events-are-clustered).

```js
"use strict";

const { EventQueueProcessorBase, EventProcessingStatus } = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
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

module.exports = EventQueueMinimalistic;
```

## Minimal implementation for periodic events

The `processPeriodicEvent` function is utilized to process periodic events. In comparison to ad-hoc events periodic
events
should not return a processing status. The process function for periodic events also does not get passed a payload for
processing.

```js
"use strict";

const { EventQueueProcessorBase } = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key, eventEntry) {
    try {
      await doHeavyProcessing(queueEntries, payload);
    } catch {
      this.logger.error("Error during processing periodic event!", err);
    }
  }
}

module.exports = EventQueueMinimalistic;
```

For periodic events there are no more class methods which can be overridden to customize any logic.

# Managed Transactions and CDS Context

During event processing, the library manages transaction handling. To gain a more comprehensive understanding of the
scenarios in which transactions are committed or rolled back, please refer to the dedicated chapter on
[transaction handling](/event-queue/transaction-handling).

# Advanced implementation

The following paragraph outlines the most common methods that can be overridden in the base class (
EventQueueProcessorBase).
For detailed descriptions of each function, please refer to the JSDoc documentation in the base class (
EventQueueProcessorBase).

## Ad-hoc events

### checkEventAndGeneratePayload

The function `checkEventAndGeneratePayload` is called for each event that will be processed. This function is used to
validate whether the event still needs to be processed and to fetch additional data that cannot be fetched in bulk
(for all events at once). The data retrieved in this function is typically used in the `clusterQueueEntries` function.
Mass-enabled data reading is possible in the `beforeProcessingEvents` function.

```js
"use strict";

const { EventQueueProcessorBase } = require("@cap-js-community/event-queue");

class EventQueueAdvanced extends EventQueueProcessorBase {
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

### clusterQueueEntries

The function `clusterQueueEntries` is designed to bundle the processing of multiple events into a single batch. This
approach means the `processEvent` method is invoked only once for all events that have been grouped or "clustered"
together.

This method is particularly beneficial in situations where multiple events of the same type have been published and need
to be
processed in a unified manner. For instance, if multiple email events have been published, you could use
`clusterQueueEntries` to send a single batch email to the user, instead of triggering multiple individual emails.

Here is an example of how to use the `clusterQueueEntries` function:

```js
clusterQueueEntries(queueEntriesWithPayloadMap);
{
  Object.entries(queueEntriesWithPayloadMap).forEach(([key, { queueEntry, payload }]) => {
    const clusterKey = payload.emailAddress;
    this.addEntryToProcessingMap(clusterKey, queueEntry, payload);
  });
}
```

However, it is important to note that when using this function, transaction handling can become more complex. See the
example [below](#example-if-multiple-events-are-clustered) for that.

#### Example if multiple events are clustered

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
been rolled back from the previous transaction. This could potentially lead to data inconsistencies, because the status
suggests that the events were processed successfully, but the business data associated with these events was not
committed due to the transaction rollback.

This scenario highlights the importance of careful error handling and status management in batch processing of events,
to
ensure data integrity and consistency.

### beforeProcessingEvents

This function, `beforeProcessingEvents`, is used to read data in bulk that is required for processing all selected
events. The key distinction between this and the `processEvent` function is that `beforeProcessingEvents` is invoked
only once with all events, rather than being called repeatedly for each cluster entry. To retrieve all clustered events,
you can use the getter function of `eventProcessingMap`. The example below demonstrates how to use this function.

```js
"use strict";

const { EventQueueProcessorBase } = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async beforeProcessingEvents() {
    this.__cache = await loadCache(this.eventProcessingMap);
  }
}

module.exports = EventQueueMinimalistic;
```

## Periodic events

Periodic events have a few functions that are designed to be overridden from the base class. The current design allows
for the `processPeriodicEvent` function only to be reimplemented. However, there's a specific function for periodic
events that retrieves the timestamp of the last successful run for an event within the given context.

### Using the Timestamp of the Last Successful Run for the Next Run

When dealing with periodic events, you may find it helpful to use the timestamp of the last successful run to choose the
next chunk or execute delta processing. To get this timestamp, the base class provides
the `getLastSuccessfulRunTimestamp`
function. If no successful run has occurred yet, the function will return null.

```js
"use strict";

const { EventQueueProcessorBase } = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueProcessorBase {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processPeriodicEvent(processContext, key, eventEntry) {
    try {
      const tsLastRun = await this.getLastSuccessfulRunTimestamp(); // 2023-12-07T09:15:44.237
      await doHeavyProcessing(queueEntries, payload);
    } catch {
      this.logger.error("Error during processing periodic event!", err);
    }
  }
}

module.exports = EventQueueMinimalistic;
```
