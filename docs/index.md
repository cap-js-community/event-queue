---
layout: home
title: Home
nav_order: 1
---

# About

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers, the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

Additionally, Event-Queue provides support for [periodic events](/event-queue/configure-event/#periodic-events), allowing for processing at defined intervals. This
feature further extends its capabilities in load balancing and transaction management, ensuring that even regularly
occurring tasks are handled efficiently and effectively without overloading any single instance. This makes it an ideal
solution for applications needing consistent, reliable event processing.

## Content

| Area                                         | Purpose                                                |
| :------------------------------------------- | :----------------------------------------------------- |
| [Getting started](setup)                     | Integrate the event-queue into your project            |
| [Configure Event](configure-event)           | Maintain Event Configuration                           |
| [Implement an Event](implement-event)        | How to implement an Event                              |
| [Publishing of Events](publish-event)        | How to publish an Event                                |
| [Transaction Handling](transaction-handling) | Managed transaction with event-queue                   |
| [Event Status Handling](status-handling)     | Event Status Handling                                  |
| [Concurrency Control](setup)                 | Configure and concepts on Concurrency Control          |
| [Load-balancing app-instances](setup)        | How load is distributed on the available app instances |

## Features

- [load balancing](/event-queue/load-balancing) and concurrency control of event processing across app instances
- [periodic events](/event-queue/configure-event/#periodic-events) similar to running cron jobs for business processes
- [managed transactions](/event-queue/transaction-handling) for event processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)
- [plug and play](setup) via cds-plugin

## Functionality and Problem Solutions

- The provided packages offer a robust solution for efficient, asynchronous processing of any load, bolstered by comprehensive CAP and transaction management support.
  - For example, consider a business process that dispatches notifications such as emails. With the event-queue, you can publish an event under the same transaction used to handle the business process data. This process involves creating a database entry, providing transactional consistency. The event is either committed or rolled back in tandem with the primary transaction of the business process. The event-queue processes the event only after the completion of the business transaction. This methodology keeps the business process lean and prevents the user interface from making the user wait while processing the asynchronous load.
- Transaction Management:
  - Each event processor is invoked with a managed transaction, akin to CAP handlers. This arrangement absolves you of the responsibility of managing transactions, allowing you to concentrate on crafting business code.
- Load Management (a vital aspect when the app serves numerous users):
  - When the event-queue is employed for asynchronous processing, the package can regulate the load, thus avoiding CPU/Memory peaks. This functionality allows processing based on the available resources in the app. Furthermore, the event-queue disseminates the load across all available app instances where the event-queue has been initialized. Consequently, the app instance which publishes the event need not process the event. This distribution capability also facilitates processing the event on a different app than the one that published it, supporting a microservice architecture if required.
- Periodic Events (currently under beta testing):
  - It's possible to set up periodic events that execute every X seconds. Even here, the event-queue manages the load, distributing it across all available app instances.
