# Pastebin Lite

Create a plain-text paste and share it by URL. Each paste can have a time limit, a view limit, or both.

## Run locally

Use Node.js 24 and a Neon Postgres database. Copy `.env.example` to `.env` and set `DATABASE_URL` to the Neon connection string.

```text
npm ci
npm run db:setup
npm run dev
```

Open [localhost:3000](http://localhost:3000). Run `npm test` to exercise the HTTP routes and the real SQL against an isolated, embedded Postgres database. The tests require no Neon credentials.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /api/healthz` | Returns `200 {"ok":true}` when the paste table is reachable, or `503` otherwise. |
| `POST /api/pastes` | Accepts JSON with non-blank `content` and optional positive integers `ttl_seconds` and `max_views`. Returns `201` with `id` and `url`. |
| `GET /api/pastes/:id` | Returns `200` with `content`, `remaining_views`, and `expires_at`, or a JSON `404` if unavailable. |
| `GET /p/:id` | Renders the text in HTML, or shows an unavailable page with status `404`. |

Example create request body:

```json
{
  "content": "A note to share",
  "ttl_seconds": 3600,
  "max_views": 5
}
```

Omit a limit to leave it unset. An unset limit is `null` in the read response. Expiry timestamps use ISO 8601 UTC, and the paste becomes unavailable at that timestamp. Invalid requests return `400` with an `error` string. The JSON request body is capped at 1 MiB.

## Deployment

1. Import the private GitHub repository into Vercel. The repository sets the Express framework and a region near its Neon database.
2. Set `DATABASE_URL` in the Vercel Production environment. Run `npm run db:setup` once with that database's connection string to create the table.
3. Deploy and check `/api/healthz`. Create a paste with one allowed view, follow its generated link, then reload to confirm that the second request returns `404`.

## Design decisions

- Express serves the JSON API and the HTML viewer. The Vercel function connects to Neon through its HTTP driver, and PostgreSQL holds all persistent state.
- A single conditional UPDATE claims a view and returns the paste. PostgreSQL locks the row and rechecks the limit for competing updates, so the last allowed request succeeds with `remaining_views: 0`. Unlimited pastes use a read-only branch of the same query. Each successful GET from either read route counts toward the same limit. HEAD checks availability.
- The viewer escapes paste content and renders it as text. The read routes set `Cache-Control: no-store` so each request checks availability. A random URL grants access to anyone who has it. Expiry blocks future reads and leaves rows in the database.
