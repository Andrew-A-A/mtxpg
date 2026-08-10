# mtxpg

Schema-per-tenant multitenancy for SAP CAP on PostgreSQL — the PostgreSQL counterpart to `@sap/cds-mtxs` (which targets SAP HANA).

Each tenant gets its own PostgreSQL schema (`tenant_<slug>_<hash>`). The CDS model is deployed identically into every tenant schema, while a single shared `db_Tenants` table in `public` tracks the tenant registry. At request time, the package sets `search_path` on the active database transaction so all CAP queries transparently hit the caller's tenant schema.

> **Read this before wiring it up:** `TenantService` is a control-plane API and ships behind the `mtxpg-admin` role, and `setTenantContext` performs tenant *resolution*, not authorization. See [Security model](#security-model).

**Requirements:** Node >= 18 · `@sap/cds` >= 8 · `@cap-js/postgres` >= 1 · PostgreSQL 12+. Both CAP packages are peer dependencies — mtxpg does not bundle them.

Read [Limitations](#limitations) before adopting. mtxpg deliberately does *not* implement everything `@sap/cds-mtxs` does.

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
       - verifies the tenant schema exists (cached per process)
       - runs SET LOCAL search_path TO "tenant_acme_1f3d9c"
         (registry targets instead get search_path TO public)
                  ▼
       @cap-js/postgres executes the query
       - tables resolve to tenant_acme_1f3d9c.db_Products etc.
```

`public` is deliberately **not** on the tenant `search_path`. PostgreSQL accepts a non-existent schema in `search_path` without error and simply skips it, so a trailing `public` would turn a missing tenant schema into a silent read/write of the shared template tables. Without it, a tenant whose schema is missing fails closed with `Tenant '<id>' is not provisioned`.

Provisioning (`createTenant` action) runs `CREATE SCHEMA` followed by the full CDS-generated DDL, all on the same request transaction so it's atomic.

---

## Setup

### 1. Install

In your CAP project:

```bash
npm install @sap/cds @cap-js/postgres
npm install mtxpg
```

`@cap-js/postgres` and `@sap/cds` (>=8) are peer dependencies — install them yourself; mtxpg will not pull them in.

### 2. Configure `package.json`

```jsonc
{
  "dependencies": {
    "@sap/cds": "^8",
    "@cap-js/postgres": "^1",
    "mtxpg": "^0.6.0"
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
          "host":     "localhost",
          "port":     5432,
          "database": "my_database",
          "user":     "postgres",
          "password": "postgres",
          "ssl":      false
        }
      }
    },
    "features": { "serve_on_root": true }
  }
}
```

#### Credentials from the environment

**CAP does not expand env-var names inside `credentials`.** Writing `"host": "DB_HOST"` connects to a host literally called `DB_HOST` — verified, not theoretical. To source credentials from the environment, use CAP's `CDS_*` config overrides, which map onto the `cds.requires.*` path:

```bash
CDS_REQUIRES_DB_CREDENTIALS_HOST=db.internal
CDS_REQUIRES_DB_CREDENTIALS_PORT=5432
CDS_REQUIRES_DB_CREDENTIALS_DATABASE=my_database
CDS_REQUIRES_DB_CREDENTIALS_USER=app
CDS_REQUIRES_DB_CREDENTIALS_PASSWORD=…
```

These are read by `@sap/cds` itself, so they work whether they come from a real environment, a `.env` file loaded by `dotenv`, or a platform binding. A plain `.env` with `DB_HOST=…` names is **not** picked up by the db config on its own — either rename the variables as above, or read `process.env` yourself in `server.js` and assign into `cds.env.requires.db.credentials` before the db service connects.

On SAP BTP, prefer a real service binding (`VCAP_SERVICES`), which CAP resolves without any of this.

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

You should see `schema-per-tenant routing enabled` from the `mtxpg` logger. All mtxpg output goes through `cds.log('mtxpg')`, so it obeys CAP's logging config — silence it with `CDS_LOG_LEVELS_MTXPG=error`.

---

## Usage

### Onboard a tenant

```bash
curl -X POST http://localhost:4004/odata/v4/tenant/createTenant \
  -u operator:operator \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme","name":"ACME Corp"}'
```

Effect:
- `CREATE SCHEMA "tenant_acme_<hash>"`
- All business tables created inside that schema
- A row inserted into `public.db_Tenants` with `status = 'ACTIVE'`

All in a single transaction — if any DDL fails, the registry row rolls back. Re-running the same call is idempotent.

`tenantId` must be non-empty and at most 50 characters; anything else is a 400.

### Tenant-scoped queries

Send the tenant header on every business request:

```bash
curl http://localhost:4004/odata/v4/business/Products \
  -H "x-tenant-id: acme"
```

The middleware looks up the tenant in `db_Tenants`, sets `cds.context.tenant = 'acme'`, and the `db.before('*')` hook runs `SET LOCAL search_path TO "tenant_acme_<hash>"` on the transaction. CAP queries against `db.Products` resolve to that schema.

Tenant resolution order:

1. `req.user.tenant` — the authenticated identity. Wins over everything else, because it is the only source the caller cannot choose.
2. `x-tenant-id` header
3. `sap-tenancy` header
4. `?tenant=` query parameter — **ignored unless** `cds.env.mtxpg.allowQueryTenant` is explicitly enabled.

If the caller is authenticated to one tenant and names a different one in a header, the request is rejected with 403.

The `?tenant=` parameter is off by default because it is an unauthenticated tenant-selection channel: it would let anyone who guesses a tenant id read that tenant's data with a plain URL, and tenant ids would leak into access logs, `Referer` headers and browser history. Enable it only for local development:

```json
{ "cds": { "mtxpg": { "allowQueryTenant": true } } }
```

### Offboard a tenant

```bash
curl -X POST http://localhost:4004/odata/v4/tenant/deleteTenant \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"acme"}'
```

Looks the tenant up in the registry, then drops `tenant_acme_<hash>` (CASCADE) and removes its row. An unknown `tenantId` is a 404, not a silent success.

### Other actions

| Action | Description |
|---|---|
| `POST /odata/v4/tenant/createTenant` | Provision schema and registry row |
| `POST /odata/v4/tenant/deleteTenant` | Drop schema and registry row |
| `GET  /odata/v4/tenant/getTenantInfo(tenantId='acme')` | Returns tenant record as JSON |
| `GET  /odata/v4/tenant/listTenants()` | Returns array of active tenant IDs |
| `GET  /odata/v4/tenant/Tenants` | Standard CRUD over the registry |

Every one of these requires the `mtxpg-admin` role — see [Security model](#security-model). None of them return the `config` field.

---

## Security model

Two separate concerns, and mtxpg only owns one of them.

### `TenantService` requires the `mtxpg-admin` role

Tenant onboarding and offboarding create and `DROP SCHEMA … CASCADE` real customer data, so the service is annotated `@requires: 'mtxpg-admin'` and ships closed. Grant the role to your operators:

```json
{
  "cds": {
    "requires": {
      "auth": {
        "kind": "xsuaa",
        "restrict_all_services": false
      }
    }
  }
}
```

…and map `mtxpg-admin` in your `xs-security.json` role collections. For local development with mocked auth:

```json
{
  "cds": {
    "requires": {
      "auth": {
        "kind": "mocked",
        "users": { "operator": { "password": "operator", "roles": ["mtxpg-admin"] } }
      }
    }
  }
}
```

Widen it if you need to — `@requires` can be overridden with a CDS aspect — but do it deliberately. Without the role, every authenticated user, including any regular tenant user, could enumerate the registry and delete other tenants.

### `setTenantContext` is resolution, not authorization

The middleware answers *"which tenant is this request for, and is it usable?"* — it validates that the tenant exists and is `ACTIVE`, and that the claimed tenant matches the authenticated user when there is one. It does **not** authenticate the caller.

You are responsible for:

- authenticating the request (CAP's `auth` middleware, or your own) **before** `setTenantContext` runs, and
- binding that identity to a tenant, so `req.user.tenant` is populated.

Mounting `setTenantContext` on a route that anyone can reach means anyone can pick a tenant with a header. That is a supported deployment (single-tenant-per-deployment, trusted network) but it is a decision, not a default.

### Do not store secrets in `config`

`db.Tenants.config` is a free-form `LargeString`. `TenantService` never returns it — neither the `Tenants` projection nor `getTenantInfo` exposes it — but it is stored in plaintext in `public.db_Tenants` and readable by anything with database access. Put credentials in a secret store and reference them from `config` instead.

---

## Public API

```js
const {
  TenantManager,        // class — schema lifecycle
  setTenantContext,     // Express middleware
  getTenantFromRequest, // tenant resolution helper
  tenantMiddleware,     // { setTenantContext, getTenantFromRequest }
} = require('mtxpg');
```

Requiring the package for its side effect (`require('mtxpg')`) is what registers the `db.before('*')` search_path hook; the named exports are for callers that drive provisioning themselves.

TypeScript declarations ship with the package (`index.d.ts`) — no `@types/mtxpg` needed. They are self-contained: the request, response and transaction parameters are structural types, so an Express `Request`/`Response` and a CAP `db.tx(req)` satisfy them without mtxpg depending on `@types/express` or CAP's own type package.

```ts
import { TenantManager, setTenantContext } from 'mtxpg';

const schema: string = TenantManager.getSchemaName('acme'); // tenant_acme_822b33
```

### `TenantManager`

| Method | Description |
|---|---|
| `getSchemaName(tenantId)` | Returns `tenant_<slug>_<hash>` |
| `ensureTenantSchema(tenantId, tx?)` | Creates schema and deploys DDL. Idempotent |
| `dropTenantSchema(tenantId, tx?)` | `DROP SCHEMA … CASCADE` |
| `assertValidTenantId(tenantId)` | Throws unless non-empty and ≤ 50 characters |

Pass `tx` (a CAP DB transaction, e.g. `db.tx(req)`) to make the operation atomic with the caller's own work. Omit it for standalone use — `ensureTenantSchema` then opens its own transaction, which it must: `SET LOCAL` is a no-op outside a transaction block, and autocommitted statements may land on different pooled connections, so the DDL would execute against the default `search_path` (i.e. into `public`).

`ensureTenantSchema` leaves the transaction's `search_path` on `public` when it returns, so a registry write can follow it on the same `tx`.

#### Schema naming

`getSchemaName` is **injective** — distinct tenant ids always map to distinct schemas. The readable slug (non-`[a-zA-Z0-9_]` rewritten to `_`, lowercased) is lossy on its own: `acme-corp`, `acme.corp` and `ACME_CORP` all flatten to `acme_corp`. A 6-character hash of the raw id is therefore appended, keeping the name recognisable to an operator while guaranteeing that two customers never share a schema. Total length is capped at PostgreSQL's 63-byte identifier limit, since silent truncation is itself a collision.

### `setTenantContext(req, res, next)`

Express middleware. Resolves the tenant, looks it up in `db_Tenants`, then sets `cds.context.tenant`. Rejects with:

| Status | Reason |
|---|---|
| 400 | No tenant could be resolved |
| 403 | Claimed tenant does not match the authenticated user |
| 404 | Unknown tenant |
| 403 | Tenant is not `ACTIVE` |
| 500 | Lookup failed (details go to the `mtxpg` log, not the response) |

Tenant resolution, not authorization — see [Security model](#security-model).

### `getTenantFromRequest(req)`

Returns the resolved tenant ID, or `null`. `req.user.tenant` outranks caller-supplied headers; see the resolution order under [Tenant-scoped queries](#tenant-scoped-queries).

---

## Configuration reference

| Setting | Where | Required | Notes |
|---|---|---|---|
| `cds.requires.db.kind: 'postgres'` | `package.json` | yes | Tells CAP to use `@cap-js/postgres` |
| `cds.requires.db.credentials.*`    | `package.json` / `CDS_*` env | yes | Standard pg connection params. Literal values or `CDS_REQUIRES_DB_CREDENTIALS_*` — **not** env-var names inline |
| `using from 'mtxpg/src/db/schema'`  | `db/schema.cds` | yes | Brings `db.Tenants` into the deployable model |
| `using from 'mtxpg/src/srv/tenant-service'` | a file under `srv/` | yes | Brings `TenantService` into the served model |
| `require('mtxpg')` | `server.js` | yes | Registers the `db.before('*')` search_path hook |
| `cds.requires.auth` + `mtxpg-admin` role | `package.json` / `xs-security.json` | yes | Required to call `TenantService` at all |
| `cds.mtxpg.allowQueryTenant` | `package.json` | no | Default `false`. Enables `?tenant=`; dev only |

---

## Operational notes

- **DDL changes to business entities** require replaying the DDL into every tenant schema. `CREATE TABLE` / `CREATE VIEW` are rewritten to `CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE VIEW`, so calling `TenantManager.ensureTenantSchema(id)` against an existing tenant adds new tables and redefines views. It does **not** alter existing tables — adding a column to an already-deployed entity still needs a migration step of your own.
- **The DDL is cached in process memory** after the first `createTenant` call. Restart the server after schema changes.
- **`createTenant` is idempotent.** Re-running it against an existing tenant re-applies the DDL and leaves the registry row untouched, so onboarding retries are safe.
- **`tenantId` is immutable.** `PATCH /Tenants(ID)` rejects a change to `tenantId` with 400: the schema name is derived from it, so a rename would leave the registry pointing at a schema that does not exist. Delete and re-create instead.
- **Transactions**: `createTenant` and `deleteTenant` are atomic with their registry update. The `SET LOCAL search_path` only affects the current transaction, so search_path leakage between requests is not possible.
- **The `db_Tenants` table lives in `public`**. The `db.before('*')` hook routes registry targets (`db.Tenants` and any projection on it) to `public` explicitly, rather than relying on `search_path` resolution order.
- **Schema existence is cached per process.** The hook verifies a tenant schema exists before pinning `search_path` to it, and remembers the positive result. Dropping a tenant schema by hand under a running server leaves that cache stale — restart after manual surgery.
- **Errors are generic by design.** Provisioning and middleware failures return `Tenant creation failed` / `Tenant resolution failed`; the cause goes to the `mtxpg` log. Raw PostgreSQL text discloses schema names, column types and table existence, so check the log rather than the response body.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Service "TenantService" has no handler for "undefined"` | Calling `req.tx.run(rawSQL)` — `req.tx` is the service tx, not the DB tx | Use `(await cds.connect.to('db')).tx(req).run(...)` |
| `Generated foreign key element "X_ID" … conflicts with existing element` | DDL generated from runtime CSN (already has FKs materialised) | `TenantManager._tenantDDL()` loads a fresh CSN via `cds.load('*')` — make sure the cached DDL is invalidated on schema change |
| Tables created in `public` only, none in tenant schema | `search_path` not set before DDL | Confirm `SET LOCAL search_path` runs first in `ensureTenantSchema`, and that the DDL runs inside a transaction |
| `Tenant '<id>' is not provisioned` on a business request | Registry row exists but its schema does not | Re-run `createTenant` for that tenant (idempotent). This is the fail-closed path that used to silently read `public` |
| `401` from every `/odata/v4/tenant` call | Request is unauthenticated | Authenticate the caller; the service is not public |
| `403` from every `/odata/v4/tenant` call | Caller is authenticated but lacks the `mtxpg-admin` role | Grant the role — see [Security model](#security-model) |
| `tenantId is immutable` on `PATCH /Tenants(ID)` | Rename attempted | Delete and re-create the tenant; the schema name is derived from `tenantId` |
| Views fail to deploy in tenant schemas | View bodies referenced public tables | Same fix — `search_path` must be set before `CREATE VIEW` |
| `npm run deploy` does nothing | `scripts/deploy.js` `require()`'d `cds-deploy.js`, which short-circuits its CLI block via `if (!module.parent)` | Spawn `cds-deploy` as a child process (already in this repo's wrapper) |
| Connection refused to a host named `DB_HOST` | Env-var *names* used as `credentials` values; CAP does not expand them | Use literals or `CDS_REQUIRES_DB_CREDENTIALS_*` — see [Credentials from the environment](#credentials-from-the-environment) |

---

## Testing

The package ships with a Jest suite covering both unit-level helpers and end-to-end multitenancy behaviour against a real PostgreSQL.

### Layout

```
mtxpg/test/
├── unit/                       # pure functions, no DB
│   ├── sanitize.test.js
│   ├── schema-name-collision.test.js   # schema names must be injective
│   └── get-tenant-from-request.test.js
├── integration/                # boots the host CAP project against real Postgres
│   └── multitenancy.test.js
├── hardening/                  # regression suite for the audited defects
│   └── hardening.test.js
├── destructive/                # isolated: asserts a bad request cannot kill the server
│   └── process-crash.test.js
└── helpers/
    ├── pg.js                   # direct pg client for schema introspection
    ├── server.js               # spawns the host project; supplies the admin credentials
    └── tenant-id.js            # generates collision-free `jest_<ts>_<rand>` IDs
```

`hardening/` is written against the behaviour mtxpg **must** have, so a failure there is a real open defect rather than a stale expectation. `destructive/` is a separate Jest project because a crash would fail every test sharing the run.

### Prerequisites for integration tests

1. **PostgreSQL is running** and reachable. Defaults: `localhost:5432`, db `cds_multitenant`, user/pw `postgres/postgres`. Override with env vars `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.
2. **The host project has been deployed** at least once (`npm run deploy` from the parent), so `public.db_Tenants` and the business tables exist as a template.
3. **The host project is wired** as described in the Setup section (CDS imports + `require('mtxpg')` in `server.js`).

The server-backed suites spawn the parent CAP app as a child process (`npx cds-serve`) and drive it over HTTP — that's why the host wiring matters even for tests living inside the package. `TenantService` requires the `mtxpg-admin` role, so `test/helpers/server.js` injects a mock admin user into the spawned server via a `CDS_REQUIRES_AUTH_USERS` override and exports its `Authorization` header; the host project needs no test-only auth config of its own.

### Running

From inside `mtxpg/`:

```bash
npm install               # installs jest, pg, axios, typescript (devDeps)
npm run types:check       # tsc --noEmit over index.d.ts; no DB required
npm run test:unit         # ~1s, no DB required
npm run test:integration  # boots CAP, hits real Postgres
npm run test:hardening    # regression suite for the audited defects
npm run test:destructive   # isolated — kills the server on purpose
npm test                  # unit + integration
npm run test:all          # types:check + all four suites, in order
```

`types:check` compiles `index.d.ts` together with `test/types/usage.ts`, a compile-only fixture that exercises every export. It is the guard against declarations drifting from the implementation — types that are never compiled are documentation, not contracts.

`--runInBand` is enforced because each project boots a single shared HTTP server; running test files in parallel would clobber it. Set `TEST_SERVER_LOG=1` to forward the spawned server's output — necessary when debugging a 500, since error responses are deliberately generic.

Last full run — Node 22.21, `@sap/cds` 8.9.4, `@cap-js/postgres` 1.12, PostgreSQL on localhost:

| Suite | Result |
|---|---|
| types:check | clean (`tsc` 5.9, `--strict`) |
| unit | 28/28 pass |
| integration | 12/12 pass |
| hardening | 11/11 pass |
| destructive | 1/1 pass |

### What's covered

| Layer | Scenario |
|---|---|
| Unit | `sanitize` — identifier-safe output, lowercasing, falsy-input rejection, SQL-injection-shaped inputs |
| Unit | `getSchemaName` — injective across colliding id pairs, deterministic, within the 63-byte limit |
| Unit | `assertValidTenantId` — rejects ids over the declared `String(50)` |
| Unit | `getTenantFromRequest` — `req.user.tenant` outranks headers; `?tenant=` ignored unless opted in |
| Integration | `createTenant` provisions the schema and a registry row |
| Integration | Tenant schema contains business tables but **not** `db_Tenants` |
| Integration | `listTenants` / `getTenantInfo` reflect the new tenant |
| Integration | `createTenant` rejects missing `tenantId` |
| Integration | `deleteTenant` drops the schema and removes the registry row |
| Integration | POST with `x-tenant-id` lands in `tenant_<id>.db_Products`, not `public` |
| Integration | Tenant A and Tenant B see only their own rows (data isolation) |
| Integration | DELETE only affects the calling tenant |
| Integration | Missing `x-tenant-id` → 400 |
| Integration | Unknown tenant → 404 |
| Integration | Inactive tenant → 403 |
| Integration | `db.before('*')` hook routes registry targets to `public` |
| Hardening | A tenant whose schema is missing fails closed — no write, nothing in `public`, no leak to another tenant |
| Hardening | Concurrent writes from different tenants stay in their own schemas |
| Hardening | `?tenant=` grants no data access on its own |
| Hardening | The registry is not world-readable |
| Hardening | `deleteTenant` 404s on an unknown tenant instead of reporting success |
| Hardening | `deleteTenant` never drops a schema belonging to a different tenant |
| Hardening | `createTenant` is idempotent — no 500, no duplicate registry row |
| Hardening | An over-long `tenantId` is a 400 with no raw DB text |
| Hardening | `PATCH /Tenants(ID)` never leaves the registry pointing at a missing schema |
| Hardening | `DELETE /Tenants(ID)` actually removes the schema and the row |
| Hardening | `POST /Tenants` responds 201 and leaks no open transaction |
| Destructive | `POST /Tenants` with no `tenantId` returns 400 and the process survives |

### Cleanup

Every integration test uses a unique `jest_<timestamp>_<rand>` tenant ID. `afterAll` drops the schemas and removes their registry rows. Even if a run is killed mid-flight, the next run uses fresh IDs and the strays can be removed with:

```sql
DROP SCHEMA IF EXISTS "tenant_jest_..." CASCADE;
DELETE FROM public.db_Tenants WHERE "tenantId" LIKE 'jest_%';
```

### CI / pre-publish gate

Wire `npm run test:all` into your CI step. A green run validates:
- the shipped TypeScript declarations still compile and still match the exports,
- the public API surface still works,
- the search_path hook is in place and fails closed,
- DDL still emits cleanly for the host model,
- the middleware still rejects bad requests with the documented status codes,
- the control plane is still closed to unauthorized callers,
- none of the audited defects have regressed.

Bump the package version only after `npm run test:all` passes against the supported Postgres version.

---

## Upgrading to 0.6

Three breaking changes, all of them closing defects that could leak or destroy tenant data.

### 1. Schema names changed

`getSchemaName` now appends a hash: `tenant_acme` becomes `tenant_acme_<hash>`. Existing tenant schemas will not be found under their old names. For each existing tenant, rename the schema before starting the new version:

```sql
-- print the new name for every registered tenant first:
--   node -e "console.log(require('mtxpg').TenantManager.getSchemaName('acme'))"
ALTER SCHEMA "tenant_acme" RENAME TO "tenant_acme_1f3d9c";
```

If two of your existing tenant ids collided onto one schema, they were already sharing data — split them before upgrading, because the new naming will route them apart and each will then see only what the rename left behind.

### 2. `TenantService` requires the `mtxpg-admin` role

Previously reachable with whatever the host's default auth allowed. Grant the role to your operators or every `/odata/v4/tenant` call returns 401. See [Security model](#security-model).

### 3. `?tenant=` no longer selects a tenant

Set `cds.mtxpg.allowQueryTenant` to re-enable it for local development. Anything relying on it in production was an unauthenticated cross-tenant read.

Also worth knowing: `config` is no longer returned by `getTenantInfo` or `GET /Tenants`, error responses no longer carry PostgreSQL text (check the `mtxpg` log instead), and a tenant whose schema is missing now fails with `Tenant '<id>' is not provisioned` rather than silently reading `public`.

---

## Limitations

Known and deliberate. Read these before choosing mtxpg over `@sap/cds-mtxs`.

- **No schema migration for existing tenants.** `ensureTenantSchema` adds new tables and redefines views; it does not `ALTER` an existing table. Adding or changing a column on a deployed entity needs a migration of your own, replayed across every tenant schema.
- **Not verified on SAP BTP.** Everything documented here was tested against PostgreSQL on localhost with a locally served CAP app. A BTP deployment (Cloud Foundry, service binding via `VCAP_SERVICES`, XSUAA-issued `mtxpg-admin`) is expected to work but has not been exercised end to end. Treat it as unvalidated.
- **No `@sap/cds-mtxs` feature parity.** No extensibility (`cds.xt.ExtensibilityService`), no feature toggles, no model-variant support, no SaaS subscription callbacks (`/-/cds/saas-provisioning`). Tenant onboarding is your own call to `createTenant`, not a subscription event.
- **`Tenants` is a reserved entity name.** The search_path hook routes any target matching `/(^|\.)Tenants$/` to `public`, so a business entity of your own called `Tenants` will be routed to the shared schema.
- **DDL is cached for the process lifetime.** A rolling deploy can provision tenants from two model versions depending on which instance answers. Restart after model changes.
- **The schema-existence cache is positive-only and never invalidated.** Dropping a tenant schema by hand under a running server leaves the cache stale; restart after manual surgery.
- **One `SET LOCAL search_path` per statement**, not per transaction. A deep OData `$expand` roughly doubles its round-trip count.

`ISSUES.md` in the repository is the audit record behind the 0.6 hardening work — it documents each defect, its reproduction, and the fix.

---

## License

MIT — see [LICENSE](./LICENSE).
