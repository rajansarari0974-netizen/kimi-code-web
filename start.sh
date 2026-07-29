#!/bin/bash
set -e

# Use fixed token for Render
KIMI_CODE_PASSWORD="${KIMI_CODE_PASSWORD:-VNE1wpc7gqGD1THY-Np6WRPYdU5LlOrk3ICvxsy_N58}"
export KIMI_CODE_PASSWORD

echo "============================================"
echo "  Kimi Code Server"
echo "  Port: ${PORT:-10000}"
echo "============================================"

# Update to latest version
npm install @moonshot-ai/kimi-code@latest 2>&1 | tail -3

# Find kimi binary
if [ -f "node_modules/.bin/kimi" ]; then
    KIMI_PATH="node_modules/.bin/kimi"
    echo "  Using: local binary (node_modules/.bin/kimi)"
    exec "$KIMI_PATH" web --no-open --port "${PORT:-10000}" --host "0.0.0.0"
elif [ -f "node_modules/@moonshot-ai/kimi-code/dist/main.mjs" ]; then
    KIMI_PATH="node_modules/@moonshot-ai/kimi-code/dist/main.mjs"
    echo "  Using: main.mjs"
    exec node "$KIMI_PATH" web --no-open --port "${PORT:-10000}" --host "0.0.0.0"
elif command -v npx &>/dev/null; then
    echo "  Using: npx"
    exec npx --yes @moonshot-ai/kimi-code web --no-open --port "${PORT:-10000}" --host "0.0.0.0"
else
    echo "ERROR: No kimi binary found!"
    exit 1
fi
