"use strict";

let state = {};
const _createMainClientAndConnect = async () => ({
  get: async (key) => state[key] ?? null,
  set: async (key, value) => {
    if (state[key]) {
      return null;
    }
    state[key] = value;
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
  clearState: () => (state = {}),
};
