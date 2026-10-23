import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` in a transaction. Ingress, follow-up jobs and audit rows commit together. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function one<T extends pg.QueryResultRow>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await q.query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await q.query<T>(sql, params);
  return result.rows;
}
