import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

try {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is required.");
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  const sql = neon(migrationUrl);
  await sql.transaction(schema.trim().split(/^-- statement\r?$/m).map((statement) => sql.query(statement)));
  console.log("Paste schema is ready.");
} catch (error) {
  console.error(`Schema setup failed (${error.code ?? error.name}). Check DATABASE_MIGRATION_URL and its permissions.`);
  process.exitCode = 1;
}
