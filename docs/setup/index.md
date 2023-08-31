---
layout: default
title: Getting started
nav_order: 2
---

<!-- prettier-ignore-start -->
# Setup
{: .no_toc}
<!-- prettier-ignore-end -->

<!-- prettier-ignore -->
- TOC
{: toc}

## Getting started

- Run `npm add @cap-community/event-queue` in `@sap/cds` project
- Initialize the event queue for example in the CAP server.js
- Enhance or create `./srv/server.js`:

### As cds-plugin

Extend the cds section of your package.json. Reference to the cds-plugin section in the capire documentation about the
[cds-plugin concept](https://cap.cloud.sap/docs/releases/march23#new-cds-plugin-technique).

```json
{
  "cds": {
    "eventQueue": {
      "plugin": true,
      "configFilePath": "./srv/eventQueueConfig.yml"
    }
  }
}
```
