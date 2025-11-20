"use strict";

const cdsHelper = require("../../src/shared/cdsHelper");

/**
 * @typedef TenantInfo
 * @type object
 * @property {string} tenantId
 * @property {string} subdomain
 */
/**
 * For service action interfaces, with a tenants = [...] data field this code
 * resolves the inputs into a tenantInfos array.
 *
 * Inputs:
 * - ["all"]   give me all tenants
 * - ["self"]  give me just the context tenant
 * - []        give me no tenant
 * - ["<tenantId1>", "<tenantId2>", "<subdomain3>", "<subdomain4>",...]
 *             give me those tenants where either tenantId or subdomain corresponds to the given inputs
 *
 * @returns {Promise<Array<TenantInfo>>} returns an array of {@link TenantInfo} objects.
 */
const resolveTenantInfos = async (context, { sortByTenantId = true } = {}) => {
  let result = await _resolveTenantInfos(context);
  if (sortByTenantId) {
    result = result.sort(_orderByTenantId);
  }
  return result;
};

const _resolveTenantInfos = async (context) => {
  if (!Array.isArray(context.data.tenants)) {
    return [];
  }
  for (const tenant of context.data.tenants) {
    if (tenant === "self") {
      return [context.tenant];
    }
    if (tenant === "all") {
      return await cdsHelper.getAllTenantIds();
    }
  }
  const contextTenantsMap = Object.fromEntries(context.data.tenants.map((tenant) => [tenant, true]));
  return (await cdsHelper.getAllTenantIds()).filter((tenantId) => contextTenantsMap[tenantId]);
};

const _orderByTenantId = (a, b) => a.localeCompare(b);

module.exports = {
  resolveTenantInfos,
};
