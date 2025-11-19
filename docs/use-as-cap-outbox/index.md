---
layout: default
title: CAP Queue
nav_order: 5
---

<!-- prettier-ignore-start -->

{: .no_toc}

# CAP Queue

<!-- prettier-ignore -->

- TOC
{: toc}

<!-- prettier-ignore-end -->

The event-queue can be used to replace the CAP queue solution to achieve a unified and streamlined architecture for
asynchronous processing. If this feature is activated, the event-queue replaces the queue implementation of CAP with
its own implementation during the bootstrap process. This allows leveraging the features of the event-queue, such as
transaction modes, load balancing, and others, with queued CDS services.

## How to enable the event-queue as queue mechanism for CAP

The initialization parameter `useAsCAPQueue` enables the event-queue to act as a CAP queue. To set this parameter,
refer to the [setup](/event-queue/setup/#initialization-parameters) part of the documentation. This is the only
configuration needed to enable the event-queue as a CAP queue.

```json
{
  "cds": {
    "eventQueue": { "useAsCAPQueue": true }
  }
}
```

## How to Configure a Queued Service

Services can be queued without any additional configuration. In this scenario, the service is queued using the
default parameters of the CAP queue and the event-queue. Currently, the CAP queue implementation supports the
following parameters, which are mapped to the corresponding configuration parameters of the event-queue:

| CAP queue  | event-queue             | CAP default       |
| ----------- | ----------------------- | ----------------- |
| chunkSize   | selectMaxChunkSize      | 100               |
| maxAttempts | retryAttempts           | 20                |
| parallel    | parallelEventProcessing | yes (mapped to 5) |
| -           | useEventQueueUser       | false             |

The `parallel` parameter is treated specially. The CAP queue supports `true` or `false` as values for this parameter.
Since the event-queue allows specifying concurrency with a number, `parallel=true` is mapped
to `parallelEventProcessing=5`, and `parallel=false` is mapped to `parallelEventProcessing=1`. For full flexibility, the
configuration prioritizes the `parallelEventProcessing` parameter over `parallel`.

The `useEventQueueUser` parameter can be set to true or false. When set to true, the user defined in the [general
configuration](/event-queue/setup/#initialization-parameters) will be used as the cds context user (context.user.id).
This influences actions such as updating managed
database fields like modifiedBy. The default value for this parameter is false.

All supported parameters available for [EventQueueProcessors](/event-queue/configure-event/#parameters) are also
available for CAP queued services. This means
that you can use the same configuration settings and options that you would use with EventQueueProcessors when
configuring CAP queued services, ensuring consistent behavior and flexibility across both use cases.

Parameters are managed via the `cds.require` section, not through the config yml file as with other events. For details
on maintaining the `cds.requires` section, refer to
the [CAP documentation](https://cap.cloud.sap/docs/node.js/core-services#required-services). Below is an example of
using the event-queue to queue the `@cap-js/audit-logging` service:

```json
{
  "cds": {
    "requires": {
      "audit-log": {
        "queued": {
          "kind": "persistent-queue",
          "transactionMode": "alwaysRollback",
          "maxAttempts": 5,
          "checkForNextChunk": false,
          "parallelEventProcessing": 5
        }
      }
    }
  }
}
```

The parameters in the queued section of a service are passed as configuration to the event-queue.
The `persistent-queue` kind allows the event-queue to persist events instead of executing them in memory, mirroring the
behavior of the [CAP queue](https://cap.cloud.sap/docs/node.js/queue). The parameters `transactionMode`,
`checkForNextChunk`, and `parallelEventProcessing` are
exclusive to the event-queue.

### Periodic Actions/Events in Queued Services

The event-queue supports to periodically schedule actions of a CAP service based on a cron expression or defined
interval.
Every event/action in CAP Service can have a different periodicity. The periodicity is defined in the `queued` section
of the service configuration. In the example below the `syncTasks` action is scheduled every 15 minutes and the
`masterDataSync`
action is scheduled every day at 3:00 AM.

```json
{
  "my-service": {
    "queued": {
      "kind": "persistent-queue",
      "events": {
        "syncTasks": { "cron": "*/15 * * * *" },
        "masterDataSync": { "cron": "0 3 * * *" }
      }
    }
  }
}
```

### Configure certain actions differently in the same CAP Service

It is possible to configure different actions in the same CAP service differently. In the example below, all actions in
the service are configured with a `maxAttempts` of 1, except for the `importantTask` action, which is configured with a
`maxAttempts` of 20. Based on this logic all configuration parameters can be set differently but having a reasonable
default configuration for the service.

```json
{
  "my-service": {
    "queued": {
      "kind": "persistent-queue",
      "maxAttempts": 1,
      "events": { "importantTask": { "maxAttempts": 20 } }
    }
  }
}
```

## Example of a Custom Queued Service

### Internal Service with `cds.Service`

The implementation below demonstrates a basic `cds.Service` that can be queued. If you want to configure queuing
via `cds.env.requires`, the service needs to inherit from `cds.Service`.

```js
const cds = require("@sap/cds");

module.exports = class TaskService extends cds.Service {
  async init() {
    await super.init();
    this.on("process", async function (req) {
      // add your code here
    });
  }
};
```

Queueing can be enabled via configuration using `cds.env.requires`, for example, through `package.json`.

```json
{
  "cds": {
    "requires": {
      "task-service": {
        "impl": "./srv/PATH_SERVICE/taskService.js",
        "queued": {
          "kind": "persistent-queue",
          "transactionMode": "alwaysRollback",
          "maxAttempts": 5,
          "parallelEventProcessing": 5
        }
      }
    }
  }
}
```

### Application Service with `cds.ApplicationService`

In contrast, `cds.ApplicationService`, which is served based on protocols like odata-v4, cannot be queued via
configuration (`cds.env.requires`). Nevertheless, queuing can be performed manually as shown in the example below:

```js
const service = await cds.connect.to("task-service");
const queuedService = cds.queued(service, {
  kind: "persistent-queue",
  transactionMode: "alwaysRollback",
});
await queuedService.send("process", {
  ID: 1,
  comment: "done",
});
```

## How to cluster multiple queue events

This functionality allows multiple service calls to be processed in a single batch, reducing redundant executions.
Instead of invoking a service action separately for each event, clustering groups similar events together and processes
them in one call.

This approach is particularly useful when multiple events trigger the same action. For example, if an action is
responsible for sending emails, clustering can combine all relevant events into a single email. See the example below
for implementation in a CAP service:

```js
this.on("eventQueueCluster", (req) => {
  return req.eventQueue.clusterByDataProperty("to", (clusterKey, clusterEntries) => {
    // clusterKey is the value of the property "req.data.to"
    // clusterEntries is an array of all entries with the same "req.data.to" value
    return { recipients: clusterKey, mails: clusterEntries };
  });
});
```

If different actions require different clustering logic, you can define action-specific clustering. The following
example clusters only the sendMail action:

```js
this.on("eventQueueCluster.sendMail", (req) => {
  return req.eventQueue.clusterByDataProperty("to", (clusterKey, clusterEntries) => {
    // clusterKey is the value of the property "req.data.to"
    // clusterEntries is an array of all entries with the same "req.data.to" value
    return { recipients: clusterKey, mails: clusterEntries };
  });
});
```

The event-queue provides three basic clustering helper functions:

- **`clusterByDataProperty`**: Clusters events based on a specific `req.data` property from the original action call.
- **`clusterByPayloadProperty`**: Clusters events based on properties from the raw action call payload, such as `req.event`,
  `contextUser`, `headers`, and more. This can be used, for example, to group all calls of the same action into a single
  batch. To achieve this, pass `"event"` as the first parameter to this function.
- **`clusterByEventProperty`**: Clusters events based on raw event data, which corresponds to the event database entry.
  This allows grouping by fields such as `referenceEntityKey`, `attempts`, `status`, and more.

Event-queue follows a priority order when applying clustering:

1. It first checks for an action-specific implementation (e.g., `eventQueueCluster.sendMail`).
2. If none is found, it falls back to the general implementation (`eventQueueCluster`).
3. If neither is implemented, no clustering is performed.

## Register hook for exceeded events retries

Event-queue provides a hook that allows you to register a function to be called when an event exceeds the maximum number
of retry attempts. This hook enables you to implement custom logic within a managed transaction.

If the hook is triggered, the failed service call gets up to three additional retry attempts. Regardless of the outcome,
the event will ultimately be marked as `Exceeded`. The exceeded hook can be registered for the entire service or for
specific actions, following the same approach as `eventQueueCluster`. See the example below a generic exceeded hook
and an action-specific exceeded hook:

```js
this.on("eventQueueRetriesExceeded", (req) => {
  // provides a manage transaction
});

this.on("eventQueueRetriesExceeded.sendMail", (req) => {
  // provides a manage transaction
});
```

## How to Delay Queued Service Calls

The event queue has a feature that enables the publication of delayed events. This feature is also applicable to CAP
queued services.

To implement this feature, include the `x-eventqueue-startAfter` header attribute during the send or emit process.

```js
const queuedService = await cds.connect.to("task-service");
await queuedService.send(
  "process",
  {
    ID: 1,
    comment: "done",
  },
  // delay the processing 4 minutes
  { "x-eventqueue-startAfter": new Date(Date.now() + 4 * 60 * 1000).toISOString() }
);
```

## Additional parameters Queued Service Calls

Similar to delaying published events, it is also possible to provide other parameters when publishing events. All event
publication properties can be found [here](/event-queue/publish-event/#function-parameters).

## Error Handling in a Custom Queued Service

If the custom service is invoked via `service.send()`, errors can be raised with `req.reject()` and `req.error()`.
The `reject` and `error` functions cannot be used if the service call is made via `service.emit()`. Refer to the example
below for an implementation reference.

```js
class TaskService extends cds.Service {
  async init() {
    await super.init();
    this.on("rejectEvent", (req) => {
      req.reject(404, "error occured");
    });

    this.on("errorEvent", (req) => {
      req.error(404, "error occured");
    });
  }
}
```

Errors raised in a custom queued service are thrown and will be logged from the event queue. The event entry will be
marked as an error and will be retried based on the event configuration.

## Event-Queue properties

The event queue properties that are available for the native event queue processor (refer
to [this documentation](/event-queue/implement-event/#minimal-implementation-for-ad-hoc-events)) are
also accessible for queued services utilizing the event queue. These properties can be accessed via the cds request.
The following properties are available:

- processor: instance of event-queue processor
- key
- queueEntries
- payload

```js
class TaskService extends cds.Service {
  async init() {
    await super.init();
    this.on("send", (req) => {
      const { processor, queueEntries, payload, key } = req.eventQueue;
    });
  }
}
```

## How to return a custom status?

It's possible to return a custom status for an event. The allowed status values are
explained [here](/event-queue/status-handling/).

```js
this.on("returnPlainStatus", (req) => {
  return EventProcessingStatus.Done;
});
```
