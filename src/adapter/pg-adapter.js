const crypto = require('crypto');
const cds = require('@sap/cds');

const LOG = cds.log('mtxpg');

// Statements touching the tenant registry are never deployed into a tenant
// schema — the registry lives in public only. Matches the table and any view
// selecting from it (e.g. TenantService_Tenants).
const TENANTS_TABLE_REGEX = /\bdb_tenants\b/i;

const SCHEMA_PREFIX = 'tenant_';
const MAX_TENANT_ID = 50; // must match `tenantId : String(50)` in src/db/schema.cds
const HASH_LEN = 6;
// PostgreSQL truncates identifiers at 63 bytes, and truncation is itself a
// collision. Budget: 'tenant_' + slug + '_' + hash = 7 + 49 + 1 + 6 = 63.
const MAX_SLUG = 63 - SCHEMA_PREFIX.length - 1 - HASH_LEN;

// Validate at the boundary so an over-long id fails here with a clear message
// instead of reaching Postgres and coming back as `value too long for type
// character varying(50)`.
function assertValidTenantId(tenantId) {
  if (tenantId === undefined || tenantId === null || tenantId === '') {
    throw new Error('tenantId is required');
  }
  const id = String(tenantId);
  if (id.length > MAX_TENANT_ID) {
    throw new Error(`tenantId must be at most ${MAX_TENANT_ID} characters`);
  }
  return id;
}

// Maps a tenant id onto an identifier-safe, *injective* schema suffix.
//
// The readable slug alone is lossy — 'acme-corp', 'acme.corp' and 'ACME_CORP'
// all flatten to 'acme_corp' — which would route distinct customers to one
// schema. The trailing hash is taken over the raw id, so the mapping stays
// injective while the slug keeps the schema name recognisable to an operator.
function sanitize(tenantId) {
  const id = assertValidTenantId(tenantId);
  const slug = id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, MAX_SLUG);
  const hash = crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, HASH_LEN);
  return `${slug}_${hash}`;
}

class TenantManager {
  static getSchemaName(tenantId) {
    return `${SCHEMA_PREFIX}${sanitize(tenantId)}`;
  }

  // Pass `tx` (e.g. `db.tx(req)`) to make provisioning atomic with the caller's
  // own work. Without one we open our own transaction rather than running on the
  // pool directly: `SET LOCAL` is a no-op outside a transaction block, and each
  // autocommitted `run` may land on a different pooled connection, so the DDL
  // would execute against the default search_path — i.e. into public.
  static async ensureTenantSchema(tenantId, tx) {
    if (tx) return TenantManager._deploy(tenantId, tx);
    const db = await cds.connect.to('db');
    return db.tx((t) => TenantManager._deploy(tenantId, t));
  }

  static async _deploy(tenantId, tx) {
    const schema = TenantManager.getSchemaName(tenantId);

    await tx.run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    // Pin DDL execution to the tenant schema. Tables are created there directly,
    // and views' FROM clauses (which CAP emits unqualified) bind to those tables
    // at CREATE VIEW time via search_path resolution. public is deliberately not
    // on the path: a statement that fails to resolve must fail loudly rather
    // than silently deploy into the shared schema.
    await tx.run(`SET LOCAL search_path TO "${schema}"`);

    for (const stmt of await TenantManager._tenantDDL()) {
      await tx.run(stmt);
    }

    // SET LOCAL lasts for the whole transaction, so hand the caller's tx back on
    // public. Otherwise the registry INSERT that normally follows provisioning
    // resolves inside the tenant schema, where db_tenants does not exist.
    await tx.run('SET LOCAL search_path TO public');

    LOG.info('tenant schema ready:', schema);
    return schema;
  }

  static async dropTenantSchema(tenantId, tx) {
    const conn = tx || (await cds.connect.to('db'));
    const schema = TenantManager.getSchemaName(tenantId);
    await conn.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    LOG.info('tenant schema dropped:', schema);
  }

  static async _tenantDDL() {
    if (!TenantManager._cachedDDL) {
      const csn = await cds.load('*').then(cds.minify);
      const sql = cds.compile.to.sql(csn, { dialect: 'postgres' });
      const statements = Array.isArray(sql) ? sql : String(sql).split(/;\s*\n/);
      TenantManager._cachedDDL = statements
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !TENANTS_TABLE_REGEX.test(s))
        .map(TenantManager._idempotent);
    }
    return TenantManager._cachedDDL;
  }

  // CAP emits plain CREATE TABLE / CREATE VIEW, so re-running the DDL against an
  // existing tenant aborts on `already exists`. Rewriting the two verbs makes
  // ensureTenantSchema re-runnable, which is what onboarding retries and the
  // documented "apply model additions to existing tenants" workflow need.
  //
  // ponytail: this adds new tables and redefines views; it does not alter
  // existing tables. Column additions to an already-deployed tenant still need a
  // real migration step.
  static _idempotent(stmt) {
    return stmt
      .replace(/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE\s+VIEW\s+/i, 'CREATE OR REPLACE VIEW ');
  }
}

module.exports = TenantManager;
module.exports.sanitize = sanitize;
module.exports.assertValidTenantId = assertValidTenantId;
module.exports.MAX_TENANT_ID = MAX_TENANT_ID;
