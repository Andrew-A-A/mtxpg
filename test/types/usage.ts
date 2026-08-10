// Compile-only check for index.d.ts. Never executed — `npm run types:check`
// runs `tsc --noEmit` over it, so a broken or unusable declaration fails CI.
// Excluded from the published tarball by the `files` allowlist in package.json.

import {
  TenantManager,
  setTenantContext,
  getTenantFromRequest,
  tenantMiddleware,
  type CdsTransaction,
  type TenantRequest,
  type TenantResponse,
} from '../../index';

// --- TenantManager -----------------------------------------------------------

const schema: string = TenantManager.getSchemaName('acme');
const limit: number = TenantManager.MAX_TENANT_ID;
const validated: string = TenantManager.assertValidTenantId(process.env.TENANT);
const slug: string = TenantManager.sanitize('acme-corp');

declare const tx: CdsTransaction;

async function provision(): Promise<void> {
  const created: string = await TenantManager.ensureTenantSchema('acme', tx);
  await TenantManager.ensureTenantSchema('acme'); // tx is optional
  await TenantManager.dropTenantSchema('acme', tx);
  await TenantManager.dropTenantSchema('acme');
  void created;
}

// A CAP transaction satisfies CdsTransaction structurally.
const capTx: CdsTransaction = { run: async (_q: unknown) => [{ ok: 1 }] };

// --- resolution --------------------------------------------------------------

const resolved: string | null = getTenantFromRequest({
  headers: { 'x-tenant-id': 'acme' },
  query: { tenant: 'acme' },
  user: { tenant: 'acme' },
});

// Node's IncomingHttpHeaders shape (string | string[] | undefined) is accepted.
const fromNodeHeaders: string | null = getTenantFromRequest({
  headers: { 'x-tenant-id': 'acme', 'set-cookie': ['a=1'], 'x-absent': undefined },
});

// user and query are both optional.
const minimal: string | null = getTenantFromRequest({ headers: {} });

// --- middleware --------------------------------------------------------------

// An Express-shaped request/response satisfies the middleware signature.
declare const req: TenantRequest;
declare const res: TenantResponse;
declare const next: (err?: unknown) => void;

const mounted: Promise<void> = setTenantContext(req, res, next);

// Usable as an Express handler: (req, res, next) with a chainable status().json().
async function asHandler(): Promise<void> {
  await setTenantContext(
    { headers: { 'x-tenant-id': 'acme' } },
    { status: (_code: number) => ({ json: (_body: unknown) => undefined }) },
    () => undefined,
  );
}

// The grouped export mirrors the top-level functions.
const alias: typeof setTenantContext = tenantMiddleware.setTenantContext;
const aliasResolve: typeof getTenantFromRequest = tenantMiddleware.getTenantFromRequest;

void [
  schema, limit, validated, slug, provision, capTx,
  resolved, fromNodeHeaders, minimal, mounted, asHandler, alias, aliasResolve,
];
