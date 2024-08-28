# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## v1.6.6 - 2024-08-XX

### Fixed

- In some cases the event broadcasting is delayed if a periodic event can't obtain the processing lock

## v1.6.5 - 2024-08-22

### Added

- Introduced the `retryFailedAfter` configuration option, allowing you to specify the interval (in milliseconds) after which failed events should be retried, provided the retry limit has not been exceeded.

## v1.6.4 - 2024-08-14

### Added

- [outbox] add option to use defined user for event-queue also for CAP outboxed services

## v1.6.3 - 2024-08-07

### Fixed

- [openTelemetry] avoid empty traces for persist-event-status
- [openTelemetry] more resilient for finished spans

## v1.6.2 - 2024-08-31

### Fixed

- pass correct tenant to fetch authInfo

## v1.6.1 - 2024-07-30

### Changed

- upgrade to @sap/xssec 4
- Testing with cds 8

### Added

- Export `WorkerQueue` for monitoring purposes to provide insights into the running load of the application.
- JSDocs: added addEntryToProcessingMap for EventQueueProcessorBase
- Enhanced Event Processing: Events will continue to be processed even if the initial processing time is exceeded. Events are now broadcast, allowing different application instances to pick them up. The existing worker queue is used to ensure proper load balancing.

## v1.6.0 - 2024-07-09

### Added

- Added an option to events to specify which application instance should process the event. See [documentation](https://cap-js-community.github.io/event-queue/configure-event/#parameters).

### Fixed

- Avoid issues with not connected CAP service and open events
- fix clear timeout tenant unsubscribe

## v1.5.3 - 2024-06-28

### Changed

- single tenant performance improvements

### Added

- better test coverage for single tenant

## v1.5.2 - 2024-06-26

### Added

- Added tracing to redis pub/sub

### Fixed

- Workaround for memory issues due to bug in node.js with timers: https://github.com/nodejs/node/pull/53337

## v1.5.1 - 2024-06-19

### Fixed

- Bug in CDS 7.9.2: Introduced a bug affecting the instant processing of events. This release includes a temporary workaround until the bug is fixed.
- Memory Leaks: Fixed memory leaks caused by setTimeout returning an object instead of a primitive value

## v1.5.0 - 2024-06-13

### Added

- Telemetry instrumentation for processing events. This can be enabled with the `enableCAPTelemetry` setting.
- Additional types.
- allow to use `skipInsertEventsBeforeCommit` in `publishEvent` function.

### Fixed

- `cds.build.register` may be undefined if `@sap/cds-dk` is not installed locally or globally.
- Double release of locks for periodic event processing.

## v1.4.6 - 2024-05-28

### Added

- federate unsubscribe events via redis to all application instances and allow to register custom handler for unsubscribe events
- types for event-queue config

### Fixed

- upgrade dependencies

## v1.4.5 - 2024-04-24

### Fixed

- add xssec authInfo to CDS user also for CAP outbox

## v1.4.4 - 2024-04-22

### Fixed

- `insertEventsBeforeCommit` did not commit all events in certain scenarios.

## v1.4.3 - 2024-04-17

### Added

- typescript types for the most common functions
- add subdomain for logging of broadcasting events via redis

### Changed

- the getter of eventType cuts the periodic event suffix and returns the exact name of the event definition

## v1.4.2 - 2024-04-04

### Added

- [cds-outboxed] Add eventQueue processor, key, queueEntries, and payload to req (can be accessed via req.context.\_eventQueue)
- Add option `insertEventsBeforeCommit` to improve performance for `publishEvent`.
- Add cds shutdown handler to clear existing redis locks before shutdown of the instance.

### Fixed

- [cds-outboxed] Call cds.connect.to for open outboxed events

## v1.4.1 - 2024-03-27

### Changed

- Removed authInfo from context.http.req and moved to a full-fledged xssec/xsuaa authInfo attached to context.user.authInfo
- [cds-plugin] return promise for init for cds to wait until plugin is fully initialized

## v1.4.0 - 2024-03-21

### Added

- add to supply custom redis options for create client.

### Changed

- Reworked periodic processing of all events to be more efficient and to reduce the load on the database and use less database connections.
- Removed support for custom tables. The event-queue now uses always the provided tables.

## v1.3.6 - 2024-03-14

### Fixed

- Redis reconnects

## v1.3.5 - 2024-03-12

### Fixed

- In instances of overlapping intervals, periodic events may fall behind schedule.

## v1.3.4 - 2024-03-08

### Added

- Trigger processing again if time is exceeded for event processing.

### Changed

- removed CF check to enable redis to allow using redis even if process.env.USER is not vcap.

## v1.3.3 - 2024-03-06

### Changed

- Default for runInterval changed from 5 minutes to 25 minutes. This is to reduce the load on the database.
- The load of the internal periodic event DELETE_EVENTS is increased to 20 to only process 5 tenants in parallel. This is to reduce the load on the database.
- The max processing time for the event-queue is set to the runInterval.

## v1.3.2 - 2024-03-01

### Added

- option for delayed events for cds outboxed services: [documentation](https://cap-js-community.github.io/event-queue/use-as-cap-outbox/#how-to-delay-outboxed-service-calls)

### Fixed

- Delay registration of processors until the database connection is established.

## v1.3.1 - 2024-02-21

### Fixed

- Log message for blocked events

### Changed

- Reduce log severity for skip publish redis event as no lock is available to debug
- Only do etag checks after a processing time of 10 minutes to improve performance

## v1.3.0 - 2024-02-21

### Added

- add option to block ad-hoc events. More information in [documentation](https://cap-js-community.github.io/event-queue/configure-event/##blocking-events).
- Define priorities for event types. More information in [documentation](https://cap-js-community.github.io/event-queue/configure-event/#priority-of-events).

### Fixed

- In more cases the global cds.context was not set correctly because the async-chain could break in high load scenarios.

## v1.2.6 - 2024-02-15

### Fixed

- In some cases the global cds.context was not set correctly because the async-chain could break in high load scenarios.

## v1.2.5 - 2024-02-13

### Added

- The `cleanupLocksAndEventsForDev` parameter allows for the cleanup of all locks and events in progress during server
  start. This option is intended for development purposes.

### Fixed

- Allow to initialize event-queue without config.yml in case of usage as CAP outbox

### Changed

- The parameter `runInterval` is checked during init. Only values greater than 10 seconds are allowed.

## v1.2.4 - 2024-02-07

### Changed

- Optimize promise handling

## v1.2.3 - 2024-02-07

### Changed

- update redis to 4.6.13

## v1.2.2 - 2024-02-05

### Added

- improved logging
- better tenant subdomain caching

## v1.2.1 - 2024-01-30

### Fixed

- fix registration of db-handler

## v1.2.0 - 2024-01-26

### Added

- option to set user for all created cds contexts and with that the user for updating the managed database fields.

### Changed

- rework initialization via cds-plugin.

## v1.1.0 - 2024-01-22

### Added

- enable event-queue to work as CAP outbox. The flag `useAsCAPOutbox` replaces the CAP implementation by
  the event-queue.

## v1.0.3 - 2024-01-08

### Fixed

- update tenant hash for newly onboarded tenants
- consider running periodic events during update of periodic events

## v1.0.2 - 2024-01-05

### Added

- filter out not invalid tenant ids during processing

## v1.0.1 - 2024-01-04

### Added

- introduced `thresholdLoggingEventProcessing` config variable to adjust logging threshold for event
  processing [documentation](https://cap-js-community.github.io/event-queue/setup/#initialization-parameters)

## v1.0.0 - 2023-12-20

### Added

- block the run of periodic events via
  config [documentation](https://cap-js-community.github.io/event-queue/configure-event/#blocking-periodic-events)
- Add a label to the workerQueue. This will help in understanding which events were throttled in case of throttling.
- The `isEventQueueActive` configuration can now be used to deactivate the runtime processing of all events.
- with the function `getLastSuccessfulRunTimestamp` the timestamp of the last successful run for a periodic event can be
  requested. [documentation](https://cap-js-community.github.io/event-queue/implement-event/#using-the-timestamp-of-the-last-successful-run-for-the-next-run)
- Added a performance tracer for periodic events. This will log any processing that takes longer than 50ms.
- Added type and subtype to all performance traces.

### Fixed

- Catch exception during Redis channel subscription
- Endless running if event status open is returned and checkForNextChunk is activated

### Changed

- Refactored the deletion process for completed events. The default setting for deleting processed events has now been
  updated to a 7-day timeframe.
  [documentation](https://cap-js-community.github.io/event-queue/configure-event/#delete-processed-events)
- the configuration variable `isRunnerDeactivated` is renamed to `isEventQueueActive`.
- Reduced the log severity to debug for "Selected event queue entries for processing" during periodic events.

## v0.3.0 - 2023-11-30

### Changed

- Removed the `instanceLoadLimit` parameter. The limit is now statically set to 100. The event load should henceforth be
  specified as a percentage.
- Upgrade docs dependencies
- Adjusted workerQueue logging thresholds for waiting time

### Fixed

- fix transaction handling for periodic events
- set cds.context correctly for periodic runner

## v0.2.5 - 2023-11-16

### Added

- logger get setter for better providing own logger

### Changed

- new documentation
- improve logging

### Fixed

- small bug fixes and improvements for periodic events

## v0.2.4 - 2023-11-16

### Added

- further improve periodic events

### Changed

- rework of load management and concurrency control

## v0.2.3 - 2023-11-15

### Fixed

- fixes and improvements for periodic events

## v0.2.2 - 2023-11-14

### Added

- periodic events - use event-queue to process periodic jobs

## v0.2.1 - 2023-11-13

### Added

- cds shutdown - close redis clients
- add redis cluster support

## v0.2.0 - 2023-11-09

### Added

- implementation of delayed events, which allows to publish events that should be processed at a later point in time
- option to disable redis + refactoring of config
- improved HANA integration test setup

## v0.1.58 - 2023-11-03

### Changed

- update dependencies
- remove uuid dependency

## v0.1.56 - 2023-08-31

### Added

- example project

### Fixed

- small bug fixes for local mode

### Changed

- better documentation

## v0.1.55 - 2023-08-17

### Fixed

- fix redis connect client

## v0.1.54 - 2023-08-16

### Added

- allow to distribute config via redis to instances

### Fixed

- move loggers from top-level to functions because cds 7 has different require orders. This the event-queue to use the
  custom project loggers

## v0.1.53 - 2023-08-07

### Added

- more resilient for small clock shifts in setInterval

## v0.1.52 - 2023-07-31

### Fixed

- fix missing catch for isOutdatedAndKeepalive

## v0.1.51 - 2023-07-27

### Added

- Delete event entries after defined number of days
- improve exceeded event handling

### Fixed

- fix model loading for cds-plugin
- fix setInterval clock drift

## v0.1.50 - 2023-07-13

### Added

- new transaction modes
- register rollback of transaction in combination with returning successful event processing status

## v0.1.49 - 2023-07-05

### Added

- first npm release after internal development
