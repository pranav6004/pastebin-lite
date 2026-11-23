import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../app.js";

const database = new PGlite();
const initialTime = Date.parse("2026-01-01T00:00:00.000Z");
let time = initialTime;
let server;
let origin;
let queryCount = 0;

before(async () => {
  const schema = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  await database.exec(`BEGIN;\n${schema}\nCOMMIT;`);
  const query = (...args) => database.transaction(async (transaction) => {
    queryCount++;
    await transaction.exec("SET LOCAL ROLE pastebin_runtime");
    return (await transaction.query(...args)).rows;
  });
  server = createApp(query, () => new Date(time)).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await database.close();
});

function post(body) {
  return fetch(`${origin}/api/pastes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function create(body) {
  const response = await post(body);
  assert.equal(response.status, 201);
  const paste = await response.json();
  assert.match(paste.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(paste.url, `${origin}/p/${paste.id}`);
  return paste;
}

test("health, editor, and assets respond", async () => {
  const before = queryCount;
  const health = await fetch(`${origin}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(queryCount, before);

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<textarea id="content"/);
  const css = await fetch(`${origin}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.equal((await fetch(`${origin}/API/PASTES`, { method: "POST" })).status, 404);
});

test("invalid content, limits, and malformed JSON return a JSON error", async () => {
  for (const body of [
    {}, { content: 12 }, { content: " \n\t" }, { content: "one\0two" }, { content: "\ud800" },
    { content: "valid", ttl_seconds: 0 }, { content: "valid", ttl_seconds: 1.5 },
    { content: "valid", ttl_seconds: 1e12 }, { content: "valid", max_views: "2" },
    { content: "valid", max_views: null }, { content: "valid", max_views: -1 },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof (await response.json()).error, "string");
  }

  const malformed = await fetch(`${origin}/api/pastes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, "string");

  const oversized = await post({ content: "x".repeat(1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(typeof (await oversized.json()).error, "string");
});

test("unlimited paste preserves text in JSON and escapes it in HTML", async () => {
  const content = "\n  <script>alert('plain text')</script>\r\n  & café 📄  ";
  const { id, url } = await create({ content });
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${origin}/api/pastes/${id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { content, remaining_views: null, expires_at: null });
  }

  const view = await fetch(url);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.ok(html.includes('id="paste-content">\n  &lt;script&gt;alert(&#39;plain text&#39;)&lt;/script&gt;&#13;\n  &amp; café 📄  </span>'));
  assert.equal(html.includes("<script>alert("), false);
});

test("TTL expires at the exact boundary before remaining views run out", async () => {
  const { id, url } = await create({ content: "timed", ttl_seconds: 2, max_views: 4 });
  const api = `${origin}/api/pastes/${id}`;
  time = initialTime + 1999;
  try {
    const before = await fetch(api);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), {
      content: "timed", remaining_views: 3, expires_at: "2026-01-01T00:00:02.000Z",
    });

    time = initialTime + 2000;
    assert.equal((await fetch(api)).status, 404);
    assert.equal((await fetch(url)).status, 404);
  } finally {
    time = initialTime;
  }
});

test("concurrent reads share the limit, HEAD leaves the count alone, and exhaustion returns 404", async () => {
  const { id, url } = await create({ content: "limited", ttl_seconds: 3600, max_views: 3 });
  const api = `${origin}/api/pastes/${id}`;
  for (const target of [api, url]) {
    assert.equal((await fetch(target, { method: "HEAD" })).status, 200);
  }

  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, index) => fetch(index % 2 === 0 ? api : url)),
  );
  assert.equal(responses.filter(({ status }) => status === 200).length, 3);
  assert.equal(responses.filter(({ status }) => status === 404).length, 9);
  assert.equal((await fetch(api, { method: "HEAD" })).status, 404);

  const last = await create({ content: "last", max_views: 1 });
  const response = await fetch(`${origin}/api/pastes/${last.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).remaining_views, 0);
  assert.equal((await fetch(last.url)).status, 404);

  assert.equal((await fetch(`${origin}/api/pastes/missing`)).status, 404);
});

test("conditional responses on both routes leave the final view available", async () => {
  const { id, url } = await create({ content: "one view", max_views: 1 });
  const api = `${origin}/api/pastes/${id}`;
  for (const target of [api, url]) {
    const status = await new Promise((resolve, reject) => {
      // Raw HTTP preserves the conditional request without Fetch adding Cache-Control.
      const req = request(target, { headers: { "If-None-Match": "*" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 304);
  }
  assert.equal(await (await fetch(api)).json().then((body) => body.remaining_views), 0);
  assert.equal((await fetch(url)).status, 404);
});

test("UTF-8 content is bounded and older large pastes still return plain text", async () => {
  const limit = 768 * 1024;
  const content = "&".repeat(limit);
  const paste = await create({ content });
  const view = await fetch(paste.url);
  assert.match(view.headers.get("content-type"), /text\/html/);
  assert.ok((await view.arrayBuffer()).byteLength < 4_000_000);

  const tooLarge = await post({ content: "é".repeat(limit / 2 + 1) });
  assert.equal(tooLarge.status, 413);

  const legacyId = "L".repeat(22);
  const legacyContent = "&".repeat(850_000);
  await database.query(
    "INSERT INTO public.pastes (id, content, remaining_views) VALUES ($1, $2, 1)",
    [legacyId, legacyContent],
  );
  const legacyUrl = `${origin}/p/${legacyId}`;
  const legacy = await fetch(legacyUrl);
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get("content-type"), /text\/plain/);
  assert.equal(await legacy.text(), legacyContent);
  assert.equal((await fetch(legacyUrl)).status, 404);
});

test("creation reclaims unavailable rows and enforces shared byte and row budgets", async () => {
  const expired = "X".repeat(22);
  const exhausted = "E".repeat(22);
  await database.query(
    "INSERT INTO public.pastes (id, content, expires_at, remaining_views) VALUES ($1, 'expired', '2000-01-01', NULL), ($2, 'spent', NULL, 0)",
    [expired, exhausted],
  );
  await create({ content: "cleanup trigger" });
  const reclaimed = await database.query("SELECT id FROM public.pastes WHERE id IN ($1, $2)", [expired, exhausted]);
  assert.equal(reclaimed.rows.length, 0);

  await database.exec("UPDATE public.paste_storage SET max_bytes = content_bytes + 4, max_pastes = paste_count + 1");
  try {
    const full = await post({ content: "five!" });
    assert.equal(full.status, 507);
    assert.equal(typeof (await full.json()).error, "string");
    const competing = await Promise.all(Array.from({ length: 4 }, () => post({ content: "x" })));
    assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 507, 507, 507]);

    const { rows: [budget] } = await database.query(`
      SELECT paste_count = (SELECT count(*) FROM public.pastes) AS count_matches,
             content_bytes = (SELECT sum(octet_length(content)) FROM public.pastes) AS bytes_match
      FROM public.paste_storage
    `);
    assert.deepEqual(budget, { count_matches: true, bytes_match: true });
  } finally {
    await database.exec("UPDATE public.paste_storage SET max_bytes = DEFAULT, max_pastes = DEFAULT");
  }
});

test("runtime role cannot write paste bodies, delete rows, or read the budget table", async () => {
  const { rows: [permissions] } = await database.query(`
    SELECT
      has_table_privilege('pastebin_runtime', 'public.pastes', 'INSERT') AS direct_insert,
      has_table_privilege('pastebin_runtime', 'public.pastes', 'DELETE') AS direct_delete,
      has_column_privilege('pastebin_runtime', 'public.pastes', 'content', 'UPDATE') AS update_content,
      has_table_privilege('pastebin_runtime', 'public.paste_storage', 'SELECT') AS read_budget
  `);
  assert.deepEqual(permissions, { direct_insert: false, direct_delete: false, update_content: false, read_budget: false });
});
