"use strict";

const COMPONENT = "eventQueue/SetIntervalDriftSafe";

const ALLOWED_SHIFT_IN_PROCENT = 0.1;

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
    } else if (
      Math.abs(now + this.#interval - this.#nextTickScheduledFor - this.#interval) >
      this.#interval * ALLOWED_SHIFT_IN_PROCENT
    ) {
      this.#logger.log("overlapping ticks, skipping this run");
      return;
    } else {
      this.#adjustedInterval = this.#interval - (now - this.#expectedCycleTime);
      this.#expectedCycleTime += this.#interval;
    }
    this.#nextTickScheduledFor = now + this.#adjustedInterval;
    setTimeout(() => {
      this.run(fn);
      fn();
    }, this.#adjustedInterval);
  }
}

module.exports = SetIntervalDriftSafe;
