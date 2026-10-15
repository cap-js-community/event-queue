"use strict";

const cds = require("@sap/cds");

const contextDepths = [];

// number of contexts cds.context inherits from via _propagated
const contextDepth = (context) => {
  let depth = 0;
  for (let current = context?._propagated; current && !Object.isSealed(current); current = current._propagated) {
    depth++;
  }
  return depth;
};

class ContextDepthService extends cds.Service {
  async init() {
    await super.init();
    this.on("tick", () => {
      contextDepths.push(contextDepth(cds.context));
    });
  }
}

ContextDepthService.contextDepths = contextDepths;
module.exports = ContextDepthService;
