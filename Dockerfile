# ============================================================
# image-browser relay — 多阶段构建
# 构建: docker build -t image-browser-relay .
# 运行: docker compose up -d
# ============================================================

# ---- 阶段 1: 构建 ----
FROM node:22-alpine AS builder

WORKDIR /build

# 复制 workspace 配置和所有包
COPY package.json package-lock.json ./
COPY packages/relay/package.json packages/relay/tsconfig.json packages/relay/
COPY packages/viewer/package.json packages/viewer/vite.config.ts packages/viewer/
COPY packages/relay/src/ packages/relay/src/
COPY packages/viewer/src/ packages/viewer/src/

# 安装全部依赖（含 devDependencies）
RUN npm ci

# 构建 viewer 静态文件
RUN npm -w packages/viewer run build

# 编译 relay TypeScript
RUN npm -w packages/relay run build

# 删除 devDependencies（仅保留生产依赖）
RUN npm prune --omit=dev

# ---- 阶段 2: 运行 ----
FROM node:22-alpine

WORKDIR /app

# relay 运行时
COPY --from=builder /build/packages/relay/dist/ ./dist/

# 依赖（workspace 提升到根 node_modules）
COPY --from=builder /build/node_modules/ ./node_modules/

# viewer 静态文件
COPY --from=builder /build/packages/viewer/dist/ ./viewer/

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-4190}/health || exit 1

EXPOSE 4190

ENV PORT=4190
ENV VIEWER_PATH=/app/viewer

CMD ["node", "dist/index.js"]
