const TenantManager = require('../../src/adapter/pg-adapter');
const { sanitize } = TenantManager;

describe('sanitize(tenantId)', () => {
  test('lowercases ASCII letters', () => {
    expect(sanitize('ACME')).toBe('acme');
  });

  test('replaces non-alphanumerics with underscore', () => {
    expect(sanitize('acme corp')).toBe('acme_corp');
    expect(sanitize('acme-corp')).toBe('acme_corp');
    expect(sanitize('acme.corp')).toBe('acme_corp');
    expect(sanitize('acme/corp')).toBe('acme_corp');
    expect(sanitize("acme';--drop")).toBe('acme____drop');
  });

  test('preserves digits and underscores', () => {
    expect(sanitize('tenant_42')).toBe('tenant_42');
  });

  test('throws on falsy input', () => {
    expect(() => sanitize('')).toThrow(/required/);
    expect(() => sanitize(null)).toThrow(/required/);
    expect(() => sanitize(undefined)).toThrow(/required/);
  });

  test('coerces non-string input to string', () => {
    expect(sanitize(42)).toBe('42');
  });
});

describe('TenantManager.getSchemaName(tenantId)', () => {
  test('prefixes with tenant_ and sanitizes', () => {
    expect(TenantManager.getSchemaName('ACME')).toBe('tenant_acme');
    expect(TenantManager.getSchemaName('foo-bar')).toBe('tenant_foo_bar');
  });

  test('throws on falsy input via sanitize', () => {
    expect(() => TenantManager.getSchemaName(null)).toThrow(/required/);
  });

  test('is deterministic — same input → same schema name', () => {
    const a = TenantManager.getSchemaName('Acme.Corp');
    const b = TenantManager.getSchemaName('Acme.Corp');
    expect(a).toBe(b);
  });
});
