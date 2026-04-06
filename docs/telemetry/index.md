---
layout: default
title: Telemetry
nav_order: 6
---

<!-- prettier-ignore-start -->

{: .no_toc}

# Telemetry Insights

<!-- prettier-ignore -->

- TOC
{: toc}

<!-- prettier-ignore-end -->

The `@cap-js-community/event-queue` module comes with built-in support for OpenTelemetry, enabling seamless tracing and
observability of event processing. With this integration, you can track events from publication to execution, ensuring
full visibility into your system’s event flow.

## Key Features

- **Automatic Event Tracing** – Captures OpenTelemetry traces for event execution, helping you analyze processing times
- and dependencies.
- **Trace Context Propagation** – Preserves the OpenTelemetry tracing context when events are published and processed,
- maintaining a clear linkage across distributed systems.
- **End-to-End Monitoring** – Ensures that traceability is maintained from the moment an event is created until it is
- fully processed.

## How It Works

1. **Publishing an Event**

   - When an event is published, the current OpenTelemetry trace context is extracted.
   - If no trace context is present, a new one is automatically created.
   - The trace context is then attached to the event metadata.

2. **Processing an Event**
   - Upon processing, the previously stored trace context is retrieved.
   - If no trace context exists, a new one is generated to ensure traceability.
     - Periodic Events never have a existing trace context
   - The trace context is injected back into the OpenTelemetry framework, maintaining continuity.

## Benefits

- **Comprehensive Observability** – Gain insight into event-driven workflows across different services.
- **Easier Debugging** – Quickly pinpoint performance issues and failure points.
- **Seamless Integration** – Compatible with OpenTelemetry-based monitoring tools with minimal setup.

## Configuration

By default, OpenTelemetry tracing is enabled if an OpenTelemetry exporter is set up or if Dynatrace OneAgent is
configured to export traces. However, the OpenTelemetry API must always be installed in the project.

### Trace Context Propagation

The propagation of the trace context can be controlled on an event level using the parameter `inheritTraceContext`.
By default, this is set to `true`, meaning the trace context will be inherited and propagated during event publishing
and processing. If set to `false`, the trace context propagation will be disabled for that particular event.

### Disabling Telemetry

Complete telemetry support can be disabled globally with the initialization parameter `enableTelemetry`. The default
value is `true`, meaning telemetry is enabled. If set to `false`, all telemetry features, including OpenTelemetry
tracing, will be disabled for the event-queue.

For more advanced configurations, refer to the OpenTelemetry documentation on context propagation and trace exporters.
This integration also works smoothly with `@cap-js/telemetry`, meaning that if `@cap-js/telemetry` is configured, trace
exporting works out of the box with no additional setup.

## Pitfalls with OpenTelemetry Tracing and Dynatrace OneAgent

When using Dynatrace OneAgent for trace exporting without a separate OpenTelemetry exporter, there are some important
limitations to be aware of:

- **Dependency on Dynatrace Trace Context**  
  Dynatrace OneAgent only exports traces to Dynatrace if they contain a valid Dynatrace trace context. This context is
  automatically created when an event is published within the scope of an HTTP request or another operation captured by
  Dynatrace OneAgent.

- **Issues with Periodic and Standalone Events**  
  Events that are triggered periodically (e.g., scheduled jobs) or published without an existing Dynatrace trace context
  may not be visible in Dynatrace. Since these events lack the necessary Dynatrace trace context, OneAgent does not
  export them unless a separate OpenTelemetry exporter is configured.

### Recommendation

To ensure visibility of all traces—including periodic events or events outside of a Dynatrace-traced request—configure
a dedicated OpenTelemetry exporter alongside Dynatrace OneAgent. This guarantees that traces are properly exported even
when a Dynatrace trace context is missing.

## Example Trace

![Example Trace](img_1.png)

## Event Queue Metrics

In addition to distributed tracing, the event-queue can expose real-time queue depth metrics via OpenTelemetry. When
enabled, it tracks how many events are **pending** (waiting to be processed) and **in progress** (actively being
processed) per namespace, stored in Redis and exposed as OpenTelemetry Observable Gauges.

### Metrics Published

| Metric name                         | Unit | Description                                               |
| ----------------------------------- | ---- | --------------------------------------------------------- |
| `cap.event_queue.jobs.pending`      | 1    | Current number of events waiting to be processed          |
| `cap.event_queue.jobs.in_progress`  | 1    | Current number of events actively being processed         |
| `cap.event_queue.stats.refresh_age` | s    | Age of the most recent stats snapshot (staleness monitor) |

All metrics carry a `queue.namespace` attribute so you can filter by namespace in your monitoring tool.

### How It Works

- **On INSERT**: when events are published and the transaction commits, the pending counter is incremented.
- **On UPDATE**: as events transition between statuses (Open → InProgress → Done/Error/Exceeded/Suspended), the
  pending and inProgress counters are adjusted accordingly.
- **On each runner cycle**: the runner refreshes the absolute pending count per namespace from the database, so
  counters stay accurate even after restarts or direct DB modifications.
- Gauges are polled by the OpenTelemetry metrics SDK on demand; the event-queue additionally refreshes its
  internal stats snapshot every 30 seconds as a background task.

### Enabling Metrics

Metrics collection requires Redis and is **opt-in**. Enable it via the initialization parameter
`collectEventQueueMetrics`:

```js
await eventQueue.initialize({
  // ...
  collectEventQueueMetrics: true,
});
```

Or via `cds.env` (e.g. in `package.json`):

```json
{
  "cds": {
    "eventQueue": {
      "collectEventQueueMetrics": true
    }
  }
}
```

The full set of conditions required for metrics to be active:

| Condition                  | Required value | Notes                                                                                        |
| -------------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `collectEventQueueMetrics` | `true`         | Master switch; default `false`                                                               |
| `enableTelemetry`          | `true`         | Default `true`; global telemetry kill-switch                                                 |
| Redis enabled              | yes            | Stats are stored in Redis hashes                                                             |
| `registerAsEventProcessor` | `true`         | Metrics are only initialised on instances that process events                                |
| CF instance index          | `0`            | Only the first application instance registers gauges to avoid duplicate metric registrations |
| OpenTelemetry metrics SDK  | present        | `@opentelemetry/api` with a configured MeterProvider                                         |

If any condition is not met, `initMetrics()` returns immediately and no gauges are registered.

### Example Dashboard

![Event Queue Metrics Dashboard](img_2.png)
