/* eslint-disable no-console */
const cds = require('@sap/cds');
const TenantManager = require('./src/adapter/pg-adapter');
const tenantUtils = require('./src/utils/tenant-utils');
const tenantMiddleware = require('./src/middleware/tenant-middleware');

// On every DB transaction, route queries to the tenant's schema.
// We avoid touching the public schema for non-Tenants entities.
cds.on('connect', (db) => {
  if (db.kind !== 'postgres') return;

  db.before('*', async (req) => {
    const tenantId = cds.context && cds.context.tenant;
    if (!tenantId) return;

    const target = req.target && req.target.name;
    if (target === 'db.Tenants') return; // Tenants table lives in public

    const schema = TenantManager.getSchemaName(tenantId);
    await req.tx.run(`SET LOCAL search_path TO "${schema}", public`);
  });

  console.log('[mtxpg] schema-per-tenant routing enabled');
});

module.exports = {
  TenantManager,
  tenantUtils,
  tenantMiddleware,
  setTenantContext: tenantMiddleware.setTenantContext,
  getTenantFromRequest: tenantMiddleware.getTenantFromRequest,
};
