/* eslint-disable no-console */
const cds = require('@sap/cds');
const TenantManager = require('../adapter/pg-adapter');

const TENANTS = 'db.Tenants';

class TenantService extends cds.ApplicationService {
  async init() {
    const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

    this.on('createTenant', (req) => this._provision(req));
    this.on('deleteTenant', (req) => this._deprovision(req));
    this.on('getTenantInfo', (req) => this._info(req));
    this.on('listTenants', (req) => this._list(req));

    this.on('CREATE', 'Tenants', (req) => this._provision({ data: req.data }));
    this.on('DELETE', 'Tenants', async (req) => {
      const row = await SELECT.one.from(TENANTS).where(req.data);
      if (!row) req.reject(404, `Tenant not found`);
      return this._deprovision({ data: { tenantId: row.tenantId } });
    });
    this.on('UPDATE', 'Tenants', async (req) => UPDATE(TENANTS).set(req.data).where({ ID: req.data.ID }));

    return super.init();
  }

  async _provision(req) {
    const { INSERT } = cds.ql;
    const { tenantId } = req.data;
    const name = req.data.name || tenantId;
    const config = req.data.config || '{}';

    if (!tenantId) return req.reject(400, 'tenantId is required');

    try {
      const db = await cds.connect.to('db');
      const tx = db.tx(req);

      await TenantManager.ensureTenantSchema(tenantId, tx);
      await tx.run(
        INSERT.into(TENANTS).entries({ tenantId, name, config, status: 'ACTIVE' }),
      );

      return `Tenant ${tenantId} created successfully`;
    } catch (err) {
      console.error(`[mtxpg] failed to create tenant ${tenantId}:`, err);
      return req.reject(500, `Tenant creation failed: ${err.message}`);
    }
  }

  async _deprovision(req) {
    const { DELETE } = cds.ql;
    const { tenantId } = req.data;
    if (!tenantId) return req.reject(400, 'tenantId is required');

    try {
      const db = await cds.connect.to('db');
      const tx = db.tx(req);

      await TenantManager.dropTenantSchema(tenantId, tx);
      await tx.run(DELETE.from(TENANTS).where({ tenantId }));

      return `Tenant ${tenantId} deleted successfully`;
    } catch (err) {
      console.error(`[mtxpg] failed to delete tenant ${tenantId}:`, err);
      return req.reject(500, `Tenant deletion failed: ${err.message}`);
    }
  }

  async _info(req) {
    const { SELECT } = cds.ql;
    const { tenantId } = req.data;
    const tx = req.tx || (await cds.connect.to('db')).tx(req);
    const tenant = await tx.run(SELECT.one.from(TENANTS).where({ tenantId }));
    return tenant ? JSON.stringify(tenant) : null;
  }

  async _list(req) {
    const { SELECT } = cds.ql;
    const tx = req.tx || (await cds.connect.to('db')).tx(req);
    const rows = await tx.run(SELECT.from(TENANTS).where({ status: 'ACTIVE' }));
    return rows.map((r) => r.tenantId);
  }
}

module.exports = TenantService;
