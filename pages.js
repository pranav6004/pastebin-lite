const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\r": "&#13;" };

function escapeHtml(text) {
  return text.replace(/[&<>"'\r]/g, (character) => entities[character]);
}

function layout(title, body, showNewPaste = false) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f5f2">
  <title>${title} | Pastebin Lite</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/client.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="shell site-header-inner">
      <a class="brand" href="/" translate="no"><span class="brand-mark" aria-hidden="true"></span>Pastebin Lite</a>
      ${showNewPaste ? '<a class="button secondary" href="/">New paste</a>' : ""}
    </div>
  </header>
  <main id="main" class="shell" tabindex="-1">
    ${body}
  </main>
</body>
</html>`;
}

export function composePage() {
  return layout("Create a paste", `
    <div class="intro">
      <h1>Create a paste</h1>
      <p>Save text and share it with a link.</p>
    </div>
    <form id="compose" method="post" action="/api/pastes" autocomplete="off">
      <div class="workspace">
        <div class="editor">
          <label class="editor-label" for="content">Paste content</label>
          <textarea id="content" name="content" required spellcheck="false" dir="auto" placeholder="Paste or type your text…"></textarea>
          <div class="editor-footer">
            <span>Plain text</span>
            <span id="character-count">0 characters</span>
          </div>
        </div>
        <fieldset class="settings">
          <legend>Expiry settings</legend>
          <label for="ttl">Expires after (seconds)</label>
          <input id="ttl" name="ttl_seconds" type="number" min="1" step="1" placeholder="No time limit">
          <label for="views">Maximum views</label>
          <input id="views" name="max_views" type="number" min="1" step="1" placeholder="No view limit">
          <button id="publish" class="button primary" type="submit">Create paste <span aria-hidden="true">→</span></button>
          <p id="form-status" class="status" role="status"></p>
        </fieldset>
      </div>
    </form>
    <section id="share-result" class="share-result" aria-label="Paste created" hidden>
      <label for="share-url">Shareable link</label>
      <div class="share-controls">
        <input id="share-url" name="share_url" type="url" readonly>
        <button class="button primary" type="button" data-copy="share-url">Copy link</button>
        <a id="open-paste" class="button secondary">Open paste <span aria-hidden="true">↗</span></a>
      </div>
      <p class="status" data-copy-status role="status"></p>
    </section>
    <noscript><p>Enable JavaScript to create a paste from this page.</p></noscript>
  `);
}

export function pastePage(paste) {
  const { content, remaining_views, expires_at } = paste;
  const views = remaining_views === null
    ? "Unlimited views"
    : `${new Intl.NumberFormat("en").format(remaining_views)} ${remaining_views === 1 ? "view" : "views"} left`;
  const expiry = expires_at
    ? `Expires <time datetime="${expires_at}">${expires_at}</time>`
    : "No time limit";

  return layout("View paste", `
    <div class="intro">
      <h1>Shared paste</h1>
      <ul class="paste-details" aria-label="Paste limits">
        <li>${views}</li>
        <li>${expiry}</li>
      </ul>
    </div>
    <section class="editor" aria-label="Paste content">
      <div class="editor-toolbar">
        <span>Plain text</span>
        <button class="button editor-button" type="button" data-copy="paste-content">Copy text</button>
      </div>
      <pre class="paste-text" dir="auto" translate="no"><span id="paste-content">${escapeHtml(content)}</span></pre>
      <p class="status editor-status" data-copy-status role="status"></p>
    </section>
  `, true);
}

export function errorPage(title, message) {
  return layout(title, `
    <div class="intro">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
    <a class="button primary" href="/">Create a paste <span aria-hidden="true">→</span></a>
  `);
}
