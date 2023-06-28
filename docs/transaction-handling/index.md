---
layout: default
title: Transactional Handling
nav_order: 5
---

<!-- prettier-ignore-start -->

# Transaction Handling

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->

- TOC
  {: toc}

## Overview

One of the main pillars of this library is the safe handling of transactions in conjunction with business processes. All
transactions related to event processing are fully managed and should not be committed or rolled back by the event
implementation. The circumstances under which transactions are committed or rolled back are described in the following
section.

## How are transaction handled

The handling of a transaction for an event is determined by the [event configuration](/event-queue/configure-event),
particularly the parameter `commitOnEventLevel`. When this parameter is enabled, a new transaction is initiated with
each call of `processEvent` and committed or rolled back based various factors, described later.

The event-queue provides two types of transactions. Transactions made for db read access and transactions made for 
read/write access. This is realized that read transactions 

## In which cases are transaction rolled back
- If an exception is raised and not handled
    - The event queue attempts to catch all exceptions and sets the event entry to an error state if this happens
- The event processor (`processEvent`) sets the status of an event to error.

In both scenarios, the transaction associated with processing the event will be rolled back. This means that all changes
made within the transaction passed to `processEvent` will be reverted, and the event will be reprocessed based on the
configured `retryAttempts` parameter.

## In which cases are transactions committed

## Best practices
