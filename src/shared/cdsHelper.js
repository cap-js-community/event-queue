"use strict";

const VError = require("verror");
const cds = require("@sap/cds");

const config = require("../config");
const common = require("./common");
const { TenantIdCheckTypes } = require("../constants");
const { limiter } = require("./common");

const VERROR_CLUSTER_NAME = "ExecuteInNewTransactionError";
const COMPONENT_NAME = "/eventQueue/cdsHelper";

const CONCURRENCY_AUTH_INFO = 3;

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
  let transactionRollbackPromise = Promise.resolve(true);
  try {
    const authInfo = await common.getAuthContext(context.tenant);
    const user = new cds.User.Privileged({ id: config.userId, authInfo, tokenInfo: authInfo?.token });
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
          return new Promise((outerResolve, outerReject) => {
            transactionRollbackPromise = new Promise((resolve) => {
              tx.context.on("succeeded", () => resolve(false));
              tx.context.on("failed", () => resolve(true));
              fn(tx, ...parameters)
                .then(outerResolve)
                .catch(outerReject);
            });
          });
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
          async (tx) => {
            await fn(tx, ...parameters);
            transactionRollbackPromise = false;
          }
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
        const txRollback = contextTx.rollback;
        contextTx.rollback = async () => {
          // tx should not be managed here as we did not open the tx
          // change rollback to no opt - closing tx would cause follow-up usage to fail.
          // the process that opened the tx needs to manage it
        };
        await fn(contextTx, ...parameters)
          .then(() => (transactionRollbackPromise = false))
          .finally(() => (contextTx.rollback = txRollback));
      }
    }
  } catch (err) {
    const transactionRollback = await transactionRollbackPromise;
    if (err instanceof VError) {
      Object.assign(err.jse_info, {
        newTx: info,
      });
      if (transactionRollback) {
        throw err;
      } else {
        logger.error("business transaction commited but succeeded|done|failed threw a error!", err);
      }
    } else {
      const nestedError = new VError(
        {
          name: VERROR_CLUSTER_NAME,
          cause: err,
          info,
        },
        "Execution in new transaction failed"
      );
      if (transactionRollback) {
        throw err;
      } else {
        logger.error("business transaction commited but succeeded|done|failed threw a error!", nestedError);
      }
    }
  } finally {
    logger.debug("Execution in new transaction finished", info);
  }
}

const _getAllTenantBase = async () => {
  if (!config.isMultiTenancy) {
    return null;
  }

  // NOTE: tmp workaround until cds-mtxs fixes the connect.to service
  for (let i = 0; i < 10; i++) {
    if (cds.services["cds.xt.SaasProvisioningService"] || cds.services["saas-registry"]) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const ssp = await cds.connect.to("cds.xt.SaasProvisioningService");
  return await ssp.get("/tenant");
};

const getAllTenantIds = async () => {
  const response = await _getAllTenantBase();
  if (!response) {
    return null;
  }

  const tenantIds = response.map((tenant) => tenant.subscribedTenantId ?? tenant.tenant);
  const suspendedTenants = {};
  if (config.disableProcessingOfSuspendedTenants) {
    await limiter(CONCURRENCY_AUTH_INFO, tenantIds, async (tenantId) => {
      const result = await common.getAuthContext(tenantId, { returnError: true });
      // NOTE: only 404 errors are propagated all others are ignored
      if (result?.[0]) {
        suspendedTenants[tenantId] = true;
        cds.log(COMPONENT_NAME).info("skip event-queue processing, tenant suspended", { tenantId });
      }
    });
  }

  return tenantIds.reduce(async (result, tenantId) => {
    result = await result;
    if (!suspendedTenants[tenantId] && (await common.isTenantIdValidCb(TenantIdCheckTypes.eventProcessing, tenantId))) {
      result.push(tenantId);
    }
    return result;
  }, []);
};

module.exports = {
  executeInNewTransaction,
  getAllTenantIds,
};
