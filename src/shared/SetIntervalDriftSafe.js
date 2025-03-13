"use strict";

const COMPONENT = "eventQueue/SetIntervalDriftSafe";

class SetIntervalDriftSafe {
  #adjustedInterval;
  #interval;
  #expectedCycleTime = 0;
  #nextTickScheduledFor;
  #logger;
  #shouldRun = true;
  #lastTimeoutId;

  constructor(interval) {
    this.#interval = interval;
    this.#adjustedInterval = interval;
    this.#logger = cds.log(COMPONENT);
  }

  start(fn) {
    this.#shouldRun = true;
    this.run(fn);
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
    const timeoutId = setTimeout(() => {
      if (!this.#shouldRun) {
        return;
      }
      this.run(fn);
      fn();
    }, this.#adjustedInterval).unref();
    this.#lastTimeoutId = Number(timeoutId);
  }

  stop() {
    this.#shouldRun = false;
    clearTimeout(this.#lastTimeoutId);
  }
}

module.exports = SetIntervalDriftSafe;
