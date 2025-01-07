"use strict";

const cds = require("@sap/cds");

let instance;

class Env {
  #vcapApplication;
  #vcapApplicationInstance;

  constructor() {
    try {
      this.#vcapApplication = JSON.parse(process.env.VCAP_APPLICATION);
    } catch {
      this.#vcapApplication = {};
    }
    this.#vcapApplicationInstance = Number(process.env.CF_INSTANCE_INDEX);
  }

  get redisCredentials() {
    return cds.requires["eventqueue-redis-cache"].credentials;
  }

  get applicationName() {
    return this.#vcapApplication.application_name;
  }

  get applicationInstance() {
    return this.#vcapApplicationInstance;
  }

  set applicationInstance(value) {
    this.#vcapApplicationInstance = value;
  }

  set vcapApplication(value) {
    this.#vcapApplication = value;
  }

  get vcapApplication() {
    return this.#vcapApplication;
  }
}

module.exports = {
  getEnvInstance: () => {
    if (!instance) {
      instance = new Env();
    }
    return instance;
  },
};
