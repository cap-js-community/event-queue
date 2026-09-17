"use strict";

let state = {};
let testState = {};

const _isExpired = (key) => {
  const expiresAt = state[key]?.expiresAt;
  if (expiresAt === undefined || expiresAt > Date.now()) {
    return false;
  }
  delete state[key];
  return true;
};

const _exists = (key) => !_isExpired(key) && Object.prototype.hasOwnProperty.call(state, key);

const _get = (key) => (_exists(key) ? (state[key].value ?? null) : null);

const _ttl = (key) => {
  if (!_exists(key)) {
    return -2;
  }
  const expiresAt = state[key].expiresAt;
  return expiresAt === undefined ? -1 : Math.ceil((expiresAt - Date.now()) / 1000);
};

const _buildClient = () => ({
  get: async (key) => _get(key),
  exists: async (key) => _exists(key),
  ttl: async (key) => _ttl(key),
  set: async (key, value, options = {}) => {
    const exists = _exists(key);
    if ((options.NX && exists) || (options.XX && !exists)) {
      return null;
    }
    const expiresAt = options.PX ? Date.now() + options.PX : undefined;
    state[key] = { value, options, expiresAt };
    testState[key] = { value, options };
    return "OK";
  },
  del: async (key) => {
    const existed = _exists(key);
    delete state[key];
    return existed ? 1 : 0;
  },
  hIncrBy: async (key, field, increment) => {
    if (!state[key]) {
      state[key] = { hash: {} };
    }
    const current = parseInt(state[key].hash[field] ?? "0", 10);
    state[key].hash[field] = String(current + increment);
    return current + increment;
  },
  hSet: async (key, field, value) => {
    if (!state[key]) {
      state[key] = { hash: {} };
    }
    const isNew = !Object.prototype.hasOwnProperty.call(state[key].hash, field);
    state[key].hash[field] = String(value);
    return isNew ? 1 : 0;
  },
  hGetAll: async (key) => {
    return state[key]?.hash ?? {};
  },
  scanIterator: ({ MATCH } = {}) => {
    const regex = MATCH
      ? new RegExp(
          "^" +
            MATCH.replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$"
        )
      : null;
    const matchingKeys = Object.keys(state).filter((k) => _exists(k) && (!regex || regex.test(k)));
    return (async function* () {
      for (const key of matchingKeys) {
        yield key;
      }
    })();
  },
  multi: () => {
    const ops = [];
    const pipeline = {
      ttl: (key) => {
        ops.push(async () => _ttl(key));
        return pipeline;
      },
      get: (key) => {
        ops.push(async () => _get(key));
        return pipeline;
      },
      hIncrBy: (key, field, increment) => {
        ops.push(async () => {
          if (!state[key]) {
            state[key] = { hash: {} };
          }
          const current = parseInt(state[key].hash[field] ?? "0", 10);
          state[key].hash[field] = String(current + increment);
          return current + increment;
        });
        return pipeline;
      },
      hSet: (key, field, value) => {
        ops.push(async () => {
          if (!state[key]) {
            state[key] = { hash: {} };
          }
          state[key].hash[field] = String(value);
        });
        return pipeline;
      },
      exec: async () => {
        const results = [];
        for (const op of ops) {
          results.push(await op());
        }
        return results;
      },
    };
    return pipeline;
  },
  _: {
    state,
  },
});

const _createMainClientAndConnect = async () => _buildClient();

module.exports = {
  attachRedisUnsubscribeHandler: () => {},
  subscribeRedisChannel: () => {},
  publishMessage: async () => {},
  isClusterMode: () => false,
  createClientAndConnect: _createMainClientAndConnect,
  createMainClientAndConnect: _createMainClientAndConnect,
  closeSubscribeClient: () => {},
  clearState: () => (state = {}),
  clearTestState: () => (testState = {}),
  closeMainClient: () => {},
  registerShutdownHandler: () => {},
  getTestState: () =>
    Object.fromEntries(
      Object.entries(testState).map(([key, value]) => {
        return [_sanatizeKey(key), value];
      })
    ),
  getState: () =>
    Object.fromEntries(
      Object.entries(state).map(([key, value]) => {
        delete value.value;
        delete value.expiresAt;
        return [_sanatizeKey(key), value];
      })
    ),
};

const _sanatizeKey = (key) => {
  const keyParts = key.split("##");
  const last = keyParts.pop();
  keyParts.push(last.length === 36 ? "TEST_STATIC" : last);
  return keyParts.join("##");
};
