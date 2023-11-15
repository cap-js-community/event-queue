"use strict";

const cds = require("@sap/cds");

const { getEnvInstance } = require("./shared/env");
const redis = require("./shared/redis");
const EventQueueError = require("./EventQueueError");

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;
const REDIS_CONFIG_CHANNEL = "EVENT_QUEUE_CONFIG_CHANNEL";
const COMPONENT_NAME = "eventQueue/config";
const MIN_INTERVAL_SEC = 10;

class Config {
  #logger;
  #config;
  #forUpdateTimeout;
  #globalTxTimeout;
  #runInterval;
  #redisEnabled;
  #initialized;
  #parallelTenantProcessing;
  #tableNameEventQueue;
  #tableNameEventLock;
  #isRunnerDeactivated;
  #configFilePath;
  #processEventsAfterPublish;
  #skipCsnCheck;
  #disableRedis;
  #env;
  #eventMap;
  #updatePeriodicEvents;
  static #instance;
  constructor() {
    this.#logger = cds.log(COMPONENT_NAME);
    this.#config = null;
    this.#forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.#globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.#runInterval = null;
    this.#redisEnabled = null;
    this.#initialized = false;
    this.#parallelTenantProcessing = null;
    this.#tableNameEventQueue = null;
    this.#tableNameEventLock = null;
    this.#isRunnerDeactivated = false;
    this.#configFilePath = null;
    this.#processEventsAfterPublish = null;
    this.#skipCsnCheck = null;
    this.#disableRedis = null;
    this.#env = getEnvInstance();
  }

  getEventConfig(type, subType) {
    return this.#eventMap[this.generateKey(type, subType)];
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
    redis.subscribeRedisChannel(REDIS_CONFIG_CHANNEL, (messageData) => {
      try {
        const { key, value } = JSON.parse(messageData);
        if (this[key] !== value) {
          this.#logger.info("received config change", { key, value });
          this[key] = value;
        }
      } catch (err) {
        this.#logger.error("could not parse event config change", {
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

  get isRunnerDeactivated() {
    return this.#isRunnerDeactivated;
  }

  set isRunnerDeactivated(value) {
    this.#isRunnerDeactivated = value;
  }

  set fileContent(config) {
    this.#config = config;
    config.events = config.events ?? [];
    config.periodicEvents = config.periodicEvents ?? [];
    this.#eventMap = config.events.reduce((result, event) => {
      this.validateAdHocEvents(result, event);
      result[[event.type, event.subType].join("##")] = event;
      return result;
    }, {});
    this.#eventMap = config.periodicEvents.reduce((result, event) => {
      const SUFFIX_PERIODIC = "_PERIODIC";
      event.type = `${event.type}${SUFFIX_PERIODIC}`;
      event.isPeriodic = true;
      this.validatePeriodicConfig(result, event);
      result[[event.type, event.subType].join("##")] = event;
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

  get parallelTenantProcessing() {
    return this.#parallelTenantProcessing;
  }

  set parallelTenantProcessing(value) {
    this.#parallelTenantProcessing = value;
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
