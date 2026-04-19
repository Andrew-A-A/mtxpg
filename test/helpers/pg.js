const { Client } = require('pg');

function clientFromEnv() {
  return new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'cds_multitenant',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: false,
  });
}

async function withClient(fn) {
  const c = clientFromEnv();
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function schemaExists(name) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`,
      [name],
    );
    return r.rowCount > 0;
  });
}

async function listTablesInSchema(schema) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    return r.rows.map((row) => row.table_name);
  });
}

async function rowCount(schemaQualifiedTable) {
  return withClient(async (c) => {
    const r = await c.query(`SELECT COUNT(*)::int AS n FROM ${schemaQualifiedTable}`);
    return r.rows[0].n;
  });
}

async function dropSchemaIfExists(schema) {
  return withClient((c) => c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
}

async function deleteRegistryRowsByPrefix(prefix) {
  return withClient((c) =>
    c.query(`DELETE FROM public.db_tenants WHERE tenantid LIKE $1`, [`${prefix}%`]),
  );
}

module.exports = {
  clientFromEnv,
  withClient,
  schemaExists,
  listTablesInSchema,
  rowCount,
  dropSchemaIfExists,
  deleteRegistryRowsByPrefix,
};
