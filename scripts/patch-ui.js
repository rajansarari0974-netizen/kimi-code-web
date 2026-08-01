#!/usr/bin/env node
/* Patch @moonshot-ai/kimi-code dist-web with the kimi.com-style chrome.
   Run AFTER `npm install` so node_modules exists. Idempotent: safe to run
   on an already-patched dist (tags are only appended if missing). */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const webDir = path.join(root, "node_modules/@moonshot-ai/kimi-code/dist-web");

/* Cache-busting version: bump this on every UI deploy so browsers and
   WebViews re-fetch the custom chrome instead of serving a stale copy. */
const VERSION = "v20260801a";

if (!fs.existsSync(webDir)) {
  console.error("[patch-ui] dist-web not found at " + webDir);
  process.exit(1);
}

/* 1. Copy our assets into the web root */
const copies = {
  "public/kimi-com.css": "kimi-com.css",
  "public/kimi-com-boot.js": "kimi-com-boot.js",
  "public/kimi-com.js": "kimi-com.js",
  "public/favicon-kimi.ico": "favicon.ico",
};
for (const [src, dest] of Object.entries(copies)) {
  const srcPath = path.join(root, src);
  if (!fs.existsSync(srcPath)) {
    console.warn("[patch-ui] missing " + src + " — skipping " + dest);
    continue;
  }
  fs.copyFileSync(srcPath, path.join(webDir, dest));
  console.log("[patch-ui] copied " + src + " -> dist-web/" + dest);
}

/* 2. Inject tags into index.html (idempotent) */
const indexPath = path.join(webDir, "index.html");
let html = fs.readFileSync(indexPath, "utf-8");

/* Strip any previous version suffix from our tags, then re-add with the
   current VERSION so a redeploy forces fresh fetch of the chrome assets. */
html = html.replace(/src="\/kimi-com-boot\.js\?v=[^"]+"/, 'src="/kimi-com-boot.js"');
html = html.replace(/href="\/kimi-com\.css\?v=[^"]+"/, 'href="/kimi-com.css"');
html = html.replace(/src="\/kimi-com\.js\?v=[^"]+"/, 'src="/kimi-com.js"');

if (!html.includes("kimi-com-boot.js")) {
  html = html.replace(
    '<script src="/boot.js"></script>',
    '<script src="/boot.js"></script>\n    <script src="/kimi-com-boot.js?v=' + VERSION + '"></script>'
  );
  console.log("[patch-ui] injected kimi-com-boot.js");
} else {
  html = html.replace('src="/kimi-com-boot.js"', 'src="/kimi-com-boot.js?v=' + VERSION + '"');
  console.log("[patch-ui] versioned kimi-com-boot.js");
}
if (!html.includes("kimi-com.css")) {
  html = html.replace(
    '<link rel="icon" href="/favicon.ico" sizes="64x64" />',
    '<link rel="icon" href="/favicon.ico" sizes="64x64" />\n    <link rel="stylesheet" href="/kimi-com.css?v=' + VERSION + '">'
  );
  console.log("[patch-ui] injected kimi-com.css");
} else {
  html = html.replace('href="/kimi-com.css"', 'href="/kimi-com.css?v=' + VERSION + '"');
  console.log("[patch-ui] versioned kimi-com.css");
}
if (!html.includes("kimi-com.js")) {
  html = html.replace(
    "</body>",
    '<script src="/kimi-com.js?v=' + VERSION + '"></script>\n  </body>'
  );
  console.log("[patch-ui] injected kimi-com.js");
} else {
  html = html.replace('src="/kimi-com.js"', 'src="/kimi-com.js?v=' + VERSION + '"');
  console.log("[patch-ui] versioned kimi-com.js");
}
/* Chromium deadlocks when a deferred classic script coexists with the
   module bundle (DOMContentLoaded never fires) — make sure any older
   defer-tagged copy from a previous patch run is converted to sync. */
if (html.includes('<script src="/kimi-com.js" defer>')) {
  html = html.replace(
    '<script src="/kimi-com.js" defer></script>',
    '<script src="/kimi-com.js"></script>'
  );
  console.log("[patch-ui] kimi-com.js defer -> sync");
}
if (html.includes("<title>Kimi Code Web</title>")) {
  html = html.replace("<title>Kimi Code Web</title>", "<title>Kimi</title>");
  console.log("[patch-ui] title -> Kimi");
}
if (!html.includes('content="#ffffff" />')) {
  html = html.replace(
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />',
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />\n    <meta name="theme-color" content="#ffffff" />'
  );
  console.log("[patch-ui] theme-color pinned to #ffffff");
}

/* No-cache meta: the kimi server sends no Cache-Control headers, so browsers
   and Android WebViews fall back to heuristic caching and can keep serving a
   stale index.html for a long time. Pin it to always revalidate. */
if (!html.includes('http-equiv="Cache-Control"')) {
  html = html.replace(
    '<meta name="viewport"',
    '<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />\n' +
      '    <meta http-equiv="Pragma" content="no-cache" />\n' +
      '    <meta http-equiv="Expires" content="0" />\n    <meta name="viewport"'
  );
  console.log("[patch-ui] injected no-cache meta");
}

fs.writeFileSync(indexPath, html);
console.log("[patch-ui] done");
