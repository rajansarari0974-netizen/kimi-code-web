#!/bin/bash
# pid-guard: exit if another start-loop.sh instance is alive
if [ -f /tmp/start-loop.pid ]; then
  OLDPID=$(cat /tmp/start-loop.pid 2>/dev/null || echo 0)
  if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    echo "$(date "+%Y-%m-%d %H:%M:%S") another start-loop alive ($OLDPID), exiting" >> /tmp/start-loop.log
    exit 0
  fi
fi
echo $$ > /tmp/start-loop.pid
cd /workspaces/kimi-code-web || exit 1
export KIMI_CODE_PASSWORD=VNE1wpc7gqGD1THY-Np6WRPYdU5LlOrk3ICvxsy_N58
if [ ! -f /workspaces/kimi-code-web/cloudflared ]; then
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /workspaces/kimi-code-web/cloudflared && chmod +x /workspaces/kimi-code-web/cloudflared
fi
while true; do
  if ! pgrep -x kimi-code > /dev/null; then
    echo "$(date "+%Y-%m-%d %H:%M:%S") restarting kimi" >> /tmp/start-loop.log
    nohup ./node_modules/.bin/kimi web --no-open --port 10002 --host 0.0.0.0 --allowed-host .trycloudflare.com --allowed-host .app.github.dev --dangerous-bypass-auth >> /tmp/kimi-10002.log 2>&1 &
  fi
  if ! pgrep -f "cloudflared [t]unnel" > /dev/null; then
    echo "$(date "+%Y-%m-%d %H:%M:%S") restarting tunnel" >> /tmp/start-loop.log
    (setsid nohup /workspaces/kimi-code-web/cloudflared tunnel --url http://localhost:10002 > /tmp/cf.log 2>&1 < /dev/null &)
  fi
  sleep 25
done
