#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$REPO_DIR/logs/deploy.log"
LOCK_FILE="$REPO_DIR/logs/deploy.lock"
MAX_CATCHUP_ROUNDS=5

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
}
log_stderr() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_FILE"
  echo "$1" >&2
}

if ! command -v flock >/dev/null 2>&1; then
  log_stderr "缺少 flock 命令，无法加锁"
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "已有部署在进行中，等待其完成后接管"
  flock 9
fi

cleanup() {
  local exit_code=$?
  flock -u 9 2>/dev/null || true
  exec 9>&-
  if [ $exit_code -ne 0 ]; then
    log "部署失败，行号: ${BASH_LINENO[0]}，exit code: $exit_code"
  fi
}
trap cleanup EXIT

log "开始部署..."
cd "$REPO_DIR"
PREV_COMMIT=$(git rev-parse --short HEAD)
log "当前版本: $PREV_COMMIT"

round=0
while [ "$round" -lt "$MAX_CATCHUP_ROUNDS" ]; do
  round=$((round + 1))

  if ! GIT_FETCH_ERR=$(git fetch origin main 2>&1); then
    log_stderr "git fetch 失败: $GIT_FETCH_ERR"
    if echo "$GIT_FETCH_ERR" | grep -qi "read-only\|Read-only"; then
      log_stderr "→ 文件系统只读，检查 webhook systemd 服务的 ReadWritePaths 是否包含项目目录"
    fi
    exit 1
  fi

  REMOTE_HEAD=$(git rev-parse origin/main)
  LOCAL_HEAD=$(git rev-parse HEAD)
  if [ "$REMOTE_HEAD" = "$LOCAL_HEAD" ]; then
    log "远程无新变更，跳过本轮部署"
    exit 0
  fi

  if ! GIT_RESET_ERR=$(git reset --hard origin/main 2>&1); then
    log_stderr "git reset 失败: $GIT_RESET_ERR"
    exit 1
  fi

  NEW_COMMIT=$(git rev-parse --short HEAD)
  log "部署版本: $PREV_COMMIT -> $NEW_COMMIT (第 $round 轮)"

  if git diff "$PREV_COMMIT" HEAD --name-only | grep -qE '(^|/)(package\.json|package-lock\.json)$'; then
    log "依赖有变动，开始安装..."
    if ! NPM_ERR=$(npm ci --registry=https://registry.npmmirror.com 2>&1); then
      log_stderr "npm ci 失败: $NPM_ERR"
      exit 1
    fi
  else
    log "依赖无变动，跳过安装"
  fi

  if ! pm2 reload ecosystem.config.js --update-env 2>&1; then
    log "pm2 reload 失败，尝试 pm2 start..."
    if ! PM2_ERR=$(pm2 start ecosystem.config.js --update-env 2>&1); then
      log_stderr "pm2 start 失败: $PM2_ERR"
      exit 1
    fi
  fi

  PREV_COMMIT=$NEW_COMMIT
done

log_stderr "连续 $MAX_CATCHUP_ROUNDS 轮部署后远程仍在变化，退出；等待中的部署实例会继续接管"
exit 0
