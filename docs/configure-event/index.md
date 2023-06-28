---
layout: default
title: Configure Event
nav_order: 3
---

<!-- prettier-ignore-start -->
# Configure Event
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## Configuration File

- Run `npm add @cap-community/event-queue` in `@sap/cds` project
- Initialize the event queue for example in the CAP server.js
- Enhance or create `./srv/server.js`:

## Parameters

| Property                | Description                                                                                                                                                                                                             | Default Value |
|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| retryAttempts           | For infinite retries, maintain -1.                                                                                                                                                                                      | 3             |
| parallelEventProcessing | How many events of the same type and subType are parallel processed after clustering. Limit is 10.                                                                                                                      | 1             |
| eventOutdatedCheck      | Checks if the db record for the event has been modified since the selection and right before the processing of the event.                                                                                               | true          |
| commitOnEventLevel      | After processing an event, the associated transaction is committed and the associated status is committed with the same transaction. This should be used if events should be processed atomically.                      | false         |
| selectMaxChunkSize      | Number of events which are selected at once. If it should be checked if there are more open events available, set the parameter checkForNextChunk to true.                                                              | 100           |
| checkForNextChunk       | Determines if after processing a chunk (the size depends on the value of selectMaxChunkSize), a next chunk is being processed if there are more open events and the processing time has not already exceeded 5 minutes. | false         |
