# mtxpg

Schema-per-tenant multitenancy for SAP CAP on PostgreSQL — the PostgreSQL counterpart to `@sap/cds-mtxs` (which targets SAP HANA).

Each tenant gets its own PostgreSQL schema (`tenant_<id>`). The CDS model is deployed identically into every tenant schema, while a single shared `db_Tenants` table in `public` tracks the tenant registry. At request time, the package sets `search_path` on the active database transaction so all CAP queries transparently hit the caller's tenant schema.

---

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  HTTP request: x-tenant-id: acme                             │
└─────────────────┬────────────────────────────────────────────┘
                  ▼
       Express middleware (setTenantContext)
       - validates tenant exists in db_Tenants (public)
       - sets cds.context.tenant = 'acme'
                  ▼
       CAP dispatches request → opens DB transaction
                  ▼
       db.before('*') hook (registered by mtxpg)
       - reads cds.context.tenant
       - runs SET LOCAL search_path TO "tenant_acme", public
                  ▼
       @cap-js/postgres executes the query
       - tables resolve to tenant_acme.db_Products etc.
       - db_Tenants resolves through to public
```

Provisioning (`createTenant` action) runs `CREATE SCHEMA "tenant_<id>"` followed by the full CDS-generated DDL, all on the same request transaction so it's atomic.

---

## Setup

### 1. Install

In your CAP project:

```bash
npm install @sap/cds @cap-js/postgres
npm install file:./mtxpg   # or however you vendor mtxpg
```

`@cap-js/postgres` and `@sap/cds` (>=8) are peer dependencies.

### 2. Configure `package.json`

```jsonc
{
  "dependencies": {
    "@sap/cds": "^8",
    "@cap-js/postgres": "^1",
    "mtxpg": "file:./mtxpg"
  },
  "scripts": {
    "start":  "cds-serve",
    "deploy": "node scripts/deploy.js"
  },
  "cds": {
    "requires": {
      "db": {
        "kind": "postgres",
        "credentials": {
          "host":     "${DB_HOST}",
          "port":     "${DB_PORT}",
          "database": "${DB_NAME}",
          "user":     "${DB_USER}",
          "password": "${DB_PASSWORD}",
          "ssl":      false
        }
      }
    },
    "fiori":    { "lean_draft": true },     // required by @cap-js/postgres
    "features": { "serve_on_root": true }
  }
}
```

`cds.fiori.lean_draft: true` is required — `@cap-js/postgres` refuses to start without it.

### 3. Pull the tenant model into your project

Because `cds-deploy` and `cds-serve` only auto-load CDS files from your project's default roots (`db/`, `srv/`, `app/`), you need one-line `using` statements in your own files to bring the tenant entity and service into scope:

**`db/schema.cds`**
```cds
using { managed, cuid } from '@sap/cds/common';
using from 'mtxpg/src/db/schema';      // pulls in db.Tenants

namespace db;

entity Products : cuid, managed { /* … */ }
// … your business entities
```

**`srv/business-service.cds`** (or any service file under `srv/`)
```cds
using { db } from '../db/schema';
using from 'mtxpg/src/srv/tenant-service';   // pulls in TenantService

service BusinessService {
  entity Products as projection on db.Products;
  // …
}
```

The `TenantService` implementation (`mtxpg/src/srv/tenant-service.js`) is auto-discovered by CAP because it sits next to its `.cds` file.

### 4. Bootstrap the runtime

**`server.js`**
```js
require('dotenv').config();
const cds = require('@sap/cds');
require('mtxpg');                                // registers db.before('*') hook
const { setTenantContext } = require('mtxpg');

cds.on('bootstrap', (app) => {
  app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

  // Tenant context required for all OData routes except /tenant
  app.use('/odata/v4/business', setTenantContext);
});

module.exports = cds.server;
```

`require('mtxpg')` must run before `cds.server` starts so the `cds.on('connect', …)` listener is in place when the database service connects.

### 5. Deploy the shared `db_Tenants` table

```bash
npm run deploy
```

This runs `cds-deploy` against the configured PostgreSQL database and creates `public.db_Tenants` (plus the business tables in `public`, which are unused for tenant-scoped traffic but exist as a template).

`scripts/deploy.js` is a thin wrapper that loads `.env` and spawns the `cds-deploy` binary as a child process — needed because `cds-deploy.js` only runs its CLI block when loaded as the main module.

### 6. Start the server

```bash
npm start
```

You should see `[mtxpg] schema-per-tenant routing enabled` in the log.

---

## Usage

### Onboard a tenant

```bash
curl -X POST http://localhost:4004/odata/v4/tenant/createTenant \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme","name":"ACME Corp"}'
```

Effect:
- `CREATE SCHEMA "tenant_acme"`
- All business tables created inside `tenant_acme`
- A row inserted into `public.db_Tenants` with `status = 'ACTIVE'`

All in a single transaction — if any DDL fails, the registry row rolls back.

### Tenant-scoped queries

Send the tenant header on every business request:

```bash
curl http://localhost:4004/odata/v4/business/Products \
  -H "x-tenant-id: acme"
```

The middleware looks up the tenant in `db_Tenants`, sets `cds.context.tenant = 'acme'`, and the `db.before('*')` hook runs `SET LOCAL search_path TO "tenant_acme", public` on the transaction. CAP queries against `db.Products` resolve to `tenant_acme.db_Products`.

Other recognised tenant headers (in order): `x-tenant-id`, `sap-tenancy`, `?tenant=` query param, `req.user.tenant`.

### Offboard a tenant

```bash
curl -X POST http://localhost:4004/odata/v4/tenant/deleteTenant \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme"}'
```

Drops `tenant_acme` (CASCADE) and removes the registry row.

### Other actions

| Action | Description |
|---|---|
| `POST /odata/v4/tenant/createTenant` | Provision schema and registry row |
| `POST /odata/v4/tenant/deleteTenant` | Drop schema and registry row |
| `GET  /odata/v4/tenant/getTenantInfo(tenantId='acme')` | Returns tenant record as JSON |
| `GET  /odata/v4/tenant/listTenants()` | Returns array of active tenant IDs |
| `GET  /odata/v4/tenant/Tenants` | Standard CRUD over the registry |

---

## Public API

```js
const {
  TenantManager,        // class — schema lifecycle
  setTenantContext,     // Express middleware
  getTenantFromRequest, // header parsing helper
  tenantUtils,          // misc helpers
} = require('mtxpg');
```

### `TenantManager`

| Method | Description |
|---|---|
| `getSchemaName(tenantId)` | Returns `tenant_<sanitized-id>` |
| `ensureTenantSchema(tenantId, tx?)` | Creates schema and deploys DDL |
| `dropTenantSchema(tenantId, tx?)` | `DROP SCHEMA … CASCADE` |

Pass `tx` (a CAP DB transaction, e.g. `db.tx(req)`) to keep the operation on the request's connection. Omit it for standalone use.

### `setTenantContext(req, res, next)`

Express middleware. Validates the tenant header, looks up the tenant in `db_Tenants`, rejects with 400 (missing header), 404 (unknown tenant), or 403 (inactive tenant), then sets `cds.context.tenant`.

### `getTenantFromRequest(req)`

Returns the tenant ID extracted from request headers / query / user, or `null`.

---

## Configuration reference

| Setting | Where | Required | Notes |
|---|---|---|---|
| `cds.requires.db.kind: 'postgres'` | `package.json` | yes | Tells CAP to use `@cap-js/postgres` |
| `cds.requires.db.credentials.*`    | `package.json` | yes | Standard pg connection params |
| `cds.fiori.lean_draft: true`        | `package.json` | yes | Required by `@cap-js/postgres` |
| `using from 'mtxpg/src/db/schema'`  | `db/schema.cds` | yes | Brings `db.Tenants` into the deployable model |
| `using from 'mtxpg/src/srv/tenant-service'` | a file under `srv/` | yes | Brings `TenantService` into the served model |
| `require('mtxpg')` | `server.js` | yes | Registers the `db.before('*')` search_path hook |

---

## Operational notes

- **DDL changes to business entities** require redeploying every tenant schema. The package does not currently auto-replay DDL; you can call `TenantManager.ensureTenantSchema(id)` against existing tenants to apply additions (CAP emits `CREATE TABLE IF NOT EXISTS`-equivalent or schema-evolution statements depending on your CAP version).
- **The DDL is cached in process memory** after the first `createTenant` call. Restart the server after schema changes.
- **Transactions**: `createTenant` and `deleteTenant` are atomic with their registry update. The `SET LOCAL search_path` only affects the current transaction, so search_path leakage between requests is not possible.
- **The `db_Tenants` table lives in `public`**. The `db.before('*')` hook explicitly skips `db.Tenants` so registry queries fall through to `public` instead of the tenant schema.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Service "TenantService" has no handler for "undefined"` | Calling `req.tx.run(rawSQL)` — `req.tx` is the service tx, not the DB tx | Use `(await cds.connect.to('db')).tx(req).run(...)` |
| `Generated foreign key element "X_ID" … conflicts with existing element` | DDL generated from runtime CSN (already has FKs materialised) | `TenantManager._tenantDDL()` loads a fresh CSN via `cds.load('*')` — make sure the cached DDL is invalidated on schema change |
| Tables created in `public` only, none in tenant schema | `search_path` not set before DDL | Confirm `SET LOCAL search_path` runs first in `ensureTenantSchema` |
| Views fail to deploy in tenant schemas | View bodies referenced public tables | Same fix — `search_path` must be set before `CREATE VIEW` |
| `npm run deploy` does nothing | `scripts/deploy.js` `require()`'d `cds-deploy.js`, which short-circuits its CLI block via `if (!module.parent)` | Spawn `cds-deploy` as a child process (already in this repo's wrapper) |
| `cds.fiori.lean_draft` error on startup | Missing config | Add `"fiori": { "lean_draft": true }` to `cds` config |

## TODO:
[] Test the behavior of adapter in case of using `.env` file
[] Test project deployment on BTP while using `mtxpg`
