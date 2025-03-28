---
layout: home
title: Home
nav_order: 1
---

# SAP BTP Event-Queue for CAP Node.js

The Event-Queue is a framework built on top of CAP Node.js. It is designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers, the Event-Queue framework simplifies event processing and enhancing the overall performance of your
application.

Moreover, the Event-Queue framework incorporates transaction safety in its asynchronous processing. This feature ensures
that each event is recorded with the business transaction from the synchronous process in the database. Applying this
design, the framework is able to offer a secure environment for handling business transactions while still maintaining
its high-performing asynchronous capabilities.

Additionally, Event-Queue provides support for [periodic events](/event-queue/configure-event/#periodic-events),
allowing for processing at defined intervals. This feature further extends its capabilities in load balancing and
transaction management, ensuring that even regularly occurring tasks are handled efficiently and effectively without
overloading any single instance. This makes it an ideal solution for applications needing consistent and reliable event
processing.

## Features

- [Load balancing](/event-queue/load-balancing) and concurrency control for event processing across app instances,
  protecting the application from load spikes.
- [Use as CAP outbox](/event-queue/use-as-cap-outbox) with full support for all event-queue features.
- [Periodic events](/event-queue/configure-event/#periodic-events) using cron patterns with load management for optimal
  job execution.
- [Managed transactions](/event-queue/transaction-handling) for reliable event processing.
- [Plug and play](setup) integration via `cds-plugin`.
- [Telemetry support and trace propagation](/event-queue/telemetry), including event-queue-specific telemetry data and
  tracing information.
- Full support for local testing with SQLite, enabling feature development and testing in a local environment to boost
  productivity.
- Asynchronous processing of resource-intensive tasks to improve UI responsiveness.
- Optimized to use as less database connections as possible to facilitate project with many tenants and rather small
  HANA instances.
- Supports redis eventing for faster event processing and effective communication between application instances. If
  redis is not available the event-queue falls back to pure database mechanisms.
- Clustering of published events during processing (e.g., combining multiple email events into a single email).
- Support for microservice architectures by configuring which app instances should process events.
- Tenant-sticky processing on application instances possible.

## Functionality and Problem Solutions

- The provided packages offer a robust solution for efficient, asynchronous processing of any load, bolstered by
  comprehensive CAP and transaction management support.
  - For example, consider a business process that dispatches notifications such as emails. With the event-queue, you
    can publish an event under the same transaction used to handle the business process data. This process involves
    creating a database entry, providing transactional consistency. The event is either committed or rolled back in
    tandem with the primary transaction of the business process. The event-queue processes the event only after the
    completion of the business transaction. This methodology keeps the business process lean and prevents the user
    interface from making the user wait while processing the asynchronous load.
- Transaction Management
  - Each event processor is invoked with a managed transaction, akin to CAP handlers. This arrangement absolves you of
    the responsibility of managing transactions, allowing you to concentrate on crafting business code.
- Load Management (a vital aspect when the app serves numerous users)
  - When the event-queue is employed for asynchronous processing, the package can regulate the load, thus avoiding
    CPU/Memory peaks. This functionality allows processing based on the available resources in the app. Furthermore,
    the event-queue disseminates the load across all available app instances where the event-queue has been
    initialized. Consequently, the app instance which publishes the event need not process the event. This
    distribution capability also facilitates processing the event on a different app than the one that published it,
    supporting a microservice architecture if required.
- Periodic Events
  - It's possible to set up periodic events that execute in specified second intervals. Even here, the event-queue
    manages the load, distributing it across all available app instances.+
- OpenTelemetry and Trace Propagation
  - The event-queue integrates with OpenTelemetry, providing detailed telemetry data for monitoring and
    troubleshooting.
    OpenTelemetry captures traces, spans, and metrics that help diagnose performance bottlenecks, detect failures, and
    understand the lifecycle of events.
  - **Trace Propagation** ensures that tracing context is maintained across distributed services, allowing end-to-end
    visibility
    into event processing. This is especially beneficial in microservice architectures, where events traverse multiple
    services and instances. With trace propagation, developers can track event execution paths, measure processing
    times,
    and correlate related events across different services, leading to improved observability and debugging
    efficiency.
