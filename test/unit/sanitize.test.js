const TenantManager = require('../../src/adapter/pg-adapter');

const { sanitize, assertValidTenantId, MAX_TENANT_ID } = TenantManager;

// sanitize() used to be a plain lossy slug — every character outside
// [a-zA-Z0-9_] rewritten to '_' — which mapped distinct tenants onto one schema.
// It now appends a hash of the raw id so the mapping is injective; the slug is
// kept as a readable prefix. Injectivity itself is covered by
// schema-name-collision.test.js.
describe('sanitize(tenantId)', () => {
  test('keeps a readable, identifier-safe, lowercased slug prefix', () => {
    expect(sanitize('ACME')).toMatch(/^acme_[0-9a-f]{6}$/);
    expect(sanitize('acme corp')).toMatch(/^acme_corp_[0-9a-f]{6}$/);
    expect(sanitize('acme-corp')).toMatch(/^acme_corp_[0-9a-f]{6}$/);
    expect(sanitize('tenant_42')).toMatch(/^tenant_42_[0-9a-f]{6}$/);
  });

  test('emits only characters legal in an unquoted PostgreSQL identifier', () => {
    expect(sanitize("acme';--drop")).toMatch(/^[a-z0-9_]+$/);
    expect(sanitize('müller')).toMatch(/^[a-z0-9_]+$/);
  });

  test('is deterministic — same input → same output', () => {
    expect(sanitize('Acme.Corp')).toBe(sanitize('Acme.Corp'));
  });

  test('throws on falsy input', () => {
    expect(() => sanitize('')).toThrow(/required/);
    expect(() => sanitize(null)).toThrow(/required/);
    expect(() => sanitize(undefined)).toThrow(/required/);
  });

  test('coerces non-string input to string', () => {
    expect(sanitize(42)).toBe(sanitize('42'));
  });
});

describe('assertValidTenantId(tenantId)', () => {
  test('rejects ids longer than the declared String(50) before they reach the DB', () => {
    expect(() => assertValidTenantId('x'.repeat(MAX_TENANT_ID + 1))).toThrow(/at most 50/);
  });

  test('accepts an id exactly at the limit', () => {
    expect(assertValidTenantId('x'.repeat(MAX_TENANT_ID))).toHaveLength(MAX_TENANT_ID);
  });
});

describe('TenantManager.getSchemaName(tenantId)', () => {
  test('prefixes with tenant_ and keeps the slug recognisable', () => {
    expect(TenantManager.getSchemaName('ACME')).toMatch(/^tenant_acme_[0-9a-f]{6}$/);
    expect(TenantManager.getSchemaName('foo-bar')).toMatch(/^tenant_foo_bar_[0-9a-f]{6}$/);
  });

  test('throws on falsy input via sanitize', () => {
    expect(() => TenantManager.getSchemaName(null)).toThrow(/required/);
  });

  test('is deterministic — same input → same schema name', () => {
    expect(TenantManager.getSchemaName('Acme.Corp')).toBe(TenantManager.getSchemaName('Acme.Corp'));
  });
});
