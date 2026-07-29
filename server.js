#!/usr/bin/env node
/**
 * Kimi Code Render Server — Minimal reliable version
 * Spawns kimi web on internal port, provides /health, proxies requests.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = 58630;

// Ensure KIMI_CODE_HOME exists
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
process.env.KIMI_CODE_HOME = KIMI_HOME;
fs.mkdirSync(KIMI_HOME, { recursive: true });

// Write config.toml with providers on first start
const CONFIG_B64 = "ZGVmYXVsdF9tb2RlbCA9ICJkZWVwc2Vlay12NC1mbGFzaC1mcmVlIgoKW2Vudl0KVVZfVVNFX0lPX1VSSU5HID0gIjAiCkxJQlVWX05PX0lPX1VSSU5HID0gIjEiCgpbcHJvdmlkZXJzLm9wZW5jb2RlXQp0eXBlID0gIm9wZW5haSIKYXBpS2V5ID0gInNrLTR5VWNVanB0OUR1V3c3V2JIelh0SGtNemRMVzZReFFQb0JaNm12bUk4OWxqdUNTTWUwQWM5VXRWZWtETXluZnoiCmJhc2VfdXJsID0gImh0dHBzOi8vb3BlbmNvZGUuYWkvemVuL3YxIgoKW3Byb3ZpZGVycy5ibHVlc21pbmRzXQp0eXBlID0gIm9wZW5haSIKYXBpS2V5ID0gInNrLU4wbFgxVDJlWmczcjVWN3dZOWJBY0VkRmhKa01uT3BRclN0VXZXeFl6Q1loWSIKYmFzZV91cmwgPSAiaHR0cHM6Ly9hcGkuYmx1ZXNtaW5kcy5jb20vdjEiCgpbcHJvdmlkZXJzLmJsdWVzbWluZHMtYmFja3VwXQp0eXBlID0gIm9wZW5haSIKYXBpS2V5ID0gInNrLTY2Wm1INGtQMnFSOHRXMHlCM2RGNWdIN2pLOWxOMXBRM3NWNXhYN3pBOUMzQTVSIgpiYXNlX3VybCA9ICJodHRwczovL2FwaS5ibHVlc21pbmRzLmNvbS92MSIKCltwcm92aWRlcnMub21uaXJvdXRlXQp0eXBlID0gIm9wZW5haSIKYXBpS2V5ID0gIm5vLWF1dGgtcmVxdWlyZWQiCmJhc2VfdXJsID0gImh0dHA6Ly8xMjcuMC4wLjE6MjAxMjgvdjEiCgpbcHJvdmlkZXJzLnplbm11eF0KdHlwZSA9ICJvcGVuYWkiCmFwaUtleSA9ICJzay1tZy12MS0xZjI2OWE4YTdmMWM5NjM2YWJiN2IyZTQ2MjQ1MTNhZDNiM2FiNTdlZjY1NDVjMGZkZTVkOTA2MDc0N2IzM2E4IgpiYXNlX3VybCA9ICJodHRwczovL3plbm11eC5haS9hcGkvdjEiCgpbcHJvdmlkZXJzLmFpYW5kXQp0eXBlID0gIm9wZW5haSIKYXBpS2V5ID0gInNrLTZiNzUwMDExY2MwNDNkNGM3OTVkMjBkM2Q0Y2VkMjE0ZTBhYWE5OTZjMWE4YjAwMTUwM2Y4NmJiMzljODRlNjQiCmJhc2VfdXJsID0gImh0dHBzOi8vYXBpLmFpYW5kLmNvbS92MSIKClttb2RlbHMuZGVlcHNlZWstdjQtZmxhc2gtZnJlZV0KcHJvdmlkZXIgPSAib3BlbmNvZGUiCm1vZGVsID0gImRlZXBzZWVrLXY0LWZsYXNoLWZyZWUiCm1heF9jb250ZXh0X3NpemUgPSAxMjgwMDAK";
const configPath = path.join(KIMI_HOME, "config.toml");
if (!fs.existsSync(configPath)) {
  try {
    fs.writeFileSync(configPath, Buffer.from(CONFIG_B64, "base64").toString("utf-8"));
    console.error("Config written to " + configPath);
  } catch (e) {
    console.error("Failed to write config: " + e.message);
  }
}

// Allow all known Render hosts for WebSocket
process.env.KIMI_CODE_ALLOWED_HOSTS = ".onrender.com,localhost,127.0.0.1";
process.env.KIMI_CODE_CORS_ORIGINS = "*";

// Find kimi binary
const kimiPaths = [
  path.join(__dirname, "node_modules/.bin/kimi"),
  path.join(__dirname, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
];
const kimiBin = kimiPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || "npx";

const args = kimiBin === "npx"
  ? ["--yes", "@moonshot-ai/kimi-code", "web", "--no-open", "--port", String(KIMI_PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"]
  : ["web", "--no-open", "--port", String(KIMI_PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"];

console.error("Starting Kimi: " + kimiBin + " " + args.join(" "));

const kimiProc = spawn(kimiBin, args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
  shell: kimiBin === "npx",
});

kimiProc.stdout.on("data", d => process.stdout.write("[kimi] " + d));
kimiProc.stderr.on("data", d => process.stderr.write("[kimi] " + d));
kimiProc.on("exit", (code, sig) => {
  console.error("Kimi exited (code=" + code + ", signal=" + sig + ") — restarting in 3s");
  setTimeout(() => process.exit(1), 3000);
});

// HTTP server — health check + proxy to Kimi
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/_health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", uptime: process.uptime(), kimi_alive: true }));
    return;
  }
  const opts = {
    hostname: "127.0.0.1",
    port: KIMI_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, connection: "close" },
  };
  const pr = http.request(opts, prRes => {
    const headers = { ...prRes.headers };
    delete headers["transfer-encoding"];
    res.writeHead(prRes.statusCode, headers);
    prRes.pipe(res);
  });
  pr.on("error", err => {
    console.error("Proxy error: " + err.message);
    if (req.url && req.url.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 50001, msg: "Kimi daemon is starting up", data: null }));
    } else {
      const html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Kimi Code</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f0f0f;color:#e0e0e0}div{text-align:center}.loading{width:20px;height:20px;border:3px solid #333;border-radius:50%;border-top-color:#6c5ce7;animation:spin 1s linear infinite;margin:10px auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div><div class=\"loading\"></div><h2>Kimi Code</h2><p>Starting...</p><script>setTimeout(()=>location.reload(),5000)</script></div></body></html>";
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    }
  });
  req.pipe(pr);
});

// WebSocket proxy
server.on("upgrade", (req, socket, head) => {
  const proxySocket = require("net").connect(KIMI_PORT, "127.0.0.1", () => {
    proxySocket.write(req.method + " " + req.url + " HTTP/1.1\r\n");
    for (const [k, v] of Object.entries(req.headers)) {
      proxySocket.write(k + ": " + v + "\r\n");
    }
    proxySocket.write("\r\n");
    proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxySocket.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.end();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.error("Server on :" + PORT + ", Kimi on :" + KIMI_PORT);
});

process.on("SIGTERM", () => {
  console.error("SIGTERM, shutting down...");
  kimiProc.kill();
  server.close(() => process.exit(0));
});
