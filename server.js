#!/usr/bin/env node
/**
 * Kimi Code Render Server — Minimal reliable version
 * Spawns kimi web on internal port, provides /health, proxies requests.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PORT = parseInt(process.env.PORT) || 10000;
const KIMI_PORT = 58630;
const FIXED_TOKEN = 'VNE1wpc7gqGD1THY-Np6WRPYdU5LlOrk3ICvxsy_N58';

// Ensure KIMI_CODE_PASSWORD is set
process.env.KIMI_CODE_PASSWORD = FIXED_TOKEN;
process.env.KIMI_CODE_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
fs.mkdirSync(process.env.KIMI_CODE_HOME, { recursive: true });

// Allow all known Render hosts for WebSocket
process.env.KIMI_CODE_ALLOWED_HOSTS = '.onrender.com,localhost,127.0.0.1';
process.env.KIMI_CODE_CORS_ORIGINS = '*';

// Find kimi binary
const kimiPaths = [
  path.join(__dirname, 'node_modules/.bin/kimi'),
  path.join(__dirname, 'node_modules/@moonshot-ai/kimi-code/dist/main.mjs'),
];
const kimiBin = kimiPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || 'npx';

const args = kimiBin === 'npx'
  ? ['--yes', '@moonshot-ai/kimi-code', 'web', '--no-open', '--port', String(KIMI_PORT), '--host', '0.0.0.0']
  : ['web', '--no-open', '--port', String(KIMI_PORT), '--host', '0.0.0.0'];

console.error(`Starting Kimi: ${kimiBin} ${args.join(' ')}`);

const kimiProc = spawn(kimiBin, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
  shell: kimiBin === 'npx',
});

kimiProc.stdout.on('data', d => process.stdout.write(`[kimi] ${d}`));
kimiProc.stderr.on('data', d => process.stderr.write(`[kimi] ${d}`));
kimiProc.on('exit', (code, sig) => {
  console.error(`Kimi exited (code=${code}, signal=${sig}) — restarting in 3s`);
  setTimeout(() => process.exit(1), 3000); // Let Render restart us
});

// HTTP server — health check + proxy to Kimi
const server = http.createServer((req, res) => {
  // Health check — respond instantly
  if (req.url === '/health' || req.url === '/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', uptime: process.uptime(), kimi_alive: true }));
    return;
  }

  // Proxy to Kimi daemon
  const opts = {
    hostname: '127.0.0.1',
    port: KIMI_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, connection: 'close' },
  };

  const pr = http.request(opts, prRes => {
    const headers = { ...prRes.headers };
    delete headers['transfer-encoding'];
    res.writeHead(prRes.statusCode, headers);
    prRes.pipe(res);
  });

  pr.on('error', err => {
    console.error(`Proxy error: ${err.message}`);
    // For API, return JSON; for pages, let browser retry
    if (req.url && req.url.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 50001, msg: 'Kimi daemon is starting up', data: null }));
    } else {
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kimi Code</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f0f0f;color:#e0e0e0}div{text-align:center}.loading{width:20px;height:20px;border:3px solid #333;border-radius:50%;border-top-color:#6c5ce7;animation:spin 1s linear infinite;margin:10px auto}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div><div class="loading"></div><h2>Kimi Code</h2><p>Starting...</p><script>setTimeout(()=>location.reload(),5000)</script></div></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
  });

  req.pipe(pr);
});

// WebSocket proxy
server.on('upgrade', (req, socket, head) => {
  const proxySocket = require('net').connect(KIMI_PORT, '127.0.0.1', () => {
    proxySocket.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (const [k, v] of Object.entries(req.headers)) {
      proxySocket.write(`${k}: ${v}\r\n`);
    }
    proxySocket.write(`authorization: Bearer ${FIXED_TOKEN}\r\n\r\n`);
    proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxySocket.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.error(`Server on :${PORT}, Kimi on :${KIMI_PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('SIGTERM, shutting down...');
  kimiProc.kill();
  server.close(() => process.exit(0));
});
