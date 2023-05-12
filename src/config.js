"use strict";

let instance;

const FOR_UPDATE_TIMEOUT = 10;
const GLOBAL_TX_TIMEOUT = 30 * 60 * 1000;

class Config {
  constructor() {
    this.__config = null;
    this.__forUpdateTimeout = FOR_UPDATE_TIMEOUT;
    this.__globalTxTimeout = GLOBAL_TX_TIMEOUT;
    this.__betweenRuns = null;
    this.__betweenEvents = null;
  }

  getEventConfig(type, subType) {
    return this.__eventMap[[type, subType].join("##")];
  }

  getEventsForAutomaticRuns() {
    return this.__config.events.filter((event) => event.runAutomatically);
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

  get betweenEvents() {
    return this.__betweenEvents;
  }

  set betweenRuns(value) {
    this.__betweenRuns = value;
  }

  set betweenEvents(value) {
    this.__betweenEvents = value;
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
