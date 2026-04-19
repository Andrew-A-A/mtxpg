const { getTenantFromRequest } = require('../../src/middleware/tenant-middleware');

const req = (overrides = {}) => ({ headers: {}, query: {}, user: {}, ...overrides });

describe('getTenantFromRequest(req)', () => {
  test('returns x-tenant-id header when present', () => {
    expect(getTenantFromRequest(req({ headers: { 'x-tenant-id': 'acme' } }))).toBe('acme');
  });

  test('falls back to sap-tenancy header', () => {
    expect(getTenantFromRequest(req({ headers: { 'sap-tenancy': 'globex' } }))).toBe('globex');
  });

  test('falls back to ?tenant= query param', () => {
    expect(getTenantFromRequest(req({ query: { tenant: 'initech' } }))).toBe('initech');
  });

  test('falls back to req.user.tenant', () => {
    expect(getTenantFromRequest(req({ user: { tenant: 'umbrella' } }))).toBe('umbrella');
  });

  test('returns null when no tenant info is present', () => {
    expect(getTenantFromRequest(req())).toBeNull();
  });

  test('header order: x-tenant-id > sap-tenancy > query > user', () => {
    const r = req({
      headers: { 'x-tenant-id': 'first', 'sap-tenancy': 'second' },
      query: { tenant: 'third' },
      user: { tenant: 'fourth' },
    });
    expect(getTenantFromRequest(r)).toBe('first');

    const r2 = req({
      headers: { 'sap-tenancy': 'second' },
      query: { tenant: 'third' },
      user: { tenant: 'fourth' },
    });
    expect(getTenantFromRequest(r2)).toBe('second');

    const r3 = req({ query: { tenant: 'third' }, user: { tenant: 'fourth' } });
    expect(getTenantFromRequest(r3)).toBe('third');
  });
});
