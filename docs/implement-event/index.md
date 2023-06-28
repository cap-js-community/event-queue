---
layout: default
title: Implement Event
nav_order: 4
---

<!-- prettier-ignore-start -->

# Implement Event

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->

- TOC
  {: toc}

## Overview

Events implement an Event-Processor. Every Event-Processor needs to be a class that is inherits from
EventQueueProcessorBase.

## Basic Implementation

The most minimalist Event Implementation only redefines the `processEvent` method. This method receives as arguments the
following:

| Argument       | Purpose                                                                                     | 
|:---------------|:--------------------------------------------------------------------------------------------|
| processContext | cds event context - this context is associated with a managed transaction.                  |
| key            | key to identify the event-queue db entry                                                    |
| queueEntries   | Array of event-queue entries. If no clustering has been implemented the length is always 1. |
| payload        | The payload that has been provided during publishing the event. The payload can be mo       |

### Minimal implementation:

The `processEvent` function must return an array of tuples containing the ID of the processed eventEntry and its
corresponding status. In this particular scenario, the eventEntries parameter of the `processEvent` function is always
an array with a length of 1. However, this behavior can be modified by overriding the `clusterQueueEntries` function in
the base class `EventQueueProcessorBase`. This becomes useful when there is a need to process multiple events together.
In such cases, multiple queueEntries are provided to the `processEvent` function, and it is required to return a status
for each queueEntry. Each queueEntry may have a different status.

```js
"use strict";

const {EventQueueBaseClass, EventProcessingStatus} = require("@cap-js-community/event-queue");

class EventQueueMinimalistic extends EventQueueBaseClass {
    constructor(context, eventType, eventSubType, config) {
        super(context, eventType, eventSubType, config);
    }

    async processEvent(processContext, key, eventEntries, payload) {
        let eventStatus = EventProcessingStatus.Done;
        try {
            await doHeavyProcessingStuff(queueEntries, payload);
        } catch {
            eventStatus = EventProcessingStatus.Error;
        }
        return eventEntries.map((eventEntry) => [eventEntry.ID, eventStatus]);
    }
}

module.exports = EventQueueMinimalistic;
```

## Managed Transactions and CDS Context

tt

## Advanced implementation

The following paragraph outlines the most common methods that can be overridden in the base class (
EventQueueProcessorBase). For detailed descriptions of each function, please refer to the JSDoc documentation in the
base class (EventQueueProcessorBase).

### checkEventAndGeneratePayload

The function "checkEventAndGeneratePayload" is called for each event that will be processed. This function is used to
validate whether the event still needs to be processed and to fetch additional data that cannot be fetched in bulk (for
all events at once). The data retrieved in this function is typically used in the "clusterQueueEntries" function.
Mass-enabled data reading is possible in the "beforeProcessingEvents" function.

```js
"use strict";

const {EventQueueBaseClass} = require("@cap-js-community/event-queue");

class EventQueueAdvanced extends EventQueueBaseClass {
    constructor(context, eventType, eventSubType, config) {
        super(context, eventType, eventSubType, config);
    }

    async checkEventAndGeneratePayload(queueEntry) {
        const eventStillValid = await checkEventIsStillValid(this.tx, queueEntry.payload);
        if (!eventStillValid) {
            this.logger.info("Event not valid anymore, skipping processing", {
                eventType: this.__eventType,
                eventSubType: this.__eventSubType,
                queueEntryId: queueEntry.ID,
            });
            return null;
        }
        return queueEntry;
    }
}

module.exports = EventQueueAdvanced;
```