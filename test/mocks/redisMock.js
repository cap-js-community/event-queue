"use strict";

let state = {};
const _createMainClientAndConnect = async () => ({
  get: async (key) => state[key]?.value ?? null,
  exists: async (key) => Object.prototype.hasOwnProperty.call(state, key),
  set: async (key, value, options) => {
    if (state[key]) {
      return null;
    }
    state[key] = { value, options };
    return "OK";
  },
  del: async (key) => delete state[key],
  _: {
    state,
  },
});

module.exports = {
  createClientAndConnect: _createMainClientAndConnect,
  createMainClientAndConnect: _createMainClientAndConnect,
  closeSubscribeClient: () => {},
  clearState: () => (state = {}),
  closeMainClient: () => {},
  registerShutdownHandler: () => {},
  getState: () =>
    Object.fromEntries(
      Object.entries(state).map(([key, value]) => {
        delete value.value;
        return [key, value];
      })
    ),
};
