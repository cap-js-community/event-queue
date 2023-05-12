"use strict";

const isLocal = process.env.USER !== "vcap";
const isOnCF = !isLocal;

module.exports = {
  isOnCF,
  isLocal,
};
