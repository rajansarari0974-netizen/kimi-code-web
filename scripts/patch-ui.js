#!/usr/bin/env node
/* Patch @moonshot-ai/kimi-code dist-web with the kimi.com-style chrome.
   Run AFTER `npm install` so node_modules exists. Idempotent: safe to run
   on an already-patched dist (tags are only appended if missing). */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const webDir = path.join(root, "node_modules/@moonshot-ai/kimi-code/dist-web");

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

if (!html.includes("kimi-com-boot.js")) {
  html = html.replace(
    '<script src="/boot.js"></script>',
    '<script src="/boot.js"></script>\n    <script src="/kimi-com-boot.js"></script>'
  );
  console.log("[patch-ui] injected kimi-com-boot.js");
}
if (!html.includes("kimi-com.css")) {
  html = html.replace(
    '<link rel="icon" href="/favicon.ico" sizes="64x64" />',
    '<link rel="icon" href="/favicon.ico" sizes="64x64" />\n    <link rel="stylesheet" href="/kimi-com.css">'
  );
  console.log("[patch-ui] injected kimi-com.css");
}
if (!html.includes("kimi-com.js")) {
  html = html.replace(
    "</body>",
    '<script src="/kimi-com.js"></script>\n  </body>'
  );
  console.log("[patch-ui] injected kimi-com.js");
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

fs.writeFileSync(indexPath, html);
console.log("[patch-ui] done");
