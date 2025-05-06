"use strict";

sap.ui.define(["sap/fe/core/AppComponent", "sap/ui/core/ws/WebSocket"], function (Component, WebSocket) {
  return Component.extend("sap.eventqueue.monitoring.Component", {
    metadata: {
      manifest: "json",
    },

    constructor: function () {
      Component.prototype.constructor.apply(this, arguments);
      // window.socket = new WebSocket(this.getManifestObject().resolveUri("ws/job-scheduling"));
    },
  });
});
