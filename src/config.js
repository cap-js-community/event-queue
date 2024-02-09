"use strict";

const cds = require("@sap/cds");

const { getEnvInstance } = require("./shared/env");
const redis = require("./shared/redis");
const EventQueueError = require("./EventQueueError");

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;
const REDIS_CONFIG_CHANNEL = "EVENT_QUEUE_CONFIG_CHANNEL";
const REDIS_CONFIG_BLOCKLIST_CHANNEL = "REDIS_CONFIG_BLOCKLIST_CHANNEL";
const COMPONENT_NAME = "/eventQueue/config";
const MIN_INTERVAL_SEC = 10;
const DEFAULT_LOAD = 1;
const SUFFIX_PERIODIC = "_PERIODIC";
const COMMAND_BLOCK = "EVENT_QUEUE_EVENT_BLOCK";
const COMMAND_UNBLOCK = "EVENT_QUEUE_EVENT_UNBLOCK";
const CAP_EVENT_TYPE = "CAP_OUTBOX";

const CAP_PARALLEL_DEFAULT = 5;

const BASE_PERIODIC_EVENTS = [
  {
    type: "EVENT_QUEUE_BASE",
    subType: "DELETE_EVENTS",
    impl: "./housekeeping/EventQueueDeleteEvents",
    load: 1,
    interval: 86400, // 1 day,
    internalEvent: true,
  },
];

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
  #skipCsnCheck;
  #registerAsEventProcessor;
  #disableRedis;
  #env;
  #eventMap;
  #updatePeriodicEvents;
  #blockedPeriodicEvents;
  #isPeriodicEventBlockedCb;
  #thresholdLoggingEventProcessing;
  #useAsCAPOutbox;
  #userId;
  #enableTxConsistencyCheck;
  #cleanupLocksAndEventsForDev;
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
    this.#skipCsnCheck = null;
    this.#disableRedis = null;
    this.#env = getEnvInstance();
    this.#blockedPeriodicEvents = {};
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
    return !!this.#env.getRedisCredentialsFromEnv();
  }

  checkRedisEnabled() {
    this.#redisEnabled = !this.#disableRedis && this._checkRedisIsBound() && this.#env.isOnCF;
  }

  attachConfigChangeHandler() {
    this.#attachBlocklistChangeHandler();
    redis.subscribeRedisChannel(REDIS_CONFIG_CHANNEL, (messageData) => {
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

  publishConfigChange(key, value) {
    if (!this.redisEnabled) {
      this.#logger.info("redis not connected, config change won't be published", { key, value });
      return;
    }
    redis.publishMessage(REDIS_CONFIG_CHANNEL, JSON.stringify({ key, value })).catch((error) => {
      this.#logger.error(`publishing config change failed key: ${key}, value: ${value}`, error);
    });
  }

  #attachBlocklistChangeHandler() {
    redis.subscribeRedisChannel(REDIS_CONFIG_BLOCKLIST_CHANNEL, (messageData) => {
      try {
        const { command, key, tenant } = JSON.parse(messageData);
        if (command === COMMAND_BLOCK) {
          this.#blockPeriodicEventLocalState(key, tenant);
        } else {
          this.#unblockPeriodicEventLocalState(key, tenant);
        }
      } catch (err) {
        this.#logger.error("could not parse event blocklist change", err, {
          messageData,
        });
      }
    });
  }

  blockPeriodicEvent(type, subType, tenant = "*") {
    const typeWithSuffix = `${type}${SUFFIX_PERIODIC}`;
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    const key = this.generateKey(typeWithSuffix, subType);
    this.#blockPeriodicEventLocalState(key, tenant);
    if (!this.redisEnabled) {
      return;
    }

    redis
      .publishMessage(REDIS_CONFIG_BLOCKLIST_CHANNEL, JSON.stringify({ command: COMMAND_BLOCK, key, tenant }))
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  #blockPeriodicEventLocalState(key, tenant) {
    this.#blockedPeriodicEvents[key] ??= {};
    this.#blockedPeriodicEvents[key][tenant] = true;
    return key;
  }

  clearPeriodicEventBlockList() {
    this.#blockedPeriodicEvents = {};
  }

  unblockPeriodicEvent(type, subType, tenant = "*") {
    const typeWithSuffix = `${type}${SUFFIX_PERIODIC}`;
    const key = this.generateKey(typeWithSuffix, subType);
    const config = this.getEventConfig(typeWithSuffix, subType);
    if (!config) {
      return;
    }
    this.#unblockPeriodicEventLocalState(key, tenant);
    if (!this.redisEnabled) {
      return;
    }

    redis
      .publishMessage(REDIS_CONFIG_BLOCKLIST_CHANNEL, JSON.stringify({ command: COMMAND_UNBLOCK, key, tenant }))
      .catch((error) => {
        this.#logger.error(`publishing config block failed key: ${key}`, error);
      });
  }

  addCAPOutboxEvent(serviceName, config) {
    if (this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)]) {
      return;
    }

    const eventConfig = {
      type: CAP_EVENT_TYPE,
      subType: serviceName,
      load: config.load ?? DEFAULT_LOAD,
      impl: "./outbox/EventQueueGenericOutboxHandler",
      selectMaxChunkSize: config.chunkSize,
      parallelEventProcessing: config.parallelEventProcessing ?? (config.parallel && CAP_PARALLEL_DEFAULT),
      retryAttempts: config.maxAttempts,
      transactionMode: config.transactionMode,
      processAfterCommit: config.processAfterCommit,
      eventOutdatedCheck: config.eventOutdatedCheck,
      checkForNextChunk: config.checkForNextChunk,
      deleteFinishedEventsAfterDays: config.deleteFinishedEventsAfterDays,
      internalEvent: true,
    };
    this.#config.events.push(eventConfig);
    this.#eventMap[this.generateKey(CAP_EVENT_TYPE, serviceName)] = eventConfig;
  }

  #unblockPeriodicEventLocalState(key, tenant) {
    const map = this.#blockedPeriodicEvents[key];
    if (!map) {
      return;
    }
    this.#blockedPeriodicEvents[key][tenant] = false;
    return key;
  }

  isPeriodicEventBlocked(type, subType, tenant) {
    const map = this.#blockedPeriodicEvents[this.generateKey(type, subType)];
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
    config.periodicEvents = (config.periodicEvents ?? []).concat(BASE_PERIODIC_EVENTS.map((event) => ({ ...event })));
    this.#eventMap = config.events.reduce((result, event) => {
      event.load = event.load ?? DEFAULT_LOAD;
      this.validateAdHocEvents(result, event);
      result[this.generateKey(event.type, event.subType)] = event;
      return result;
    }, {});
    this.#eventMap = config.periodicEvents.reduce((result, event) => {
      event.load = event.load ?? DEFAULT_LOAD;
      event.type = `${event.type}${SUFFIX_PERIODIC}`;
      event.isPeriodic = true;
      this.validatePeriodicConfig(result, event);
      result[this.generateKey(event.type, event.subType)] = event;
      return result;
    }, this.#eventMap);
  }

  validatePeriodicConfig(eventMap, config) {
    const key = this.generateKey(config.type, config.subType);
    if (eventMap[key] && eventMap[key].isPeriodic) {
      throw EventQueueError.duplicateEventRegistration(config.type, config.subType);
    }

    if (!config.interval || config.interval <= MIN_INTERVAL_SEC) {
      throw EventQueueError.invalidInterval(config.type, config.subType, config.interval);
    }

    if (!config.impl) {
      throw EventQueueError.missingImpl(config.type, config.subType);
    }
  }

  validateAdHocEvents(eventMap, config) {
    const key = this.generateKey(config.type, config.subType);
    if (eventMap[key] && !eventMap[key].isPeriodic) {
      throw EventQueueError.duplicateEventRegistration(config.type, config.subType);
    }

    if (!config.impl) {
      throw EventQueueError.missingImpl(config.type, config.subType);
    }
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

  get instanceLoadLimit() {
    return this.#instanceLoadLimit;
  }

  set instanceLoadLimit(value) {
    this.#instanceLoadLimit = value;
  }

  get isPeriodicEventBlockedCb() {
    return this.#isPeriodicEventBlockedCb;
  }

  set isPeriodicEventBlockedCb(value) {
    this.#isPeriodicEventBlockedCb = value;
  }

  get tableNameEventQueue() {
    return this.#tableNameEventQueue;
  }

  set tableNameEventQueue(value) {
    this.#tableNameEventQueue = value;
  }

  get tableNameEventLock() {
    return this.#tableNameEventLock;
  }

  set tableNameEventLock(value) {
    this.#tableNameEventLock = value;
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

  set skipCsnCheck(value) {
    this.#skipCsnCheck = value;
  }

  get skipCsnCheck() {
    return this.#skipCsnCheck;
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

  set enableTxConsistencyCheck(value) {
    this.#enableTxConsistencyCheck = value;
  }

  get enableTxConsistencyCheck() {
    return this.#enableTxConsistencyCheck;
  }

  set cleanupLocksAndEventsForDev(value) {
    this.#cleanupLocksAndEventsForDev = value;
  }

  get cleanupLocksAndEventsForDev() {
    return this.#cleanupLocksAndEventsForDev;
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
