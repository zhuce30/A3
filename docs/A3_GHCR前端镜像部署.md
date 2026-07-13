# A3 GHCR 前端镜像部署手册

## 原则与前提

前端镜像由 GitHub Actions 在 `codex/a3-latest-integration` 分支构建并发布到私有包 `ghcr.io/zhuce30/a3-frontend`。生产 VPS 只拉取镜像和重建 `frontend` 容器，避免 2 vCPU / 4 GiB 主机再次因前端构建耗尽资源。

生产环境禁止执行：

```bash
docker compose build
docker compose up --build
pnpm build
```

部署前确认：

1. `Build frontend image` Actions 在 `codex/a3-latest-integration` 的目标提交上成功。
2. 私有 GHCR 包及 `latest`、完整提交 SHA 标签已经存在。
3. GitHub 账号 `zhuce30` 可读取私有仓库和对应 GHCR 包。

## 目录与密钥所有权

- `/opt/A3` 的 Git 元数据、受版本控制文件及其父目录必须对 `admin` 可写，生产拉取固定以 `admin` 身份执行。
- `/opt/A3/.env.production` 不进入 Git，必须保持 `root:root`、权限 `0600`。
- 不要通过递归放宽权限解决部署问题；先修复具体 Git 路径的所有权，再恢复环境文件的严格权限。

部署前执行只读检查：

```bash
(
  set -euo pipefail
  sudo -H -u admin test -w /opt/A3
  sudo -H -u admin test -w /opt/A3/.git
  sudo test -f /opt/A3/.env.production
  test "$(sudo stat -c '%U:%G %a' /opt/A3/.env.production)" = 'root:root 600'
)
```

## 一次性登录 GHCR

为 `zhuce30` 创建 classic PAT，仅授予 `read:packages`。令牌只在终端静默输入，经标准输入交给 Docker；不写入 Git、文档、命令参数、环境文件或 shell 历史。

```bash
(
  set -euo pipefail
  trap 'unset GHCR_TOKEN' EXIT
  read -rsp "GitHub PAT: " GHCR_TOKEN
  printf '\n'
  printf '%s' "$GHCR_TOKEN" |
    sudo -H env -u DOCKER_CONFIG docker login ghcr.io -u zhuce30 --password-stdin
  unset GHCR_TOKEN

  sudo test -f /root/.docker/config.json
  test "$(sudo stat -c '%U:%G %a' /root/.docker/config.json)" = 'root:root 600'
)
```

检查仅验证文件元数据，不打印 `/root/.docker/config.json` 内容。令牌撤销或失效后，重复以上安全登录流程。

## 标准 latest 部署

该流程适用于 `.env.production` 已指向 `ghcr.io/zhuce30/a3-frontend:latest` 的日常发布。若当前固定在回滚 SHA，先执行后文“安全切换镜像”并选择 `latest`。

```bash
(
  set -euo pipefail
  cd /opt/A3
  test "$(sudo stat -c '%U:%G %a' .env.production)" = 'root:root 600'
  sudo grep -qx 'A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:latest' .env.production

  sudo -H -u admin git -C /opt/A3 pull --ff-only origin codex/a3-latest-integration
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart caddy
)
```

`pull frontend` 在容器重建之前完成；拉取失败时子 shell 立即停止，当前 frontend 服务和本地镜像保持不变。该流程只替换 `frontend` 并重启 Caddy，MySQL、Redis、backend、Celery worker 和 Celery beat 保持运行。

`/opt/A3/.env.production` 是服务器持久化运行时配置，不由镜像携带，也不应被 `git pull` 覆盖。修改前端运行时密钥后，使用目标重建让新值生效，仍然禁止构建镜像：

```bash
(
  set -euo pipefail
  cd /opt/A3
  test "$(sudo stat -c '%U:%G %a' .env.production)" = 'root:root 600'
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps --force-recreate frontend
)
```

不要为前端密钥变更重建数据库或队列服务。

## 自动化验证

以下检查会真实断言：根路径状态为 `308`、`Location` 为 `/a3`、CSRF JSON 的 `success` 为 `true`，且未登录任务接口为 `401` 而不是 `500`。失败会停止子 shell，不会退出当前交互 shell。

```bash
(
  set -euo pipefail
  ROOT_HEADERS="$(mktemp)"
  trap 'rm -f "$ROOT_HEADERS"' EXIT

  ROOT_STATUS="$(curl -sS -o /dev/null -D "$ROOT_HEADERS" -w '%{http_code}' https://a3.zhuce.work/)"
  test "$ROOT_STATUS" = '308'
  tr -d '\r' <"$ROOT_HEADERS" | grep -Eiq '^location:[[:space:]]*/a3$'

  curl -fsS https://api.zhuce.work/api/auth/csrf/ |
    python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True'

  TASK_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)"
  test "$TASK_STATUS" = '401'

  printf 'public verification passed: root=308, location=/a3, csrf=true, unauthenticated_tasks=401\n'
)
```

再验证已登录请求：

1. 在浏览器打开 `https://a3.zhuce.work/a3/login`，通过 A3 页面正常登录。
2. 打开开发者工具的 Network 面板并刷新 A3 页面。
3. 筛选 `/api/a3/tasks`，确认该请求状态码为 `200`。
4. 不要复制、导出或粘贴密码、CSRF token、session cookie；不要用 shell 重放已登录请求。

最后确认 7 个服务 `mysql`、`redis`、`backend`、`celery`、`celery-beat`、`frontend`、`caddy` 均为 `Up`：

```bash
sudo -H env -u DOCKER_CONFIG docker compose --env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml ps
```

## 安全切换镜像

同一流程同时用于回滚和恢复 `latest`。选择 `rollback` 时，`ROLLBACK_SHA` 必须来自此前成功的 `Build frontend image` Actions 运行，并使用完整 40 位提交 SHA；选择 `latest` 前也必须确认最新 Actions 成功。

流程顺序固定为：验证环境文件、先拉取目标镜像、创建 root-only 快照、同目录原子更新、目标重建、验证公共 HTTP、删除快照。更新或验证失败时，ERR trap 会恢复旧环境文件并只重建 `frontend`、重启 Caddy。

```bash
(
  set -euo pipefail
  cd /opt/A3

  ENV_FILE='/opt/A3/.env.production'
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)
  SNAPSHOT=''

  verify_public_http() (
    set -uo pipefail
    local root_headers root_status task_status
    root_headers="$(mktemp)" || exit 1
    trap 'rm -f "$root_headers"' EXIT

    root_status="$(curl -sS -o /dev/null -D "$root_headers" -w '%{http_code}' https://a3.zhuce.work/)" || exit 1
    test "$root_status" = '308' || exit 1
    tr -d '\r' <"$root_headers" | grep -Eiq '^location:[[:space:]]*/a3$' || exit 1
    curl -fsS https://api.zhuce.work/api/auth/csrf/ |
      python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True' || exit 1
    task_status="$(curl -sS -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)" || exit 1
    test "$task_status" = '401' || exit 1
  )

  cleanup_snapshot() {
    if [ -n "$SNAPSHOT" ]; then
      sudo rm -f "$SNAPSHOT"
    fi
  }

  restore_on_error() {
    local rc=$?
    trap - ERR
    set +e
    if [ -n "$SNAPSHOT" ] && sudo test -f "$SNAPSHOT"; then
      sudo mv -f "$SNAPSHOT" "$ENV_FILE"
      sudo chown root:root "$ENV_FILE"
      sudo chmod 0600 "$ENV_FILE"
      SNAPSHOT=''
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps frontend
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy
    fi
    exit "$rc"
  }

  trap cleanup_snapshot EXIT

  sudo test -f "$ENV_FILE"
  test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'

  read -rp "切换模式（rollback/latest）: " SWITCH_MODE
  case "$SWITCH_MODE" in
    rollback)
      read -rp "ROLLBACK_SHA（此前成功 Actions 的完整提交 SHA）: " ROLLBACK_SHA
      if [[ ! "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'ROLLBACK_SHA 必须是 40 位小写十六进制提交 SHA\n' >&2
        exit 1
      fi
      IMAGE_REF="ghcr.io/zhuce30/a3-frontend:$ROLLBACK_SHA"
      unset ROLLBACK_SHA
      ;;
    latest)
      IMAGE_REF='ghcr.io/zhuce30/a3-frontend:latest'
      ;;
    *)
      printf '切换模式只能是 rollback 或 latest\n' >&2
      exit 1
      ;;
  esac
  unset SWITCH_MODE

  sudo -H env -u DOCKER_CONFIG docker pull "$IMAGE_REF"

  SNAPSHOT="$(sudo mktemp --tmpdir=/opt/A3 .env.production.snapshot.XXXXXX)"
  sudo install -o root -g root -m 0600 "$ENV_FILE" "$SNAPSHOT"
  test "$(sudo stat -c '%U:%G %a' "$SNAPSHOT")" = 'root:root 600'
  trap restore_on_error ERR

  sudo bash -s -- "$ENV_FILE" "$IMAGE_REF" <<'ROOT_UPSERT'
set -euo pipefail
env_file=$1
image_ref=$2
tmp="$(mktemp "${env_file}.new.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk -v image_ref="$image_ref" '
  /^A3_FRONTEND_IMAGE=/ {
    if (!seen) {
      print "A3_FRONTEND_IMAGE=" image_ref
      seen = 1
    }
    next
  }
  { print }
  END {
    if (!seen) {
      print "A3_FRONTEND_IMAGE=" image_ref
    }
  }
' "$env_file" >"$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$env_file"
trap - EXIT
ROOT_UPSERT

  test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps frontend
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy
  if ! verify_public_http; then
    false
  fi

  sudo rm -f "$SNAPSHOT"
  SNAPSHOT=''
  trap - ERR
  trap - EXIT
  unset IMAGE_REF
)
```

该流程不执行数据库迁移，不停止或重建 MySQL、Redis、backend、Celery worker、Celery beat。成功后再按“自动化验证”和浏览器步骤完成最终确认。

## 失败处理

- Actions 失败不会发布新的可部署标签，也不会改变 VPS 当前服务。
- 标准部署的 `pull frontend` 失败发生在 `up` 之前，当前 frontend 服务和本地镜像继续运行。
- 安全切换在配置变更前先执行 `docker pull`；拉取失败不会触碰 `.env.production`。变更后的失败由 ERR trap 恢复旧配置和旧 frontend。
- 前端启动、恢复或代理异常时查看日志，并保留终端错误输出用于排查：

```bash
sudo -H env -u DOCKER_CONFIG docker compose --env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml logs --tail=200 frontend caddy
```
