"use strict";

let instance;

class Env {
  #isLocal;
  #vcapServices;

  constructor() {
    try {
      this.#vcapServices = JSON.parse(process.env.VCAP_SERVICES);
    } catch {
      this.#vcapServices = {};
    }
  }

  getRedisCredentialsFromEnv() {
    return this.#vcapServices["redis-cache"]?.[0]?.credentials;
  }

  set isLocal(value) {
    this.#isLocal = value;
  }
  get isLocal() {
    return this.#isLocal;
  }

  set vcapServices(value) {
    this.#vcapServices = value;
  }
  get vcapServices() {
    return this.#vcapServices;
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
