const cds = require('@sap/cds');
const { getTenantFromRequest } = require('../../src/middleware/tenant-middleware');

const req = (overrides = {}) => ({ headers: {}, query: {}, user: {}, ...overrides });

describe('getTenantFromRequest(req)', () => {
  test('returns x-tenant-id header when present', () => {
    expect(getTenantFromRequest(req({ headers: { 'x-tenant-id': 'acme' } }))).toBe('acme');
  });

  test('falls back to sap-tenancy header', () => {
    expect(getTenantFromRequest(req({ headers: { 'sap-tenancy': 'globex' } }))).toBe('globex');
  });

  test('uses req.user.tenant', () => {
    expect(getTenantFromRequest(req({ user: { tenant: 'umbrella' } }))).toBe('umbrella');
  });

  test('returns null when no tenant info is present', () => {
    expect(getTenantFromRequest(req())).toBeNull();
  });

  // The authenticated identity is the only source the caller cannot choose, so
  // it must outrank every header. Otherwise an application that binds the tenant
  // to a verified JWT claim is silently overridden by a request header.
  test('req.user.tenant outranks any caller-supplied header', () => {
    const r = req({
      headers: { 'x-tenant-id': 'attacker', 'sap-tenancy': 'attacker2' },
      query: { tenant: 'attacker3' },
      user: { tenant: 'trusted' },
    });
    expect(getTenantFromRequest(r)).toBe('trusted');
  });

  test('header order among caller-supplied sources: x-tenant-id > sap-tenancy', () => {
    expect(
      getTenantFromRequest(req({ headers: { 'x-tenant-id': 'first', 'sap-tenancy': 'second' } })),
    ).toBe('first');
    expect(getTenantFromRequest(req({ headers: { 'sap-tenancy': 'second' } }))).toBe('second');
  });
});

describe('?tenant= query parameter', () => {
  afterEach(() => {
    delete cds.env.mtxpg;
  });

  test('is ignored by default — it is an unauthenticated tenant-selection channel', () => {
    expect(getTenantFromRequest(req({ query: { tenant: 'initech' } }))).toBeNull();
  });

  test('is honoured only behind the explicit cds.env.mtxpg.allowQueryTenant opt-in', () => {
    cds.env.mtxpg = { allowQueryTenant: true };
    expect(getTenantFromRequest(req({ query: { tenant: 'initech' } }))).toBe('initech');
  });

  test('even when opted in, it does not outrank the authenticated user', () => {
    cds.env.mtxpg = { allowQueryTenant: true };
    expect(
      getTenantFromRequest(req({ query: { tenant: 'initech' }, user: { tenant: 'trusted' } })),
    ).toBe('trusted');
  });
});
