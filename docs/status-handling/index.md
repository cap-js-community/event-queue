---
layout: default
title: Event Status Handling
nav_order: 6
---

<!-- prettier-ignore-start -->

# Event Status Handling

{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->

- TOC
{: toc}

## Overview
One of the main pillars of this library is safe transaction handling of events in combination with business processes.
All available transaction throughout processing events are fully managed and must not be committed nor rolled back by
the event implementation. In which cases transactions are committed or rolled back are described in the following section.

## How are transaction handled
The transaction handling of an event is influenced by the [event-configuration](/event-queue/configure-event).
Especially by the parameter ``commitOnEventLevel``. With this parameter enabled with every call of `processEvent` a new 
transaction is issued and committed/rolled back depending on two factors.
- raised and not handled exception
  - the event-queue is catching all exceptions as far as possible and setting the event entry to error 

## Best practices
