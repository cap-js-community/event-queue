---
layout: default
title: Transactional Handling
nav_order: 8
---

<!-- prettier-ignore-start -->

# Transaction Handling
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

# Overview

One of the fundamental pillars of this library is the secure handling of transactions in conjunction with business
processes. All transactions related to event processing are fully managed and should not be committed or rolled back by
the event implementation. The circumstances under which transactions are committed or rolled back are described in the
following section. Transactions are always CDS transactions associated with a CDS context. For more general information
about CAP transaction handling, please refer to the [documentation](https://cap.cloud.sap/docs/node.js/cds-tx).

# Transaction Handling

The handling of a transaction for an event is determined by the event configuration, particularly the
parameter `transactionMode`. This parameter influences heavily the behaviour of transactions passed to the `processEvent` method.
Either they are committed or rolled back after processing. Other factors, described later, can also have an impact on this behaviour.

The event queue provides two types of transactions: transactions made for database read access and transactions made for
read/write access. This is realized in such a way that every read transaction is rolled back at the end of processing.
While read/write transactions are committed or rolled back based on the following definitions.

The transactions available in the pre-processing steps are always read transactions. Pre-processing steps refer to
everything considered before the `processEvent` method. However, the `processEvent` always has a read/write transaction
available.

## Transaction Modes

There are three available transaction modes. The first two should be used when it's not possible to establish a proper
transactional bracket between the transaction passed to the `processEvent` function and the data processed within this
function. For instance, within `processEvent`, a third-party service, such as an Email Service or Fiori Notification
Service, might be used. These services have their own transactional handling. This implies that the rollback of the
event-queue transaction won't retract previously sent emails or Fiori notifications. In such cases, the transaction
passed to `processEvent` can always be committed or rolled back without affecting the outcome. However, if business data
is processed and altered with the transaction passed to `processEvent`, the transaction mode `isolated` should be used.

- alwaysCommit
  - The transaction passed to `processEvent` is always committed, even if an unsuccessful event status is returned.
- alwaysRollback
  - The transaction passed to `processEvent` is always rolled back, regardless of the event status returned
- isolated
  - Whether the transaction is committed or rolled back depends on the event status returned from the `processEvent`
    function.
    - Status `Done` will result in a commit.
    - Status `Open`,`Error`, `Exceeded` will result in a rollback. For more information about the status handling of
      events, refer to the corresponding [documentation page](/event-queue/status-handling).

{% include warning.html message="
The function `setShouldRollbackTransaction` can be used to override the transaction mode `alwaysCommit`. This function
can also be used in `isolation` mode if the event status has been reported as `Done`, which usually results in
committing the associated transaction. However, with `setShouldRollbackTransaction` the transaction would be rolled
back, regardless of the reported event status. The example belows shows how to use the function.

```js
class EventQueueMinimalistic extends EventQueueBaseClass {
  constructor(context, eventType, eventSubType, config) {
    super(context, eventType, eventSubType, config);
  }

  async processEvent(processContext, key, eventEntries, payload) {
    let eventStatus = EventProcessingStatus.Done;
    try {
      await sendNotification(queueEntries, payload);
    } catch {
      eventStatus = EventProcessingStatus.Error;
    }
    this.setShouldRollbackTransaction(key); // leads to always rollback the transaction
    return eventEntries.map((eventEntry) => [eventEntry.ID, eventStatus]);
  }
}
```

" %}

## Exception Handling

- When an exception is raised by user code and not handled:
  - The event queue tries to catch all exceptions, and if this occurs, it sets the event entry to error.
- The event processor (`processEvent`) changes the status of an event to `error`. For more details on status handling of
  events, please refer to the dedicated [wiki page](/event-queue/status-handling).

In both situations, the transaction associated with the event processing is rolled back. This means that all changes
made within the transaction passed to `processEvent` will be undone and the event will be reprocessed based on
the configured parameter`retryAttempts`. For the sake of consistency, it is recommended to adhere to the transactions
managed by the library, as transactional safety cannot be guaranteed otherwise.
