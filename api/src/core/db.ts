import pg, { Pool, types } from 'pg';

// Return int8/bigint columns as JS numbers. Storage is milliunits; personal
// budget values sit far below Number.MAX_SAFE_INTEGER, so the default string
// serialization is unnecessary noise for the client.
types.setTypeParser(types.builtins.INT8, (val) => Number.parseInt(val, 10));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required (postgres connection string)');
}

export const pool = new Pool({
  connectionString: databaseUrl,
  // Fail a connect attempt instead of hanging forever when postgres is down.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// Upstream pg/pg-pool race: when connect() rejects via connectionTimeoutMillis,
// pg-pool never runs its listener attachment for that client, so when the
// half-open socket later dies the Client emits 'error' with zero listeners and
// the process exits (killed the API pod on a transient DB blip, 2026-09-30).
// Pre-attach a logging listener before every connect so the worst case is a
// logged error, not a crash; pool-managed clients still forward to
// pool.on('error') below.
const origConnect = pg.Client.prototype.connect;
pg.Client.prototype.connect = function (
  this: pg.Client,
  ...args: Parameters<typeof pg.Client.prototype.connect>
) {
  if (this.listenerCount('error') === 0) {
    this.on('error', (err) => {
      console.error('Unexpected postgres client error', err);
    });
  }
  return origConnect.apply(this, args);
} as typeof pg.Client.prototype.connect;

pool.on('error', (err) => {
  console.error('Unexpected postgres pool error', err);
});
