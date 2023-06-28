"use strict";

const cds = require("@sap/cds");

const env = require("./shared/env");

let instance;

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;

class Config {
  constructor() {
    this.__config = null;
    this.__forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.__globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.__runInterval = null;
    this.__redisEnabled = null;
    this.__isOnCF = env.isOnCF;
    this.__initialized = false;
    this.__parallelTenantProcessing = 1;
    this.__tableNameEventQueue = null;
    this.__tableNameEventLock = null;
    this.__vcapServices = this._parseVcapServices();
    this.__isRunnerDeactivated = false;
    this.__eventsForAutomaticRun = null;
  }

  getEventConfig(type, subType) {
    return this.__eventMap[[type, subType].join("##")];
  }

  hasEventAfterCommitFlag(type, subType) {
    return (
      this.__eventMap[[type, subType].join("##")]?.processAfterCommit ?? true
    );
  }

  _checkRedisIsBound() {
    return !!this.getRedisCredentialsFromEnv();
  }

  getRedisCredentialsFromEnv() {
    return this.__vcapServices["redis-cache"]?.[0]?.credentials;
  }

  _parseVcapServices() {
    try {
      return JSON.parse(process.env.VCAP_SERVICES);
    } catch {
      return {};
    }
  }

  calculateIsRedisEnabled() {
    this.__redisEnabled = this._checkRedisIsBound() && this.__isOnCF;
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

  get isOnCF() {
    return this.__isOnCF;
  }

  set isOnCF(value) {
    this.__isOnCF = value;
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
