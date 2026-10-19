import { readFile } from 'node:fs/promises';

/** PostgreSQL-compatible database. PGlite is serialized including ordinary reads;
 * transaction callbacks must use their tx argument, never the outer database. */
export async function createDatabase({ dataDir, connectionString = process.env.DATABASE_URL } = {}) {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (connectionString) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString });
    return {
      kind: 'postgres',
      query: (sql, params = []) => pool.query(sql, params),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          // Domain mutations share this transaction-scoped lock. This prevents
          // payout/refund races across workers, including different processes.
          await client.query('SELECT pg_advisory_xact_lock(637092401)');
          const result = await fn({ query: (sql, params = []) => client.query(sql, params) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
      async migrate() { await pool.query(schema); },
      async close() { await pool.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const engine = new PGlite(dataDir);
  await engine.waitReady;
  let queue = Promise.resolve();
  const serial = fn => {
    const operation = queue.then(fn, fn);
    queue = operation.catch(() => {});
    return operation;
  };
  const normalize = result => ({ ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 });
  return {
    kind: 'pglite',
    query: (sql, params = []) => serial(async () => normalize(await engine.query(sql, params))),
    transaction: fn => serial(() => engine.transaction(async tx => fn({
      query: async (sql, params = []) => normalize(await tx.query(sql, params)),
    }))),
    migrate: () => serial(() => engine.exec(schema)),
    close: () => serial(() => engine.close()),
  };
}
