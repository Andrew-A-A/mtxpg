const cds = require('@sap/cds');
const TenantManager = require('./src/adapter/pg-adapter');
const tenantMiddleware = require('./src/middleware/tenant-middleware');

// cds.log, not console: consumers route and silence mtxpg output through CAP's
// own logging config like every other CAP component.
const LOG = cds.log('mtxpg');

// The tenant registry lives in public, never in a tenant schema — this matches
// db.Tenants and any projection on it (e.g. TenantService.Tenants).
// ponytail: name-based match. An application entity of its own called `Tenants`
// would also route to public; the name is effectively reserved by mtxpg, which
// already excludes it from the per-tenant DDL.
const REGISTRY_TARGET = /(^|\.)Tenants$/;

// Positive cache of schemas confirmed to exist, so the check below costs one
// query per tenant per process rather than one per request.
// ponytail: positive-only and never invalidated. A schema dropped from under a
// running process goes stale-positive and falls back to the raw Postgres error;
// restart, or add invalidation, if operators drop schemas by hand.
const provisionedSchemas = new Set();

async function assertProvisioned(tx, schema, tenantId) {
  if (provisionedSchemas.has(schema)) return;
  // `schema` comes from sanitize(), which guarantees /^[a-z0-9_]+$/ — safe to inline.
  const rows = await tx.run(
    `SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = '${schema}'`,
  );
  if (!rows || !rows.length) {
    // Fail with our own message. Letting the query proceed would surface raw
    // PostgreSQL text (`relation "db_products" does not exist`), disclosing
    // internal table names and acting as an existence oracle for tenant schemas.
    const err = new Error(`Tenant '${tenantId}' is not provisioned`);
    err.code = 500;
    throw err;
  }
  provisionedSchemas.add(schema);
}

// On every DB transaction, route queries to the tenant's schema.
cds.on('connect', (db) => {
  if (db.kind !== 'postgres') return;

  db.before('*', async (req) => {
    const tenantId = cds.context && cds.context.tenant;
    if (!tenantId) return;

    const target = req.target && req.target.name;
    if (!target) return; // lifecycle events (BEGIN/COMMIT/raw SQL) — no search_path needed

    // Set the path explicitly in both directions. SET LOCAL persists for the
    // whole transaction, so a registry read following a tenant read would
    // otherwise inherit the tenant schema.
    if (REGISTRY_TARGET.test(target)) {
      await req.tx.run('SET LOCAL search_path TO public');
      return;
    }

    // public is deliberately absent. Postgres accepts a non-existent schema in
    // search_path without error and just skips it, so a trailing `public` turns
    // a missing tenant schema into a silent read/write of the shared template
    // tables — cross-tenant leakage. Without it the query fails closed.
    const schema = TenantManager.getSchemaName(tenantId);
    await assertProvisioned(req.tx, schema, tenantId);
    await req.tx.run(`SET LOCAL search_path TO "${schema}"`);
  });

  LOG.info('schema-per-tenant routing enabled');
});

module.exports = {
  TenantManager,
  tenantMiddleware,
  setTenantContext: tenantMiddleware.setTenantContext,
  getTenantFromRequest: tenantMiddleware.getTenantFromRequest,
};
