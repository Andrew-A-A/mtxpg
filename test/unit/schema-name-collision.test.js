const TenantManager = require('../../src/adapter/pg-adapter');
const { sanitize } = TenantManager;

// These assert the property a schema-per-tenant router MUST hold:
// distinct tenant ids must never map to the same schema. See ISSUES.md #6.
describe('schema names must be injective (distinct tenants → distinct schemas)', () => {
  const collidingPairs = [
    ['acme-corp', 'acme.corp'],
    ['acme corp', 'acme_corp'],
    ['ACME', 'acme'],
    ['a/b', 'a:b'],
    ['tenant@1', 'tenant#1'],
  ];

  test.each(collidingPairs)('%s and %s must not share a schema', (a, b) => {
    expect(TenantManager.getSchemaName(a)).not.toBe(TenantManager.getSchemaName(b));
  });

  test('an id made only of punctuation must not degrade to a constant', () => {
    expect(sanitize('@@@')).not.toBe(sanitize('###'));
  });

  test('non-ASCII ids must stay distinguishable', () => {
    // 'müller' and 'm_ller' are different companies.
    expect(sanitize('müller')).not.toBe(sanitize('m_ller'));
  });
});

describe('schema name length', () => {
  test('stays inside PostgreSQL 63-byte identifier limit (silent truncation = collision)', () => {
    const maxId = 'x'.repeat(50); // tenantId is declared String(50)
    expect(Buffer.byteLength(TenantManager.getSchemaName(maxId))).toBeLessThanOrEqual(63);
  });

  test('a multi-byte id within String(50) still fits in 63 bytes', () => {
    expect(Buffer.byteLength(TenantManager.getSchemaName('ü'.repeat(50)))).toBeLessThanOrEqual(63);
  });
});
