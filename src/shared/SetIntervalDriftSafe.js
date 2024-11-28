"use strict";

const COMPONENT = "eventQueue/SetIntervalDriftSafe";

class SetIntervalDriftSafe {
  #adjustedInterval;
  #interval;
  #expectedCycleTime = 0;
  #nextTickScheduledFor;
  #logger;

  constructor(interval) {
    this.#interval = interval;
    this.#adjustedInterval = interval;
    this.#logger = cds.log(COMPONENT);
  }

  run(fn) {
    const now = Date.now();
    if (this.#expectedCycleTime === 0) {
      this.#expectedCycleTime = now + this.#interval;
    } else {
      this.#adjustedInterval = this.#interval - (now - this.#expectedCycleTime);
      this.#expectedCycleTime += this.#interval;
    }
    this.#nextTickScheduledFor = now + this.#adjustedInterval;
    setTimeout(() => {
      this.run(fn);
      fn();
    }, this.#adjustedInterval).unref();
  }
}

module.exports = SetIntervalDriftSafe;
