---
layout: default
title: Use as CAP Outbox
nav_order: 5
---

<!-- prettier-ignore-start -->

{: .no_toc}

# Use as CAP Outbox

<!-- prettier-ignore -->
- TOC
{: toc}
<!-- prettier-ignore-end -->

The event-queue can be used to replace the CAP outbox solution to achieve a unified and streamlined architecture for
asynchronous processing. If this feature is activated, the event-queue replaces the outbox implementation of CAP with
its own implementation during the bootstrap process. This allows leveraging the features of the event-queue, such as
transaction modes, load balancing, and others, with outboxed CDS services.

# How to enable the event-queue as outbox mechanism for CAP

The initialization parameter `useAsCAPOutbox` enables the event-queue to act as a CAP outbox. To set this parameter,
refer to the [setup](/event-queue/setup/#initialization-parameters) part of the documentation. This is the only
configuration needed to enable the event-queue as a CAP outbox.

# How to Configure an Outboxed Service

Services can be outboxed without any additional configuration. In this scenario, the service is outboxed using the
default parameters of the CAP outbox and the event-queue. Currently, the CAP outbox implementation supports the
following parameters, which are mapped to the corresponding configuration parameters of the event-queue:

| CAP outbox  | event-queue             |
| ----------- | ----------------------- |
| chunkSize   | selectMaxChunkSize      |
| maxAttempts | retryAttempts           |
| parallel    | parallelEventProcessing |

The `parallel` parameter is treated specially. The CAP outbox supports `true` or `false` as values for this parameter.
Since the event-queue allows specifying concurrency with a number, `parallel=true` is mapped
to `parallelEventProcessing=5`, and `parallel=false` is mapped to `parallelEventProcessing=1`. For full flexibility, the
configuration prioritizes the `parallelEventProcessing` parameter over `parallel`.

Parameters are managed via the `cds.require` section, not through the config yml file as with other events. For details
on maintaining the `cds.requires` section, refer to
the [CAP documentation](https://cap.cloud.sap/docs/node.js/core-services#required-services). Below is an example of
using the event-queue to outbox the `@cap-js/audit-logging` service:

```json
{
  "cds": {
    "requires": {
      "audit-log": {
        "outbox": {
          "kind": "persistent-outbox",
          "transactionMode": "alwaysRollback",
          "maxAttempts": 5,
          "checkForNextChunk": true,
          "parallelEventProcessing": 5
        }
      }
    }
  }
}
```

The parameters in the outbox section of a service are passed as configuration to the event-queue.
The `persistent-outbox` kind allows the event-queue to persist events instead of executing them in memory, mirroring the
behavior of the [CAP outbox](https://cap.cloud.sap/docs/node.js/outbox). The
parameters `transactionMode`, `checkForNextChunk`, and `parallelEventProcessing` are
exclusive to the event-queue.
