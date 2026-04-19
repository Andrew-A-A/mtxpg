/* eslint-disable no-console */
const cds = require('@sap/cds');

const TENANTS_TABLE_REGEX = /\bdb_tenants\b/i;

function sanitize(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  return String(tenantId).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

class TenantManager {
  static getSchemaName(tenantId) {
    return `tenant_${sanitize(tenantId)}`;
  }

  // Caller passes an active tx (req.tx) to keep this on the request's connection
  // and make tenant provisioning atomic with whatever else the caller does.
  static async ensureTenantSchema(tenantId, tx) {
    const conn = tx || (await cds.connect.to('db'));
    const schema = TenantManager.getSchemaName(tenantId);

    await conn.run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // Pin DDL execution to the tenant schema. Tables are created there directly,
    // and views' FROM clauses (which CAP emits unqualified) bind to those tables
    // at CREATE VIEW time via search_path resolution. Tenants table stays in
    // public — it's filtered out of the DDL list and middleware lookups will
    // still find it via the trailing public on search_path.
    await conn.run(`SET LOCAL search_path TO "${schema}", public`);

    const ddl = await TenantManager._tenantDDL();
    for (const stmt of ddl) {
      await conn.run(stmt);
    }

    console.log(`[mtxpg] tenant schema ready: ${schema}`);
    return schema;
  }

  static async dropTenantSchema(tenantId, tx) {
    const conn = tx || (await cds.connect.to('db'));
    const schema = TenantManager.getSchemaName(tenantId);
    await conn.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    console.log(`[mtxpg] tenant schema dropped: ${schema}`);
  }

  static async _tenantDDL() {
    if (!TenantManager._cachedDDL) {
      const csn = await cds.load('*').then(cds.minify);
      const sql = cds.compile.to.sql(csn, { dialect: 'postgres' });
      const statements = Array.isArray(sql) ? sql : String(sql).split(/;\s*\n/);
      TenantManager._cachedDDL = statements
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !TENANTS_TABLE_REGEX.test(s));
    }
    return TenantManager._cachedDDL;
  }
}

module.exports = TenantManager;
module.exports.sanitize = sanitize;
