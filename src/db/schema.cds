using { managed, cuid } from '@sap/cds/common';

namespace db;

entity Tenants : cuid, managed {
  tenantId    : String(50) not null;
  name        : String(100) not null;
  status      : String(20) default 'ACTIVE';
  config      : LargeString; // JSON configuration
}
