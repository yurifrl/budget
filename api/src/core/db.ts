import pg, { Pool, types, type PoolClient } from 'pg';

// Return int8/bigint columns as JS numbers. Storage is milliunits; personal
// budget values sit far below Number.MAX_SAFE_INTEGER, so the default string
// serialization is unnecessary noise for the client.
types.setTypeParser(types.builtins.INT8, (val) => Number.parseInt(val, 10));

/** Database settings handed over by the entrypoint (index.ts, worker.ts, scripts, test preload). */
export interface DbConfig {
  /** postgres:// connection string. */
  connectionString: string;
}

/**
 * The process pool, created unconfigured at import (pg reads nothing until a
 * client connects): connect() — and so query() — rejects until configureDb()
 * has supplied the connection string. A real Pool object (not a wrapper), so
 * `pool.connect`, `pool.end`, counters and test spies behave as before.
 */
class AppPool extends Pool {
  private configured = false;

  configure(connectionString: string): void {
    if (this.configured) {
      if (this.options.connectionString === connectionString) return;
      throw new Error('configureDb: the pool is already configured with another connection string');
    }
    // pg-pool hands `this.options` to every new client, so this is the
    // connection string the first connect() uses.
    this.options.connectionString = connectionString;
    this.configured = true;
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void): void;
  override connect(callback?: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void): Promise<PoolClient> | void {
    if (!this.configured) {
      const err = new Error('database not configured: the entrypoint must call configureDb() before the first query');
      if (callback) return callback(err, undefined, () => undefined);
      return Promise.reject(err);
    }
    return callback ? super.connect(callback as never) : super.connect();
  }
}

/** The process-wide pool (see AppPool); configured by the entrypoint through configureDb(). */
export const pool: Pool = new AppPool({
  // Fail a connect attempt instead of hanging forever when postgres is down.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected postgres pool error', err);
});

/**
 * Point the process pool at the database. Called once by each entrypoint
 * (index.ts, worker.ts, the e2e scripts) with DATABASE_URL, and by the bun
 * test preload with the throwaway test database — core reads no env itself.
 * Repeating the call with the same string is a no-op; another string throws.
 */
export function configureDb(config: DbConfig): void {
  if (!config.connectionString) {
    throw new Error('DATABASE_URL is required (postgres connection string)');
  }
  (pool as AppPool).configure(config.connectionString);
}

/** A pool or a checked-out client (inside or outside a transaction): anything that runs a query. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Run `fn` inside one transaction on a client checked out of `db`:
 * BEGIN, then COMMIT when `fn` resolves (its value is returned) or ROLLBACK
 * when it throws (the error is rethrown unchanged). The client is always
 * released; if ROLLBACK itself fails the client is released as broken
 * (destroyed) and the ORIGINAL error is still the one rethrown.
 *
 * Nesting is rejected by the type: `db` must be a Pool (its `connect()`
 * hands out a PoolClient), so a PoolClient cannot be passed. Code that
 * already runs inside a transaction takes the client as a `Queryable`
 * parameter and calls the store functions with it directly.
 *
 * `fn` may issue its own explicit ROLLBACK before throwing (some handlers do
 * when a row is missing); the second ROLLBACK is a server-side WARNING, not
 * an error, so behaviour is unchanged.
 */
export async function withTransaction<T>(
  db: Pick<Pool, 'connect'>,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
