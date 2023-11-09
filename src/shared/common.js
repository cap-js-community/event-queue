"use strict";

const { floor, abs, min } = Math;

const arrayToFlatMap = (array, key = "ID") => {
  return array.reduce((result, element) => {
    result[element[key]] = element;
    return result;
  }, {});
};

/**
 * Establish a "Funnel" instance to limit how much
 * load can be processed in parallel. This is somewhat
 * similar to the limiter function however it has some
 * distinctintly different features. The Funnel will
 * not know in advance which functions and how many
 * loads it will have to process.
 */
class Funnel {
  /**
   * Create a funnel with specified capacity
   * @param capacity - the capacity of the funnel (integer, sign will be ignored)
   */
  constructor(capacity = 100) {
    this.runningPromises = [];
    this.capacity = floor(abs(capacity));
  }

  /**
   * Asynchronously run a function that will put a specified load to the funnel.
   * The total amount of load of all running functions shall not
   * exceed the capacity of the funnel. If the desired load exceeds the capacity
   * the funnel will wait until sufficient capacity is available.
   * If a function requires a load >= capacity, then it will run
   * exclusively.
   * @param load - the load (integer, sign will be ignored)
   * @param f
   * @param args
   * @return {Promise<unknown>}
   */
  async run(load, f, ...args) {
    load = min(floor(abs(load)), Number.MAX_SAFE_INTEGER);

    // wait for sufficient capacity
    while (this.capacity < load && this.runningPromises.length > 0) {
      try {
        await Promise.race(this.runningPromises);
      } catch {
        // Yes, we must ignore exceptions here. The
        // caller expects exceptions from f and no
        // exceptions from other workloads.
        // Other exceptions must be handled by the
        // other callers. See (*) below.
      }
    }

    // map function call to promise
    const p = f.constructor.name === "AsyncFunction" ? f(...args) : Promise.resolve().then(() => f(...args));

    // create promise for book keeping
    const workload = p.finally(() => {
      // remove workload
      this.runningPromises.splice(this.runningPromises.indexOf(workload), 1);
      // and reclaim its capacity
      this.capacity += load;
    });

    // claim the capacity and schedule workload
    this.capacity -= load;
    this.runningPromises.push(workload);

    // make the caller wait for the workload
    // this also establish the seemingly missing
    // exception handling. See (*) above.
    return workload;
  }
}

/**
 * Defines a promise that resolves when all payloads are processed by the iterator, but limits
 * the number concurrent executions.
 *
 * @param limit     number of concurrent executions
 * @param payloads  array where each element is an array of arguments passed to the iterator
 * @param iterator  (async) function to process a payload
 * @returns {Promise<[]>} promise for an array of iterator results
 */
const limiter = async (limit, payloads, iterator) => {
  const returnPromises = [];
  const runningPromises = [];
  for (const payload of payloads) {
    const p =
      iterator.constructor.name === "AsyncFunction"
        ? iterator(payload)
        : Promise.resolve().then(() => iterator(payload));
    returnPromises.push(p);

    if (limit <= payloads.length) {
      const e = p.catch(() => {}).finally(() => runningPromises.splice(runningPromises.indexOf(e), 1));
      runningPromises.push(e);
      if (limit <= runningPromises.length) {
        await Promise.race(runningPromises);
      }
    }
  }
  return Promise.allSettled(returnPromises);
};

const isValidDate = (value) => {
  if (typeof value === "string") {
    const date = Date.parse(value);
    return !isNaN(date);
  } else if (value instanceof Date) {
    return !isNaN(value.getTime());
  } else {
    return false;
  }
};

module.exports = { arrayToFlatMap, Funnel, limiter, isValidDate };
