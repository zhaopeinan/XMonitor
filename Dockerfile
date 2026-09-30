# ---- build frontend ----
FROM node:20-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

# ---- runtime（内置 Chromium，提供 Obscura/CDP）----
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 make g++ \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
# 需要 tsx（devDep）与 better-sqlite3 原生编译
RUN npm ci

COPY server server
COPY --from=web-build /app/web/dist web/dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8790
ENV XMONITOR_OBSCURA_ENDPOINT=http://127.0.0.1:9222
EXPOSE 8790

VOLUME ["/app/data"]

ENTRYPOINT ["/entrypoint.sh"]
