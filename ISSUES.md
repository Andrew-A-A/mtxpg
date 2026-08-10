# mtxpg — pre-publish issue list

Findings from a full functional test pass against `mtxpg@0.5` on Node 22.21,
`@sap/cds` 8.9, `@cap-js/postgres` 1.12, PostgreSQL on localhost, using the
host project in the parent directory.

Every issue below was **reproduced against a running server and a real
database** — nothing here is inferred from reading the code alone. Reproductions
live in `test/hardening/`, `test/destructive/` and `test/unit/schema-name-collision.test.js`.
Those suites are written against *correct* behaviour, so a failing test is an
open defect and it turns green when the defect is fixed.

> **Status: all 11 issues fixed in `mtxpg@0.6.0`.** This file is kept as the
> audit record — the reproductions and root-cause analysis below are what the
> hardening suite was written from. See the "Upgrading to 0.6" section of the
> README for the three breaking changes the fixes required.

State when the audit was taken, against `mtxpg@0.5`:

| Suite | Before | After |
|---|---|---|
| `npm run test:unit` (existing) | 14/14 pass | 19/19 pass (rewritten for the new contracts) |
| `npm run test:integration` (existing) | 12/12 pass | 12/12 pass |
| `test/unit/schema-name-collision.test.js` (new) | 7 fail / 2 pass | 9/9 pass |
| `npm run test:hardening` (new) | 10 fail / 1 pass | 11/11 pass |
| `npm run test:destructive` (new) | 1 fail (kills the server) | 1/1 pass |

Two of the pre-existing unit tests asserted the defective behaviour directly and
were rewritten rather than kept green: `sanitize.test.js` pinned the lossy
schema-name mapping of #6, and `get-tenant-from-request.test.js` pinned the
`?tenant=` precedence chain of #8.

---

## Blockers — data loss, cross-tenant leakage, or process crash

### 1. A tenant whose schema is missing silently reads and writes `public`
`index.js:21` sets `SET LOCAL search_path TO "<schema>", public`. PostgreSQL
accepts a non-existent schema in `search_path` without error, so every query
falls through to the trailing `public` — which holds the deployed template
tables. The request succeeds with 201/200 and the caller never learns their
schema is gone.

Reproduced: two tenants with `ACTIVE` registry rows and no schemas. Tenant A's
`POST /odata/v4/business/Products` returned **201**, the row landed in
`public.db_products`, and tenant B's `GET` **returned tenant A's row**.

Reachable in production through issues 2, 4, 5 and 8, through a restored
registry backup, or through an operator dropping a schema by hand.

Fix: drop `, public` from the tenant `search_path` and keep the registry lookup
on an explicitly `public.`-qualified query, or verify the schema exists before
setting it and fail closed.

*Test:* `hardening.test.js` → "a tenant whose schema is missing must FAIL…"

---

### 2. `deleteTenant` drops schemas it does not own, and reports success for tenants that never existed
`tenant-service.js:_deprovision` runs `DROP SCHEMA … CASCADE` before checking
that the tenant exists, using only the sanitized name.

* `deleteTenant({tenantId:'never_existed'})` → **200 "deleted successfully"**.
* Tenant `acme-1` is live. `deleteTenant({tenantId:'acme.1'})` — an id that was
  never registered — **destroyed `tenant_acme_1` and all of its data**, and
  returned 200.

Fix: look the tenant up first, 404 if absent, and only then drop the schema
named on that row.

*Tests:* "deleteTenant on an unknown tenant must 404…", "deleteTenant must never
drop a schema belonging to a different tenant"

---

### 3. `POST /odata/v4/tenant/Tenants` never responds and permanently leaks a pooled connection
`this.on('CREATE','Tenants')` returns `_provision()`'s string
(`"Tenant x created successfully"`). CAP's OData layer then does
`'ID' in <that string>` in `calculateLocationHeader` and throws
`TypeError: Cannot use 'in' operator to search for 'ID' in Tenant … created successfully`.
The throw is uncaught, no response is ever sent, and the transaction is left
open.

Measured: 5 such requests took the `idle in transaction` backend count from 1 to
6, permanently. With the host's `pool.max` of 20 the app stops serving after
~20 requests; the open transactions also block unrelated DDL (a concurrent
`DROP SCHEMA` sat waiting on their locks). The schema is created but the
registry row is never committed, so every attempt also leaves an orphan schema.

Fix: `on('CREATE','Tenants')` must return the created entity (or `req.data`),
not a status string.

*Test:* "POST /Tenants responds, and does not leak an open transaction"

---

### 4. `POST /odata/v4/tenant/Tenants` with no `tenantId` crashes the server process
The CRUD handlers call `this._provision({ data: req.data })` — a plain object
with no `reject`. `_provision` line 33 then calls `req.reject(400, …)` →
`TypeError: req.reject is not a function`, uncaught, **process exits**.

Unauthenticated, one request, whole service down. Confirmed: every subsequent
request in the run returned `ECONNREFUSED`.

Fix: pass the real `req` through to `_provision`/`_deprovision` instead of
fabricating `{data}`, and validate before dispatching.

*Test:* `test/destructive/process-crash.test.js`

---

### 5. `DELETE /odata/v4/tenant/Tenants(ID)` returns 204 but does nothing
Same fake-request root cause: `db.tx({data:…})` produces a transaction with no
request lifecycle to commit it. The `DROP SCHEMA` and the registry `DELETE`
both roll back, yet OData still answers **204 No Content**. Verified after the
call: schema still present, registry row still present, one more leaked
`idle in transaction` backend.

A caller who trusts the 204 believes the tenant is gone. Combined with issue 1,
a subsequently "re-created" tenant is a live registry row with data in `public`.

*Test:* "DELETE /Tenants(ID) actually removes the schema and the row"

---

### 6. Distinct tenant ids collapse onto the same schema
`sanitize()` maps every non-`[a-zA-Z0-9_]` character to `_` and lowercases, with
no collision handling and no uniqueness constraint anywhere:

| These ids | all become |
|---|---|
| `acme-corp`, `acme.corp`, `acme corp`, `acme/corp`, `acme_corp` | `tenant_acme_corp` |
| `ACME`, `acme`, `Acme` | `tenant_acme` |
| `@@@`, `###`, `!!!` | `tenant____` |
| `müller`, `m_ller` | `tenant_m_ller` |

Today the second `createTenant` on a colliding id fails with a 500 (`relation
"db_products" already exists`), so it is a denial-of-onboarding rather than an
immediate leak — but issue 2 turns the same collision into destruction of the
first tenant's data, and any registry row created by another path (issue 3/5,
a data migration) turns it into a live shared schema.

`db.Tenants.tenantId` is also a plain `String(50)` — not a key, no
`@assert.unique`, no index. Nothing stops two rows with the same `tenantId`.

Fix: reject ids that do not already match `^[a-z][a-z0-9_]*$` instead of
rewriting them (or hash-suffix the schema name), and add
`@assert.unique: { tenantId: [tenantId] }` plus an index.

*Tests:* `test/unit/schema-name-collision.test.js`

---

### 7. `TenantManager.ensureTenantSchema(id)` without a `tx` deploys the tenant DDL into `public`
The README documents this as supported ("Omit it for standalone use", and
"you can call `TenantManager.ensureTenantSchema(id)` against existing tenants to
apply additions"). It does not work: without an explicit transaction each
`conn.run(...)` takes a different pooled connection, and `SET LOCAL` outside a
transaction is a no-op. So `pg-adapter.js:29` never takes effect and every
`CREATE TABLE` runs against `public`.

Reproduced standalone: schema `tenant_probe_notx_hess` was created and left
**empty**; the DDL raised `relation "db_products" already exists` — i.e. it was
executing against `public`. On a database where those tables did not already
exist, it would have silently written the tenant's tables into the shared
schema.

Fix: open a transaction inside `ensureTenantSchema` when no `tx` is passed
(`db.tx(async tx => …)`), or use `SET search_path` on a dedicated connection.

---

## High — security

### 8. No authorization anywhere; the tenant is whatever the caller claims
`getTenantFromRequest` accepts `x-tenant-id`, `sap-tenancy`, **and `?tenant=`**.
Confirmed: `GET /odata/v4/business/Products?tenant=<id>` with no headers, no
token and no session returned that tenant's rows in full.

Equally, `GET /odata/v4/tenant/Tenants` returned the entire tenant registry
unauthenticated, and `createTenant` / `deleteTenant` are callable by anyone who
can reach the port.

This may be an intentional "bring your own auth" split, but nothing in the code
or README says so, and the query-param fallback actively undermines any auth a
consumer bolts on (a tenant-scoped JWT is silently overridden by a URL
parameter). At minimum: drop the query-param source, document that `mtxpg`
performs no authorization, and require the tenant claim to be cross-checked
against `req.user`.

*Tests:* "?tenant= query param must not grant data access on its own", "the
tenant registry must not be world-readable"

### 9. Internal database errors are returned to the client
`tenant-middleware.js:44` returns `err.message` in a 500 body, and `_provision`
returns `Tenant creation failed: ${err.message}`. A caller sees raw PostgreSQL
text, e.g. `value too long for type character varying(50)` and
`relation "db_products" already exists`, which leaks schema details.

### 10. `getTenantInfo` returns the whole registry row
`JSON.stringify(tenant)` includes `config`, documented as holding JSON
configuration. Anything a consumer stores there (connection strings, keys) is
returned verbatim on an unauthenticated endpoint.

---

## Medium — correctness and lifecycle

### 11. `PATCH /Tenants(ID)` renames the registry row without moving the schema
`on('UPDATE','Tenants')` writes whatever is in `req.data`. Renaming `tenantId`
leaves the row pointing at a schema that does not exist — which, per issue 1,
means that tenant now transparently uses `public`. Confirmed end to end:
after the rename, a request as the renamed tenant returned **200** and was served
from `public`. (The PATCH itself also hangs and leaks a connection.)

Fix: reject `tenantId` changes, or rename the schema in the same transaction.

*Test:* "PATCH /Tenants(ID) must not leave the registry pointing at a schema that does not exist"

### 12. `createTenant` is not idempotent, and there is no DDL upgrade path
Re-running `createTenant` for an existing tenant fails with
`500 relation "db_products" already exists` — the CDS compiler emits plain
`CREATE TABLE`, not `IF NOT EXISTS`. The README's operational note ("you can
call `ensureTenantSchema(id)` against existing tenants to apply additions") is
therefore wrong on two counts (see also issue 7).

Adding a column or an entity leaves every existing tenant schema stale with no
supported way to migrate. For a package whose whole purpose is replacing
`@sap/cds-mtxs`, tenant DDL upgrade is table stakes — it needs to exist, or the
README needs to say plainly that it does not.

*Test:* "createTenant on an existing tenant is idempotent…"

### 13. Oversize `tenantId` surfaces as a 500
`tenantId` longer than the declared `String(50)` reaches PostgreSQL and returns
`500 … value too long for type character varying(50)`. Should be a 400 from
input validation at the boundary.

*Test:* "a tenantId longer than the declared String(50) is rejected with 400…"

### 14. The `db.Tenants` exclusion in the hook is name-matched and fragile
`index.js:18` skips exactly `target === 'db.Tenants'`. The projection
`TenantService.Tenants` is *not* skipped, so registry reads through the service
entity do run with a tenant `search_path` — they happen to work only because
the tenant schema has no `tenantservice_tenants` view and the `, public`
fallback catches them. Remove that fallback (issue 1) and these break. Qualify
the registry table as `public.db_tenants` instead of relying on resolution
order.

Relatedly, `TENANTS_TABLE_REGEX = /\bdb_tenants\b/i` filters DDL statements by
*mentioning* `db_tenants`. For the host model it removes exactly the two
intended statements, but any business entity with an association to `Tenants`
would have its `CREATE TABLE` silently dropped from every tenant schema.

### 15. `_cachedDDL` is a permanent process-level cache
`pg-adapter.js:48` never invalidates. Documented, but it means a rolling deploy
can provision tenants from two different model versions depending on which pod
answers.

### 16. `tenant-utils.js` is dead code that contradicts the middleware
`getTenantByRequest` uses the implicit auto-tx (`SELECT.one.from(...)`) that the
comment in `tenant-middleware.js:19-21` explicitly warns leaks connections under
load. It is exported as public API (`tenantUtils`), documented as "misc
helpers", and used nowhere. Delete it or fix it to match.

### 17. One extra round-trip per statement
The hook issues a separate `SET LOCAL search_path` before **every** query, not
once per transaction. A deep OData `$expand` doubles its round-trip count. Cache
the current `search_path` on the transaction and set it only on first use.

---

## Low — packaging and docs, but publish-blocking

### 18. `"version": "0.5"` is not valid semver
`npm publish` requires `MAJOR.MINOR.PATCH`. Must become `0.5.0`.

### 19. Missing package metadata
`license`, `repository`, `author`, `bugs`, `homepage`, `engines` are all absent.
A `LICENSE` file (MIT) exists but is not declared in `package.json`, so npm will
show the package as UNLICENSED. `engines` should state the Node floor.

`npm pack --dry-run` output is otherwise correct — 10 files, 9.2 kB, no tests or
`node_modules` leaked.

### 20. No TypeScript types
No `index.d.ts` and no `types` field. Not fatal, but expected of a "mature"
package and cheap for a surface this small (4 exports).

### 21. `console.log` instead of `cds.log`
`index.js`, `pg-adapter.js`, `tenant-service.js` and `tenant-middleware.js` all
write directly to the console, so consumers cannot route or silence mtxpg output
through CAP's logging config. Use `cds.log('mtxpg')`.

### 22. README inaccuracies
* Setup §2 shows `"host": "DB_HOST"` etc. as credential values. CAP does not
  substitute env vars there — those literal strings are what gets used. The
  host project in this repo hardcodes real values, and `.env` is unused by the
  db config, which is exactly the open TODO at the bottom of the README.
* The configuration table marks `cds.fiori.lean_draft: true` **required** — the
  host project does not set it and the server starts and serves fine.
* Testing §"Prerequisites" says the suite "calls `cds.test('<host-project-root>')`".
  It does not; `test/helpers/server.js` spawns `npx cds-serve` as a child
  process. The `--runInBand` rationale given ("`cds.test()` boots a single shared
  HTTP server") is stale for the same reason.
* Operational notes claim `createTenant`/`deleteTenant` transactionality that
  holds for the action endpoints but not for the OData CRUD endpoints
  (issues 3 and 5).
* `TenantManager.ensureTenantSchema(tenantId, tx?)` is documented with `tx`
  optional; per issue 7 it is mandatory.

### 23. The published package cannot run its own tests
`test/helpers/server.js` resolves the host project as
`path.resolve(__dirname, '../../..')`, i.e. it only works while mtxpg is
vendored inside a CAP app. Tests are correctly excluded from the tarball, but
there is no self-contained fixture project, so CI for the package itself has to
carry a host app. Worth adding a minimal `test/fixture/` CAP project — the jest
config already ignores that path, suggesting it was planned.

---

## What is working correctly

Worth stating explicitly, since these are the hard parts:

* **Concurrency isolation is sound.** 24 interleaved writes from two tenants
  landed entirely in their own schemas, none in `public`. `cds.context`
  propagation through `AsyncLocalStorage` and `SET LOCAL` per transaction both
  behave as documented — no cross-request bleed.
* **SQL injection through the tenant id is blocked.** `sanitize()`'s allow-list
  neutralises `'; DROP TABLE db_products; --` (it 404s and the table survives).
  The collision problem in issue 6 is a *correctness* consequence of that
  allow-list, not an injection hole.
* **The `search_path` mechanism itself works.** Tables and views deploy into the
  tenant schema, `db_Tenants` is correctly kept out of tenant schemas, and the
  documented 400/404/403 middleware responses are all correct.
* **DDL filtering** removes exactly `CREATE TABLE db_Tenants` and
  `CREATE VIEW TenantService_Tenants` from the host model, as intended.

---

## Suggested order of work

1. Issues 4, 3, 5 — the CRUD handlers. One root cause (`{data:…}` fake request
   and string return values); fixing it clears the crash, the hang, the
   connection leak and the silent no-op delete.
2. Issue 1 — remove the `public` fallback and fail closed. This is the one that
   turns every other lifecycle bug into a cross-tenant data leak.
3. Issue 2 — look up before dropping.
4. Issue 6 — validate ids instead of rewriting them; add the unique constraint.
5. Issue 7 — wrap `ensureTenantSchema` in its own transaction.
6. Issue 8 — decide and document the auth contract; drop the query-param source.
7. Issues 18/19 — packaging metadata, then publish.
