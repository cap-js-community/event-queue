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

One of the fundamental pillars of this library is the secure handling of transactions in conjunction with business
processes. All transactions related to event processing are fully managed and should not be committed or rolled back by
the event implementation. The circumstances under which transactions are committed or rolled back are described in the
following section. Transactions are always CDS transactions associated with a CDS context. For more general information
about CAP transaction handling, please refer to the [documentation](https://cap.cloud.sap/docs/node.js/cds-tx).

## Transaction Handling

The handling of a transaction for an event is determined by the event configuration, particularly the
parameter `commitOnEventLevel`. When this parameter is enabled, a new transaction is initiated with each call
of `processEvent` and committed or rolled back based on various factors, which are described later. However,
if `commitOnEventLevel` is false, the whole selected chunk (the size depends on the event configuration) uses the same
transaction.

The event queue provides two types of transactions: transactions made for database read access and transactions made for
read/write access. This is realized in such a way that every read transaction is rolled back at the end of processing,
while read/write transactions are committed or rolled back based on the following definitions.

The transactions available in the pre-processing steps are always read transactions. Pre-processing steps refer to
everything considered before the `processEvent` method. However, the `processEvent` always has a read/write transaction
available.

### Cases in Which Transactions are Rolled Back

- If an exception is raised by user code and not handled
    - The event queue attempts to catch all exceptions and sets the event entry to an error state if this happens
- The event processor (`processEvent`) sets the status of an event to error. Please refer to the dedicated chapter for
  status handling of events.

In both scenarios, the transaction associated with processing the event will be rolled back. This means that all changes
made within the transaction passed to `processEvent` will be reverted, and the event will be reprocessed based on the
configured `retryAttempts` parameter. It is recommended to stick to the transactions managed by the library to avoid
inconsistencies, as transactional safety cannot be ensured anymore.

### Cases in Which Transactions are Committed

As described in the introduction, only the transaction passed to `processEvent` is eligible for committing data. Whether
the transaction is committed or not depends on the returned status of the method `processEvent`.