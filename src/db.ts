import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : undefined,
});

export const query = async <T extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
) => pool.query<T>(text, params);

export const migrate = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../migrations"),
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "../database/migrations"),
  ];
  const migrationsDir = candidates.find((dir) => {
    try {
      return readdirSync(dir).some((file) => file.endsWith(".sql"));
    } catch {
      return false;
    }
  });

  if (!migrationsDir) {
    throw new Error("Could not find SQL migrations directory");
  }

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [file],
    );
    if (applied.rowCount) {
      continue;
    }
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    logger.info("applying migration", { file });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
};
