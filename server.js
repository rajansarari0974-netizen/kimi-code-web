#!/usr/bin/env node
/**
 * Kimi Code Render Server — Direct mode (no proxy)
 * Runs `kimi web` directly on Render's PORT for proper WebSocket support.
 * No proxy layer — eliminates all proxy-related WebSocket issues.
 */
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = parseInt(process.env.PORT) || 10000;

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

process.env.KIMI_CODE_ALLOWED_HOSTS = ".onrender.com,localhost,127.0.0.1";
process.env.KIMI_CODE_CORS_ORIGINS = "*";

// Find kimi binary
const kimiPaths = [
  path.join(__dirname, "node_modules/.bin/kimi"),
  path.join(__dirname, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
];
const kimiBin = kimiPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || "npx";

// Run kimi web directly on Render's PORT — no proxy, WebSocket works natively
const args = kimiBin === "npx"
  ? ["--yes", "@moonshot-ai/kimi-code", "web", "--no-open", "--port", String(PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"]
  : ["web", "--no-open", "--port", String(PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"];

console.error("Starting Kimi on port " + PORT + ": " + kimiBin + " " + args.join(" "));

const kimiProc = spawn(kimiBin, args, {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, PORT: String(PORT) },
  shell: kimiBin === "npx",
});

kimiProc.on("exit", (code, sig) => {
  console.error("Kimi exited (code=" + code + ", signal=" + sig + ")");
  process.exit(code || 0);
});

process.on("SIGTERM", () => {
  console.error("SIGTERM received, forwarding to kimi...");
  kimiProc.kill("SIGTERM");
});
