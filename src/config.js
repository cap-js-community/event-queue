"use strict";

const cds = require("@sap/cds");

const { getEnvInstance: getEnvInstance } = require("./shared/env");
const redis = require("./shared/redis");

let instance;

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;
const REDIS_CONFIG_CHANNEL = "EVENT_QUEUE_CONFIG_CHANNEL";
const COMPONENT_NAME = "eventQueue/config";

class Config {
  constructor() {
    this.__logger = cds.log(COMPONENT_NAME);
    this.__config = null;
    this.__forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.__globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.__runInterval = null;
    this.__redisEnabled = null;
    this.__initialized = false;
    this.__parallelTenantProcessing = null;
    this.__tableNameEventQueue = null;
    this.__tableNameEventLock = null;
    this.__isRunnerDeactivated = false;
    this.__configFilePath = null;
    this.__processEventsAfterPublish = null;
    this.__skipCsnCheck = null;
    this.__env = getEnvInstance();
  }

  getEventConfig(type, subType) {
    return this.__eventMap[[type, subType].join("##")];
  }

  hasEventAfterCommitFlag(type, subType) {
    return this.__eventMap[[type, subType].join("##")]?.processAfterCommit ?? true;
  }

  _checkRedisIsBound() {
    return !!this.__env.getRedisCredentialsFromEnv();
  }

  checkRedisEnabled() {
    this.__redisEnabled = this._checkRedisIsBound() && this.__env.isOnCF;
  }

  attachConfigChangeHandler() {
    redis.subscribeRedisChannel(REDIS_CONFIG_CHANNEL, (messageData) => {
      try {
        const { key, value } = JSON.parse(messageData);
        if (this[key] !== value) {
          this.__logger.info("received config change", { key, value });
          this[key] = value;
        }
      } catch (err) {
        this.__logger.error("could not parse event config change", {
          messageData,
        });
      }
    });
  }

  publishConfigChange(key, value) {
    if (!this.redisEnabled) {
      this.__logger.info("redis not connected, config change won't be published", { key, value });
      return;
    }
    redis.publishMessage(REDIS_CONFIG_CHANNEL, JSON.stringify({ key, value })).catch((error) => {
      this.__logger.error(`publishing config change failed key: ${key}, value: ${value}`, error);
    });
  }

  get isRunnerDeactivated() {
    return this.__isRunnerDeactivated;
  }

  set isRunnerDeactivated(value) {
    this.__isRunnerDeactivated = value;
  }

  set fileContent(config) {
    this.__config = config;
    this.__eventMap = config.events.reduce((result, event) => {
      result[[event.type, event.subType].join("##")] = event;
      return result;
    }, {});
  }

  get fileContent() {
    return this.__config;
  }

  get events() {
    return this.__config.events;
  }

  get forUpdateTimeout() {
    return this.__forUpdateTimeout;
  }

  get globalTxTimeout() {
    return this.__globalTxTimeout;
  }

  set forUpdateTimeout(value) {
    this.__forUpdateTimeout = value;
  }

  set globalTxTimeout(value) {
    this.__globalTxTimeout = value;
  }

  get runInterval() {
    return this.__runInterval;
  }

  set runInterval(value) {
    this.__runInterval = value;
  }

  get redisEnabled() {
    return this.__redisEnabled;
  }

  set redisEnabled(value) {
    this.__redisEnabled = value;
  }

  get initialized() {
    return this.__initialized;
  }

  set initialized(value) {
    this.__initialized = value;
  }

  get parallelTenantProcessing() {
    return this.__parallelTenantProcessing;
  }

  set parallelTenantProcessing(value) {
    this.__parallelTenantProcessing = value;
  }

  get tableNameEventQueue() {
    return this.__tableNameEventQueue;
  }

  set tableNameEventQueue(value) {
    this.__tableNameEventQueue = value;
  }

  get tableNameEventLock() {
    return this.__tableNameEventLock;
  }

  set tableNameEventLock(value) {
    this.__tableNameEventLock = value;
  }

  set configFilePath(value) {
    this.__configFilePath = value;
  }

  get configFilePath() {
    return this.__configFilePath;
  }

  set processEventsAfterPublish(value) {
    this.__processEventsAfterPublish = value;
  }

  get processEventsAfterPublish() {
    return this.__processEventsAfterPublish;
  }

  set skipCsnCheck(value) {
    this.__skipCsnCheck = value;
  }

  get skipCsnCheck() {
    return this.__skipCsnCheck;
  }

  get isMultiTenancy() {
    return !!cds.requires.multitenancy;
  }
}

const getConfigInstance = () => {
  if (!instance) {
    instance = new Config();
  }
  return instance;
};

module.exports = {
  getConfigInstance,
};
