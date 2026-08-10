/**
 * Hardening / regression suite.
 *
 * Every test here asserts behaviour mtxpg MUST have before it is safe to
 * publish. They are written against the *correct* behaviour, so a failure is
 * a real open defect — see ISSUES.md for the matching entry.
 *
 * Same prerequisites as multitenancy.test.js (running Postgres, host project
 * deployed once), plus the mtxpg-admin credentials that helpers/server.js
 * injects into the spawned server. Tests are ordered least-destructive first;
 * the OData CRUD block used to leak connections and is kept last for that
 * reason.
 */

const axios = require('axios');
const TenantManager = require('../../src/adapter/pg-adapter');
const { newTenantId, PREFIX } = require('../helpers/tenant-id');
const { BASE_URL, AUTH } = require('../helpers/server');
const { withClient, schemaExists, dropSchemaIfExists, deleteRegistryRowsByPrefix } = require('../helpers/pg');

// `http` is deliberately anonymous — used to prove the control plane is closed.
const http = axios.create({ baseURL: BASE_URL, validateStatus: () => true, timeout: 15000 });
// `admin` holds the mtxpg-admin role, for the lifecycle calls under test.
const admin = axios.create({ baseURL: BASE_URL, validateStatus: () => true, timeout: 15000, headers: AUTH });
const T = '/odata/v4/tenant';
const B = '/odata/v4/business';

const created = new Set();
async function provision(tenantId, name = tenantId) {
  created.add(tenantId);
  return admin.post(`${T}/createTenant`, { tenantId, name });
}
// Never let a hung request fail the run with an unhandled rejection.
const req = async (fn) => {
  try { return await fn(); } catch (e) { return { status: `ERR:${e.code || e.message}`, data: null }; }
};
const idleTxCount = async () =>
  withClient(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    return r.rows[0].n;
  });

afterAll(async () => {
  for (const id of created) await dropSchemaIfExists(TenantManager.getSchemaName(id)).catch(() => {});
  await deleteRegistryRowsByPrefix(PREFIX).catch(() => {});
  await withClient((c) => c.query(`DELETE FROM public.db_products WHERE name LIKE 'HARDENING-%'`)).catch(() => {});
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('isolation', () => {
  test('a tenant whose schema is missing must FAIL, not silently fall through to public', async () => {
    const a = newTenantId();
    const b = newTenantId();
    created.add(a); created.add(b);
    // Registry row present + ACTIVE, schema absent. Reachable in production via
    // the PATCH-rename path, the no-op CRUD delete, a restored registry backup,
    // or an operator dropping a schema by hand.
    for (const t of [a, b]) {
      await withClient((c) =>
        c.query(
          `INSERT INTO public.db_tenants (id, tenantid, name, status)
           VALUES (gen_random_uuid()::text, $1, $1, 'ACTIVE')`, [t]));
    }

    const write = await req(() =>
      http.post(`${B}/Products`, { name: 'HARDENING-CONFIDENTIAL', price: '1' }, { headers: { 'x-tenant-id': a } }));
    const inPublic = await withClient(async (c) =>
      (await c.query(`SELECT count(*)::int n FROM public.db_products WHERE name = 'HARDENING-CONFIDENTIAL'`)).rows[0].n);
    const asB = await req(() => http.get(`${B}/Products`, { headers: { 'x-tenant-id': b } }));

    expect(write.status).not.toBe(201);                                  // must not accept the write
    expect(inPublic).toBe(0);                                            // must not write to public
    expect(JSON.stringify(asB.data)).not.toContain('HARDENING-CONFIDENTIAL'); // must not leak to another tenant
  });

  test('concurrent writes from different tenants stay in their own schemas', async () => {
    const a = newTenantId(); const b = newTenantId();
    await provision(a); await provision(b);
    const jobs = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(req(() => http.post(`${B}/Products`, { name: `HARDENING-A${i}`, price: '1' }, { headers: { 'x-tenant-id': a } })));
      jobs.push(req(() => http.post(`${B}/Products`, { name: `HARDENING-B${i}`, price: '1' }, { headers: { 'x-tenant-id': b } })));
    }
    await Promise.all(jobs);
    const names = async (t) => withClient(async (c) =>
      (await c.query(`SELECT name FROM "${TenantManager.getSchemaName(t)}".db_products`)).rows.map((r) => r.name));
    expect((await names(a)).every((n) => n.startsWith('HARDENING-A'))).toBe(true);
    expect((await names(b)).every((n) => n.startsWith('HARDENING-B'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe('authorization', () => {
  test('?tenant= query param must not grant data access on its own', async () => {
    const t = newTenantId();
    await provision(t);
    await req(() => http.post(`${B}/Products`, { name: 'HARDENING-QP', price: '1' }, { headers: { 'x-tenant-id': t } }));
    const res = await req(() => http.get(`${B}/Products?tenant=${t}`));
    expect(JSON.stringify(res.data)).not.toContain('HARDENING-QP');
  });

  test('the tenant registry must not be world-readable', async () => {
    const res = await req(() => http.get(`${T}/Tenants`));
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle correctness
// ---------------------------------------------------------------------------

describe('tenant lifecycle', () => {
  test('deleteTenant on an unknown tenant must 404, not report success', async () => {
    const res = await req(() => admin.post(`${T}/deleteTenant`, { tenantId: `${PREFIX}never_existed_xyz` }));
    expect(res.status).toBe(404);
  });

  test('deleteTenant must never drop a schema belonging to a different tenant', async () => {
    const base = Math.random().toString(36).slice(2, 6);
    const live = `${PREFIX}collide-${base}`;   // '-' sanitizes to '_'
    const other = `${PREFIX}collide.${base}`;  // '.' sanitizes to '_' → same schema
    await provision(live);
    await req(() => admin.post(`${T}/deleteTenant`, { tenantId: other }));
    expect(await schemaExists(TenantManager.getSchemaName(live))).toBe(true);
  });

  test('createTenant on an existing tenant is idempotent (README claims re-run applies DDL additions)', async () => {
    const t = newTenantId();
    await provision(t);
    const again = await req(() => admin.post(`${T}/createTenant`, { tenantId: t, name: t }));
    expect(again.status).not.toBe(500);
    const rows = await withClient(async (c) =>
      (await c.query(`SELECT count(*)::int n FROM public.db_tenants WHERE tenantid = $1`, [t])).rows[0].n);
    expect(rows).toBe(1);
  });

  test('a tenantId longer than the declared String(50) is rejected with 400, not a raw DB error', async () => {
    const res = await req(() => admin.post(`${T}/createTenant`, { tenantId: `${PREFIX}${'x'.repeat(80)}`, name: 'too long' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).not.toMatch(/character varying/i); // no internal DB text leaked
  });

  test('PATCH /Tenants(ID) must not leave the registry pointing at a schema that does not exist', async () => {
    const t = newTenantId();
    await provision(t);
    const key = await withClient(async (c) =>
      (await c.query(`SELECT id FROM public.db_tenants WHERE tenantid = $1`, [t])).rows[0].id);

    await req(() => admin.patch(`${T}/Tenants(${key})`, { tenantId: `${t}_ren` }));

    const now = await withClient(async (c) =>
      (await c.query(`SELECT tenantid FROM public.db_tenants WHERE id = $1`, [key])).rows[0].tenantid);
    created.add(now);
    // Either the rename was refused, or the schema moved with it. Never both.
    expect(now === t || (await schemaExists(TenantManager.getSchemaName(now)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OData CRUD over the registry entity — leaks connections; keep near the end.
// ---------------------------------------------------------------------------

describe('OData CRUD over Tenants', () => {
  test('DELETE /Tenants(ID) actually removes the schema and the row', async () => {
    const t = newTenantId();
    await provision(t);
    const key = await withClient(async (c) =>
      (await c.query(`SELECT id FROM public.db_tenants WHERE tenantid = $1`, [t])).rows[0].id);

    const res = await req(() => admin.delete(`${T}/Tenants(${key})`));
    expect(res.status).toBe(204);
    expect(await schemaExists(TenantManager.getSchemaName(t))).toBe(false);
    const left = await withClient(async (c) =>
      (await c.query(`SELECT count(*)::int n FROM public.db_tenants WHERE tenantid = $1`, [t])).rows[0].n);
    expect(left).toBe(0);
  });

  test('POST /Tenants responds, and does not leak an open transaction', async () => {
    const before = await idleTxCount();
    const t = newTenantId();
    created.add(t);
    const res = await req(() => admin.post(`${T}/Tenants`, { tenantId: t, name: t }));
    expect(res.status).toBe(201);
    expect(await idleTxCount()).toBeLessThanOrEqual(before);
  });
});

// The remaining case — POST /Tenants with no tenantId — kills the server
// process outright, so it lives in test/destructive/ and is run on its own
// via `npm run test:destructive`.
