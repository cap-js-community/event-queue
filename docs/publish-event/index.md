---
layout: default
title: Legacy - Publishing of Events
nav_order: 11
---

<!-- prettier-ignore-start -->


# Publishing of Events
{: .no_toc}
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
# Ad-hoc events

This function `publishEvent` offered by the package helps you to publish events in an efficient way.
Basic input validations are executed and handling the insertion of the event data into the appropriate database table is done.

```js
"use strict";

const { publishEvent } = require("@cap-js-community/event-queue");

await publishEvent(tx, {
  type: "Notifications",
  subType: "Tasks",
  payload: JSON.stringify({
    recipients: ["alice@wonder.land"],
  }),
});
```

## Function Parameters

The `publishEvent` function takes two parameters:

1. `tx` - The transaction object to be used for database operations.
2. `events` - Either an array of event objects or a single instance of an event object.

Each event object should contain the following properties:

- `type` (String) [Required]: Event type
- `subType` (String) [Required]: Event subtype
- `referenceEntity` (String): Reference entity associated with the event
- `referenceEntityKey` (UUID): UUID key of the reference entity
- `status` (Status): Status of the event, defaults to 0
- `payload` (String) [Required]: Event payload

## Error Handling

The function throws an `EventQueueError` in the following cases:

- The configuration is not initialized
- The event type is unknown
- The `startAfter` field is not a valid date

## Return Value

The function returns a `Promise` that resolves to the result of the database insert operation. This can be used to
handle any subsequent logic depending on the outcome of the event publishing operation.

# Delayed Events

Delayed events allow for scheduling events to be processed at a future time. This is especially useful when there are
tasks or events that need to be triggered at a specific time in the future.

The `publishEvent` function supports delayed events through the `startAfter` field in the event object. If
the `startAfter` field contains a timestamp that is in the future, the event will be scheduled for that future time.

```js
await publishEvent(tx, {
  type: "Notifications",
  subType: "Tasks",
  startAfter: new Date("2023-12-31T12:00:00"), // Future timestamp
  payload: JSON.stringify({
    recipients: ["alice@wonder.land"],
  }),
});
```

The `startAfter` field is optional. If it is not provided or if it contains a past/current timestamp, the event will
be processed immediately. If it contains a future timestamp, the event will be stored in the database, but will not be
processed until the specified time.

Please note that the actual time of publishing may vary slightly due to the processing interval and the load on the
server. The event will be processed as soon as possible after the `startAfter` time.

# Periodic Events

Periodic events must not published manually and are rejected by the `publishEvent` function. Updating and keeping track
of new periodic events happens automatically during server start. The events are derived from the `config.yml`.

# Processing of events after publish

The processing of events relies on various configurations. Events are directly processed after publishing if
the [processEventsAfterPublish](/event-queue/setup/#initialization-parameters) parameter is set to `true` during the
initialization of the event queue. If this parameter is set to `false`, the event is processed at the next regular
interval for processing events. However, in the case of automatic processing, the way of processing depends on whether
Redis is available and enabled.

## Redis

If Redis is available and enabled, the event is broadcasted to all available app instances which are registered
as [registerAsEventProcessor](/event-queue/setup/#initialization-parameters) during initialization of the event queue.
This enables automatic load balancing across all app instances.

## DB

In this case, the event is processed directly in the app instance, in which the event has been published.
