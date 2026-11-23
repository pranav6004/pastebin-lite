import { fileURLToPath } from "node:url";
import express from "express";
import { connect, pasteStore } from "./db/store.js";
import { composePage, errorPage, pastePage } from "./pages.js";

const pasteId = /^[A-Za-z0-9_-]{22}$/;
const bodyLimit = "1mb";
const contentLimit = 768 * 1024;
const htmlLimit = 4_000_000;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function createApp(query, now = () => new Date()) {
  const app = express();
  const store = pasteStore(query);

  app.disable("x-powered-by");
  app.disable("etag");
  app.enable("case sensitive routing");
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    });
    next();
  });
  app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url))));
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/", (_req, res) => res.send(composePage()));

  app.get("/api/healthz", (_req, res) => res.json({ ok: true }));

  app.post("/api/pastes", express.json({ limit: bodyLimit }), async (req, res) => {
    const { content, ttl_seconds: ttl, max_views: maxViews } = req.body ?? {};
    if (typeof content !== "string" || !content.trim() || content.includes("\0") || !content.isWellFormed()) {
      return res.status(400).json({ error: "Enter non-empty text with valid Unicode and no null characters." });
    }
    if (Buffer.byteLength(content) > contentLimit) {
      return res.status(413).json({ error: "Paste content exceeds 768 KiB." });
    }
    if (ttl !== undefined && !positiveInteger(ttl)) {
      return res.status(400).json({ error: "ttl_seconds must be a positive integer." });
    }
    if (maxViews !== undefined && !positiveInteger(maxViews)) {
      return res.status(400).json({ error: "max_views must be a positive integer." });
    }

    const createdAt = now();
    const expiresAt = ttl === undefined ? null : new Date(createdAt.getTime() + ttl * 1000);
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getUTCFullYear() > 9999)) {
      return res.status(400).json({ error: "ttl_seconds is too large." });
    }

    const id = await store.create(content, expiresAt?.toISOString() ?? null, maxViews ?? null);
    if (!id) {
      return res.status(507).json({ error: "Paste storage is full. Try again later." });
    }
    const protocol = process.env.VERCEL === "1" ? "https" : req.protocol;
    res.status(201).json({ id, url: `${protocol}://${req.get("host")}/p/${id}` });
  });

  async function readPaste(req, withBody) {
    if (!pasteId.test(req.params.id)) return null;
    const time = now().toISOString();
    return withBody ? store.read(req.params.id, time) : store.available(req.params.id, time);
  }

  app.get("/api/pastes/:id", async (req, res) => {
    const fresh = req.fresh;
    const withBody = req.method === "GET" && !fresh;
    const paste = await readPaste(req, withBody);
    if (!paste) return res.status(404).json({ error: "Paste not found." });
    if (!withBody) return res.status(fresh ? 304 : 200).type("json").end();
    res.json(paste);
  });

  app.get("/p/:id", async (req, res) => {
    const fresh = req.fresh;
    const withBody = req.method === "GET" && !fresh;
    const paste = await readPaste(req, withBody);
    if (!paste) return res.status(404).send(errorPage("Paste unavailable", "This paste may have expired, reached its view limit, or never existed."));
    if (!withBody) return res.status(fresh ? 304 : 200).type("html").end();
    const html = pastePage(paste);
    // Older pastes can exceed the new cap. Keep their text available without oversized HTML.
    if (Buffer.byteLength(html) > htmlLimit) return res.type("text").send(paste.content);
    res.send(html);
  });

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
    res.status(404).send(errorPage("Page not found", "Check the address or create a new paste."));
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      ? error.status : 500;
    if (status === 500) console.error("Request failed:", error.code ?? error.name);

    const message = {
      400: "The request is invalid.",
      413: "The paste request exceeds 1 MiB.",
      415: "Send the request as JSON.",
    }[status] ?? "The request could not be completed. Try again.";

    if (req.path.startsWith("/api/")) return res.status(status).json({ error: message });
    res.status(status).send(errorPage("Unable to open this page", message));
  });

  return app;
}

let database;
export default createApp((...args) => {
  database ??= connect();
  return database.query(...args);
});
