# 基础镜像可覆盖：Docker Hub 不可达时可指向镜像站，例如
#   docker build --build-arg NODE_IMAGE=docker.1ms.run/library/node:20-bookworm-slim -t xmonitor:0.1.0 .
ARG NODE_IMAGE=node:20-bookworm-slim

# ---- build frontend ----
FROM ${NODE_IMAGE} AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

# ---- runtime（内置 Chromium，提供 Obscura/CDP）----
FROM ${NODE_IMAGE}
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
