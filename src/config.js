"use strict";

const env = require("./shared/env");

let instance;

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;

class Config {
  constructor() {
    this.__config = null;
    this.__forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.__globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.__betweenRuns = null;
    this.__redisEnabled = null;
    this.__isOnCF = env.isOnCF;
    this.__initialized = false;
    this.__parallelTenantProcessing = 1;
  }

  getEventConfig(type, subType) {
    return this.__eventMap[[type, subType].join("##")];
  }

  getEventsForAutomaticRuns() {
    return this.__config.events.filter((event) => event.runAutomatically);
  }

  hasEventAfterCommitFlag(type, subType) {
    return (
      this.__eventMap[[type, subType].join("##")]?.processAfterCommit ?? true
    );
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

  get betweenRuns() {
    return this.__betweenRuns;
  }

  set betweenRuns(value) {
    this.__betweenRuns = value;
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
