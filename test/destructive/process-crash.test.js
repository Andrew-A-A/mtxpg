/**
 * Isolated because it kills the server process — anything sharing the run
 * would fail with ECONNREFUSED afterwards. Run with `npm run test:destructive`.
 */

const axios = require('axios');
const { BASE_URL, AUTH } = require('../helpers/server');

// Authenticated on purpose: the point is that a *bad payload* from an authorized
// caller must not take the process down, not that auth blocks it.
const http = axios.create({ baseURL: BASE_URL, validateStatus: () => true, timeout: 15000, headers: AUTH });
const req = async (fn) => {
  try { return await fn(); } catch (e) { return { status: `ERR:${e.code || e.message}`, data: null }; }
};

test('POST /Tenants without a tenantId returns 400 instead of crashing the process', async () => {
  const res = await req(() => http.post('/odata/v4/tenant/Tenants', { name: 'no id' }));
  expect(res.status).toBe(400);

  const alive = await req(() => http.get('/health'));
  expect(alive.status).toBe(200); // server must survive a bad request
});
