import "dotenv/config";
import { spawnSync } from "node:child_process";
import pg from "pg";

if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL is required.");
for (const name of [
  "SEED_ADMIN_PASSWORD",
  "SEED_USER_PASSWORD",
  "SEED_READONLY_PASSWORD",
]) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
const executable = process.platform === "win32" ? "docker.exe" : "docker";
const compose = spawnSync(
  executable,
  ["compose", "up", "-d", "postgres-test"],
  { stdio: "inherit" },
);
if (compose.status !== 0) process.exit(compose.status ?? 1);

for (let attempt = 0; attempt < 30; attempt += 1) {
  const connection = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  try {
    await connection.connect();
    await connection.end();
    break;
  } catch (error) {
    await connection.end().catch(() => {});
    if (attempt === 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const env = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  ALLOW_DEV_SEED: "true",
};
for (const script of ["database/migrate.js", "database/seeders/seed.js"]) {
  const result = spawnSync(process.execPath, [script], {
    stdio: "inherit",
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
