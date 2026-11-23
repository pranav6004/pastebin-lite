import { readFile } from "node:fs/promises";
import { connect } from "./store.js";

try {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await connect().query(schema);
  console.log("Paste schema is ready.");
} catch (error) {
  console.error(`Schema setup failed (${error.code ?? error.name}). Check DATABASE_URL and database access.`);
  process.exitCode = 1;
}
