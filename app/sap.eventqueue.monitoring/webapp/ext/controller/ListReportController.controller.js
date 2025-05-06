"use strict";

sap.ui.define(
  ["sap/ui/core/mvc/ControllerExtension", "sap/m/MessageToast"],
  function (ControllerExtension, MessageToast) {
    return ControllerExtension.extend("sap.eventqueue.monitoring.ext.controller.ListReportController", {
      override: {
        onInit: function () {
          this.base.onInit();
          window.socket.attachMessage("message", (event) => {
            const message = JSON.parse(event.getParameter("data"));
            if (message?.event === "jobStatusChanged") {
              if (message.data?.status === "requested") {
                this.refreshForAll();
              } else {
                this.refreshForContext(message);
              }
            }
          });
        },
      },

      refreshForContext(message) {
        const table = this.getView().byId("sap.eventqueue.monitoring::JobList--fe::table::Job::LineItem::Table");
        const contexts = table.tableBindingInfo?.binding?.getAllCurrentContexts();
        for (const context of contexts ?? []) {
          if (message.data?.IDs?.includes(context.getObject().ID)) {
            this.base.getExtensionAPI().refresh();
            const router = this.base.getAppComponent().getRouter();
            if (router && !router.getHashChanger().getHash().startsWith("Job")) {
              const toast = this.base
                .getExtensionAPI()
                .getModel("i18n")
                .getResourceBundle()
                .getText("listReportRefresh");
              MessageToast.show(toast);
            }
            break;
          }
        }
      },

      refreshForAll() {
        this.base.getExtensionAPI().refresh();
        const toast = this.base.getExtensionAPI().getModel("i18n").getResourceBundle().getText("listReportRefresh");
        MessageToast.show(toast);
      },
    });
  }
);
