#!/usr/bin/env node
/**
 * Kimi Code Render Server v2.0 — Direct mode + PostgreSQL Session Store
 * Runs `kimi web` directly on Render's PORT for proper WebSocket support.
 * Sessions are stored in PostgreSQL + backed up to Pentaract API every 5 min
 * — so they NEVER get lost on deploy/restart.
 */
const { spawn, execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const https = require("https");
const http = require("http");

const PORT = parseInt(process.env.PORT) || 10000;

// ── PostgreSQL config ─────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://kimi_postgres_user:TXIdRdDqyyHVfDoxXIVRUGDYGLTCzMoL@dpg-d98sd9jtqb8s739mee80-a.oregon-postgres.render.com:5432/kimi_postgres";

let pgPool = null;

// ── Pentaract config (fallback) ───────────────────────────────────
const PENTARACT_URL = "https://pentaract-i2os.onrender.com";
const PENTARACT_EMAIL = "admin@pentaract.io";
const PENTARACT_PASSWORD = "Px9kL2mN7vQ4wR8tY5uI1oP3sA6dF0gH";
const PENTARACT_STORAGE_ID = "516cb035-eb2f-4fce-842e-2c9a7d66458d";
const BACKUP_FILENAME = "kimi-sessions-backup.tar.gz";

// ── Ensure KIMI_CODE_HOME ────────────────────────────────────────
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
process.env.KIMI_CODE_HOME = KIMI_HOME;
fs.mkdirSync(KIMI_HOME, { recursive: true });
const SESSIONS_DIR = path.join(KIMI_HOME, "sessions");

// ── Config — read template from repo, substitute env vars ──
const configPath = path.join(KIMI_HOME, "config.toml");
const repoConfigPath = path.join(__dirname, "config.toml");
try {
  let configContent = null;
  if (fs.existsSync(repoConfigPath)) {
    configContent = fs.readFileSync(repoConfigPath, "utf-8");
    console.error("[setup] Loaded config template from repo (" + (Buffer.byteLength(configContent) / 1024).toFixed(0) + " KB)");
  } else {
    const CONFIG_B64 = "ZGVmYXVsdF9tb2RlbCA9ICJibHVlc21pbmRzLWdwdDUyLWNoYXQiCgpbZW52XQpVVl9VU0VfSU9fVVJJTkcgPSAiMCIKTElCVVZfTk9fSU9fVVJJTkcgPSAiMSI=";
    configContent = Buffer.from(CONFIG_B64, "base64").toString("utf-8");
    console.error("[setup] Loaded minimal config from base64 fallback");
  }
  // Substitute env vars for API keys and password
  const envMap = {
    '__ENV_SERVER_PASSWORD__':     process.env.SERVER_PASSWORD,
    '__ENV_OPENCODE_ZEN_API_KEY__': process.env.OPENCODE_ZEN_API_KEY,
    '__ENV_BLUESMINDS_API_KEY__':  process.env.BLUESMINDS_API_KEY,
    '__ENV_Z_AI_API_KEY__':       process.env.Z_AI_API_KEY,
    '__ENV_ZENMUX_API_KEY__':     process.env.ZENMUX_API_KEY,
    '__ENV_CLOUDFLARE_API_KEY__': process.env.CLOUDFLARE_API_KEY,
    '__ENV_NVIDIA_API_KEY__':     process.env.NVIDIA_API_KEY,
    '__ENV_AIAND_API_KEY__':      process.env.AIAND_API_KEY,
  };
  for (const [placeholder, envVal] of Object.entries(envMap)) {
    if (envVal) {
      while (configContent.includes(placeholder)) {
        configContent = configContent.replace(placeholder, envVal);
      }
    }
  }
  fs.writeFileSync(configPath, configContent);
  console.error("[setup] Config written to " + configPath);
} catch (e) {
  console.error("[setup] Failed to write config: " + e.message);
}

process.env.KIMI_CODE_ALLOWED_HOSTS = ".onrender.com,localhost,127.0.0.1";
process.env.KIMI_CODE_CORS_ORIGINS = "*";

// ── PostgreSQL helpers ────────────────────────────────────────────

async function initPostgres() {
  try {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    // Test connection
    const client = await pgPool.connect();
    await client.query("SELECT 1");
    // Create sessions table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS kimi_sessions (
        session_id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Create index on updated_at
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kimi_sessions_updated ON kimi_sessions(updated_at)
    `).catch(() => {});
    client.release();
    console.error("[pg] PostgreSQL connected & sessions table ready");
    return true;
  } catch (e) {
    console.error("[pg] PostgreSQL init failed: " + e.message + " (will use Pentaract-only backup)");
    pgPool = null;
    return false;
  }
}

async function saveSessionsToPostgres() {
  if (!pgPool) return;
  try {
    // Read all session directories
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const sessionDirs = fs.readdirSync(SESSIONS_DIR).filter(f =>
      fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
    );
    if (sessionDirs.length === 0) return;

    const client = await pgPool.connect();
    try {
      for (const sid of sessionDirs) {
        const sessionPath = path.join(SESSIONS_DIR, sid);
        const files = fs.readdirSync(sessionPath).filter(f => f.endsWith(".jsonl"));
        if (files.length === 0) continue;

        // Tar the session directory
        const tmpFile = "/tmp/pg-session-" + sid + ".tar.gz";
        try {
          execSync(`tar czf "${tmpFile}" -C "${KIMI_HOME}" sessions/${sid} 2>/dev/null`, {
            stdio: "ignore", timeout: 15000
          });
          if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) continue;

          const data = fs.readFileSync(tmpFile);
          await client.query(
            `INSERT INTO kimi_sessions (session_id, data, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (session_id) DO UPDATE SET data = $2, updated_at = NOW()`,
            [sid, data]
          );
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
      }
      console.error("[pg] Saved " + sessionDirs.length + " sessions to PostgreSQL");
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[pg] Failed to save sessions to PostgreSQL: " + e.message);
  }
}

async function restoreSessionsFromPostgres() {
  if (!pgPool) return false;
  try {
    const client = await pgPool.connect();
    try {
      const result = await client.query("SELECT session_id, data FROM kimi_sessions ORDER BY updated_at DESC");
      if (result.rows.length === 0) {
        console.error("[pg] No sessions in PostgreSQL");
        return false;
      }

      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      let restored = 0;
      for (const row of result.rows) {
        const tmpFile = "/tmp/pg-restore-" + row.session_id + ".tar.gz";
        try {
          fs.writeFileSync(tmpFile, row.data);
          execSync(`tar xzf "${tmpFile}" -C "${KIMI_HOME}" 2>/dev/null`, {
            stdio: "ignore", timeout: 15000
          });
          restored++;
        } catch (e) {
          console.error("[pg] Failed to restore session " + row.session_id + ": " + e.message);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
      }
      console.error("[pg] Restored " + restored + "/" + result.rows.length + " sessions from PostgreSQL");
      return restored > 0;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[pg] Failed to restore from PostgreSQL: " + e.message);
    return false;
  }
}

// ── Pentaract API helpers (fallback) ─────────────────────────────

function pentaractLogin() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ email: PENTARACT_EMAIL, password: PENTARACT_PASSWORD });
    const url = new URL(PENTARACT_URL + "/api/auth/login");
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { const j = JSON.parse(body); if (j.access_token) resolve(j.access_token); else reject(new Error("Login failed: " + body)); }
        catch (e) { reject(new Error("Login parse error: " + body.substring(0, 100))); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function pentaractUpload(token, filePath, remotePath) {
  return new Promise((resolve, reject) => {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/gzip\r\n\r\n`;
    const footer = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${remotePath}\r\n--${boundary}--\r\n`;
    const bodyBuf = Buffer.concat([Buffer.from(header, "utf-8"), fileContent, Buffer.from(footer, "utf-8")]);
    const url = new URL(PENTARACT_URL + "/api/storages/" + PENTARACT_STORAGE_ID + "/files/upload");
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": bodyBuf.length },
    };
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => { if (res.statusCode < 300) resolve(body); else reject(new Error("Upload failed: HTTP " + res.statusCode + " " + body)); });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function pentaractDownload(token, remotePath) {
  return new Promise((resolve, reject) => {
    const url = new URL(PENTARACT_URL + "/api/storages/" + PENTARACT_STORAGE_ID + "/files/download/" + remotePath);
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname + url.search,
      method: "GET", headers: { Authorization: "Bearer " + token },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode < 300) resolve(Buffer.concat(chunks));
        else { const body = Buffer.concat(chunks).toString(); if (res.statusCode === 404) resolve(null); else reject(new Error("Download failed: HTTP " + res.statusCode + " " + body)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Session backup & restore ─────────────────────────────────────

async function backupSessions() {
  // Save to PostgreSQL first
  await saveSessionsToPostgres();

  // Also backup to Pentaract (fallback)
  if (!fs.existsSync(SESSIONS_DIR)) return;
  const items = fs.readdirSync(SESSIONS_DIR).filter((f) => f !== "." && f !== "..");
  if (items.length === 0) return;

  const tmpFile = "/tmp/" + BACKUP_FILENAME;
  try {
    execSync(`tar czf "${tmpFile}" -C "${KIMI_HOME}" sessions 2>/dev/null`, {
      stdio: "ignore", timeout: 30000,
    });
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) return;

    const token = await pentaractLogin();
    await pentaractUpload(token, tmpFile, BACKUP_FILENAME);
    console.error("[backup] Pentaract backup OK (" + (fs.statSync(tmpFile).size / 1024).toFixed(0) + " KB)");
  } catch (e) {
    console.error("[backup] Pentaract backup failed: " + e.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

async function restoreSessions() {
  // Try PostgreSQL first (primary)
  const pgRestored = await restoreSessionsFromPostgres();
  if (pgRestored) {
    console.error("[restore] Sessions restored from PostgreSQL");
    return;
  }

  // Fallback to Pentaract
  console.error("[restore] No sessions in PostgreSQL, trying Pentaract...");
  const tmpFile = "/tmp/" + BACKUP_FILENAME;
  try {
    const token = await pentaractLogin();
    const data = await pentaractDownload(token, BACKUP_FILENAME);
    if (!data || data.length === 0) {
      console.error("[restore] No backup found in Pentaract, starting fresh");
      return;
    }
    fs.writeFileSync(tmpFile, data);
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    execSync(`tar xzf "${tmpFile}" -C "${KIMI_HOME}" 2>/dev/null`, {
      stdio: "ignore", timeout: 30000,
    });
    const sessionCount = fs.readdirSync(SESSIONS_DIR).filter((f) =>
      fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
    ).length;
    console.error("[restore] Restored " + sessionCount + " sessions from Pentaract (" +
      (data.length / 1024).toFixed(0) + " KB)");

    // Also save to PostgreSQL so next restore is faster
    await saveSessionsToPostgres();
  } catch (e) {
    console.error("[restore] Pentaract restore failed: " + e.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ── Health / Admin endpoint ──────────────────────────────────────
function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const sessions = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()).length : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions, pg_connected: pgPool !== null }));
    } else if (req.url === "/kimi-admin/pg-info" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        connected: pgPool !== null,
        database_url: DATABASE_URL.replace(/\/\/[^:]+:([^@]+)@/, "//***:***@"),
        sessions_table: "kimi_sessions"
      }, null, 2));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  const healthPort = PORT + 1;
  server.listen(healthPort, "127.0.0.1", () => {
    console.error("[health] Health server on 127.0.0.1:" + healthPort);
  });
  server.on("error", () => {});
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.error("=== Kimi Code Server v2.0 (PostgreSQL Session Store) ===");
  console.error("[main] PORT=" + PORT + " KIMI_HOME=" + KIMI_HOME);

  // Init PostgreSQL
  await initPostgres();

  // Restore sessions (PostgreSQL primary, Pentaract fallback)
  await restoreSessions();

  // Find kimi binary
  const kimiPaths = [
    path.join(__dirname, "node_modules/.bin/kimi"),
    path.join(__dirname, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
  ];
  const kimiBin = kimiPaths.find((p) => {
    try { return fs.existsSync(p); } catch (e) { return false; }
  }) || "npx";

  const args = kimiBin === "npx"
    ? ["--yes", "@moonshot-ai/kimi-code", "web", "--no-open",
       "--port", String(PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"]
    : ["web", "--no-open",
       "--port", String(PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"];

  console.error("[main] Starting Kimi: " + kimiBin + " " + args.join(" "));

  const kimiProc = spawn(kimiBin, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PORT: String(PORT) },
    shell: kimiBin === "npx",
  });

  // Auto-backup every 5 minutes (saves to both PostgreSQL and Pentaract)
  const backupInterval = setInterval(() => {
    console.error("[backup] Auto-backup...");
    backupSessions();
  }, 5 * 60 * 1000);

  // Backup on exit
  const shutdown = async (signal) => {
    console.error("[shutdown] " + signal + " received, backing up sessions...");
    clearInterval(backupInterval);
    await backupSessions();
    console.error("[shutdown] Backup done, forwarding " + signal + " to kimi...");
    kimiProc.kill(signal);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  kimiProc.on("exit", (code, sig) => {
    console.error("[main] Kimi exited (code=" + code + ", signal=" + sig + ")");
    process.exit(code || 0);
  });

  // Start health server for Render/Docker HEALTHCHECK
  startHealthServer();
}

main().catch((e) => {
  console.error("[main] Fatal error: " + e.message);
  process.exit(1);
});
