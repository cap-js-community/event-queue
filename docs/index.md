---
layout: home
title: Home
nav_order: 1
---

# cds-event-queue

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers,
the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

## Install or Upgrade

tbd

```bash
# globally
npm install --global @cap-js-community/event-queue
# project local
npm install --save-dev @cap-js-community/event-queue
```

## Content

| Area                                         | Purpose                                                |
| :------------------------------------------- | :----------------------------------------------------- |
| [Getting started](setup)                     | Integrate the event-queue into your project            |
| [Configure Event](configure-event)           | Maintain Event Configuration                           |
| [Implement an Event](implement-event)        | How to implement an Event                              |
| [Transaction Handling](transaction-handling) | Managed transaction with event-queue                   |
| [Event Status Handling](status-handling)     | Event Status Handling                                  |
| [Concurrency Control](setup)                 | Configure and concepts on Concurrency Control          |
| [Load-balancing app-instances](setup)        | How load is distributed on the available app instances |
