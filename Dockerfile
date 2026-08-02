FROM node:20-slim

WORKDIR /app

# curl for health checks; python3 + build tools for the Hermes agent (venv)
RUN apt-get update -qq && apt-get install -y -qq ca-certificates curl python3 python3-venv make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install
COPY package*.json ./
RUN npm install --production 2>&1 | tail -5

# Pre-cache kimi binary (makes startup faster)
RUN npx --yes @moonshot-ai/kimi-code --version 2>/dev/null || true

# Hermes agent (python) in an isolated venv — avoids PEP 668 system pip issues
RUN python3 -m venv /opt/hermes && /opt/hermes/bin/pip install --no-cache-dir -U pip hermes-agent && /opt/hermes/bin/pip install --no-cache-dir aiohttp==3.14.1

# Copy app source
COPY . .

# Apply kimi.com-style UI patch to the kimi web dist
RUN node scripts/patch-ui.js

# Apply Kimi Claw branding to the hermes web ui client
RUN node scripts/claw-branding.js

# Allow all Render hosts
ENV KIMI_CODE_ALLOWED_HOSTS=.onrender.com,localhost,127.0.0.1

EXPOSE 10000

# Docker HEALTHCHECK — unified entrypoint serves kimi UI on /
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3   CMD curl -sf http://localhost:${PORT:-10000}/ || exit 1

# Unified entrypoint (kimi + hermes proxy in one process)
CMD ["node", "--max-old-space-size=96", "server.js"]
