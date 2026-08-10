using { managed, cuid } from '@sap/cds/common';

namespace db;

// One registry row per tenant: tenantId is what the schema name is derived from,
// so duplicates would route two rows to one schema and make the middleware's
// SELECT.one pick arbitrarily between them.
@assert.unique: { tenantId: [tenantId] }
entity Tenants : cuid, managed {
  tenantId    : String(50) not null;
  name        : String(100) not null;
  status      : String(20) default 'ACTIVE';
  config      : LargeString; // JSON configuration — never exposed by TenantService; do not store secrets here
}
