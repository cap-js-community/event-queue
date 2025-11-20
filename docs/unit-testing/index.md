---
layout: default
title: Unit Testing
nav_order: 10
---

<!-- prettier-ignore-start -->

{: .no_toc}

# Unit Testing

- TOC
{: toc}
<!-- prettier-ignore-end -->

# Overview

This topic provides an overview of how to write unit tests for event processors and queued CAP services.

# Setup

The event-queue leverages CDS profiles to adjust the runtime behavior depending on the environment. For more
information regarding CDS profiles, please refer to
the [official CDS documentation](https://cap.cloud.sap/docs/node.js/cds-env#profiles).

The preconfigured profiles with their respective configurations are as follows:

```json
{
  "cds": {
    "eventQueue": {
      "[production]": {
        "disableRedis": false
      },
      "[test]": {
        "registerAsEventProcessor": false,
        "isEventQueueActive": false,
        "updatePeriodicEvents": false
      }
    }
  }
}
```

The `test` profile is used to disable the event-queue runner and to prevent the automatic processing of events. This is
to ensure that the event-queue does not process events during the execution of unit tests. However, the event-queue can
still be used to publish events and to process them manually. Alternatively, the profile values can be overridden in the
package.json of the project. For information on how to override the profile, please refer to the
[official CDS documentation](https://cap.cloud.sap/docs/node.js/cds-env#sources-for-cds-env).

The tests in the next section utilize the `cds.test`. The `cds.test` is a testing framework for CAP applications. For
more information regarding the `cds.test`, please refer to the [official CDS documentation](https://cap.cloud.sap/docs/node.js/cds-test).

# Testing the Publishing and Processing of Events

Published events are written to the database, which effectively decouples processes. Unit/Integration Testing greatly
benefits from this pattern. From a testing perspective, the processes can be tested in isolation. For instance, if
process A publishes an event to trigger process B, process A can expect if the correct event for triggering process B
with correct parameters was published.

## Testing if an Event was Correctly Published

Published events can be selected from the event database table (`sap.eventqueue.Event`). The following example
demonstrates how to test if an event was correctly published.

```javascript
const cds = require("@sap/cds");

it("should publish an event", async () => {
  // Act - triggerProcessA publish an event for process B
  await triggerProcessA();

  // Assert
  const tx = cds.tx({});
  const publishedEvents = await tx.run(SELECT.from("sap.eventqueue.Event"));
  await tx.rollback();
  expect(publishedEvents).toHaveLength(1);
  expect(publishedEvent[0]).toMatchObject({
    type: "task",
    subType: "processB",
    status: EventProcessingStatus.Open,
    payload: {
      key: "value",
    },
  });
});
```

## Testing the Processing of Events

Published events can be processed using the functionalities exposed by the event-queue. The example below demonstrates
how to test the processing of events.

```javascript
const cds = require("@sap/cds");
const { processEventQueue } = require("@cap-js-community/event-queue");

it("should process an event", async () => {
  // Arrange - triggerProcessA publishes an event for process B
  await triggerProcessA();

  // Act - process the event
  await processEventQueue({}, "task", "processB"); // parameters are cds context, type, and subType

  // Assert
  const tx = cds.tx({});
  const publishedEvents = await tx.run(SELECT.from("sap.eventqueue.Event"));
  await tx.rollback();
  expect(publishedEvents).toHaveLength(1);
  expect(publishedEvent[0]).toMatchObject({
    type: "task",
    subType: "processB",
    status: EventProcessingStatus.Done,
  });
});
```

# Testing CAP queued services

The event-queue can be used as a CDS Queue. The following examples demonstrates how to test the publishing of events
processing of queued CAP services as well as the processing of those events.

## Testing if an Event was Correctly Published

```javascript
const cds = require("@sap/cds");
const { processEventQueue } = require("@cap-js-community/event-queue");

it("should process an queued service", async () => {
  // Arrange connect to service and queue it
  const service = await cds.connect.to("NotificationService");
  const queuedService = cds.queued(service);

  // Act - call the queued service
  await queuedService.send("sendFiori", {
    to: "to",
    subject: "subject",
    body: "body",
  });

  // Assert
  tx = cds.tx({});
  const publishedEvents = await tx.run(SELECT.from("sap.eventqueue.Event"));
  await tx.rollback();
  expect(publishedEvent[0]).toMatchObject({
    type: "CAP_OUTBOX",
    subType: "NotificationService",
    status: EventProcessingStatus.Open,
  });
  expect(service).not.sendFioriActionCalled(); // this is pseudo code
});
```

## Testing the Processing of Events

```javascript
const cds = require("@sap/cds");
const { processEventQueue } = require("@cap-js-community/event-queue");

it("should process an queued service", async () => {
  // Arrange connect to service and queue it
  const service = await cds.connect.to("NotificationService");
  const queuedService = cds.queued(service);
  await queuedService.send("sendFiori", {
    to: "to",
    subject: "subject",
    body: "body",
  });

  // Act - process the event
  await processEventQueue({}, "CAP_OUTBOX", "NotificationService"); // parameters are cds context, type, and subType

  // Assert
  tx = cds.tx({});
  const publishedEvents = await tx.run(SELECT.from("sap.eventqueue.Event"));
  expect(publishedEvent[0]).toMatchObject({
    type: "CAP_OUTBOX",
    subType: "NotificationService",
    status: EventProcessingStatus.Done,
  });
  expect(service).sendFioriActionCalled(); // this is pseudo code
});
```
