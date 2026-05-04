"use strict";

class SetIntervalDriftSafe {
  #adjustedInterval;
  #interval;
  #expectedCycleTime = 0;
  #shouldRun = true;
  #lastTimeoutId;

  constructor(interval) {
    this.#interval = interval;
    this.#adjustedInterval = interval;
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
