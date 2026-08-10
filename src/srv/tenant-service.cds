using { db } from '../db/schema';

// Tenant onboarding and offboarding is a control-plane API — it provisions and
// drops PostgreSQL schemas. It therefore ships closed: grant the `mtxpg-admin`
// role to the operators allowed to manage tenants.
//
// Note this is unrelated to `setTenantContext`, which performs tenant
// *resolution* for the business routes, not authorization. See the README.
@requires: 'mtxpg-admin'
service TenantService {
  // `config` is deliberately not projected. It is the documented place for
  // per-tenant connection details and API keys, and an unqualified
  // `projection on db.Tenants` handed it back on every read.
  entity Tenants as projection on db.Tenants {
    ID, tenantId, name, status, createdAt, modifiedAt
  };

  action   createTenant(tenantId: String(50), name: String, config: String) returns String;
  action   deleteTenant(tenantId: String(50)) returns String;
  function getTenantInfo(tenantId: String(50)) returns String;
  function listTenants() returns array of String;
}
