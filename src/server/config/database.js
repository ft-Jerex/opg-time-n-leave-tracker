import pg from "pg";
import "dotenv/config";
import { SUPABASE_ROOT_CA_2021 } from "./supabase-ca.js";

const { Pool } = pg;
const connectionUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : null;
const isSupabaseDatabase =
  connectionUrl &&
  (connectionUrl.hostname.endsWith(".pooler.supabase.com") ||
    /^db\.[a-z0-9]+\.supabase\.co$/i.test(connectionUrl.hostname));
const sslCa = process.env.DB_SSL_CA_BASE64
  ? Buffer.from(process.env.DB_SSL_CA_BASE64, "base64").toString("utf8")
  : process.env.DB_SSL_CA?.replaceAll("\\n", "\n") ||
    (isSupabaseDatabase ? SUPABASE_ROOT_CA_2021 : undefined);
const hasExplicitSslConfig = process.env.DB_SSL === "true";

// node-postgres gives SSL query parameters in DATABASE_URL precedence over the
// explicit `ssl` object below. That would silently discard DB_SSL_CA. Keep
// DATABASE_URL compatible with Supabase while making certificate verification
// controlled by the server environment instead of URL query-string state.
if (connectionUrl && hasExplicitSslConfig) {
  for (const parameter of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    connectionUrl.searchParams.delete(parameter);
  }
}
pg.types.setTypeParser(1700, (value) => Number(value));
pg.types.setTypeParser(1082, (value) => value);
pg.types.setTypeParser(1114, (value) => `${value.replace(" ", "T")}Z`);
pg.types.setTypeParser(1184, (value) => new Date(value).toISOString());
export const pool = new Pool({
  ...(connectionUrl ? { connectionString: connectionUrl.toString() } : {}),
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 15000),
  ssl:
    hasExplicitSslConfig
      ? {
          rejectUnauthorized:
            process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
          ...(sslCa ? { ca: sslCa } : {}),
        }
      : undefined,
});

export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const closePool = () => pool.end();
