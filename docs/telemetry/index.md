---
layout: default
title: Telemetry
nav_order: 6
---

<!-- prettier-ignore-start -->

# Telemetry insights

<!-- prettier-ignore -->
{: .no_toc}

- TOC
{: toc}
<!-- prettier-ignore-end -->

## OpenTelemetry Integration

The `@cap-js-community/event-queue` module provides built-in support for OpenTelemetry to enhance observability and
tracing of event processing. This integration allows you to track the lifecycle of events from publishing to processing
seamlessly.

### Key Features

- **Automatic Tracing for Event Processing**: The event queue generates OpenTelemetry traces for event handling,
  allowing you to monitor event execution times and dependencies.
- **Trace Context Extraction on Publishing**: When an event is published, the module extracts the current OpenTelemetry
  tracing context and propagates it.
- **Trace Context Injection on Processing**: During event processing, the module restores the trace context from the
  publishing step, ensuring end-to-end traceability.

### How It Works

1. **Publishing an Event**
   - When an event is published, the event-queue extracts the current OpenTelemetry trace context.
   - The trace context is attached to the event metadata.
2. **Processing an Event**
   - When an event is processed, the module retrieves the previously stored trace context.
   - The trace context is injected into the OpenTelemetry context, maintaining trace continuity.

### Benefits

- **End-to-End Visibility**: Monitor event flows across distributed systems.
- **Improved Debugging**: Identify performance bottlenecks and failure points.
- **Seamless Integration**: Works out-of-the-box with OpenTelemetry-compatible monitoring tools.

### Configuration

By default, OpenTelemetry tracing is enabled if an OpenTelemetry exporter is configured or if Dynatrace OneAgent is set
up to export traces. Nevertheless, the OpenTelemetry API needs to be installed in the project in any case.

For advanced configurations, refer to the OpenTelemetry documentation for setting up context propagation and tracing
exporters. Additionally, this integration works seamlessly with `@cap-js/telemetry`, meaning that if `@cap-js/telemetry`
is configured, trace exporting functions out of the box without additional setup.
