"use strict";

const state = {};
const _createMainClientAndConnect = () => ({
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
  },
};
