/* eslint-disable no-console */
const cds = require('@sap/cds');
const { SELECT } = cds.ql;

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
// cds.context so the @cap-js/postgres adapter sees it on every query.
async function setTenantContext(req, res, next) {
  try {
    const tenantId = getTenantFromRequest(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing x-tenant-id header' });
    }

    const tenant = await SELECT.one
      .from('db.Tenants')
      .where({ tenantId });

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
