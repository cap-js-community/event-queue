---
layout: default
title: Distinction to others
nav_order: 2
---

<!-- prettier-ignore-start -->


# Distinction from other solutions
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

In the following, the event queue will be compared and differentiated with other SAP products.

## CAP persistent outbox

The event-queue package and the CAP persistent outbox share several features, yet the event-queue package offers
additional functionalities. A key distinction lies in the load-balancing and periodic events features provided by
the event-queue.

Load balancing is achieved via Redis, offering a robust way to handle traffic and distribute tasks evenly across multiple
resources. Further, there's a concurrency limit set on the application instance to prevent overloading and ensure seamless
operations. You can learn more about these features in the [load balancing section](/event-queue/load-balancing).

The event-queue package also supports periodic events, similar to cron-jobs. This feature allows for the scheduling of
tasks at regular intervals. More details about this feature are available in the.

Moreover, the event-queue package allows for the publishing and processing of events in different microservices,
enhancing the modularity and scalability of applications.

Another crucial aspect of the event-queue package is its different transaction modes. It supports three primary modes.
The first mode processes business data where each event equates to a single transaction. The second mode is suitable
for HTTP use cases, where multiple events are treated as a single transaction. The third mode allows for commit or
rollback of transactions based on the event status, i.e., whether it's done or resulted in an error. More information on
these transaction modes can be found in the [transaction handling section](/event-queue/transaction-handling).

## CAP events with SAP Event-Mash

The SAP Event-Mash is particularly suitable for cross-application or cross-product communication, making it an excellent
choice for projects that require interactions across multiple platforms. This contrasts with the event-queue, which is
primarily designed for asynchronous processing and load balancing within the same application or product. Notably,
the event-queue offers full CAP support and DB-transaction management, underscoring its specialization in maintaining
smooth operations within single applications.

Unlike the SAP event mesh, which is designed to be CAP-agnostic, the event-queue is specifically tailored for a
CAP-application. This means that it is designed with the needs and requirements of CAP-applications in mind, making it a
more targeted solution for these types of applications.

Another feature worth noting is event clustering. For example, if there are multiple email events to the same user,
these can be clustered together to send one bundled email. This feature streamlines communications and prevents the
overload of individual messages.

In terms of dependencies, the event-queue keeps it minimalistic, only using the primary database and a Redis instance
if available. This limited dependency makes it a more streamlined and self-contained solution.

Finally, this project is fully integrated with CAP and is fully multi-tenancy enabled. This means that it is designed
to work seamlessly with CAP, and can handle multiple tenants, making it highly versatile and adaptable for different
scenarios.
