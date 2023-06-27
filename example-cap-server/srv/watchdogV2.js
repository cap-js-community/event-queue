"use strict";

const asyncHooks = require("async_hooks");

const cache = {};

const MS_PER_SEC = 1e3;
const NS_PER_MS = 1e6;
const CLEAN_ORPHANED_ENTRIES_INTERVAL = 60 * 1000;
const DELETE_ENTRIES_AFTER_MS = CLEAN_ORPHANED_ENTRIES_INTERVAL * 2;

const COMPONENT = "util/watchdogV2";

const asyncHooksRegExNode16 = /node:internal\/async_hooks:/;

const cleanStack = (stack) => {
  const stackTraceLines = stack.split("\n");
  // this part is opinionated, but it's here to avoid confusing people with internals
  let i = stackTraceLines.length - 1;
  while (i && !asyncHooksRegExNode16.test(stackTraceLines[i])) {
    i--;
  }
  return stackTraceLines.slice(i + 1, stack.length - 1);
};

const init = (asyncId, type) => {
  const e = {};
  Error.captureStackTrace(e);
  cache[asyncId] = { type, stack: e.stack, createdAt: new Date().toISOString() };
};

const before = (asyncId) => {
  if (!cache[asyncId]) {
    return;
  }
  cache[asyncId].startTime = process.hrtime();
};

const after = (asyncId) => {
  const asyncInfo = cache[asyncId];
  if (!asyncInfo) {
    return;
  }
  delete cache[asyncId];
  const { type, stack, startTime } = asyncInfo;

  const diff = process.hrtime(startTime);
  const diffMs = Math.floor(diff[0] * MS_PER_SEC + diff[1] / NS_PER_MS);
  if (diffMs > 500) {
    cds.log(COMPONENT).error("detected long running async function", {
      timeDiff: diffMs,
      correlationId: cds.context?.id,
      ...(stack ? { stack: cleanStack(stack) } : {}),
      type,
    });
  }
};

const asyncHook = asyncHooks.createHook({ init, before, after });

module.exports = {
  register: () => {
    asyncHook.enable();
    setInterval(() => {
      const currentDate = new Date(Date.now() - DELETE_ENTRIES_AFTER_MS);
      for (const cacheKey in cache) {
        const { createdAt } = cache[cacheKey];
        if (currentDate >= new Date(createdAt)) {
          delete cache[cacheKey];
        }
      }
    }, CLEAN_ORPHANED_ENTRIES_INTERVAL);
  },
};
