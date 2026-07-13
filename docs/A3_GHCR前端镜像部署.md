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
2. 私有 GHCR 包存在与目标完整提交 SHA 一致的不可变标签。
3. GitHub 账号 `zhuce30` 可读取私有仓库和对应 GHCR 包。

正常生产部署必须使用成功 Actions 运行对应的完整 40 位 `DEPLOY_SHA`，镜像固定为 `ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}`。禁止把可变 `latest` 作为日常部署目标；`latest` 仅保留为显式、非推荐的便利选项，并且也必须经过同一恢复事务。

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

## 自动化验证

以下检查真实断言：

- 根路径状态为 `308` 且 `Location` 为 `/a3`。
- CSRF JSON 的 `success` 为 `true`。
- 未登录任务接口为 `401`，不能是 `500`。
- 运行中的 Compose 服务恰好为 `backend`、`caddy`、`celery`、`celery-beat`、`frontend`、`mysql`、`redis`。

失败会停止子 shell，不会退出当前交互 shell。临时文件只保存公开响应头，并由 trap 清理。

```bash
(
  set -euo pipefail
  ROOT_HEADERS="$(mktemp)"
  trap 'rm -f "$ROOT_HEADERS"' EXIT
  COMPOSE_ARGS=(--env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)

  ROOT_STATUS="$(curl -sS -o /dev/null -D "$ROOT_HEADERS" -w '%{http_code}' https://a3.zhuce.work/)"
  test "$ROOT_STATUS" = '308'
  tr -d '\r' <"$ROOT_HEADERS" | grep -Eiq '^location:[[:space:]]*/a3$'

  curl -fsS https://api.zhuce.work/api/auth/csrf/ |
    python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True'

  TASK_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)"
  test "$TASK_STATUS" = '401'

  EXPECTED_SERVICES="$(printf '%s\n' backend caddy celery celery-beat frontend mysql redis | sort)"
  RUNNING_SERVICES="$(
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" ps --status running --services |
      sort
  )"
  test "$RUNNING_SERVICES" = "$EXPECTED_SERVICES"

  printf 'verification passed: HTTP assertions and exact seven running services\n'
)
```

再验证已登录请求：

1. 在浏览器打开 `https://a3.zhuce.work/a3/login`，通过 A3 页面正常登录。
2. 打开开发者工具的 Network 面板并刷新 A3 页面。
3. 筛选 `/api/a3/tasks`，确认该请求状态码为 `200`。
4. 不要复制、导出或粘贴密码、CSRF token、session cookie；不要用 shell 重放已登录请求。

## 统一镜像切换事务

下面唯一的事务同时处理：

- `deploy`：正常部署，必须输入成功 Actions 对应的 `DEPLOY_SHA`，并先以 `admin` 身份 fast-forward 拉取集成分支。
- `rollback`：回滚，必须输入此前成功 Actions 对应的 `ROLLBACK_SHA`。
- `latest`：显式、非推荐的便利操作；不能替代正常的不可变 SHA 部署。

`switch_frontend_image` 的固定顺序是：验证镜像引用和环境文件、预拉取目标镜像、创建 `root:root 0600` 快照、同目录原子更新、只重建 frontend、重启 Caddy、断言 HTTP 和七个服务，验证通过后才删除快照并标记成功。

`EXIT/HUP/INT/TERM` 共用恢复处理器。事务未标记成功且快照仍存在时，处理器先禁用全部 trap，恢复旧配置，只强制重建旧 frontend 并重启 Caddy，最后保留原失败或信号状态退出。数据库和队列服务不会被停止或重建。

```bash
(
  set -euo pipefail
  cd /opt/A3

  ENV_FILE='/opt/A3/.env.production'
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)
  SNAPSHOT=''
  TRANSACTION_SUCCESS=0

  verify_runtime() (
    set -uo pipefail
    local root_headers root_status task_status expected_services running_services
    root_headers="$(mktemp)" || exit 1
    trap 'rm -f "$root_headers"' EXIT

    root_status="$(curl -sS -o /dev/null -D "$root_headers" -w '%{http_code}' https://a3.zhuce.work/)" || exit 1
    test "$root_status" = '308' || exit 1
    tr -d '\r' <"$root_headers" | grep -Eiq '^location:[[:space:]]*/a3$' || exit 1

    curl -fsS https://api.zhuce.work/api/auth/csrf/ |
      python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True' || exit 1

    task_status="$(curl -sS -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)" || exit 1
    test "$task_status" = '401' || exit 1

    expected_services="$(printf '%s\n' backend caddy celery celery-beat frontend mysql redis | sort)"
    running_services="$(
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" ps --status running --services |
        sort
    )" || exit 1
    test "$running_services" = "$expected_services" || exit 1
  )

  recover_transaction() {
    local rc=$?
    local trigger=$1
    trap - EXIT HUP INT TERM
    set +e

    case "$trigger" in
      HUP) rc=129 ;;
      INT) rc=130 ;;
      TERM) rc=143 ;;
    esac

    if [ "$TRANSACTION_SUCCESS" -ne 1 ] &&
       [ -n "$SNAPSHOT" ] &&
       sudo test -f "$SNAPSHOT"; then
      sudo mv -f "$SNAPSHOT" "$ENV_FILE"
      sudo chown root:root "$ENV_FILE"
      sudo chmod 0600 "$ENV_FILE"
      SNAPSHOT=''
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps --force-recreate frontend
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy
    fi

    exit "$rc"
  }

  switch_frontend_image() {
    local image_ref=$1

    [[ "$image_ref" =~ ^ghcr\.io/zhuce30/a3-frontend:([0-9a-f]{40}|latest)$ ]]
    sudo test -f "$ENV_FILE"
    test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'

    sudo -H env -u DOCKER_CONFIG docker pull "$image_ref"

    trap 'recover_transaction EXIT' EXIT
    trap 'recover_transaction HUP' HUP
    trap 'recover_transaction INT' INT
    trap 'recover_transaction TERM' TERM

    SNAPSHOT="$(
      sudo bash -s -- "$ENV_FILE" <<'ROOT_SNAPSHOT'
set -euo pipefail
env_file=$1
snapshot="$(mktemp "${env_file}.snapshot.XXXXXX")"
trap 'rm -f "$snapshot"' EXIT
install -o root -g root -m 0600 "$env_file" "$snapshot"
test "$(stat -c '%U:%G %a' "$snapshot")" = 'root:root 600'
printf '%s\n' "$snapshot"
trap - EXIT
ROOT_SNAPSHOT
    )"

    sudo bash -s -- "$ENV_FILE" "$image_ref" <<'ROOT_UPSERT'
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
    verify_runtime

    sudo rm -f "$SNAPSHOT"
    SNAPSHOT=''
    TRANSACTION_SUCCESS=1
    trap - EXIT HUP INT TERM
  }

  read -rp "操作模式（deploy/rollback/latest）: " OPERATION
  case "$OPERATION" in
    deploy)
      read -rp "DEPLOY_SHA（本次成功 Actions 的完整提交 SHA）: " DEPLOY_SHA
      if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'DEPLOY_SHA 必须是 40 位小写十六进制提交 SHA\n' >&2
        exit 1
      fi
      sudo -H -u admin git -C /opt/A3 pull --ff-only origin codex/a3-latest-integration
      IMAGE_REF="ghcr.io/zhuce30/a3-frontend:$DEPLOY_SHA"
      unset DEPLOY_SHA
      ;;
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
      read -rp "非推荐操作；输入 latest 确认使用可变标签: " LATEST_CONFIRM
      test "$LATEST_CONFIRM" = 'latest'
      IMAGE_REF='ghcr.io/zhuce30/a3-frontend:latest'
      unset LATEST_CONFIRM
      ;;
    *)
      printf '操作模式只能是 deploy、rollback 或 latest\n' >&2
      exit 1
      ;;
  esac
  unset OPERATION

  switch_frontend_image "$IMAGE_REF"
  unset IMAGE_REF
)
```

## 运行时密钥变更

`/opt/A3/.env.production` 是服务器持久化运行时配置，不由镜像携带，也不应被 `git pull` 覆盖。只修改前端运行时密钥时，目标重建 frontend 让新值生效，仍然禁止构建镜像：

```bash
(
  set -euo pipefail
  cd /opt/A3
  sudo test -f .env.production
  test "$(sudo stat -c '%U:%G %a' .env.production)" = 'root:root 600'
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps --force-recreate frontend
)
```

不要为前端镜像或密钥变更执行数据库迁移，也不要停止、重建 MySQL、Redis、backend、Celery worker 或 Celery beat。

## 失败处理

- Actions 失败不会产生可部署的 SHA 镜像，不要执行生产事务。
- 目标镜像在配置快照和变更之前预拉取；拉取失败时当前 frontend 服务、配置和本地镜像保持不变。
- 配置变更后出现命令失败、正常异常退出或 `HUP/INT/TERM` 信号时，恢复处理器会恢复快照并只重建旧 frontend、重启 Caddy。
- 前端启动、恢复或代理异常时保留终端错误输出，并查看日志：

```bash
sudo -H env -u DOCKER_CONFIG docker compose --env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml logs --tail=200 frontend caddy
```
