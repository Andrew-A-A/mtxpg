/* eslint-disable no-console */
const cds = require('@sap/cds');

function getTenantFromRequest(req) {
  return (
    req.headers['x-tenant-id'] ||
    req.headers['sap-tenancy'] ||
    (req.query && req.query.tenant) ||
    (req.user && req.user.tenant) ||
    null
  );
}

// Express middleware: validates the tenant header and propagates it via
// cds.context so the search_path hook in `index.js` sees it on every query.
//
// Implementation notes:
//   - The DB query is run against the DB service explicitly (`db.run(...)`),
//     not via the implicit auto-tx of `SELECT.one.from(...)`. The implicit
//     route can leak connections when the middleware fires repeatedly under
//     load, exhausting the pg pool.
//   - cds.context.tenant is set via the AsyncLocalStorage-aware setter so it
//     propagates to downstream handlers in the same request scope.
async function setTenantContext(req, res, next) {
  try {
    const tenantId = getTenantFromRequest(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing x-tenant-id header' });
    }

    const { SELECT } = cds.ql;
    const db = await cds.connect.to('db');
    const tenant = await db.run(SELECT.one.from('db.Tenants').where({ tenantId }));

    if (!tenant) return res.status(404).json({ error: `Tenant '${tenantId}' not found` });
    if (tenant.status !== 'ACTIVE') return res.status(403).json({ error: `Tenant '${tenantId}' is not active` });

    cds.context = { ...(cds.context || {}), tenant: tenantId };
    req.tenant = tenantId;
    next();
  } catch (err) {
    console.error('[mtxpg] tenant middleware error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { setTenantContext, getTenantFromRequest };
