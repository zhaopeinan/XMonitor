#!/bin/bash
set -euo pipefail

CHROME_BIN=""
if [ -x /usr/bin/chromium ]; then
  CHROME_BIN=/usr/bin/chromium
elif [ -x /usr/bin/chromium-browser ]; then
  CHROME_BIN=/usr/bin/chromium-browser
elif [ -x /usr/bin/google-chrome ]; then
  CHROME_BIN=/usr/bin/google-chrome
fi

if [ -n "$CHROME_BIN" ]; then
  echo "[entrypoint] 启动 Chromium CDP: $CHROME_BIN"
  "$CHROME_BIN" \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-software-rasterizer \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    about:blank >/tmp/chromium-cdp.log 2>&1 &
  echo $! >/tmp/chromium-cdp.pid

  ready=0
  for _ in $(seq 1 60); do
    if curl -sf http://127.0.0.1:9222/json/version >/dev/null; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -eq 1 ]; then
    echo "[entrypoint] Chromium CDP 就绪 (127.0.0.1:9222)"
  else
    echo "[entrypoint] 警告: Chromium CDP 未在时限内就绪，浏览器探测可能失败" >&2
    tail -n 40 /tmp/chromium-cdp.log >&2 || true
  fi
  export XMONITOR_OBSCURA_ENDPOINT="${XMONITOR_OBSCURA_ENDPOINT:-http://127.0.0.1:9222}"
else
  echo "[entrypoint] 未找到 Chromium，跳过 CDP 启动" >&2
fi

exec npm start
