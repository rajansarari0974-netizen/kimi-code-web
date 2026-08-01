#!/usr/bin/env node
/* Kimi Claw branding + /claw prefix patch for the hermes-web-ui dist client.

   Runs at Docker build time after `npm install`. Rewrites the client so it
   works behind the /claw prefix-strip proxy in server.js:

     index.html  -> asset/favicon refs + title under /claw
     assets/*.js -> `/api/`, `${...}/api/` (terminal WS / SSE / export-import),
                    `/assets/` (videos), `/logo.png`, `/health`, `/upload`
                    get the /claw prefix; "Hermes" branding -> "Kimi Claw"

   Intentionally NOT touched: router paths (`/hermes/chat` etc. — the client
   uses hash history, so deep links stay under /claw/#/...), the
   X-Hermes-Profile header, user-supplied base URLs (`/models`), and
   highlight.js keyword lists (`/dev/poll`).

   Idempotent: every replacement is prefix-prefixed, so a second run is a no-op.

   Target dir: node_modules/hermes-web-ui/dist/client by default; override with
   CLAW_CLIENT_DIR or argv[2] for local testing. Skips gracefully when the
   client is missing (kimi still runs).
*/
"use strict";

const fs = require("fs");
const path = require("path");

const clientDir =
  process.env.CLAW_CLIENT_DIR ||
  process.argv[2] ||
  path.join(__dirname, "..", "node_modules", "hermes-web-ui", "dist", "client");

const indexHtml = path.join(clientDir, "index.html");
const assetsDir = path.join(clientDir, "assets");

function patchFile(file, pairs) {
  if (!fs.existsSync(file)) return;
  let src = fs.readFileSync(file, "utf8");
  let count = 0;
  for (const [a, b] of pairs) {
    if (a === b || !src.includes(a)) continue;
    let n = 0;
    let idx = src.indexOf(a);
    while (idx !== -1) {
      n++;
      idx = src.indexOf(a, idx + a.length);
    }
    src = src.split(a).join(b);
    count += n;
  }
  if (count) {
    fs.writeFileSync(file, src);
    console.log("[claw-branding] " + path.basename(file) + ": " + count + " replacements");
  }
}

if (!fs.existsSync(indexHtml)) {
  console.log("[claw-branding] client not found at " + clientDir + " — skipping (kimi still runs)");
  process.exit(0);
}

/* index.html: keep every asset/favicon reference under /claw, rename title */
patchFile(indexHtml, [
  ['href="/assets/', 'href="/claw/assets/'],
  ['src="/assets/', 'src="/claw/assets/'],
  ['href="/favicon.ico"', 'href="/claw/favicon.ico"'],
  ["<title>Hermes</title>", "<title>Kimi Claw</title>"],
]);

/* assets/*.js */
if (fs.existsSync(assetsDir)) {
  for (const f of fs.readdirSync(assetsDir)) {
    if (!f.endsWith(".js")) continue;
    patchFile(path.join(assetsDir, f), [
      // API base inside template literals (includes `/api/hermes/...`)
      ["`/api/", "`/claw/api/"],
      // `${...}/api/...` — terminal WS, SSE events, profile export/import
      ["}/api/", "}/claw/api/"],
      // static assets referenced from JS (thinking/dance videos)
      ["`/assets/", "`/claw/assets/"],
      // logo sprite constant + img srcs
      ["`/logo.png", "`/claw/logo.png"],
      // health + upload endpoints
      ["`/health`", "`/claw/health`"],
      ["`/upload`", "`/claw/upload`"],
      // branding (exact strings only — X-Hermes-Profile untouched)
      ["`Hermes`", "`Kimi Claw`"],
      ["Hermes Agent", "Kimi Claw"],
      ['"Hermes Web UI', '"Kimi Claw'],
    ]);
  }
}

console.log("[claw-branding] done");
