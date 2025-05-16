"use strict";

let state = {};
const _createMainClientAndConnect = async () => ({
  get: async (key) => state[key]?.value ?? null,
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
  getState: () => state,
};
