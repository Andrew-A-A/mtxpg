const cds = require('@sap/cds');
const TenantManager = require('../adapter/pg-adapter');

const { assertValidTenantId } = TenantManager;
const TENANTS = 'db.Tenants';
// `config` is deliberately absent — it is the documented place for per-tenant
// connection details and API keys, so it is never returned to a caller.
const SAFE_COLUMNS = ['ID', 'tenantId', 'name', 'status', 'createdAt', 'modifiedAt'];
const LOG = cds.log('mtxpg');

class TenantService extends cds.ApplicationService {
  async init() {
    const { SELECT, UPDATE } = cds.ql;

    this.on('createTenant', async (req) => {
      const row = await this._provision(req);
      return `Tenant ${row.tenantId} created successfully`;
    });
    this.on('deleteTenant', async (req) => {
      const tenantId = await this._deprovision(req);
      return `Tenant ${tenantId} deleted successfully`;
    });
    this.on('getTenantInfo', (req) => this._info(req));
    this.on('listTenants', (req) => this._list(req));

    // OData CRUD over the registry entity.
    //
    // These pass the real `req` through. A fabricated `{ data: req.data }` has no
    // `reject` — so the validation branch threw a TypeError that killed the
    // process — and no request lifecycle, so `db.tx(...)` on it was never
    // committed and leaked a pooled connection holding an open transaction.
    //
    // CREATE must resolve to the created *entity*: the OData layer evaluates
    // `'ID' in <result>` to build the Location header, which throws on a string.
    this.on('CREATE', 'Tenants', (req) => this._provision(req));

    this.on('DELETE', 'Tenants', async (req) => {
      const tx = await this._db(req);
      const row = await tx.run(SELECT.one.from(TENANTS).where(req.data));
      if (!row) return req.reject(404, 'Tenant not found');
      req.data.tenantId = row.tenantId;
      await this._deprovision(req);
      // Resolve with no value -> 204 No Content.
    });

    this.on('UPDATE', 'Tenants', async (req) => {
      const tx = await this._db(req);
      const row = await tx.run(SELECT.one.from(TENANTS).where(this._key(req)));
      if (!row) return req.reject(404, 'Tenant not found');
      if (req.data.tenantId !== undefined && req.data.tenantId !== row.tenantId) {
        // The schema name is derived from tenantId. Renaming the row without
        // moving the schema would leave the registry pointing at a schema that
        // does not exist, which is the cross-tenant leak in a different guise.
        return req.reject(400, 'tenantId is immutable — delete and re-create the tenant instead');
      }
      const patch = { ...req.data };
      delete patch.ID;
      delete patch.tenantId;
      if (Object.keys(patch).length) await tx.run(UPDATE(TENANTS).set(patch).where({ ID: row.ID }));
      return { ...this._safe(row), ...patch };
    });

    return super.init();
  }

  // The DB-level tx, not the service tx: db.Tenants routed through the service
  // tx would dispatch back into TenantService and fail to resolve. Bound to
  // `req`, so CAP commits or rolls it back with the request.
  async _db(req) {
    return (await cds.connect.to('db')).tx(req);
  }

  _key(req) {
    return req.data.ID ? { ID: req.data.ID } : req.data;
  }

  _safe(row) {
    return row && Object.fromEntries(SAFE_COLUMNS.filter((c) => c in row).map((c) => [c, row[c]]));
  }

  async _provision(req) {
    const { SELECT, INSERT } = cds.ql;

    // Validated at the boundary, outside the try: an over-long or missing id is
    // a 400, not a 500 carrying raw Postgres text back to the caller.
    let tenantId;
    try {
      tenantId = assertValidTenantId(req.data.tenantId);
    } catch (err) {
      return req.reject(400, err.message);
    }
    const name = req.data.name || tenantId;
    const config = req.data.config || '{}';

    try {
      const tx = await this._db(req);
      const existing = await tx.run(SELECT.one.from(TENANTS).where({ tenantId }));

      await TenantManager.ensureTenantSchema(tenantId, tx);

      // Re-provisioning an existing tenant re-applies the DDL and leaves the
      // registry row alone, so onboarding retries are idempotent rather than a
      // duplicate row or a 500.
      if (existing) return this._safe(existing);

      await tx.run(INSERT.into(TENANTS).entries({ tenantId, name, config, status: 'ACTIVE' }));
      return this._safe(await tx.run(SELECT.one.from(TENANTS).where({ tenantId })));
    } catch (err) {
      // Log the cause; return a generic message. Raw Postgres errors disclose
      // schema names, column types and which tenant schemas already exist.
      LOG.error(`tenant provisioning failed for '${tenantId}'`, err);
      return req.reject(500, 'Tenant creation failed');
    }
  }

  async _deprovision(req) {
    const { SELECT, DELETE } = cds.ql;

    let tenantId;
    try {
      tenantId = assertValidTenantId(req.data.tenantId);
    } catch (err) {
      return req.reject(400, err.message);
    }

    const tx = await this._db(req);
    // Look up before dropping. Deriving the schema name straight from the
    // request destroyed the data of any *other* tenant whose id mapped to the
    // same schema, and reported success for tenants that never existed —
    // DROP SCHEMA IF EXISTS is silent, and the DELETE hitting zero rows was
    // never noticed.
    const row = await tx.run(SELECT.one.from(TENANTS).where({ tenantId }));
    if (!row) return req.reject(404, `Tenant '${tenantId}' not found`);

    try {
      await TenantManager.dropTenantSchema(row.tenantId, tx);
      await tx.run(DELETE.from(TENANTS).where({ tenantId: row.tenantId }));
      return row.tenantId;
    } catch (err) {
      LOG.error(`tenant deprovisioning failed for '${tenantId}'`, err);
      return req.reject(500, 'Tenant deletion failed');
    }
  }

  async _info(req) {
    const { SELECT } = cds.ql;
    const { tenantId } = req.data;
    if (!tenantId) return req.reject(400, 'tenantId is required');
    const tx = await this._db(req);
    const tenant = await tx.run(SELECT.one.from(TENANTS).columns(...SAFE_COLUMNS).where({ tenantId }));
    return tenant ? JSON.stringify(tenant) : null;
  }

  async _list(req) {
    const { SELECT } = cds.ql;
    const tx = await this._db(req);
    const rows = await tx.run(SELECT.from(TENANTS).columns('tenantId').where({ status: 'ACTIVE' }));
    return rows.map((r) => r.tenantId);
  }
}

module.exports = TenantService;
