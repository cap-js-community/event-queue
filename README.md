# @cap-js-community/event-queue

[![npm version](https://img.shields.io/npm/v/@cap-js-community/event-queue)](https://www.npmjs.com/package/@cap-js-community/event-queue)
[![monthly downloads](https://img.shields.io/npm/dm/@cap-js-community/event-queue)](https://www.npmjs.com/package/@cap-js-community/event-queue)
[![REUSE status](https://api.reuse.software/badge/github.com/cap-js-community/event-queue)](https://api.reuse.software/info/github.com/cap-js-community/event-queue)
[![CI Main](https://github.com/cap-js-community/event-queue/actions/workflows/main-ci.yml/badge.svg)](https://github.com/cap-js-community/event-queue/commits/main)

The Event-Queue is a framework built on top of CAP Node.js, designed specifically for efficient and
streamlined asynchronous event processing. With a focus on load balancing, this package ensures optimal
event distribution across all available application instances. By providing managed transactions similar to CAP
handlers, the Event-Queue framework simplifies event processing, enhancing the overall performance of your application.

Additionally, Event-Queue provides support for [periodic events](https://cap-js-community.github.io/event-queue/configure-event/#periodic-events),
allowing for processing at defined intervals. This feature further extends its capabilities in load balancing and
transaction management, ensuring that even regularly occurring tasks are handled efficiently and effectively without
overloading any single instance. This makes it an ideal solution for applications needing consistent, reliable event processing.

## Getting started

- Run `npm add @cap-js-community/event-queue` in `@sap/cds` project
- Activate the cds-plugin in the cds section of the package.json.

### As cds-plugin

For detailed information check out the [documentation](https://cap-js-community.github.io/event-queue/setup).

```json
{
  "cds": {
    "eventQueue": {
      "configFilePath": "./srv/eventQueueConfig.yml"
    }
  }
}
```

## Features

Learn more about features in the [documentation](https://cap-js-community.github.io/event-queue/#functionality-and-problem-solutions). To compare the
event-queue with other SAP products head over to [Distinction from other solutions](https://cap-js-community.github.io/event-queue/diff-to-outbox/).

- [load balancing](https://cap-js-community.github.io/event-queue/load-balancing) and concurrency control of event processing across app instances
- [periodic events](https://cap-js-community.github.io/event-queue/configure-event/#periodic-events) similar to running cron jobs for business processes
- [managed transactions](https://cap-js-community.github.io/event-queue/transaction-handling) for event processing
- async processing of processing intensive tasks for better UI responsiveness
- push/pull mechanism for reducing delay between publish an event and processing
- cluster published events during processing (e.g. for combining multiple E-Mail events to one E-Mail)
- [plug and play](https://cap-js-community.github.io/event-queue/setup) via cds-plugin

## Documentation

Head over to our [Documentation](https://cap-js-community.github.io/event-queue/) to learn more.

## Support, Feedback, Contributing

This project is open to feature requests/suggestions, bug reports etc.
via [GitHub issues](https://github.com/cap-js-communityevent-queue/issues). Contribution and feedback are encouraged
and always welcome. For more information about how to contribute, the project structure, as well as additional
contribution information, see our [Contribution Guidelines](CONTRIBUTING.md).

## Code of Conduct

We as members, contributors, and leaders pledge to make participation in our community a harassment-free experience for
everyone. By participating in this project, you agree to abide by its [Code of Conduct](CODE_OF_CONDUCT.md) at all
times.

## Licensing

Copyright 2023 SAP SE or an SAP affiliate company and `@cap-js-community/event-queue` contributors. Please see
our [LICENSE](LICENSE) for copyright and license information. Detailed information including third-party components and
their licensing/copyright information is
available [via the REUSE tool](https://api.reuse.software/info/github.com/cap-js-community/<your-project>).
