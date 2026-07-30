FROM node:20-slim

WORKDIR /app

# Install curl for health checks
RUN apt-get update -qq && apt-get install -y -qq ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Copy package files and install
COPY package*.json ./
RUN npm install --production 2>&1 | tail -5

# Pre-cache kimi binary (makes startup faster)
RUN npx --yes @moonshot-ai/kimi-code --version 2>/dev/null || true

# Copy app source
COPY . .

# Allow all Render hosts
ENV KIMI_CODE_ALLOWED_HOSTS=.onrender.com,localhost,127.0.0.1

EXPOSE 10000

# Docker HEALTHCHECK — kimi web serves its own UI on /
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -sf http://localhost:${PORT:-10000}/ || exit 1

# Run kimi web directly — no proxy
CMD ["node", "server.js"]

