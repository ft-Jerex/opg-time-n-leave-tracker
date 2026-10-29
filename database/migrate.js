import crypto from 'node:crypto';
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Migrations must use a session/direct connection. The application runtime may
// use Supabase's transaction pooler, which is not appropriate for DDL.
if (process.env.MIGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}
const { pool } = await import('../src/server/config/database.js');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const files = (await readdir(dir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
// Git may check SQL files out with CRLF on Windows. Hash canonical LF content so
// the same migration has the same ledger checksum on every deployment host.
const checksum = (sql) => crypto
  .createHash('sha256')
  .update(sql.replace(/\r\n/g, '\n'))
  .digest('hex');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['time-leave-tracker-migrations']);
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const digest = checksum(sql);
    const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [file]);
    if (existing.rowCount && existing.rows[0].checksum !== digest) throw new Error(`Migration checksum mismatch: ${file}`);
    if (!existing.rowCount) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file, digest]);
    }
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
