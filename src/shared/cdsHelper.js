"use strict";

const VError = require("verror");
const cds = require("@sap/cds");

const config = require("../config");
const common = require("./common");

const VERROR_CLUSTER_NAME = "ExecuteInNewTransactionError";
const COMPONENT_NAME = "/eventQueue/cdsHelper";

/**
 * Execute logic in a new managed CDS transaction context, auto-handling commit, rollback and error/exception situations.
 * Includes logging of start, end and error situation with additional info object and unique transaction id (txId)
 * @param context {object} Current CDS request context
 * @param transactionTag A tag identifying the transaction
 * @param fn {function} Callback function (logic) to be executed in context of new managed CDS transaction
 * @param args {array|object|any} Array of function arguments passed to callback function as spread arguments. Object or primitive types are auto-normalized to array.
 * @param info {object} Additional information object attached to logging
 * @returns {Promise<boolean>} Promise resolving to true if everything worked fine / false if an error occurred
 */
async function executeInNewTransaction(context = {}, transactionTag, fn, args, { info = {} } = {}) {
  const parameters = Array.isArray(args) ? args : [args];
  const logger = cds.log(COMPONENT_NAME);
  try {
    const user = new cds.User.Privileged({ id: config.userId, authInfo: await common.getAuthInfo(context.tenant) });
    if (cds.db.kind === "hana") {
      await cds.tx(
        {
          id: context.id,
          tenant: context.tenant,
          locale: context.locale,
          user,
          headers: context.headers,
        },
        async (tx) => {
          tx.context._ = context._ ?? {};
          return await fn(tx, ...parameters);
        }
      );
    } else {
      const contextTx = cds.tx(context);
      const contextTxState = contextTx.ready;
      if (!contextTxState || ["committed", "rolled back"].includes(contextTxState)) {
        await cds.tx(
          {
            id: context.id,
            tenant: context.tenant,
            locale: context.locale,
            user,
            headers: context.headers,
          },
          async (tx) => fn(tx, ...parameters)
        );
      } else {
        contextTx.context.user = user;
        try {
          contextTx.set?.({
            "$user.id": user.id,
          });
        } catch {
          /* empty */
        }
        await fn(contextTx, ...parameters);
      }
    }
  } catch (err) {
    if (!(err instanceof TriggerRollback)) {
      if (err instanceof VError) {
        Object.assign(err.jse_info, {
          newTx: info,
        });
        throw err;
      } else {
        throw new VError(
          {
            name: VERROR_CLUSTER_NAME,
            cause: err,
            info,
          },
          "Execution in new transaction failed"
        );
      }
    }
    return false;
  } finally {
    logger.debug("Execution in new transaction finished", info);
  }
  return true;
}

/**
 * Error class to be used to force rollback in executionInNewTransaction
 * Error will not be logged, as it assumes that error handling has been done before...
 */
class TriggerRollback extends VError {
  constructor() {
    super("Rollback triggered");
  }
}

const getAllTenantIds = async () => {
  if (!config.isMultiTenancy) {
    return null;
  }

  // NOTE: tmp workaround until cds-mtxs fixes the connect.to service
  for (let i = 0; i < 10; i++) {
    if (cds.services["saas-registry"]) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const ssp = await cds.connect.to("cds.xt.SaasProvisioningService");
  const response = await ssp.get("/tenant");
  return response
    .map((tenant) => tenant.subscribedTenantId ?? tenant.tenant)
    .filter((tenantId) => !isFakeTenant(tenantId));
};

const isFakeTenant = (tenantId) => /00000000-0000-4000-8000-\d{12}/.test(tenantId);

module.exports = {
  executeInNewTransaction,
  TriggerRollback,
  getAllTenantIds,
};
