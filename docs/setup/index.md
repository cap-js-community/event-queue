---
layout: default
title: Getting started
nav_order: 3
---

<!-- prettier-ignore-start -->


{: .no_toc}

# Setup

<!-- prettier-ignore -->

- TOC
{: toc}

<!-- prettier-ignore-end -->

# Ways of Initialization

- Run `npm add @cap-js-community/event-queue` in `@sap/cds` project
- Initialize the event queue as CAP-Plugin or manually in your server.js

## Using CDS Outbox with config.yaml

The simplest way to utilize the event-queue is by allowing it to manage the CDS outbox and outbox services via the
outbox method in conjunction with the event-queue. To accomplish this, the event-queue needs to be set up as a CDS
outbox. Refer to the following guides
on [how to configure the event-queue](/event-queue/use-as-cap-outbox/#how-to-enable-the-event-queue-as-outbox-mechanism-for-cap)
and [how to implement a CDS service](/event-queue/use-as-cap-outbox/#example-of-a-custom-outboxed-service)..

## As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
[cds-plugin concept](https://cap.cloud.sap/docs/node.js/cds-plugins).

```json
{
  "cds": {
    "eventQueue": {
      "configFilePath": "./srv/eventQueueConfig.yml"
    }
  }
}
```

## in server.js

Call the initialize function in your server.js. Check here the available settings for the initialization.

```js
eventQueue.initialize({
    configFilePath: "./srv/eventConfig.yml",
});
```

# Initialization parameters

The table below lists the initialization parameters that can be used to configure how the event-queue operates.
These parameters allow you to customize various aspects of the event processing,
such as the configuration file path, event processing behavior, load balancing, and more.
The table includes the parameter name, a description of its purpose, and the default value if not specified.

| Name                                 | Description                                                                                                                                                                                                                                                                                                                                      | Default        | Can be changed at runtime |
|:-------------------------------------|:-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:---------------|:--------------------------|
| configFilePath                       | Path to the configuration file.                                                                                                                                                                                                                                                                                                                  | null           | no                        |
| registerAsEventProcessor             | Whether or not to register as an event processor. If false, the app can publish events but doesn't process events.                                                                                                                                                                                                                               | true           | no                        |
| processEventsAfterPublish            | Whether or not to process events immediately after publish. Events are distributed via Redis to all available app instances.                                                                                                                                                                                                                     | true           | no                        |
| isEventQueueActive                   | Determines if the event queue is active. This property controls whether events are automatically processed. It can be modified in real-time to temporarily disable periodic runs.                                                                                                                                                                | true           | yes                       |
| runInterval [ms]                     | The interval in milliseconds at which the runner runs.                                                                                                                                                                                                                                                                                           | 25 _ 60 _ 1000 | yes                       |
| disableRedis                         | Whether or not to disable Redis.                                                                                                                                                                                                                                                                                                                 | false          | no                        |
| updatePeriodicEvents                 | Whether or not to update periodic events.                                                                                                                                                                                                                                                                                                        | true           | no                        |
| thresholdLoggingEventProcessing [ms] | Threshold after how many milliseconds the processing of a event or periodic event is logged for observability.                                                                                                                                                                                                                                   | 50             | yes                       |
| useAsCAPOutbox                       | Uses the event-queue as the [outbox](https://cap.cloud.sap/docs/node.js/outbox) of CAP. Outbox called are stored and processed in the event-queue instead of the outbox of CAP.                                                                                                                                                                  | false          | no                        |
| userId                               | User id for all created cds contexts. This influences the value for updated managed database fields like createdBy and modifiedBy.                                                                                                                                                                                                               | false          | yes                       |
| cleanupLocksAndEventsForDev          | Deletes all semantic locks and sets all events that are in progress to error during server start. This is used to clean up leftovers from server crashes or restarts during processing.                                                                                                                                                          | false          | no                        |
| redisOptions                         | The option is provided to customize settings when creating Redis clients. The object is spread at the root level for creating a client and within the `default` options for cluster clients.                                                                                                                                                     | {}             | no                        |
| insertEventsBeforeCommit             | If enabled, this feature allows events (including those for outboxed services) to be inserted in bulk using the before commit handler. This is performed to improve performance by mass inserting events instead of single insert operations. This can be disabled by the parameter `skipInsertEventsBeforeCommit` in the function publishEvent. | false          | yes                       |
| enableCAPTelemetry                   | If enabled in combination with `cap-js/telemetry`, OpenTelemetry traces about all event-queue activities are written using the `cap-js/telemetry` tracer.                                                                                                                                                                                        | false          | yes                       |
| cronTimezone                         | Determines whether to apply the central `cronTimezone` setting for scheduling events. If set to `true`, the event will use the defined `cronTimezone`. If set to `false`, the event will use UTC or the server's local time, based on the `utc` setting.                                                                                         | null           | yes                       |
| publishEventBlockList                | Determines whether the publication of events to all app instances is enabled when Redis is active. If set to true, events can be published; if set to false, the publication is disabled.                                                                                                                                                        | true           | yes                       |
| crashOnRedisUnavailable              | If enabled, the application will crash if Redis is unavailable during the connection check.                                                                                                                                                                                                                                                      | false          | false                     |

# Configure Redis

To take advantage of the event-queue capabilities that come with Redis, you simply need to bind a Redis instance to the
app where the event-queue will be used. No additional steps are required. Please note that the event-queue supports both
single and cluster Redis instances.

## Connecting to a Remote Instance via SSH Tunnel

The `event-queue` module supports connecting to a remote Redis instance for hybrid testing with CAP. This feature is
limited to non-cluster Redis instances. The following steps assume that a Redis instance has already been created in
your BTP subaccount. To establish the connection, perform the steps below:

### Step 1: Make Credentials Available for Local Testing

Ensure the credentials are accessible for local testing, for example,
using [hybrid testing](https://cap.cloud.sap/docs/advanced/hybrid-testing) as provided by CAP.

```cmd
cds bind <name_of_your_choice> --to <cf_redis_service_name>
```

### Step 2: Extract the Redis Host and Port from the Service Binding

To set up the SSH tunnel in the next step, retrieve the hostname and port of the Redis instance from the service
binding.

```cmd
cds bind --exec -- node -e 'console.log(process.env.VCAP_SERVICES)'
```

In the output, locate the Redis service-binding credentials. Among these, the `hostname` and `port` properties will be
specified. For example:

- Hostname: `master.rg-6e17d023-ab3d-4c90-97c5-ef8a68a964ca.vwvwdz.euc1.cache.amazonaws.com`
- Port: `6380`

The hostname and port pattern may vary depending on the data center.

### Step 3: Open an SSH Tunnel to an Already Deployed CF App

Ensure that the app can be [accessed via SSH](https://docs.cloudfoundry.org/devguide/deploy-apps/ssh-services.html).

```cmd
cf ssh -L <redis-port>:<your-redis-hostname>:<redis-port> <any_ssh_enabled_cf_app>
```

Replace `<redis-port>` with the port extracted in Step 2 (e.g., `6380`).

### Step 4: Configure Redis to Connect to localhost

The Redis connection options from the service binding can be overridden using one of the following configurations:

**Option 1:**

```json
{
  "cds": {
    "eventQueue": {
      "[hybrid]": {
        "redisOptions": {
          "socket": {
            "host": "localhost",
            "rejectUnauthorized": false
          }
        }
      }
    }
  }
```

**Option 2:**

```json
{
  "cds": {
    "requires": {
      "redis-eventQueue": {
        "[hybrid]": {
          "options": {
            "socket": {
              "host": "localhost",
              "rejectUnauthorized": false
            }
          }
        }
      }
    }
  }
}
```

## Why Hybrid Testing Does Not Work for Cluster Instances

Hybrid testing is not supported for Redis cluster instances due to the following reasons:

1. The Redis hostname provided in the BTP service binding corresponds to the general cluster hostname.
2. The `node-redis` library resolves this hostname to the individual nodes in the cluster and attempts to open a
   separate connection for each node.
3. The SSH tunnel is active only for the host specified in the service binding, not for the individual cluster nodes
   that the `node-redis` library tries to access.

As a result, the connections to the dedicated nodes fail because the SSH tunnel does not cover them.

# Configure Tenant Filter for Event Processing

The ability to filter tenants for event processing allows you to specify, using a callback, which tenants should have
their events processed. This functionality enables processing events for specific tenants within dedicated application
instances, providing flexibility and optimized resource allocation.

## Example

The following example demonstrates how to configure the tenant filtering functionality:

```js
const {config} = require("@cap-js-community/event-queue");

// Define a callback function to determine if a tenant's events should be processed
config.tenantIdFilterEventProcessing = async (tenantId) => {
    // Replace with your custom logic to decide whether to process the tenant
    return await checkIfTenantShouldBeProcessedOnInstance(tenantId);
};
```

### Explanation

1. **Set Tenant Filter Callback**:
   The `tenantIdFilterEventProcessing` property is assigned an asynchronous callback function. This function takes a
   `tenantId` as a parameter.

2. **Custom Logic**:
   Within the callback, you implement the logic to determine if events for the given `tenantId` should be processed. In
   the example, a placeholder function `checkIfTenantShouldBeProcessedOnInstance` is used, which you should replace with
   your specific logic.

3. **Performance Considerations**:
   The callback is performance-critical as it is invoked in various situations. It is recommended to implement caching
   to optimize performance and reduce repetitive computations.

4. **Return Value**:
   The callback must return a boolean value. `true` indicates that the events for the tenant should be processed, while
   `false` excludes the tenant from processing.

### Use Case

This configuration is especially useful in multi-tenant environments where some tenants require dedicated processing
based on specific criteria, such as resource usage, geographical location, or subscription level.


