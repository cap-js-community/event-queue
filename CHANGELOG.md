# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## v1.0.0 - 2023-XX-XX

### Added

- block the run of periodic events via
  config [documentation](https://cap-js-community.github.io/event-queue/configure-event/#blocking-periodic-events)
- Add a label to the workerQueue. This will help in understanding which events were throttled in case of throttling.
- The "`isRunnerDeactivated` configuration can now be used to deactivate the runtime processing of all events.

### Fixed

- Catch exception during Redis channel subscription

### Changed

- Refactored the deletion process for completed events. The default setting for deleting processed events has now been
  updated to a 7-day timeframe.
  [documentation](https://cap-js-community.github.io/event-queue/configure-event/#delete-processed-events)

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
