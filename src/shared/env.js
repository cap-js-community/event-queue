"use strict";

let instance;

class Env {
  #isLocal;
  #isOnCF;
  #vcapServices;

  constructor() {
    this.#isLocal = process.env.USER !== "vcap";
    this.#isOnCF = !this.#isLocal;
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

  set isOnCF(value) {
    this.#isOnCF = value;
  }
  get isOnCF() {
    return this.#isOnCF;
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
