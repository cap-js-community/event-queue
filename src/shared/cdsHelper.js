"use strict";

const VError = require("verror");
const cds = require("@sap/cds");

const config = require("../config");
const common = require("./common");
const { TenantIdCheckTypes } = require("../constants");

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
  let transactionRollbackPromise = Promise.resolve(false);
  try {
    const user = new cds.User.Privileged({ id: config.userId, tokenInfo: await common.getTokenInfo(context.tenant) });
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

  return response
    .map((tenant) => tenant.subscribedTenantId ?? tenant.tenant)
    .reduce(async (result, tenantId) => {
      result = await result;
      if (await common.isTenantIdValidCb(TenantIdCheckTypes.eventProcessing, tenantId)) {
        result.push(tenantId);
      }
      return result;
    }, []);
};

const TENANT_COLUMNS = ["subscribedSubdomain", "createdAt", "modifiedAt"];

const getAllTenantWithMetadata = async () => {
  const response = await _getAllTenantBase();
  if (!response) {
    return null;
  }

  return response.reduce(async (result, row) => {
    const tenantId = row.subscribedTenantId ?? row.tenant;
    result = await result;
    if (await common.isTenantIdValidCb(TenantIdCheckTypes.eventProcessing, tenantId)) {
      const data = Object.entries(row).reduce(
        (result, [key, value]) => {
          if (TENANT_COLUMNS.includes(key)) {
            result[key] = value;
          } else {
            result.metadata[key] = value;
          }
          return result;
        },
        { metadata: {} }
      );
      data.metadata = JSON.stringify(data.metadata);
      result.push(data);
    }
    return result;
  }, []);
};

module.exports = {
  executeInNewTransaction,
  getAllTenantIds,
  getAllTenantWithMetadata,
};
