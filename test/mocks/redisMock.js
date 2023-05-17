"use strict";

const state = {};
const _createMainClientAndConnect = async () => ({
  get: async (key) => state[key],
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
  _: {
    _createMainClientAndConnect,
    _createClientAndConnect: _createMainClientAndConnect,
  },
};
