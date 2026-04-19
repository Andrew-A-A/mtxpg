using { db } from '../db/schema';

service TenantService {
  entity Tenants as projection on db.Tenants;

  action   createTenant(tenantId: String, name: String, config: String) returns String;
  action   deleteTenant(tenantId: String) returns String;
  function getTenantInfo(tenantId: String) returns String;
  function listTenants() returns array of String;
}
