---
layout: home
title: Home
nav_order: 1
---

# SAP BTP Event-Queue for CAP Node.js

The Event-Queue is a framework built on top of CAP Node.js. It is designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers, the Event-Queue framework simplifies event processing and enhancing the overall performance of your application.

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

- [load balancing](/event-queue/load-balancing) and concurrency control of event processing across app instances
- [periodic events](/event-queue/configure-event/#periodic-events) similar to running cron jobs for business processes
- [managed transactions](/event-queue/transaction-handling) for event processing
- [plug and play](setup) via cds-plugin
- [use as CAP outbox](/event-queue/use-as-cap-outbox) use the event-queue as CDS outbox for streamlined asynchronous processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)

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
    manages the load, distributing it across all available app instances.
