const cds = require('@sap/cds');

const LOG = cds.log('mtxpg');

// Off by default. A tenant in the URL leaks into access logs, Referer headers
// and browser history, and is trivially guessable — enable only for local dev.
function queryTenantAllowed() {
  return Boolean(cds.env.mtxpg && cds.env.mtxpg.allowQueryTenant);
}

function claimedTenant(req) {
  return (
    req.headers['x-tenant-id'] ||
    req.headers['sap-tenancy'] ||
    (queryTenantAllowed() && req.query && req.query.tenant) ||
    null
  );
}

function authenticatedTenant(req) {
  return (req.user && req.user.tenant) || null;
}

// Resolves the tenant for the request.
//
// `req.user.tenant` wins: it is the only source the caller cannot choose. Every
// other source is caller-supplied, so if they were allowed to take precedence an
// application that binds the tenant to a verified JWT claim would be silently
// overridden by a header or a URL parameter.
function getTenantFromRequest(req) {
  return authenticatedTenant(req) || claimedTenant(req);
}

// Express middleware: resolves the tenant and propagates it via cds.context so
// the search_path hook in `index.js` sees it on every query.
//
// This is tenant RESOLUTION, not authorization. It validates that the tenant
// exists, is active, and matches the authenticated user when there is one. It
// does not authenticate the caller — mount it behind whatever authentication the
// application uses.
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
    const authenticated = authenticatedTenant(req);
    const claimed = claimedTenant(req);

    // A caller bound to one tenant must not be able to name another.
    if (authenticated && claimed && claimed !== authenticated) {
      return res.status(403).json({ error: 'Tenant does not match the authenticated user' });
    }

    const tenantId = authenticated || claimed;
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
    // Log the cause, return a generic message. Raw Postgres text discloses
    // schema names, column types and table existence.
    LOG.error('tenant middleware error', err);
    res.status(500).json({ error: 'Tenant resolution failed' });
  }
}

module.exports = { setTenantContext, getTenantFromRequest };
