"use strict";

sap.ui.define(
  ["sap/ui/core/mvc/ControllerExtension", "sap/m/MessageToast"],
  function (ControllerExtension, MessageToast) {
    return ControllerExtension.extend("sap.eventqueue.monitoring.ext.controller.ObjectPageController", {
      override: {
        onInit: function () {
          this.base.onInit();
          // window.socket.attachMessage("message", (event) => {
          //   const object = this.base.getExtensionAPI().getBindingContext()?.getObject();
          //   const message = JSON.parse(event.getParameter("data"));
          //   if (message.event === "jobStatusChanged") {
          //     if (message?.data?.IDs?.includes(object?.ID)) {
          //       this.base.getExtensionAPI().refresh();
          //       const router = this.base.getAppComponent().getRouter();
          //       if (router && router.getHashChanger().getHash().startsWith("Job")) {
          //         const toast = this.base
          //           .getExtensionAPI()
          //           .getModel("i18n")
          //           .getResourceBundle()
          //           .getText("objectPageRefresh");
          //         MessageToast.show(toast);
          //       }
          //     }
          //   }
          // });
        },
      },
    });
  }
);
