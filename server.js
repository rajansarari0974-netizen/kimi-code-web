#!/usr/bin/env node
/**
 * Kimi Code Render Server v4.0 — Kimi Code + Kimi Claw on ONE service
 * Runs a single HTTP proxy on Render's PORT:
 *   - everything except /claw*  → kimi web  (internal KIMI_PORT)
 *   - /claw*                     → hermes-web-ui (Kimi Claw UI, internal HERMES_PORT)
 * WebSocket upgrades are proxied too (kimi chat WS + Kimi Claw terminal).
 *
 * v3.1 heritage: Sessions saved to PostgreSQL in REAL-TIME (within ~2s of any
 * change) via file watcher, plus periodic backup every 5 min as safety net —
 * so they NEVER get lost on deploy/restart. Pentaract remains the fallback.
 */
const { spawn, exec } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const https = require("https");
const http = require("http");
const util = require("util");
const execAsync = util.promisify(exec);
const httpProxy = require("http-proxy");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = PORT + 1;            // kimi web internal port
const HERMES_PORT = 8648;              // hermes-web-ui (Kimi Claw UI) internal port
const HERMES_UPSTREAM = "http://127.0.0.1:8642"; // hermes agent gateway
const HERMES_BIN = process.env.HERMES_BIN || "/opt/hermes/bin/hermes";

// ── PostgreSQL config ─────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || "";

let pgPool = null;
let pgError = null;

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
const HERMES_HOME = path.join(os.homedir(), ".hermes");

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
  // Remove the managed:kimi-code OAuth provider section entirely
  // (including the nested .oauth subsection) to prevent "No token" errors.
  configContent = configContent.replace(
    /\[providers\."managed:kimi-code"\][\s\S]*?(?=\[providers\.|\[models\.|\[server\]|\[env\]|$)/,
    ""
  );
  fs.writeFileSync(configPath, configContent);
  console.error("[setup] Config written to " + configPath);
} catch (e) {
  console.error("[setup] Failed to write config: " + e.message);
}

process.env.KIMI_CODE_ALLOWED_HOSTS = ".onrender.com,localhost,127.0.0.1";
process.env.KIMI_CODE_CORS_ORIGINS = "*";

// ── PostgreSQL helpers ────────────────────────────────────────────

async function initPostgres() {
  if (!DATABASE_URL) {
    pgError = "DATABASE_URL not set";
    console.error("[pg] No DATABASE_URL set, skipping PostgreSQL");
    return false;
  }
  try {
    const { Pool } = require("pg");
    pgPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    // Test connection
    const client = await pgPool.connect();
    await client.query("SELECT 1");
    // Ensure sessions table exists with the right schema
    // Existing table may have different column names ('session_data' vs 'data')
    await client.query(`
      CREATE TABLE IF NOT EXISTS kimi_sessions (
        session_id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // If table was created by old code with 'session_data' column, add 'data' column
    await client.query(`
      ALTER TABLE kimi_sessions ADD COLUMN IF NOT EXISTS data BYTEA
    `).catch(() => {});
    // Remove old unused 'session_data' column if it exists
    await client.query(`
      ALTER TABLE kimi_sessions DROP COLUMN IF EXISTS session_data
    `).catch(() => {});
    // Remove old unused 'id' column if it exists
    await client.query(`
      ALTER TABLE kimi_sessions DROP COLUMN IF EXISTS id
    `).catch(() => {});
    // Create index on updated_at
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kimi_sessions_updated ON kimi_sessions(updated_at)
    `).catch(() => {});
    // Hermes (Kimi Claw) state backup table — whole-home blob + stable API key
    await client.query(`
      CREATE TABLE IF NOT EXISTS hermes_state (
        row_id TEXT PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    client.release();
    console.error("[pg] PostgreSQL connected & sessions table ready");
    return true;
  } catch (e) {
    pgError = e.message;
    console.error("[pg] PostgreSQL init failed: " + e.message + " (will use Pentaract-only backup)");
    pgPool = null;
    return false;
  }
}

// Tar sessions + registry files (workspaces.json, session_index.jsonl) so
// restores rebuild the UI's workspace list, not just the session folders.
function tarSourceArgs() {
  const args = ["sessions"];
  for (const f of ["workspaces.json", "session_index.jsonl"]) {
    if (fs.existsSync(path.join(KIMI_HOME, f))) args.push(f);
  }
  return args.join(" ");
}

async function saveSessionsToPostgres() {
  if (!pgPool) return;
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const sessionDirs = fs.readdirSync(SESSIONS_DIR).filter(f =>
      fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
    );
    if (sessionDirs.length === 0) return;

    // Tar ALL sessions into ONE archive (fast, non-blocking)
    const tmpFile = "/tmp/pg-sessions-all.tar.gz";
    const { stderr } = await execAsync(
      `tar czf "${tmpFile}" -C "${KIMI_HOME}" ${tarSourceArgs()} 2>&1`,
      { timeout: 30000 }
    ).catch(e => {
      console.error("[pg] tar failed: " + e.message);
      return { stderr: e.message };
    });
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) return;

    const data = fs.readFileSync(tmpFile);
    const client = await pgPool.connect();
    try {
      // Save as a single backup row (key = "sessions_backup")
      await client.query(
        `INSERT INTO kimi_sessions (session_id, data, updated_at)
         VALUES ('sessions_backup', $1, NOW())
         ON CONFLICT (session_id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [data]
      );
      console.error("[pg] Saved all " + sessionDirs.length + " sessions to PostgreSQL (" +
        (data.length / 1024).toFixed(0) + " KB)");
    } finally {
      client.release();
      try { fs.unlinkSync(tmpFile); } catch (_) {}
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
      // Step 1: try the single backup blob (key = "sessions_backup")
      const blobResult = await client.query(
        "SELECT data, updated_at FROM kimi_sessions WHERE session_id = 'sessions_backup'"
      );

      // Step 2: if no blob, migrate old per-session rows into a single backup
      if (blobResult.rows.length === 0) {
        console.error("[pg] No sessions_backup blob, checking individual session rows...");
        const oldRows = await client.query(
          "SELECT session_id, data FROM kimi_sessions WHERE session_id != 'sessions_backup' ORDER BY updated_at DESC"
        );
        if (oldRows.rows.length > 0) {
          console.error("[pg] Found " + oldRows.rows.length + " old session rows, extracting...");
          fs.mkdirSync(SESSIONS_DIR, { recursive: true });
          let restored = 0;
          for (const row of oldRows.rows) {
            const tmpFile = "/tmp/pg-migrate-" + row.session_id + ".tar.gz";
            try {
              fs.writeFileSync(tmpFile, row.data);
              await execAsync(`tar xzf "${tmpFile}" -C "${KIMI_HOME}" 2>&1`, { timeout: 15000 });
              restored++;
            } catch (e) {
              console.error("[pg] Failed to restore old session " + row.session_id + ": " + e.message);
            } finally {
              try { fs.unlinkSync(tmpFile); } catch (_) {}
            }
          }
          console.error("[pg] Migrated " + restored + "/" + oldRows.rows.length + " old sessions");
          return restored > 0;
        }
        console.error("[pg] No sessions at all in PostgreSQL");
        return false;
      }

      // Step 3: extract the single backup blob
      const data = blobResult.rows[0].data;
      const tmpFile = "/tmp/pg-restore-all.tar.gz";
      fs.writeFileSync(tmpFile, data);
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });

      try {
        await execAsync(`tar xzf "${tmpFile}" -C "${KIMI_HOME}" 2>&1`, { timeout: 30000 });
        const sessionCount = fs.readdirSync(SESSIONS_DIR).filter(f =>
          fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
        ).length;
        console.error("[pg] Restored " + sessionCount + " sessions from PostgreSQL backup (" +
          (data.length / 1024).toFixed(0) + " KB)");
        return sessionCount > 0;
      } catch (e) {
        console.error("[pg] Restore tar extraction failed: " + e.message);
        return false;
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[pg] Failed to restore from PostgreSQL: " + e.message);
    return false;
  }
}

// ── Hermes (Kimi Claw) state persistence ─────────────────────────
// The hermes agent keeps its sessions/memories/kanban/pairing state under
// ~/.hermes, which is EPHEMERAL on Render free tier — it gets wiped on every
// deploy/restart/sleep-wake, which is why Claw sessions kept vanishing and the
// UI showed "disconnected" after a restart. Mirror the whole home (minus
// transient/runtime files) to PostgreSQL the same way kimi sessions are backed
// up, and restore it at boot BEFORE the gateway starts. Kimi session handling
// is left completely untouched.

const HERMES_TAR_EXCLUDES = [
  "--exclude=logs", "--exclude=*.log",
  "--exclude=gateway.lock", "--exclude=gateway.pid",
  "--exclude=gateway_state.json", "--exclude=gateway-starts.log",
  "--exclude=.update_check",
  "--exclude=audio_cache", "--exclude=image_cache",
];

function hermesTarArgs() {
  // Start from the home dir so extraction puts .hermes/ back at the right place
  return `tar czf "${hermesTmpTar()}" -C "${os.homedir()}" ${HERMES_TAR_EXCLUDES.join(" ")} .hermes 2>&1`;
}

function hermesTmpTar() {
  return "/tmp/pg-hermes.tar.gz";
}

async function saveHermesToPostgres() {
  if (!pgPool) return;
  try {
    if (!fs.existsSync(HERMES_HOME)) return;
    const tmpFile = hermesTmpTar();
    await execAsync(hermesTarArgs(), { timeout: 30000 }).catch(e => {
      console.error("[pg-hermes] tar failed: " + e.message);
      return { stderr: e.message };
    });
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) return;
    const data = fs.readFileSync(tmpFile);
    const client = await pgPool.connect();
    try {
      await client.query(
        `INSERT INTO hermes_state (row_id, data, updated_at)
         VALUES ('hermes_backup', $1, NOW())
         ON CONFLICT (row_id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [data]
      );
      console.error("[pg-hermes] Saved hermes state to PostgreSQL (" +
        (data.length / 1024).toFixed(0) + " KB)");
      global.__hermesLastSave = new Date().toISOString();
    } finally {
      client.release();
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (e) {
    console.error("[pg-hermes] Failed to save hermes state: " + e.message);
  }
}

async function restoreHermesFromPostgres() {
  if (!pgPool) return false;
  try {
    const client = await pgPool.connect();
    try {
      const r = await client.query(
        "SELECT data FROM hermes_state WHERE row_id = 'hermes_backup'"
      );
      if (!r.rows.length) {
        console.error("[pg-hermes] No hermes backup in PostgreSQL, starting fresh");
        return false;
      }
      const data = r.rows[0].data;
      const tmpFile = "/tmp/pg-hermes-restore.tar.gz";
      fs.writeFileSync(tmpFile, data);
      fs.mkdirSync(HERMES_HOME, { recursive: true });
      await execAsync(`tar xzf "${tmpFile}" -C "${os.homedir()}" 2>&1`, { timeout: 30000 });
      console.error("[pg-hermes] Restored hermes state from PostgreSQL (" +
        (data.length / 1024).toFixed(0) + " KB)");
      global.__hermesLastRestore = new Date().toISOString();
      return true;
    } finally {
      client.release();
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (e) {
    console.error("[pg-hermes] Restore failed: " + e.message);
    return false;
  }
}

// Stable API_SERVER_KEY across restarts: the Claw UI stores the key in
// localStorage, so a regenerated key at every boot makes every old tab/WS
// connection stale -> "disconnected" after deploy/sleep. Persist the key in
// PostgreSQL and reuse it forever.
async function getStableApiKey() {
  let key = null;
  if (pgPool) {
    try {
      const client = await pgPool.connect();
      try {
        const r = await client.query(
          "SELECT data FROM hermes_state WHERE row_id = 'api_key'"
        );
        if (r.rows.length) key = r.rows[0].data.toString("utf-8").trim();
      } finally {
        client.release();
      }
    } catch (e) {
      console.error("[pg-hermes] getStableApiKey read failed: " + e.message);
    }
  }
  if (!key) {
    key = crypto.randomBytes(32).toString("hex");
    if (pgPool) {
      try {
        const client = await pgPool.connect();
        try {
          await client.query(
            `INSERT INTO hermes_state (row_id, data, updated_at)
             VALUES ('api_key', $1, NOW())
             ON CONFLICT (row_id) DO UPDATE SET data = $1, updated_at = NOW()`,
            [Buffer.from(key, "utf-8")]
          );
          console.error("[pg-hermes] Generated + persisted stable API key");
        } finally {
          client.release();
        }
      } catch (e) {
        console.error("[pg-hermes] API key persist failed: " + e.message);
      }
    } else {
      console.error("[pg-hermes] No PG — using ephemeral API key this boot");
    }
  }
  return key;
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
  try {
    // Self-heal registry files first so backups always carry a valid UI state
    ensureRegistryFiles();

    // Save to PostgreSQL first
    await saveSessionsToPostgres();

    // Also backup to Pentaract (fallback) — async tar, non-blocking
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const items = fs.readdirSync(SESSIONS_DIR).filter((f) => f !== "." && f !== "..");
    if (items.length === 0) return;

    const tmpFile = "/tmp/" + BACKUP_FILENAME;
    try {
      await execAsync(`tar czf "${tmpFile}" -C "${KIMI_HOME}" ${tarSourceArgs()} 2>&1`, { timeout: 30000 });
      if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) return;

      const token = await pentaractLogin();
      await pentaractUpload(token, tmpFile, BACKUP_FILENAME);
      console.error("[backup] Pentaract backup OK (" + (fs.statSync(tmpFile).size / 1024).toFixed(0) + " KB)");
    } catch (e) {
      console.error("[backup] Pentaract backup failed: " + e.message);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (e) {
    console.error("[backup] backupSessions error: " + e.message);
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
    await execAsync(`tar xzf "${tmpFile}" -C "${KIMI_HOME}" 2>&1`, { timeout: 30000 });
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

// ── Registry self-healing ────────────────────────────────────
// If workspaces.json / session_index.jsonl are missing or empty (e.g. an
// older blob clobbered them), rebuild them from the session folders on disk.
// kimi web reads these two files to populate the UI's workspace/session list,
// so without them the UI shows an empty sidebar even though sessions exist.

function isoFromMs(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n).toISOString();
}

function ensureRegistryFiles() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const buckets = fs.readdirSync(SESSIONS_DIR).filter((f) => {
      try { return fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory(); }
      catch (e) { return false; }
    });
    if (buckets.length === 0) return;

    const wsPath = path.join(KIMI_HOME, "workspaces.json");
    const idxPath = path.join(KIMI_HOME, "session_index.jsonl");

    let workspaces = null;
    try {
      if (fs.existsSync(wsPath)) {
        const parsed = JSON.parse(fs.readFileSync(wsPath, "utf-8"));
        if (parsed && parsed.workspaces && Object.keys(parsed.workspaces).length > 0) {
          workspaces = parsed.workspaces;
        }
      }
    } catch (e) { workspaces = null; }

    let indexLines = null;
    try {
      if (fs.existsSync(idxPath)) {
        const content = fs.readFileSync(idxPath, "utf-8").trim();
        if (content.length > 0) indexLines = content.split("\n").filter((l) => l.trim());
      }
    } catch (e) { indexLines = null; }

    // Rebuild workspaces.json if missing/empty
    if (!workspaces) {
      const rebuilt = {};
      const now = new Date().toISOString();
      for (const bucket of buckets) {
        const bucketAbs = path.join(SESSIONS_DIR, bucket);
        let root = null, name = bucket, created = null, opened = null;
        let entries = [];
        try { entries = fs.readdirSync(bucketAbs); } catch (e) {}
        for (const entry of entries) {
          const statePath = path.join(bucketAbs, entry, "state.json");
          try {
            const st = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            if (st.cwd) root = st.cwd;
            if (st.createdAt && created === null) created = isoFromMs(st.createdAt);
            const openedMs = Number(st.updatedAt);
            if (isFinite(openedMs) && openedMs > 0) opened = isoFromMs(openedMs);
            break;
          } catch (e) { continue; }
        }
        if (!root) {
          root = bucket.startsWith("wd_root_") ? "/root" : bucketAbs;
          name = bucket.startsWith("wd_root_") ? "root" : bucket;
        } else {
          name = bucket.startsWith("wd_root_") ? "root" : path.basename(root);
        }
        rebuilt[bucket] = {
          root: root,
          name: name,
          created_at: created || now,
          last_opened_at: opened || now,
        };
      }
      fs.writeFileSync(wsPath, JSON.stringify({ version: 1, workspaces: rebuilt, deleted_workspace_ids: [] }, null, 2));
      console.error("[registry] Rebuilt workspaces.json with " + Object.keys(rebuilt).length + " workspaces");
    }

    // Rebuild session_index.jsonl if missing/empty
    if (!indexLines) {
      const lines = [];
      for (const bucket of buckets) {
        const bucketAbs = path.join(SESSIONS_DIR, bucket);
        let entries = [];
        try { entries = fs.readdirSync(bucketAbs); } catch (e) {}
        for (const entry of entries) {
          const dirAbs = path.join(bucketAbs, entry);
          try {
            if (!fs.statSync(dirAbs).isDirectory()) continue;
          } catch (e) { continue; }
          let sid = entry, workDir = null;
          const statePath = path.join(dirAbs, "state.json");
          try {
            const st = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            if (st.id) sid = st.id;
            if (st.cwd) workDir = st.cwd;
          } catch (e) {}
          if (!workDir) {
            try {
              const wsParsed = workspaces || JSON.parse(fs.readFileSync(wsPath, "utf-8")).workspaces;
              workDir = wsParsed[bucket] ? wsParsed[bucket].root : "/root";
            } catch (e) { workDir = "/root"; }
          }
          lines.push(JSON.stringify({ sessionId: sid, sessionDir: dirAbs, workDir: workDir }));
        }
      }
      fs.writeFileSync(idxPath, lines.join("\n") + (lines.length ? "\n" : ""));
      console.error("[registry] Rebuilt session_index.jsonl with " + lines.length + " sessions");
    }
  } catch (e) {
    console.error("[registry] ensureRegistryFiles error: " + e.message);
  }
}

// ── Real-time session watcher ────────────────────────────────

let backupTimeout = null;
let watchInitialized = false;

function startSessionWatcher() {
  if (watchInitialized) return;
  watchInitialized = true;

  const indexPath = path.join(KIMI_HOME, "session_index.jsonl");

  // Debounced backup scheduler — waits 2s after LAST change, then saves
  function scheduleBackup() {
    if (backupTimeout) clearTimeout(backupTimeout);
    backupTimeout = setTimeout(() => {
      backupTimeout = null;
      backupSessions().catch(e =>
        console.error("[watcher] Backup error: " + e.message)
      );
    }, 2000);
  }

  // Watch session_index.jsonl for changes (session create/update/delete)
  try {
    if (fs.existsSync(indexPath)) {
      fs.watch(indexPath, (eventType) => {
        if (eventType === "change") scheduleBackup();
      });
      console.error("[watcher] Watching " + indexPath);
    }
  } catch (e) {
    console.error("[watcher] Cannot watch index: " + e.message);
  }

  // Watch sessions directory for new/removed session folders
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      fs.watch(SESSIONS_DIR, (eventType, filename) => {
        if (filename && filename !== "." && filename !== "..")
          scheduleBackup();
      });
      console.error("[watcher] Watching " + SESSIONS_DIR);
    }
  } catch (e) {
    console.error("[watcher] Cannot watch sessions dir: " + e.message);
  }
}

// ── HTTP proxy: /claw* → hermes-web-ui, everything else → kimi web ──

function routeTarget(reqUrl) {
  return reqUrl.startsWith("/claw") ? HERMES_PORT : KIMI_PORT;
}

// Strip the /claw prefix so the backend sees its native paths.
//  /claw        → "/"
//  /claw/       → "/"
//  /claw/api/x  → "/api/x"
function stripClawPrefix(reqUrl) {
  let out = reqUrl.replace(/^\/claw(?=\/|$)/, "");
  if (out === "") out = "/";
  return out;
}

const proxy = httpProxy.createProxyServer({
  changeOrigin: false,
  xfwd: false,
});

proxy.on("error", (err, req, resOrSocket) => {
  console.error("[proxy] " + (req && req.url) + " → " + err.message);
  if (resOrSocket && resOrSocket.writeHead) {
    try {
      if (!resOrSocket.headersSent) resOrSocket.writeHead(502, { "Content-Type": "text/plain" });
      resOrSocket.end("Bad Gateway: " + err.message);
    } catch (e) { /* ignore */ }
  } else if (resOrSocket && resOrSocket.destroy) {
    try { resOrSocket.destroy(); } catch (e) { /* ignore */ }
  }
});

// ── /_diag debug endpoint (temporary, for gateway diagnosis) ──────
function httpGetHealth(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 300) }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "ERR " + e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "TIMEOUT" }); });
  });
}

function execDiag(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? "\n[stderr] " + stderr : "");
      resolve((err ? "[exit " + err.code + "] " : "") + out.slice(0, 3000));
    });
  });
}

function maskKey(s) {
  if (typeof s !== "string") return s;
  return s.replace(/(key[:=\s]+)([A-Za-z0-9]{6})[A-Za-z0-9]+([A-Za-z0-9]{4})/g, "$1$2***$3");
}

// Root /assets/* fallback → try hermes-web-ui first (Kimi Claw lazy chunks
// were built with Vite base "/" and request /assets/* without the /claw
// prefix), then fall through to kimi web on 404 so its own assets keep
// working. Serves both from the same localhost pair — zero config, nothing
// removed.
function tryWebuiAsset(req, res) {
  return new Promise((resolve) => {
    const upReq = http.request(
      {
        host: "127.0.0.1",
        port: HERMES_PORT,
        path: req.url,
        method: req.method,
        headers: Object.assign({}, req.headers, { host: "127.0.0.1:" + HERMES_PORT }),
      },
      (upRes) => {
        // hermes-web-ui SPA-fallbacks unknown paths to index.html (200
        // text/html). Treat that as a miss so kimi web's own /assets/* keep
        // working; only serve real files (js/css/svg/ico/...).
        const ct = String(upRes.headers["content-type"] || "").toLowerCase();
        if (upRes.statusCode === 404 || ct.includes("text/html")) {
          upRes.resume();
          resolve(false);
          return;
        }
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        resolve(true);
      }
    );
    upReq.on("error", () => resolve(false));
    upReq.end();
  });
}

// Kimi Claw auto-login (runtime): the webui's served index.html is built in
// memory with a base-path transform, so writing the key into the dist file
// (injectClawKey below) doesn't stick. Instead we intercept page loads to the
// claw backend and inject the key script into the HTML response on the fly.
// The UI gate accepts any non-empty key and the API doesn't validate it.
function clawKeyScript() {
  let key = "";
  try {
    const envTxt = fs.readFileSync(path.join(os.homedir(), ".hermes", ".env"), "utf-8");
    const m = envTxt.match(/^API_SERVER_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (m && m[1]) key = m[1].trim();
  } catch (e) { /* fall through to static key */ }
  if (!key) key = "kimi-claw-ui";
  return (
    '<script id="KIMI_CLAW_KEY_INJECTED">try{localStorage.setItem("hermes_api_key","' +
    key + '");localStorage.setItem("hermes_server_url","")}catch(e){}</script>'
  );
}

// Manually fetch a claw page from the webui and inject the auto-login key
// script before </head>. Returns true if a response was sent, false to fall
// through to the normal proxy (upstream down / non-page responses).
function serveClawPage(req, res, upPath) {
  return new Promise((resolve) => {
    const headers = Object.assign({}, req.headers, {
      host: "127.0.0.1:" + HERMES_PORT,
      "accept-encoding": "identity", // keep the body plain so we can inject
    });
    delete headers["content-length"];
    const upReq = http.request(
      { host: "127.0.0.1", port: HERMES_PORT, path: upPath, method: req.method, headers },
      (upRes) => {
        const ct = String(upRes.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("text/html")) {
          // Not a page (redirect, etc.) — pass through untouched
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
          resolve(true);
          return;
        }
        const chunks = [];
        upRes.on("data", (d) => chunks.push(d));
        upRes.on("end", () => {
          let html = Buffer.concat(chunks).toString("utf-8");
          const script = clawKeyScript();
          if (html.includes("KIMI_CLAW_KEY_INJECTED")) {
            html = html.replace(/<script id="KIMI_CLAW_KEY_INJECTED">[\s\S]*?<\/script>/, script);
          } else {
            html = html.replace("</head>", script + "</head>");
          }
          const headers2 = Object.assign({}, upRes.headers);
          delete headers2["content-length"];
          headers2["content-length"] = Buffer.byteLength(html);
          res.writeHead(upRes.statusCode, headers2);
          res.end(html);
          resolve(true);
        });
        upRes.on("error", () => resolve(false));
      }
    );
    upReq.on("error", () => resolve(false));
    upReq.end();
  });
}

// Kimi Claw auto-login: the webui SPA gates the UI behind a login screen
// until localStorage.hermes_api_key is set, but the gateway API key is
// regenerated at every boot. Inject the current API_SERVER_KEY into the
// served index.html so the Claw UI opens directly, no login prompt.
// Idempotent: replaces any previous marker block with the fresh key.
function injectClawKey() {
  try {
    const hermesHome = path.join(os.homedir(), ".hermes");
    const envFile = path.join(hermesHome, ".env");
    if (!fs.existsSync(envFile)) {
      console.error("[claw-key] No .env yet, skipping inject");
      return;
    }
    const envTxt = fs.readFileSync(envFile, "utf-8");
    const m = envTxt.match(/^API_SERVER_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!m || !m[1]) {
      console.error("[claw-key] No API_SERVER_KEY in .env, skipping inject");
      return;
    }
    const key = m[1].trim();
    const idx = path.join(__dirname, "node_modules", "hermes-web-ui", "dist", "index.html");
    if (!fs.existsSync(idx)) {
      console.error("[claw-key] webui index.html not found");
      return;
    }
    let html = fs.readFileSync(idx, "utf-8");
    const marker = "KIMI_CLAW_KEY_INJECTED";
    const script =
      '<script id="' + marker + '">try{localStorage.setItem("hermes_api_key","' + key +
      '");localStorage.setItem("hermes_server_url","")}catch(e){}</script>';
    if (html.includes(marker)) {
      html = html.replace(/<script id="KIMI_CLAW_KEY_INJECTED">[\s\S]*?<\/script>/, script);
    } else {
      html = html.replace("</head>", script + "\n</head>");
    }
    fs.writeFileSync(idx, html);
    console.error("[claw-key] Injected Claw API key into webui index.html");
  } catch (e) {
    console.error("[claw-key] Inject failed: " + e.message);
  }
}

// Boot-time fallback: if hermes-web-ui's own startAll() didn't bring the
// gateway up (listProfiles → [] or CLI quirks), spawn it directly like the
// diag test does. This makes /claw survive fresh container boots.
async function ensureGatewayBoot() {
  const hm = path.join(os.homedir(), ".hermes");
  const healthUrl = "http://127.0.0.1:8642/health";
  // Give web-ui (hermesProc) its own startAll() window first: it boots
  // slower (update check + tirith install), so wait 20s before probing.
  await new Promise((r) => setTimeout(r, 20000));
  let healthy = false;
  try {
    const h = await httpGetHealth(healthUrl, 2500);
    healthy = h.status === 200;
  } catch (e) { healthy = false; }
  if (healthy) {
    console.error("[gateway-boot] Gateway already running (web-ui startAll OK)");
    return;
  }
  console.error("[gateway-boot] Gateway NOT running after web-ui boot — spawning fallback...");
  try {
    const child = spawn(HERMES_BIN, ["gateway", "run", "--replace"], {
      env: { ...process.env, HERMES_HOME: hm },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; if (log.length > 4000) log = log.slice(-4000); });
    child.stderr.on("data", (d) => { log += d; if (log.length > 4000) log = log.slice(-4000); });
    // Probe every 4s up to 60s
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      let ok = false;
      try {
        const h = await httpGetHealth(healthUrl, 2500);
        ok = h.status === 200;
      } catch (e) { ok = false; }
      if (ok) {
        child.unref();
        console.error("[gateway-boot] Fallback gateway healthy after " + ((i + 1) * 4) + "s");
        return;
      }
    }
    console.error("[gateway-boot] Fallback gateway still not healthy — log tail:\n" + log.slice(-1500));
  } catch (e) {
    console.error("[gateway-boot] Spawn failed: " + e.message);
  }
}

async function handleDiag(req, res) {
  const out = { ts: new Date().toISOString(), pid: process.pid };
  const hm = path.join(os.homedir(), ".hermes");
  out.seedRan = !!global.__seedRan;
  out.gmPatched = !!global.__gmPatched;
  out.gmReadyPatched = !!global.__gmReadyPatched;
  try {
    out.configYaml = maskKey(fs.readFileSync(path.join(hm, "config.yaml"), "utf-8"));
  } catch (e) { out.configYaml = "ERR " + e.message; }
  try {
    out.env = maskKey(fs.readFileSync(path.join(hm, ".env"), "utf-8"));
  } catch (e) { out.env = "ERR " + e.message; }
  // Hermes persistence diagnostics: state.db rows + Postgres backup state
  try {
    const dbPath = path.join(hm, "state.db");
    if (!fs.existsSync(dbPath)) {
      out.hermesStateDb = { exists: false };
    } else {
      out.hermesStateDb = { exists: true, sizeKB: (fs.statSync(dbPath).size / 1024).toFixed(0) };
    }
  } catch (e) { out.hermesStateDb = "ERR " + e.message; }
  out.hermesLastSave = global.__hermesLastSave || null;
  out.memory = await execDiag(
    "echo -n 'limit: '; cat /sys/fs/cgroup/memory.max 2>/dev/null; " +
    "echo -n 'current: '; cat /sys/fs/cgroup/memory.current 2>/dev/null; " +
    "echo '--- top RSS (KB) ---'; " +
    "for p in /proc/[0-9]*; do r=$(awk '/VmRSS/{print $2}' $p/status 2>/dev/null); " +
    "c=$(awk '/Name/{print $2}' $p/status 2>/dev/null); " +
    "[ -n \"$r\" ] && echo \"$r $c\"; done | sort -rn | head -8",
    8000
  );
  if (pgPool) {
    try {
      const client = await pgPool.connect();
      try {
        const r = await client.query(
          "SELECT row_id, length(data) AS bytes, updated_at FROM hermes_state"
        );
        out.hermesPg = r.rows.map(row => ({
          row_id: row.row_id,
          KB: row.bytes ? (row.bytes / 1024).toFixed(0) : 0,
          updated_at: row.updated_at,
        }));
      } finally { client.release(); }
    } catch (e) { out.hermesPg = "ERR " + e.message; }
  } else {
    out.hermesPg = "no pgPool";
  }
  const gmFile = path.join(__dirname, "node_modules/hermes-web-ui/dist/server/services/hermes/gateway-manager.js");
  try {
    const gm = fs.readFileSync(gmFile, "utf-8");
    out.gmHasFix = gm.includes("KIMI_KEY_FIX");
  } catch (e) { out.gmHasFix = "ERR " + e.message; }
  out.aiohttp = await execDiag("/opt/hermes/bin/python -c \"import aiohttp; print('aiohttp', aiohttp.__version__)\"", 15000);
  out.hermesVersion = await execDiag("/opt/hermes/bin/hermes --version", 15000);
  out.profileListRaw = await execDiag("/opt/hermes/bin/hermes profile list 2>&1", 20000);
  out.gmProfilesPatched = !!global.__gmProfilesPatched;

  // Direct gateway start test: spawn with same env as web-ui, probe /health
  // at 6/10/13s, dump processes+ports+hermes dir, then leave running if OK.
  const testOut = { log: "", probes: [], leftRunning: false };
  try {
    const child = spawn(HERMES_BIN, ["gateway", "run", "--replace"], {
      env: { ...process.env, HERMES_HOME: hm },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
    child.stderr.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
    for (const sec of [6, 10, 13]) {
      await new Promise((r) => setTimeout(r, sec === 6 ? 6000 : 4000));
      testOut.probes.push({ at: sec, health: await httpGetHealth("http://127.0.0.1:8642/health", 2500) });
    }
    testOut.ps = await execDiag("ps aux | grep -i hermes | grep -v grep | head -10", 8000);
    testOut.ports = await execDiag("(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E '8642|8648|LISTEN' | head -15", 8000);
    testOut.hermesDir = await execDiag("ls -la " + hm + " 2>&1 | head -25", 8000);
    const logs = await execDiag("for f in " + hm + "/logs/* " + hm + "/errors.log " + hm + "/gateway.log; do [ -f \"$f\" ] && echo \"== $f ==\" && tail -15 \"$f\"; done 2>/dev/null", 8000);
    testOut.logFiles = logs.slice(0, 2500);
    testOut.log = log.slice(0, 8000);
    const lastProbe = testOut.probes[testOut.probes.length - 1].health;
    if (lastProbe && lastProbe.status === 200) {
      child.unref();
      testOut.leftRunning = true;
      console.error("[diag] Gateway test OK — left gateway running");
    } else {
      child.kill("SIGKILL");
      testOut.leftRunning = false;
    }
  } catch (e) {
    testOut.log = "TEST ERR " + e.message;
  }
  out.gatewayTest = testOut;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out, null, 2));
}

function startProxy() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/_diag") {
      handleDiag(req, res);
      return;
    }
    // Kimi Claw lazy chunks (Vite base "/") request root /assets/*, but the
    // webui only serves them under /claw/. Try the webui first; on 404 fall
    // through to the normal proxy (kimi web keeps its own /assets/*).
    if (req.url.startsWith("/assets/") || req.url === "/favicon.ico") {
      try {
        if (await tryWebuiAsset(req, res)) return;
      } catch (e) {
        console.error("[proxy] webui asset fallback error: " + e.message);
      }
    }
    const target = routeTarget(req.url);
    if (target === HERMES_PORT) {
      // Page loads to the claw webui: inject auto-login key so the login
      // screen never shows (browser page loads carry Accept: text/html;
      // api/asset/ws requests don't). Non-page responses pass through.
      const acceptsHtml = /text\/html/.test(String(req.headers.accept || ""));
      if (req.method === "GET" && acceptsHtml && !req.url.startsWith("/claw/api/")) {
        try {
          if (await serveClawPage(req, res, stripClawPrefix(req.url))) return;
        } catch (e) {
          console.error("[proxy] claw page inject error: " + e.message);
        }
      }
      req.url = stripClawPrefix(req.url);
    }
    proxy.web(req, res, { target: "http://127.0.0.1:" + target });
  });

  // WebSocket upgrade: kimi chat WS + Kimi Claw terminal WS
  server.on("upgrade", (req, socket, head) => {
    const target = routeTarget(req.url);
    if (target === HERMES_PORT) {
      req.url = stripClawPrefix(req.url);
    }
    proxy.ws(req, socket, head, { target: "http://127.0.0.1:" + target });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.error("[proxy] Listening on 0.0.0.0:" + PORT +
      " (/claw* → :" + HERMES_PORT + " Kimi Claw, * → :" + KIMI_PORT + " kimi web)");
  });
  return server;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.error("=== Kimi Code Server v4.0 (Kimi Code + Kimi Claw, one service) ===");
  console.error("[main] PORT=" + PORT + " KIMI_HOME=" + KIMI_HOME);

  // Init PostgreSQL
  await initPostgres();

  // Restore Hermes (Claw) state from PostgreSQL BEFORE the gateway starts —
  // the gateway is spawned later in this function, so restoring here is safe
  // and makes Claw sessions/memories survive deploys and cold starts.
  await restoreHermesFromPostgres();

  // Restore sessions (PostgreSQL primary, Pentaract fallback)
  await restoreSessions();

  // Self-heal registry files from session folders BEFORE kimi web starts and
  // before the first PG save — otherwise the UI shows an empty session list
  // even though the session folders were restored.
  ensureRegistryFiles();

  // IMMEDIATELY save sessions to PG after restore — creates sessions_backup
  // row so future restores find it right away.
  saveSessionsToPostgres().catch(e =>
    console.error("[main] First-save error: " + e.message)
  );
  saveHermesToPostgres().catch(e =>
    console.error("[main] First hermes-save error: " + e.message)
  );

  // Find kimi binary
  const kimiPaths = [
    path.join(__dirname, "node_modules/.bin/kimi"),
    path.join(__dirname, "node_modules/@moonshot-ai/kimi-code/dist/main.mjs"),
  ];
  const kimiBin = kimiPaths.find((p) => {
    try { return fs.existsSync(p); } catch (e) { return false; }
  }) || "npx";

  // Run kimi web on the INTERNAL port (the proxy on PORT fronts it)
  const args = kimiBin === "npx"
    ? ["--yes", "@moonshot-ai/kimi-code", "web", "--no-open",
       "--port", String(KIMI_PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"]
    : ["web", "--no-open",
       "--port", String(KIMI_PORT), "--host", "0.0.0.0", "--dangerous-bypass-auth"];

  console.error("[main] Starting Kimi web on 0.0.0.0:" + KIMI_PORT);
  console.error("[main] Cmd: " + kimiBin + " " + args.join(" "));

  const kimiProc = spawn(kimiBin, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PORT: String(KIMI_PORT),
      NODE_OPTIONS: "--max-old-space-size=160",
    },
    shell: kimiBin === "npx",
  });

  // ── Seed Hermes gateway config (API server needs API_SERVER_KEY + aiohttp) ──
  try {
    fs.mkdirSync(HERMES_HOME, { recursive: true });
    // Stable key: reuse the PostgreSQL-persisted key so the Claw UI's stored
    // localStorage key stays valid across restarts (fixes "disconnected").
    const apiKey = await getStableApiKey();
    const configYaml = [
      "model:",
      "  default: nvidia/nemotron-3-super-120b-a12b",
      "  provider: nvidia",
      "custom_providers:",
      "  - name: zenmux",
      "    base_url: https://zenmux.ai/api/v1",
      "    key_env: ZENMUX_API_KEY",
      "    model: deepseek/deepseek-v4-flash-free",
      "  - name: bluesminds",
      "    base_url: https://api.bluesminds.com/v1",
      "    key_env: BLUESMINDS_API_KEY",
      "    model: deepseek-ai/deepseek-v4-flash",
      "  - name: aiand",
      "    base_url: https://api.aiand.com/v1",
      "    key_env: AIAND_API_KEY",
      "    model: deepseek-ai/deepseek-v4-flash",
      "platforms:",
      "  api_server:",
      "    enabled: true",
      "    extra:",
      "      host: 127.0.0.1",
      "      port: 8642",
      "      key: " + apiKey,
      "",
    ].join("\n");
    // Always write both with the same key so they can never mismatch
    fs.writeFileSync(path.join(HERMES_HOME, "config.yaml"), configYaml);
    fs.writeFileSync(path.join(HERMES_HOME, ".env"), "API_SERVER_KEY=" + apiKey + "\n");
    global.__seedRan = true;
    console.error("[main] Seeded Hermes gateway config in " + HERMES_HOME);

    // Patch hermes-web-ui writeProfilePort: it hard-codes key:'' and wipes our
    // API_SERVER_KEY on every start, which makes the gateway refuse to launch.
    const gmFile = path.join(__dirname, "node_modules/hermes-web-ui/dist/server/services/hermes/gateway-manager.js");
    if (fs.existsSync(gmFile)) {
      let gm = fs.readFileSync(gmFile, "utf-8");
      if (gm.includes("cfg.platforms.api_server.key = '';") && !gm.includes("KIMI_KEY_FIX")) {
        const fix = String.raw`
cfg.platforms.api_server.key = (() => {
          let k = '';
          try {
            const envP = path_1.join(this.profileDir(name), '.env');
            if ((0, fs_1.existsSync)(envP)) {
              const m = (0, fs_1.readFileSync)(envP, 'utf-8').match(/^API_SERVER_KEY\s*=\s*"?([^"\n]+)"?/m);
              if (m) k = m[1].trim();
            }
            if (!k) {
              k = require('crypto').randomBytes(32).toString('hex');
              (0, fs_1.appendFileSync)(envP, 'API_SERVER_KEY=' + k + '\n');
            }
          } catch (_) {}
          return k;
        })();
/*KIMI_KEY_FIX*/`;
        gm = gm.replace("cfg.platforms.api_server.key = '';", fix);
        fs.writeFileSync(gmFile, gm);
        global.__gmPatched = true;
        console.error("[main] Patched hermes-web-ui writeProfilePort (key wipe fix)");
      }
      // Widen waitForReady timeout: gateway takes ~7-10s to boot (update check,
      // tirith install); 15s was flaky and caused random "stopped" states.
      if (gm.includes("Date.now() + 15000") && !gm.includes("KIMI_READY_FIX")) {
        gm = gm.replace(
          "const deadline = Date.now() + 15000;",
          "const deadline = Date.now() + 60000; /*KIMI_READY_FIX*/"
        );
        fs.writeFileSync(gmFile, gm);
        global.__gmReadyPatched = true;
        console.error("[main] Patched hermes-web-ui waitForReady timeout (15s -> 60s)");
      }
      // listProfiles: if `hermes profile list` exits 0 but the CLI output doesn't
      // match our row regex (or lists nothing), return ['default'] so startAll()
      // still spawns the default gateway at boot. Empty list = nothing starts.
      if (gm.includes("return profiles;\n        }\n        catch {") && !gm.includes("KIMI_PROFILES_FIX")) {
        gm = gm.replace(
          "            return profiles;\n        }\n        catch {",
          "            return profiles.length ? profiles : ['default']; /*KIMI_PROFILES_FIX*/" +
            "\n        }\n        catch {"
        );
        fs.writeFileSync(gmFile, gm);
        global.__gmProfilesPatched = true;
        console.error("[main] Patched hermes-web-ui listProfiles (empty -> ['default'])");
      }
    }
  } catch (e) {
    console.error("[main] Hermes config seed failed: " + e.message);
  }

  // Inject current API key into webui index.html (Claw auto-login, no login screen)
  injectClawKey();

  // Start Kimi Claw (hermes-web-ui) on HERMES_PORT — non-fatal if missing
  let hermesProc = null;
  const hermesEntry = path.join(__dirname, "node_modules/hermes-web-ui/dist/server/index.js");
  if (fs.existsSync(hermesEntry)) {
    console.error("[main] Starting Kimi Claw (hermes-web-ui) on 0.0.0.0:" + HERMES_PORT);
    hermesProc = spawn(process.execPath, [hermesEntry], {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        PORT: String(HERMES_PORT),
        UPSTREAM: HERMES_UPSTREAM,
        AUTH_DISABLED: "1",
        HERMES_BIN: HERMES_BIN,
        NODE_OPTIONS: "--max-old-space-size=64",
      },
    });
    hermesProc.on("exit", (code, sig) => {
      console.error("[main] Kimi Claw exited (code=" + code + ", signal=" + sig + ")");
    });
  } else {
    console.error("[main] hermes-web-ui not installed — Kimi Claw disabled (kimi web still works)");
  }

  // HTTP proxy on PORT
  const proxyServer = startProxy();

  // Fallback: ensure gateway is up (web-ui startAll may return [] profiles)
  ensureGatewayBoot().catch(e => console.error("[gateway-boot] Error: " + e.message));

  // Start real-time session watcher (saves to PG within ~2s of any change)
  // Wait a few seconds after kimi starts so the session files/index exist
  setTimeout(() => startSessionWatcher(), 5000);

  // Periodic backup every 5 min as safety net
  const backupInterval = setInterval(() => {
    console.error("[backup] Periodic backup...");
    backupSessions().catch(e => console.error("[backup] Backup error: " + e.message));
    saveHermesToPostgres().catch(e => console.error("[backup] Hermes backup error: " + e.message));
  }, 5 * 60 * 1000);

  // Hermes state changes continuously while Claw is used (sessions, memories,
  // kanban). Save it every 60s too, so a crash loses at most a minute of state
  // instead of the last 5-min cycle or a wiped filesystem.
  const hermesInterval = setInterval(() => {
    saveHermesToPostgres().catch(e => console.error("[hermes-backup] Error: " + e.message));
  }, 60 * 1000);

  // Keep the free instance awake: Render spins it down after ~15 min without
  // inbound traffic, which drops the Claw SSE stream (UI shows "disconnected"
  // until a page reload). Ping our own public URL — the request goes out
  // through the network and back in through Render's router, counting as real
  // inbound traffic — every 10 min so the idle timer never trips.
  const keepaliveInterval = setInterval(() => {
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (!selfUrl) return;
    fetch(selfUrl + "/claw/")
      .then(r => console.error("[keepalive] ping " + r.status))
      .catch(e => console.error("[keepalive] error: " + e.message));
  }, 10 * 60 * 1000);

  // Memory watchdog: Render free tier caps RAM at 512MiB. When the kernel OOM
  // killer fires (SIGKILL) the whole instance is recycled with a FRESH
  // filesystem — that was the root cause of Claw sessions disappearing and
  // "disconnected" errors. Instead of dying to OOM, back everything up to
  // Postgres and exit(0) so Render restarts us cleanly and the backup is
  // restored on boot. Reads the real cgroup limit when available.
  const watchdogInterval = setInterval(async () => {
    try {
      let current = null;
      let limit = 512 * 1024 * 1024; // fallback: Render free = 512MiB
      try {
        const cgCurrent = fs.readFileSync("/sys/fs/cgroup/memory.current", "utf-8").trim();
        if (cgCurrent) current = parseInt(cgCurrent, 10);
        const cgMax = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf-8").trim();
        if (cgMax && cgMax !== "max") limit = parseInt(cgMax, 10);
      } catch (e) {
        // Not in a cgroup (local dev) — nothing to watch
        return;
      }
      if (current === null) return;
      const threshold = Math.floor(limit * 0.88);
      if (current > threshold) {
        console.error("[watchdog] memory at " + Math.round(current / 1024 / 1024) + "MB / "
          + Math.round(limit / 1024 / 1024) + "MB (limit 88%) — backing up and restarting gracefully");
        clearInterval(watchdogInterval);
        clearInterval(backupInterval);
        clearInterval(hermesInterval);
        clearInterval(keepaliveInterval);
        try { await backupSessions(); } catch (e) { console.error("[watchdog] backup error: " + e.message); }
        try { await saveHermesToPostgres(); } catch (e) { console.error("[watchdog] hermes backup error: " + e.message); }
        console.error("[watchdog] backup complete, exiting for clean restart");
        process.exit(0);
      }
    } catch (e) {
      console.error("[watchdog] error: " + e.message);
    }
  }, 30 * 1000);

  // Backup on exit
  const shutdown = async (signal) => {
    console.error("[shutdown] " + signal + " received, backing up sessions...");
    clearInterval(backupInterval);
    clearInterval(hermesInterval);
    clearInterval(keepaliveInterval);
    clearInterval(watchdogInterval);
    if (backupTimeout) clearTimeout(backupTimeout);
    await backupSessions();
    await saveHermesToPostgres();
    console.error("[shutdown] Backup done, forwarding " + signal + " to children...");
    if (kimiProc) kimiProc.kill(signal);
    if (hermesProc) hermesProc.kill(signal);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  kimiProc.on("exit", (code, sig) => {
    console.error("[main] Kimi exited (code=" + code + ", signal=" + sig + "), "
      + "saving sessions one last time...");
    // Save sessions immediately on exit
    backupSessions().then(() => {
      return saveHermesToPostgres();
    }).then(() => {
      console.error("[main] Final backup done, exiting.");
      process.exit(code || 0);
    }).catch(() => {
      process.exit(code || 0);
    });
  });

  proxyServer.on("close", () => {
    console.error("[proxy] Proxy closed");
  });
}

main().catch((e) => {
  console.error("[main] Fatal error: " + e.message);
  process.exit(1);
});

