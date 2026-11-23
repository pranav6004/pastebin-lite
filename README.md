# Pastebin Lite

Create a plain-text paste and share it by URL. Each paste can have a time limit, a view limit, or both.

## Run locally

Use Node.js 24 and a Neon Postgres database. Set `DATABASE_MIGRATION_URL` in `.env.migrate` to the migration owner's Neon connection string. Copy `.env.example` to `.env` and set `DATABASE_URL` to the separate `pastebin_runtime` connection string. The schema creates that role without login. Enable login and assign a generated password through the migration connection before the first run.

```text
npm ci
npm run db:setup
npm run dev
```

Open [127.0.0.1:3000](http://127.0.0.1:3000). Run `npm test` to exercise the HTTP routes and SQL as the runtime role against embedded Postgres. The tests require no Neon credentials.

## API

| Method and path | Behavior |
| --- | --- |
| `GET /api/healthz` | Returns `200 {"ok":true}` for process liveness without contacting storage. |
| `POST /api/pastes` | Accepts JSON with non-blank `content` and optional positive integers `ttl_seconds` and `max_views`. Returns `201` with `id` and `url`. |
| `GET /api/pastes/:id` | Returns `200` with `content`, `remaining_views`, and `expires_at`, or a JSON `404` if unavailable. |
| `GET /p/:id` | Renders the text in HTML, serves legacy oversized pastes as plain text, or returns `404` if unavailable. |

Example create request body:

```json
{
  "content": "A note to share",
  "ttl_seconds": 3600,
  "max_views": 5
}
```

Omit a limit to leave it unset. An unset limit is `null` in the read response. Expiry timestamps use ISO 8601 UTC, and the paste becomes unavailable at that timestamp. Invalid requests return `400` with an `error` string. Paste content is capped at 768 KiB of UTF-8 and the entire JSON request body at 1 MiB. A request that would exceed the shared storage budget returns `507`. The edge may return `429` when a client reaches its request limit.

## Deployment

1. Import the private GitHub repository into Vercel. The repository sets the Express framework and a region near its Neon database.
2. Run `npm run db:setup` with the migration owner before deploying. It reconciles the storage budget against existing rows in one transaction and sets a short lock acquisition timeout. Set only the restricted runtime `DATABASE_URL` in Vercel. For a first install, use the migration connection to enable `LOGIN` on `pastebin_runtime` and set its password before configuring the runtime URL.
3. Use one [Vercel WAF rate limit](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) of 60 requests per IP per minute. Match either the `/api/pastes` or `/p/` path prefix across all methods. Express uses case-sensitive routes so alternate casing cannot skip the prefixes. Treat paste URL paths as sensitive in logs and log drains.
4. Deploy and check `/api/healthz` for liveness. Check storage by creating a disposable paste with a short expiry and one view, fetching it once, and confirming that a repeat fetch returns `404`.

## Design decisions

- Express serves the JSON API and the HTML viewer. The Vercel function connects to Neon through its HTTP driver, and PostgreSQL holds all persistent state.
- A single conditional UPDATE claims a view and returns the paste. PostgreSQL rechecks the limit for competing updates, so the last allowed request succeeds with `remaining_views: 0`. Unlimited pastes use a read-only branch of the same query. Both read routes share the budget. HEAD and bodyless conditional reads only check availability. A Vercel request transform preserves the wildcard conditional signal for the application.
- The viewer escapes paste content and sets `Cache-Control: no-store`. A random URL grants access to anyone who has it. Expiry blocks future reads immediately.
- PostgreSQL caps retained content at 64 MiB and 10,000 rows. A create request reclaims up to 32 timed-out and 32 view-exhausted rows before admitting a new paste. The budget covers logical content bytes. Neon disk usage also includes tables, indexes, and history.
- Liveness and static assets do not connect to Neon. Cleanup has no timer, and there is no periodic counter sync to keep the compute awake. Real reads and writes can still consume the project's monthly compute allocation.

## Pastebin feature coverage

All implemented features are available anonymously, with no accounts, tiers, ads, or payments.

| Area | Implemented | Gaps relative to the requested checklist |
| --- | --- | --- |
| Authoring and expiry | Plain-text editor, custom TTL, permanent pastes, arbitrary view limits, one-view burn, unlisted links | Expiry preset buttons, syntax picker and highlighting, drag-and-drop files, public discovery, owner-only or password-protected pastes |
| Viewer and sharing | Monospace text with wrapping, copy text, copy link, absolute expiry display and remaining views | Raw endpoint, download, clone, embeds, QR, line numbers, wrap/fullscreen controls, total views, creation time, live countdown, size and syntax metadata |
| API and management | Anonymous JSON creation and reading, random 128-bit URL IDs | Pastebin-compatible form API, API keys, scraping feed, custom slugs, dashboards, folders, bulk tools and exports |
| Infrastructure | Vercel and Neon, atomic finite-view tracking, bounded on-write cleanup, storage budget | Dedicated load balancer or Cloudflare stack, Redis caching or counters, object storage, pre-generated Base62 tokens, scheduled sweeper. IDs aren't content hashes and the upload cap is below 10 MB. |
| Abuse and moderation | Storage limits and support for Vercel firewall admission | Content/DLP scanning, CAPTCHA, reports and takedown workflows |
