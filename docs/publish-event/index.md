---
layout: default
title: Publishing of Events
nav_order: 3
---

<!-- prettier-ignore-start -->

# Publishing of Events

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## How to

This function `publishEvent` offered by the package helps you to publish events in an efficient way. It not only
executes basic input validations, but also handles the insertion of the event data into the appropriate database table.

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

### Function Parameters

The `publishEvent` function takes two parameters:

1. `tx` - The transaction object to be used for database operations.
2. `events` - This can either be an array of event objects or a single event object.

Each event object should contain the following properties:

- `type` (String): Event type. This is a required field.
- `subType` (String): Event subtype. This is a required field.
- `referenceEntity` (String): Reference entity associated with the event.
- `referenceEntityKey` (UUID): UUID key of the reference entity.
- `status` (Status): Status of the event, defaults to 0.
- `payload` (LargeString): Payload of the event.
- `attempts` (Integer): The number of attempts made, defaults to 0.
- `lastAttemptTimestamp` (Timestamp): Timestamp of the last attempt.
- `createdAt` (Timestamp): Timestamp of event creation. This field is automatically set on insert.
- `startAfter` (Timestamp): Timestamp indicating when the event should start after.

### Error Handling

The function throws an `EventQueueError` in the following cases:

- If the configuration is not initialized.
- If the event type is unknown.
- If the `startAfter` field is not a valid date.

### Return Value

The function returns a `Promise` that resolves to the result of the database insert operation. This can be used to
handle any subsequent logic depending on the outcome of the event publishing operation.

## Delayed Events

Delayed events allow for scheduling events to be processed at a future time. This is especially useful when there are
tasks or events that need to be triggered at a specific time in the future.

The `publishEvent` function supports delayed events through the `startAfter` field in the event object. If
the `startAfter` field contains a timestamp that is in the future, the event will be scheduled for that future time.

```js
await publishEvent(tx, {
  type: "Notifications",
  subType: "Tasks",
  startAfter: new Date("2022-12-31T12:00:00"), // Future timestamp
  payload: JSON.stringify({
    recipients: ["alice@wonder.land"],
  }),
});
```

The `startAfter` field is optional. If it is not provided or if it contains a past or current timestamp, the event will
be processed immediately. If it contains a future timestamp, the event will be stored in the database but will not be
processed until the specified time.

Please note that the actual time of publishing may vary slightly due to the processing interval and the load on the
server. The event will be processed as soon as possible after the `startAfter` time.

## Processing of events after publish

The processing of events relies on various configurations. Events are directly processed after publishing if
the `processEventsAfterPublish` parameter is set to `true` during the initialization of the event queue. If this
parameter is set to `false`, the event is processed at the next regular interval for processing events. However, in the
case of automatic processing, the way of processing depends on whether Redis is available and enabled.

### Redis

If Redis is available and enabled, the event is broadcasted to all available app instances which are registered
as `registerAsEventProcessor` during initialization of the event queue. This enables automatic load balancing across all
app instances.

### DB

In this case, the event is processed directly in the app instance in which the event has been published.
