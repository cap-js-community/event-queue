"use strict";

let state = {};
let testState = {};
const _createMainClientAndConnect = async () => ({
  get: async (key) => state[key]?.value ?? null,
  exists: async (key) => Object.prototype.hasOwnProperty.call(state, key),
  set: async (key, value, options) => {
    if (state[key]) {
      return null;
    }
    state[key] = { value, options };
    testState[key] = { value, options };
    return "OK";
  },
  del: async (key) => delete state[key],
  _: {
    state,
  },
});

module.exports = {
  attachRedisUnsubscribeHandler: () => {},
  subscribeRedisChannel: () => {},
  createClientAndConnect: _createMainClientAndConnect,
  createMainClientAndConnect: _createMainClientAndConnect,
  closeSubscribeClient: () => {},
  clearState: () => (state = {}),
  clearTestState: () => (testState = {}),
  closeMainClient: () => {},
  registerShutdownHandler: () => {},
  getTestState: () =>
    Object.fromEntries(
      Object.entries(state).map(([key, value]) => {
        return [_sanatizeKey(key), value];
      })
    ),
  getState: () =>
    Object.fromEntries(
      Object.entries(state).map(([key, value]) => {
        delete value.value;
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
