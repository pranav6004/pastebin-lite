import { randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export function connect() {
  return neon(process.env.DATABASE_URL);
}

export function pasteStore(query) {
  const available = "id = $1 AND (expires_at IS NULL OR expires_at > $2)";

  return {
    async create(content, expiresAt, maxViews) {
      const id = randomBytes(16).toString("base64url");
      const [row] = await query(
        "SELECT public.create_paste($1, $2, $3, $4) AS accepted",
        [id, content, expiresAt, maxViews],
      );
      return row.accepted ? id : null;
    },

    async available(id, now) {
      const rows = await query(
        `SELECT 1 FROM public.pastes
         WHERE ${available} AND (remaining_views IS NULL OR remaining_views > 0)`,
        [id, now],
      );
      return rows.length !== 0;
    },

    async read(id, now) {
      const rows = await query(
        `WITH counted AS (
               UPDATE public.pastes SET remaining_views = remaining_views - 1
               WHERE ${available} AND remaining_views > 0
               RETURNING content, remaining_views, expires_at
             )
             SELECT content, remaining_views, expires_at FROM counted
             UNION ALL
             SELECT content, remaining_views, expires_at FROM public.pastes
             WHERE ${available} AND remaining_views IS NULL`,
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
