"use strict";

const COMPONENT = "eventQueue/SetIntervalDriftSafe";

class SetIntervalDriftSafe {
  #adjustedInterval;
  #interval;
  #expectedCycleTime = 0;
  #nextTickScheduledFor;
  #logger;
  #shouldRun = true;

  constructor(interval) {
    this.#interval = interval;
    this.#adjustedInterval = interval;
    this.#logger = cds.log(COMPONENT);
  }

  run(fn) {
    if (!this.#shouldRun) {
      return;
    }

    const now = Date.now();
    if (this.#expectedCycleTime === 0) {
      this.#expectedCycleTime = now + this.#interval;
    } else {
      this.#adjustedInterval = this.#interval - (now - this.#expectedCycleTime);
      this.#expectedCycleTime += this.#interval;
    }
    this.#nextTickScheduledFor = now + this.#adjustedInterval;
    setTimeout(() => {
      if (!this.#shouldRun) {
        return;
      }
      this.run(fn);
      fn();
    }, this.#adjustedInterval).unref();
  }

  stop() {
    this.#shouldRun = false;
  }
}

module.exports = SetIntervalDriftSafe;
