---
layout: home
title: Home
nav_order: 1
---

# About

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers,
the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

## Features

- load balancing of event processing throughout app instances
- control concurrency in app instances
- periodic events
- managed transactions for event processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)
- plug and play via cds-plugin

## What it does and what it solves

- The packages provided enable efficient and streamlined asynchronous processing of any load, with full CAP and managed transaction support.
  - For instance, if you have a business process that sends notifications of any kind (e.g., Email), you can use the event-queue to publish an event using the same transaction used for processing the business process data. Publishing an event involves writing a database entry, which ensures transactional consistency as the event is committed or rolled back alongside the primary transaction of the business process. The event-queue processes the event after the business transaction is committed. This approach keeps the business process lean, and prevents the user from having to wait on the UI for the asynchronous load to be processed.
- Managed transactions:
  - Every event processor is called with a managed transaction similar to CAP handlers. This means that you don't need to manage transactions yourself, freeing you up to focus on writing business code.
- Load management (a crucial consideration if the app attracts many users):
  - If the event-queue is used for processing asynchronously, the package can control the load and prevent CPU/Memory peaks. This feature enables the load to be processed based on the available resources in the app. Additionally, the event-queue distributes the load to all available app instances where the event-queue is initialized. This means that the app-instance which is publishing the event doesn't need to be the one processing the event. This distribution also allows you to process the event on a different app than the one that published the event (supporting a microservice architecture if needed).
- Periodic events (currently in beta):
  - You can define periodic events that should run every X seconds. The event-queue also performs load management here, distributing the load to all available app instances.

## Install or Upgrade

```bash
npm install --save @cap-js-community/event-queue
```

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
