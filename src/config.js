"use strict";

const cds = require("@sap/cds");
const cronParser = require("cron-parser");

const { getEnvInstance } = require("./shared/env");
const redis = require("./shared/redis");
const EventQueueError = require("./EventQueueError");
const { Priorities } = require("./constants");

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;
const REDIS_CONFIG_CHANNEL = "EVENT_QUEUE_CONFIG_CHANNEL";
const REDIS_OFFBOARD_TENANT_CHANNEL = "REDIS_OFFBOARD_TENANT_CHANNEL";
const REDIS_CONFIG_BLOCKLIST_CHANNEL = "EVENT_QUEUE_REDIS_CONFIG_BLOCKLIST_CHANNEL";
const COMPONENT_NAME = "/eventQueue/config";
const MIN_INTERVAL_SEC = 10;
const DEFAULT_LOAD = 1;
const DEFAULT_PRIORITY = Priorities.Medium;
const DEFAULT_INCREASE_PRIORITY = true;
const DEFAULT_KEEP_ALIVE_INTERVAL_MIN = 1;
const DEFAULT_MAX_FACTOR_STUCK_2_KEEP_ALIVE_INTERVAL = 3.5;
const SUFFIX_PERIODIC = "_PERIODIC";
const COMMAND_BLOCK = "EVENT_QUEUE_EVENT_BLOCK";
const COMMAND_UNBLOCK = "EVENT_QUEUE_EVENT_UNBLOCK";
const CAP_EVENT_TYPE = "CAP_OUTBOX";
const CAP_PARALLEL_DEFAULT = 5;
const DELETE_TENANT_BLOCK_AFTER_MS = 5 * 60 * 1000;
const PRIORITIES = Object.values(Priorities);
const UTC_DEFAULT = false;
const USE_CRON_TZ_DEFAULT = true;

const BASE_PERIODIC_EVENTS = [
  {
    type: "EVENT_QUEUE_BASE",
    subType: "DELETE_EVENTS",
    priority: Priorities.Low,
    impl: "./housekeeping/EventQueueDeleteEvents",
    load: 20,
    interval: 86400, // 1 day,
    internalEvent: true,
  },
];

const BASE_TABLES = {
  EVENT: "sap.eventqueue.Event",
  LOCK: "sap.eventqueue.Lock",
};

class Config {
  #logger;
  #config;
  #forUpdateTimeout;
  #globalTxTimeout;
  #runInterval;
  #redisEnabled;
  #initialized;
  #instanceLoadLimit;
  #tableNameEventQueue;
  #tableNameEventLock;
  #isEventQueueActive;
  #configFilePath;
  #processEventsAfterPublish;
  #registerAsEventProcessor;
  #disableRedis;
  #env;
  #eventMap;
  #updatePeriodicEvents;
  #blockedEvents;
  #isEventBlockedCb;
  #thresholdLoggingEventProcessing;
  #useAsCAPOutbox;
  #userId;
  #cleanupLocksAndEventsForDev;
  #redisOptions;
  #insertEventsBeforeCommit;
  #enableCAPTelemetry;
  #unsubscribeHandlers = [];
  #unsubscribedTenants = {};
  #cronTimezone;
  #publishEventBlockList;
  #crashOnRedisUnavailable;
  #tenantIdFilterTokenInfoCb;
  #tenantIdFilterEventProcessingCb;
  static #instance;
  constructor() {
    this.#logger = cds.log(COMPONENT_NAME);
    this.#config = null;
    this.#forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.#globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.#runInterval = null;
    this.#redisEnabled = null;
    this.#initialized = false;
    this.#instanceLoadLimit = 100;
    this.#tableNameEventQueue = null;
    this.#tableNameEventLock = null;
    this.#isEventQueueActive = true;
    this.#configFilePath = null;
    this.#processEventsAfterPublish = null;
    this.#disableRedis = null;
    this.#env = getEnvInstance();
    this.#blockedEvents = {};
  }

  getEventConfig(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)];
  }

  isCapOutboxEvent(type) {
    return type === CAP_EVENT_TYPE;
  }

  hasEventAfterCommitFlag(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)]?.processAfterCommit ?? true;
  }

  _checkRedisIsBound() {
    return !!this.#env.redisRequires?.credentials;
  }

  shouldBeProcessedInThisApplication(type, subType) {
    const config = this.#eventMap[this.generateKey(type, subType)];
    const appNameConfig = config._appNameMap;
    const appInstanceConfig = config._appInstancesMap;
    if (!appNameConfig && !appInstanceConfig) {
      return true;
    }

    if (appNameConfig) {
      const shouldBeProcessedBasedOnAppName = appNameConfig[this.#env.applicationName];
      if (!shouldBeProcessedBasedOnAppName) {
        return false;
      }
    }

    if (appInstanceConfig) {
      const shouldBeProcessedBasedOnAppInstance = appInstanceConfig[this.#env.applicationInstance];
      if (!shouldBeProcessedBasedOnAppInstance) {
        return false;
      }
    }

    return true;
  }

  checkRedisEnabled() {
    this.#redisEnabled = !this.#disableRedis && this._checkRedisIsBound();
    return this.#redisEnabled;
  }

  attachConfigChangeHandler() {
    this.#attachBlockListChangeHandler();
    redis.subscribeRedisChannel(this.#redisOptions, REDIS_CONFIG_CHANNEL, (messageData) => {
      try {
        const { key, value } = JSON.parse(messageData);
        if (this[key] !== value) {
          this.#logger.info("received config change", { key, value });
          this[key] = value;
        }
      } catch (err) {
        this.#logger.error("could not parse event config change", err, {
          messageData,
        });
      }
    });
  }

  attachRedisUnsubscribeHandler() {
    this.#logger.info("attached redis handle for unsubscribe events");
    redis.subscribeRedisChannel(this.#redisOptions, REDIS_OFFBOARD_TENANT_CHANNEL, (messageData) => {
      try {
        const { tenantId } = JSON.parse(messageData);
        this.#logger.info("received unsubscribe broadcast event", { tenantId });
        this.executeUnsubscribeHandlers(tenantId);
      } catch (err) {
        this.#logger.error("could not parse unsubscribe broadcast event", err, {
          messageData,
        });
      }
    });
  }

  executeUnsubscribeHandlers(tenantId) {
    this.#unsubscribedTenants[tenantId] = true;
    setTimeout(() => delete this.#unsubscribedTenants[tenantId], DELETE_TENANT_BLOCK_AFTER_MS);
    for (const unsubscribeHandler of this.#unsubscribeHandlers) {
      try {
        unsubscribeHandler(tenantId);
      } catch (err) {
        this.#logger.error("could executing unsubscribe handler", err, {
          tenantId,
        });
      }
    }
  }

  handleUnsubscribe(tenantId) {
    if (this.redisEnabled) {
      redis
        .publishMessage(this.#redisOptions, REDIS_OFFBOARD_TENANT_CHANNEL, JSON.stringify({ tenantId }))
        .catch((error) => {
          this.#logger.error(`publishing tenant unsubscribe failed. tenantId: ${tenantId}`, error);
        });
    } else {
      this.executeUnsubscribeHandlers(tenantId);
    }
  }

  attachUnsubscribeHandler(cb) {
    this.#unsubscribeHandlers.push(cb);
  }

  publishConfigChange(key, value) {
    if (!this.redisEnabled) {
      this.#logger.info("redis not connected, config change won't be published", { key, value });
      return;
    }
    redis.publishMessage(this.#redisOptions, REDIS_CONFIG_CHANNEL, JSON.stringify({ key, value })).catch((error) => {
      this.#logger.error(`publishing config change failed key: ${key}, value: ${value}`, error);
    });
  }

  #attachBlockListChangeHandler() {
    redis.subscribeRedisChannel(this.#redisOptions, REDIS_CONFIG_BLOCKLIST_CHANNEL, (messageData) => {
      try {
        const { command, key, tenant } = JSON.parse(messageData);
        if (command === COMMAND_BLOCK) {
          this.#blockEventLocalState(key, tenant);
        } else {
          this.#unblockEventLocalState(key, tenant);
        }
      } catch (err) {
        this.#logger.error("could not parse event blocklist change", err, {
          messageData,
        });
      }
    });
  }

  blockEvent(type, subType, isPeriodic, tenant = "*") {
    const typeWithSuffix = `${type}${isPeriodic ? SUFFIX_PERIODIC : ""}`;
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    const key = this.generateKey(typeWithSuffix, subType);
    this.#blockEventLocalState(key, tenant);
    if (!this.redisEnabled || !this.publishEventBlockList) {
      return;
    }

    redis
      .publishMessage(
        this.#redisOptions,
        REDIS_CONFIG_BLOCKLIST_CHANNEL,
        JSON.stringify({ command: COMMAND_BLOCK, key, tenant })
      )
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  #blockEventLocalState(key, tenant) {
    this.#blockedEvents[key] ??= {};
    this.#blockedEvents[key][tenant] = true;
    return key;
  }

  clearPeriodicEventBlockList() {
    this.#blockedEvents = {};
  }

  unblockEvent(type, subType, isPeriodic, tenant = "*") {
    const typeWithSuffix = `${type}${isPeriodic ? SUFFIX_PERIODIC : ""}`;
    const key = this.generateKey(typeWithSuffix, subType);
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    this.#unblockEventLocalState(key, tenant);
    if (!this.redisEnabled) {
      return;
    }

    redis
      .publishMessage(
        this.#redisOptions,
        REDIS_CONFIG_BLOCKLIST_CHANNEL,
        JSON.stringify({ command: COMMAND_UNBLOCK, key, tenant })
      )
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  addCAPOutboxEvent(serviceName, config) {
    if (this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)]) {
      const index = this.#config.events.findIndex(
        (event) => event.type === CAP_EVENT_TYPE && event.subType === serviceName
      );
      this.#config.events.splice(index, 1);
    }

    const eventConfig = {
      type: CAP_EVENT_TYPE,
      subType: serviceName,
      load: config.load,
      impl: "./outbox/EventQueueGenericOutboxHandler",
      selectMaxChunkSize: config.chunkSize,
      parallelEventProcessing: config.parallelEventProcessing ?? (config.parallel && CAP_PARALLEL_DEFAULT),
      retryAttempts: config.maxAttempts,
      transactionMode: config.transactionMode,
      processAfterCommit: config.processAfterCommit,
      eventOutdatedCheck: config.eventOutdatedCheck,
      checkForNextChunk: config.checkForNextChunk,
      deleteFinishedEventsAfterDays: config.deleteFinishedEventsAfterDays,
      appNames: config.appNames,
      appInstances: config.appInstances,
      useEventQueueUser: config.useEventQueueUser,
      retryFailedAfter: config.retryFailedAfter,
      priority: config.priority,
      multiInstanceProcessing: config.multiInstanceProcessing,
      increasePriorityOverTime: config.increasePriorityOverTime,
      keepAliveInterval: config.keepAliveInterval,
      internalEvent: true,
    };

    this.#basicEventTransformation(eventConfig);
    this.#basicEventTransformationAfterValidate(eventConfig);
    this.#config.events.push(eventConfig);
    this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)] = eventConfig;
  }

  #unblockEventLocalState(key, tenant) {
    const map = this.#blockedEvents[key];
    if (!map) {
      return;
    }
    this.#blockedEvents[key][tenant] = false;
    return key;
  }

  isEventBlocked(type, subType, isPeriodicEvent, tenant) {
    const map = this.#blockedEvents[this.generateKey(`${type}${isPeriodicEvent ? SUFFIX_PERIODIC : ""}`, subType)];
    if (!map) {
      return false;
    }
    const tenantSpecific = map[tenant];
    const allTenants = map["*"];
    return tenantSpecific ?? allTenants;
  }

  get isEventQueueActive() {
    return this.#isEventQueueActive;
  }

  set isEventQueueActive(value) {
    this.#isEventQueueActive = value;
  }

  set fileContent(config) {
    this.#config = config;
    config.events = config.events ?? [];
    const shouldIncludeBaseEvents = cds.env.profiles.includes("production") || cds.env.profiles.includes("test");
    config.periodicEvents = (config.periodicEvents ?? []).concat(
      (shouldIncludeBaseEvents ? BASE_PERIODIC_EVENTS : []).map((event) => ({ ...event }))
    );
    this.#eventMap = config.events.reduce((result, event) => {
      this.#basicEventTransformation(event);
      this.#validateAdHocEvents(result, event);
      this.#basicEventTransformationAfterValidate(event);
      result[this.generateKey(event.type, event.subType)] = event;
      return result;
    }, {});
    this.#eventMap = config.periodicEvents.reduce((result, event) => {
      event.type = `${event.type}${SUFFIX_PERIODIC}`;
      event.isPeriodic = true;
      this.#basicEventTransformation(event);
      this.#validatePeriodicConfig(result, event);
      this.#basicEventTransformationAfterValidate(event);
      result[this.generateKey(event.type, event.subType)] = event;
      return result;
    }, this.#eventMap);
  }

  #basicEventTransformation(event) {
    event.load = event.load ?? DEFAULT_LOAD;
    event.priority = event.priority ?? DEFAULT_PRIORITY;
    event.increasePriorityOverTime = event.increasePriorityOverTime ?? DEFAULT_INCREASE_PRIORITY;
    event.keepAliveInterval = event.keepAliveInterval ?? DEFAULT_KEEP_ALIVE_INTERVAL_MIN;
    event.keepAliveMaxInProgressTime = event.keepAliveInterval * DEFAULT_MAX_FACTOR_STUCK_2_KEEP_ALIVE_INTERVAL;
  }

  #basicEventTransformationAfterValidate(event) {
    event._appNameMap = event.appNames ? Object.fromEntries(new Map(event.appNames.map((a) => [a, true]))) : null;
    event._appInstancesMap = event.appInstances
      ? Object.fromEntries(new Map(event.appInstances.map((a) => [a, true])))
      : null;
  }

  #basicEventValidation(event) {
    if (!event.impl) {
      throw EventQueueError.missingImpl(event.type, event.subType);
    }

    if (event.appNames) {
      if (!Array.isArray(event.appNames) || event.appNames.some((appName) => typeof appName !== "string")) {
        throw EventQueueError.appNamesFormat(event.type, event.subType, event.appNames);
      }
    }

    if (event.appInstances) {
      if (
        !Array.isArray(event.appInstances) ||
        event.appInstances.some((appInstance) => typeof appInstance !== "number")
      ) {
        throw EventQueueError.appInstancesFormat(event.type, event.subType, event.appInstances);
      }
    }

    if (!PRIORITIES.includes(event.priority)) {
      throw EventQueueError.priorityNotAllowed(event.priority, "initEvent");
    }

    if (event.load > this.#instanceLoadLimit) {
      throw EventQueueError.loadHigherThanLimit(event.load, "initEvent");
    }
  }

  #validatePeriodicConfig(eventMap, event) {
    const key = this.generateKey(event.type, event.subType);
    if (eventMap[key] && eventMap[key].isPeriodic) {
      throw EventQueueError.duplicateEventRegistration(event.type, event.subType);
    }

    if (!event.cron && !event.interval) {
      throw EventQueueError.noCronOrInterval(event.type, event.subType);
    }

    if (event.cron && event.interval) {
      throw EventQueueError.cronAndInterval(event.type, event.subType);
    }

    if (event.cron) {
      let cron;
      event.utc = event.utc ?? UTC_DEFAULT;
      event.useCronTimezone = event.useCronTimezone ?? USE_CRON_TZ_DEFAULT;
      try {
        cron = cronParser.parseExpression(event.cron);
      } catch {
        throw EventQueueError.cantParseCronExpression(event.type, event.subType, event.cron);
      }
      const next = cron.next();
      const afterNext = cron.next();
      const diffInSeconds = (afterNext.getTime() - next.getTime()) / 1000;
      if (diffInSeconds <= MIN_INTERVAL_SEC) {
        throw EventQueueError.invalidIntervalBetweenCron(event.type, event.subType, diffInSeconds);
      }
      return this.#basicEventValidation(event);
    }

    if (!event.interval || event.interval <= MIN_INTERVAL_SEC) {
      throw EventQueueError.invalidInterval(event.type, event.subType, event.interval);
    }

    if (event.multiInstanceProcessing) {
      throw EventQueueError.multiInstanceProcessingNotAllowed(event.type, event.subType);
    }

    this.#basicEventValidation(event);
  }

  #validateAdHocEvents(eventMap, event) {
    const key = this.generateKey(event.type, event.subType);
    if (eventMap[key] && !eventMap[key].isPeriodic) {
      throw EventQueueError.duplicateEventRegistration(event.type, event.subType);
    }

    if (this.isMultiTenancy && event.multiInstanceProcessing) {
      throw EventQueueError.multiInstanceProcessingNotAllowed(event.type, event.subType);
    }

    this.#basicEventValidation(event);
  }

  generateKey(type, subType) {
    return [type, subType].join("##");
  }

  removeEvent(type, subType) {
    const index = this.#config.events.findIndex((event) => event.type === "CAP_OUTBOX");
    if (index >= 0) {
      this.#config.events.splice(index, 1);
    }
    delete this.#eventMap[this.generateKey(type, subType)];
  }

  isTenantUnsubscribed(tenantId) {
    return this.#unsubscribedTenants[tenantId];
  }

  get fileContent() {
    return this.#config;
  }

  get events() {
    return this.#config.events;
  }

  get periodicEvents() {
    return this.#config.periodicEvents;
  }

  isPeriodicEvent(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)]?.isPeriodic;
  }

  get allEvents() {
    return this.#config.events.concat(this.#config.periodicEvents);
  }

  get forUpdateTimeout() {
    return this.#forUpdateTimeout;
  }

  get globalTxTimeout() {
    return this.#globalTxTimeout;
  }

  set forUpdateTimeout(value) {
    this.#forUpdateTimeout = value;
  }

  get publishEventBlockList() {
    return this.#publishEventBlockList;
  }

  set publishEventBlockList(value) {
    this.#publishEventBlockList = value;
  }

  get crashOnRedisUnavailable() {
    return this.#crashOnRedisUnavailable;
  }

  set crashOnRedisUnavailable(value) {
    this.#crashOnRedisUnavailable = value;
  }

  get tenantIdFilterTokenInfo() {
    return this.#tenantIdFilterTokenInfoCb;
  }

  set tenantIdFilterTokenInfo(value) {
    this.#tenantIdFilterTokenInfoCb = value;
  }

  get tenantIdFilterEventProcessing() {
    return this.#tenantIdFilterEventProcessingCb;
  }

  set tenantIdFilterEventProcessing(value) {
    this.#tenantIdFilterEventProcessingCb = value;
  }

  set globalTxTimeout(value) {
    this.#globalTxTimeout = value;
  }

  get runInterval() {
    return this.#runInterval;
  }

  set runInterval(value) {
    if (!Number.isInteger(value) || value <= 10 * 1000) {
      throw EventQueueError.invalidInterval();
    }
    this.#runInterval = value;
  }

  get redisEnabled() {
    return this.#redisEnabled;
  }

  set redisEnabled(value) {
    this.#redisEnabled = value;
  }

  get initialized() {
    return this.#initialized;
  }

  set initialized(value) {
    this.#initialized = value;
  }

  get cronTimezone() {
    return this.#cronTimezone;
  }

  set cronTimezone(value) {
    this.#cronTimezone = value;
  }

  get instanceLoadLimit() {
    return this.#instanceLoadLimit;
  }

  set instanceLoadLimit(value) {
    this.#instanceLoadLimit = value;
  }

  get isEventBlockedCb() {
    return this.#isEventBlockedCb;
  }

  set isEventBlockedCb(value) {
    this.#isEventBlockedCb = value;
  }

  get tableNameEventQueue() {
    return BASE_TABLES.EVENT;
  }

  get tableNameEventLock() {
    return BASE_TABLES.LOCK;
  }

  set configFilePath(value) {
    this.#configFilePath = value;
  }

  get configFilePath() {
    return this.#configFilePath;
  }

  set processEventsAfterPublish(value) {
    this.#processEventsAfterPublish = value;
  }

  get processEventsAfterPublish() {
    return this.#processEventsAfterPublish;
  }

  set disableRedis(value) {
    this.#disableRedis = value;
  }

  get disableRedis() {
    return this.#disableRedis;
  }

  set updatePeriodicEvents(value) {
    this.#updatePeriodicEvents = value;
  }

  get updatePeriodicEvents() {
    return this.#updatePeriodicEvents;
  }

  set registerAsEventProcessor(value) {
    this.#registerAsEventProcessor = value;
  }

  get registerAsEventProcessor() {
    return this.#registerAsEventProcessor;
  }

  set thresholdLoggingEventProcessing(value) {
    this.#thresholdLoggingEventProcessing = value;
  }

  get thresholdLoggingEventProcessing() {
    return this.#thresholdLoggingEventProcessing;
  }

  set useAsCAPOutbox(value) {
    this.#useAsCAPOutbox = value;
  }

  get useAsCAPOutbox() {
    return this.#useAsCAPOutbox;
  }

  set userId(value) {
    this.#userId = value;
  }

  get userId() {
    return this.#userId;
  }

  set cleanupLocksAndEventsForDev(value) {
    this.#cleanupLocksAndEventsForDev = value;
  }

  get cleanupLocksAndEventsForDev() {
    return this.#cleanupLocksAndEventsForDev;
  }

  set redisOptions(value) {
    this.#redisOptions = value;
  }

  get redisOptions() {
    return this.#redisOptions;
  }

  set insertEventsBeforeCommit(value) {
    this.#insertEventsBeforeCommit = value;
  }

  get insertEventsBeforeCommit() {
    return this.#insertEventsBeforeCommit;
  }

  set enableCAPTelemetry(value) {
    this.#enableCAPTelemetry = value;
  }

  get enableCAPTelemetry() {
    return this.#enableCAPTelemetry;
  }

  get isMultiTenancy() {
    return !!cds.requires.multitenancy;
  }

  /**
    @return { Config }
  **/
  static get instance() {
    if (!Config.#instance) {
      Config.#instance = new Config();
    }
    return Config.#instance;
  }
}

const instance = Config.instance;

module.exports = instance;
