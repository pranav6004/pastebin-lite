import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export function connect() {
  return neon(process.env.DATABASE_URL);
}

export function pasteStore(query) {
  return {
    async ping() {
      await query("SELECT 1 FROM pastes LIMIT 1");
    },

    async create(content, expiresAt, maxViews) {
      const id = randomBytes(16).toString("base64url");
      await query(
        `INSERT INTO pastes (id, content, expires_at, remaining_views)
         VALUES ($1, $2, $3, $4)`,
        [id, content, expiresAt, maxViews],
      );
      return id;
    },

    async read(id, now, consume) {
      const available = "id = $1 AND (expires_at IS NULL OR expires_at > $2)";
      const rows = await query(
        consume
          ? `WITH counted AS (
               UPDATE pastes SET remaining_views = remaining_views - 1
               WHERE ${available} AND remaining_views > 0
               RETURNING content, remaining_views, expires_at
             )
             SELECT content, remaining_views, expires_at FROM counted
             UNION ALL
             SELECT content, remaining_views, expires_at FROM pastes
             WHERE ${available} AND remaining_views IS NULL`
          : `SELECT content, remaining_views, expires_at FROM pastes
             WHERE ${available} AND (remaining_views IS NULL OR remaining_views > 0)`,
        [id, now],
      );
      const row = rows[0];
      if (!row) return null;

      return {
        content: row.content,
        remaining_views: row.remaining_views === null ? null : Number(row.remaining_views),
        expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      };
    },
  };
}
