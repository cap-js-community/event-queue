# @cap-community/event-queue

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers,
the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

## Getting started

- Run `npm add @cap-community/event-queue` in `@sap/cds` project
- Initialize the event queue for example in the CAP server.js
- Enhance or create `./srv/server.js`:

```js
const cds = require("@sap/cds");
const eventQueue = require("@sap/cds-event-queue");

cds.on("bootstrap", () => {
    eventQueue.initialize({
        configFilePath: "./srv/eventConfig.yml",
        registerDbHandler: true,
        mode: eventQueue.RunningModes.multiInstance,
    });
})

module.exports = cds.server;
```

## Features

- load balancing of event processing throughout app intances
- managed transactions for event processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)

## Examples

## Architecture

