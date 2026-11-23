import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../app.js";

const database = new PGlite();
const initialTime = Date.parse("2026-01-01T00:00:00.000Z");
let time = initialTime;
let server;
let origin;

before(async () => {
  await database.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  const query = async (...args) => (await database.query(...args)).rows;
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
  const health = await fetch(`${origin}/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<textarea id="content"/);
  const css = await fetch(`${origin}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
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
