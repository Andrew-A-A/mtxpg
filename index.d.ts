// Type definitions for mtxpg
// Schema-per-tenant multitenancy for SAP CAP on PostgreSQL.
//
// Deliberately self-contained: no `@types/express` and no `@sap/cds` type
// imports. Both are peer concerns whose type packages consumers may not have
// installed, and a d.ts that references a missing module fails to compile for
// everyone. The structural types below accept a real Express request/response
// and a real CAP transaction without naming them.

/**
 * Minimal shape of a CAP database transaction, as returned by `db.tx(req)`.
 * Only `run` is used, so anything with a compatible `run` is accepted.
 */
export interface CdsTransaction {
  run(query: unknown, ...args: unknown[]): Promise<any>;
}

/**
 * The parts of an HTTP request tenant resolution reads. An Express `Request`
 * satisfies this structurally.
 */
export interface TenantRequest {
  headers: Record<string, unknown>;
  /** Only consulted when `cds.env.mtxpg.allowQueryTenant` is enabled. */
  query?: Record<string, unknown>;
  /** Populated by whatever authentication runs ahead of the middleware. */
  user?: { tenant?: string } | undefined;
  /** Set by `setTenantContext` to the resolved tenant id. */
  tenant?: string;
}

/** The parts of an HTTP response the middleware writes to. */
export interface TenantResponse {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Tenant schema lifecycle. All members are static.
 */
export declare class TenantManager {
  /**
   * Maps a tenant id onto its PostgreSQL schema name, `tenant_<slug>_<hash>`.
   *
   * Injective: distinct tenant ids always yield distinct schema names, and the
   * result always fits PostgreSQL's 63-byte identifier limit.
   *
   * @throws if the tenant id is empty or longer than {@link TenantManager.MAX_TENANT_ID}.
   */
  static getSchemaName(tenantId: string): string;

  /**
   * Creates the tenant schema if absent and deploys the CDS-generated DDL into
   * it. Idempotent: re-running adds new tables and redefines views, but does
   * **not** alter existing tables.
   *
   * Pass `tx` to make provisioning atomic with the caller's own work. Omit it
   * and one is opened internally — which is required, because `SET LOCAL` is a
   * no-op outside a transaction and the DDL would land in `public`.
   *
   * Leaves the transaction's `search_path` on `public`, so a registry write can
   * follow on the same `tx`.
   *
   * @returns the schema name that was provisioned.
   */
  static ensureTenantSchema(tenantId: string, tx?: CdsTransaction): Promise<string>;

  /** `DROP SCHEMA … CASCADE`. Destroys the tenant's data. */
  static dropTenantSchema(tenantId: string, tx?: CdsTransaction): Promise<void>;

  /**
   * Validates a tenant id at the trust boundary.
   *
   * @returns the id coerced to a string.
   * @throws if it is null, undefined, empty, or over {@link TenantManager.MAX_TENANT_ID} characters.
   */
  static assertValidTenantId(tenantId: unknown): string;

  /**
   * The identifier-safe, injective schema suffix for a tenant id — the part
   * after the `tenant_` prefix. Prefer {@link TenantManager.getSchemaName}.
   */
  static sanitize(tenantId: unknown): string;

  /** Maximum tenant id length; matches `tenantId : String(50)` in the CDS model. */
  static readonly MAX_TENANT_ID: number;
}

/**
 * Resolves the tenant id for a request, or `null` if none could be determined.
 *
 * Precedence: `req.user.tenant` (the only source the caller cannot choose)
 * outranks the `x-tenant-id` header, which outranks `sap-tenancy`. The
 * `?tenant=` query parameter is ignored unless `cds.env.mtxpg.allowQueryTenant`
 * is explicitly enabled.
 */
export declare function getTenantFromRequest(req: TenantRequest): string | null;

/**
 * Express middleware that resolves the tenant, verifies it exists and is
 * `ACTIVE`, and sets `cds.context.tenant` so the `search_path` hook routes
 * queries to that tenant's schema.
 *
 * This is tenant **resolution, not authorization** — it does not authenticate
 * the caller. Mount it behind whatever authentication the application uses.
 *
 * Responds 400 (unresolvable), 403 (claimed tenant does not match the
 * authenticated user, or tenant not `ACTIVE`), 404 (unknown tenant), or 500
 * (lookup failed) instead of calling `next`.
 */
export declare function setTenantContext(
  req: TenantRequest,
  res: TenantResponse,
  next: (err?: unknown) => void,
): Promise<void>;

export declare const tenantMiddleware: {
  setTenantContext: typeof setTenantContext;
  getTenantFromRequest: typeof getTenantFromRequest;
};
