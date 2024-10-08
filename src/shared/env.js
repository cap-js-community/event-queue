"use strict";

let instance;

class Env {
  #vcapServices;
  #vcapApplication;
  #vcapApplicationInstance;

  constructor() {
    try {
      this.#vcapServices = JSON.parse(process.env.VCAP_SERVICES);
      this.#vcapApplication = JSON.parse(process.env.VCAP_APPLICATION);
    } catch {
      this.#vcapServices = {};
      this.#vcapApplication = {};
    }
    this.#vcapApplicationInstance = Number(process.env.CF_INSTANCE_INDEX);
  }

  get redisCredentialsFromEnv() {
    return this.#vcapServices["redis-cache"]?.[0]?.credentials;
  }

  get applicationName() {
    return this.#vcapApplication.application_name;
  }

  get applicationInstance() {
    return this.#vcapApplicationInstance;
  }

  set vcapServices(value) {
    this.#vcapServices = value;
  }

  get vcapServices() {
    return this.#vcapServices;
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
