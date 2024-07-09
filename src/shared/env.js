"use strict";

let instance;

class Env {
  #vcapServices;
  #vcapApplication;

  constructor() {
    try {
      this.#vcapServices = JSON.parse(process.env.VCAP_SERVICES);
      this.#vcapApplication = JSON.parse(process.env.VCAP_APPLICATION);
    } catch {
      this.#vcapServices = {};
      this.#vcapApplication = {};
    }
  }

  get redisCredentialsFromEnv() {
    return this.#vcapServices["redis-cache"]?.[0]?.credentials;
  }

  get applicationName() {
    return this.#vcapApplication.application_name;
  }

  set vcapServices(value) {
    this.#vcapServices = value;
  }

  get vcapServices() {
    return this.#vcapServices;
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
