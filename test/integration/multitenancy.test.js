/**
 * End-to-end multitenancy validation against a real PostgreSQL instance.
 *
 * The Jest globalSetup spawns the host CAP project (`npm start` equivalent)
 * as a child process, then tests hit it over HTTP. This avoids the
 * cross-process state issues of running CAP in-process via cds.test.
 *
 * Prerequisites:
 *   1. PostgreSQL is running and reachable. Defaults: localhost:5432,
 *      cds_multitenant, postgres/postgres. Override with DB_HOST / DB_PORT /
 *      DB_NAME / DB_USER / DB_PASSWORD env vars.
 *   2. The host project has been `cds deploy`'d at least once so
 *      public.db_Tenants and the business tables exist as a template.
 *   3. The host project is wired correctly per the README Setup section.
 *
 * Set TEST_SERVER_LOG=1 to forward the spawned server's stdout/stderr.
 */

const axios = require('axios');
const TenantManager = require('../../src/adapter/pg-adapter');
const { newTenantId, PREFIX } = require('../helpers/tenant-id');
const { BASE_URL, AUTH } = require('../helpers/server');
const {
  schemaExists,
  listTablesInSchema,
  rowCount,
  dropSchemaIfExists,
  deleteRegistryRowsByPrefix,
  withClient,
} = require('../helpers/pg');

// HTTP client — never throw on non-2xx so we can assert codes.
const http = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
// TenantService is `@requires: 'mtxpg-admin'`; the control-plane calls below are
// authenticated as the test admin. Business routes stay unauthenticated.
const admin = axios.create({ baseURL: BASE_URL, validateStatus: () => true, headers: AUTH });

const ODATA_TENANT = '/odata/v4/tenant';
const ODATA_BUSINESS = '/odata/v4/business';

const createdTenants = new Set();
async function provision(tenantId, name = tenantId) {
  const res = await admin.post(`${ODATA_TENANT}/createTenant`, { tenantId, name });
  createdTenants.add(tenantId);
  return res;
}

afterAll(async () => {
  for (const id of createdTenants) {
    await dropSchemaIfExists(TenantManager.getSchemaName(id)).catch(() => {});
  }
  await deleteRegistryRowsByPrefix(PREFIX).catch(() => {});
});

// ---------------------------------------------------------------------------
// Tenant lifecycle
// ---------------------------------------------------------------------------

describe('Tenant lifecycle (TenantService)', () => {
  test('createTenant provisions a schema and a registry row', async () => {
    const tenantId = newTenantId();
    const res = await provision(tenantId, 'ACME Corp');

    expect(res.status).toBe(200);
    expect(res.data.value || res.data).toMatch(/created successfully/);

    const schema = TenantManager.getSchemaName(tenantId);
    expect(await schemaExists(schema)).toBe(true);

    const tables = await listTablesInSchema(schema);
    expect(tables).toEqual(expect.arrayContaining(['db_products', 'db_categories', 'db_orders', 'db_orderitems']));
    // Tenants table must NOT be created in tenant schema — it lives in public only.
    expect(tables).not.toContain('db_tenants');
  });

  test('listTenants returns the new tenant', async () => {
    const tenantId = newTenantId();
    await provision(tenantId);
    const res = await admin.get(`${ODATA_TENANT}/listTenants()`);
    expect(res.status).toBe(200);
    expect(res.data.value).toEqual(expect.arrayContaining([tenantId]));
  });

  test('getTenantInfo returns serialized tenant record', async () => {
    const tenantId = newTenantId();
    await provision(tenantId, 'Lookup Co');
    const res = await admin.get(`${ODATA_TENANT}/getTenantInfo(tenantId='${tenantId}')`);
    expect(res.status).toBe(200);
    const tenant = JSON.parse(res.data.value);
    expect(tenant).toMatchObject({ tenantId, name: 'Lookup Co', status: 'ACTIVE' });
  });

  test('createTenant rejects when tenantId is missing', async () => {
    const res = await admin.post(`${ODATA_TENANT}/createTenant`, { name: 'no-id' });
    expect([400, 500]).toContain(res.status);
  });

  test('deleteTenant drops the schema and removes the registry row', async () => {
    const tenantId = newTenantId();
    await provision(tenantId);
    const schema = TenantManager.getSchemaName(tenantId);
    expect(await schemaExists(schema)).toBe(true);

    const res = await admin.post(`${ODATA_TENANT}/deleteTenant`, { tenantId });
    expect(res.status).toBe(200);
    expect(await schemaExists(schema)).toBe(false);

    const list = await admin.get(`${ODATA_TENANT}/listTenants()`);
    expect(list.data.value).not.toContain(tenantId);

    createdTenants.delete(tenantId);
  });
});

// ---------------------------------------------------------------------------
// Tenant-scoped CRUD + isolation
// ---------------------------------------------------------------------------

describe('Tenant-scoped CRUD via x-tenant-id header', () => {
  let tenantA, tenantB;
  let schemaA, schemaB;

  beforeAll(async () => {
    tenantA = newTenantId();
    tenantB = newTenantId();
    await provision(tenantA, 'A');
    await provision(tenantB, 'B');
    schemaA = TenantManager.getSchemaName(tenantA);
    schemaB = TenantManager.getSchemaName(tenantB);
  });

  test('POST lands in the correct tenant schema, not in public', async () => {
    const res = await http.post(
      `${ODATA_BUSINESS}/Products`,
      { name: 'Widget A', price: '9.99' },
      { headers: { 'x-tenant-id': tenantA } },
    );
    expect(res.status).toBe(201);

    expect(await rowCount(`"${schemaA}".db_products`)).toBe(1);
    expect(await rowCount(`"${schemaB}".db_products`)).toBe(0);
  });

  test('GET returns only the calling tenant\'s rows', async () => {
    await http.post(
      `${ODATA_BUSINESS}/Products`,
      { name: 'Widget B', price: '4.50' },
      { headers: { 'x-tenant-id': tenantB } },
    );

    const a = await http.get(`${ODATA_BUSINESS}/Products`, { headers: { 'x-tenant-id': tenantA } });
    const b = await http.get(`${ODATA_BUSINESS}/Products`, { headers: { 'x-tenant-id': tenantB } });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.data.value.map((p) => p.name)).toEqual(['Widget A']);
    expect(b.data.value.map((p) => p.name)).toEqual(['Widget B']);
  });

  test('DELETE only affects the calling tenant', async () => {
    const list = await http.get(`${ODATA_BUSINESS}/Products`, { headers: { 'x-tenant-id': tenantA } });
    const id = list.data.value[0].ID;

    const del = await http.delete(`${ODATA_BUSINESS}/Products(${id})`, {
      headers: { 'x-tenant-id': tenantA },
    });
    expect(del.status).toBe(204);

    expect(await rowCount(`"${schemaA}".db_products`)).toBe(0);
    expect(await rowCount(`"${schemaB}".db_products`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Negative — middleware rejection paths
// ---------------------------------------------------------------------------

describe('Tenant middleware — negative cases', () => {
  test('missing x-tenant-id header → 400', async () => {
    const res = await http.get(`${ODATA_BUSINESS}/Products`);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/x-tenant-id/i);
  });

  test('unknown tenant → 404', async () => {
    const res = await http.get(`${ODATA_BUSINESS}/Products`, {
      headers: { 'x-tenant-id': 'nope_does_not_exist_xyz' },
    });
    expect(res.status).toBe(404);
  });

  test('inactive tenant → 403', async () => {
    const tenantId = newTenantId();
    await provision(tenantId);

    await withClient((c) =>
      c.query(`UPDATE public.db_tenants SET status='INACTIVE' WHERE tenantid = $1`, [tenantId]),
    );

    const res = await http.get(`${ODATA_BUSINESS}/Products`, { headers: { 'x-tenant-id': tenantId } });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// search_path hook — registry queries skip the tenant schema
// ---------------------------------------------------------------------------

describe('db.before(*) hook', () => {
  test('Tenants reads bypass tenant schema (target=db.Tenants is excluded)', async () => {
    const tenantId = newTenantId();
    await provision(tenantId);

    // listTenants reads db.Tenants. The hook must not override search_path
    // for this entity, even when a tenant context is present.
    const res = await admin.get(`${ODATA_TENANT}/listTenants()`);
    expect(res.status).toBe(200);
    expect(res.data.value).toEqual(expect.arrayContaining([tenantId]));
  });
});
