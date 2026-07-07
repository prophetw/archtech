#!/bin/bash

set -euo pipefail

# ============================================================
# image-browser 一键部署脚本
# 用法: ./deploy.sh
# 首次部署前请先修改下方的 REMOTE_HOST 等配置
# ============================================================

# ---- 基础配置（按需修改） ----
REMOTE_USER="root"
REMOTE_HOST="192.168.99.57"
REMOTE_PATH="/root/data"
LOCAL_SOURCE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_APP_DIR="image-browser"
REMOTE_LAST_DIR="image-browser-last"

# 打包时排除的文件/目录（node_modules 和 dist 由 Docker 构建阶段生成）
EXCLUDE_PATTERNS=("node_modules" "dist" ".git" ".env" "*.log")

# ---- 准备工作 ----
TIMESTAMP="$(date +%s)"
ARCHIVE_NAME="image-browser-${TIMESTAMP}.tar.gz"
LOCAL_ARCHIVE="/tmp/${ARCHIVE_NAME}"
REMOTE_ARCHIVE="/tmp/${ARCHIVE_NAME}"

cleanup() {
    rm -f "$LOCAL_ARCHIVE"
}
trap cleanup EXIT

if [ ! -f "$LOCAL_SOURCE/Dockerfile" ]; then
    echo "错误：未在 $LOCAL_SOURCE 找到 Dockerfile，请在项目根目录执行此脚本。" >&2
    exit 1
fi

# ---- 步骤 1: 本地打包 ----
tar_excludes=()
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
    tar_excludes+=("--exclude=$pattern")
done

EXCLUDE_DESC=$(printf ", %s" "${EXCLUDE_PATTERNS[@]}")
EXCLUDE_DESC=${EXCLUDE_DESC:2}

echo "📦 打包项目源码（排除 ${EXCLUDE_DESC}）..."
echo "   源目录: $LOCAL_SOURCE"
echo "   临时包: $LOCAL_ARCHIVE"
tar -czf "$LOCAL_ARCHIVE" "${tar_excludes[@]}" -C "$LOCAL_SOURCE" .

ARCHIVE_SIZE=$(du -h "$LOCAL_ARCHIVE" | cut -f1)
echo "   打包完成，大小: $ARCHIVE_SIZE"

# ---- 步骤 2: 上传到远程服务器 ----
echo ""
echo "📤 上传到服务器: $REMOTE_USER@$REMOTE_HOST:$REMOTE_ARCHIVE"
scp "$LOCAL_ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_ARCHIVE"

# ---- 步骤 3: 远程部署 ----
echo ""
echo "🔧 在远程服务器上执行部署..."
ssh "$REMOTE_USER@$REMOTE_HOST" \
    REMOTE_PATH="$REMOTE_PATH" \
    REMOTE_APP_DIR="$REMOTE_APP_DIR" \
    REMOTE_LAST_DIR="$REMOTE_LAST_DIR" \
    REMOTE_ARCHIVE="$REMOTE_ARCHIVE" \
    'bash -s' << 'REMOTE_EOF'
    set -euo pipefail

    # 确保目标父目录存在
    mkdir -p "$REMOTE_PATH"
    cd "$REMOTE_PATH"

    PROJECT="image-browser-relay"
    EXISTING_CONTAINERS="$(docker ps -aq --filter "name=^${PROJECT}$" || true)"

    # ---- 停止旧容器 ----
    if [ -n "$EXISTING_CONTAINERS" ]; then
        echo "⏸  停止并移除旧容器: $EXISTING_CONTAINERS"
        docker stop $EXISTING_CONTAINERS 2>/dev/null || true
        docker rm -f $EXISTING_CONTAINERS 2>/dev/null || true
    fi

    # ---- 备份旧目录 ----
    echo "🗑  删除旧的备份目录: $REMOTE_LAST_DIR"
    rm -rf "$REMOTE_LAST_DIR"

    if [ -d "$REMOTE_APP_DIR" ]; then
        echo "📋 备份当前应用: $REMOTE_APP_DIR -> $REMOTE_LAST_DIR"
        mv "$REMOTE_APP_DIR" "$REMOTE_LAST_DIR"
    fi

    # ---- 解压新版本 ----
    echo "📂 创建新应用目录: $REMOTE_APP_DIR"
    mkdir -p "$REMOTE_APP_DIR"

    echo "📦 解压部署包..."
    tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_APP_DIR"
    rm -f "$REMOTE_ARCHIVE"

    # ---- 迁移 .env 文件 ----
    OLD_RELAY_ENV="$REMOTE_LAST_DIR/packages/relay/.env"
    NEW_RELAY_ENV="$REMOTE_APP_DIR/packages/relay/.env"

    if [ -f "$OLD_RELAY_ENV" ]; then
        echo "🔑 保留 relay .env: $OLD_RELAY_ENV -> $NEW_RELAY_ENV"
        cp "$OLD_RELAY_ENV" "$NEW_RELAY_ENV"
    elif [ -f "$REMOTE_APP_DIR/packages/relay/.env.example" ]; then
        echo "⚠️  首次部署：请编辑 $REMOTE_APP_DIR/packages/relay/.env 填入真实密钥"
        cp "$REMOTE_APP_DIR/packages/relay/.env.example" "$NEW_RELAY_ENV"
    fi

    OLD_CLI_ENV="$REMOTE_LAST_DIR/packages/cli/.env"
    NEW_CLI_ENV="$REMOTE_APP_DIR/packages/cli/.env"

    if [ -f "$OLD_CLI_ENV" ]; then
        echo "🔑 保留 cli .env: $OLD_CLI_ENV -> $NEW_CLI_ENV"
        cp "$OLD_CLI_ENV" "$NEW_CLI_ENV"
    elif [ -f "$REMOTE_APP_DIR/packages/cli/.env.example" ]; then
        cp "$REMOTE_APP_DIR/packages/cli/.env.example" "$NEW_CLI_ENV"
    fi

    # ---- 构建并启动 ----
    COMPOSE_FILE="$REMOTE_APP_DIR/docker-compose.yml"

    if [ -f "$COMPOSE_FILE" ]; then
        echo ""
        echo "🐳 Docker Compose 构建并启动..."
        (
            cd "$REMOTE_APP_DIR"
            docker compose up -d --build --force-recreate
        )
        echo ""
        echo "✅ 容器状态:"
        docker ps --filter "name=^${PROJECT}$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    else
        echo "❌ 未找到 docker-compose.yml，部署中断。" >&2
        exit 1
    fi

    echo ""
    echo "✅ 部署成功！"
    echo "   健康检查: curl http://127.0.0.1:4190/health"
REMOTE_EOF

echo ""
echo "🎉 部署脚本执行完毕。"
