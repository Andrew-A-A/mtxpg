/* eslint-disable no-console */
const cds = require('@sap/cds');
const TenantManager = require('../adapter/pg-adapter');

const TENANTS = 'db.Tenants';

class TenantUtils {
  static getSchemaName(tenantId) {
    return TenantManager.getSchemaName(tenantId);
  }

  static async getTenantByRequest(req) {
    const { SELECT } = cds.ql;
    const tenantId = req.headers['x-tenant-id'] || (req.query && req.query.tenant);
    if (!tenantId) throw new Error('Tenant ID is required');

    const tenant = await SELECT.one.from(TENANTS).where({ tenantId });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return tenant;
  }
}

module.exports = TenantUtils;
