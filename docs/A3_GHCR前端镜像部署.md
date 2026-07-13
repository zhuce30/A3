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
2. 私有 GHCR 包存在与目标完整提交 SHA 一致的标签，且镜像 OCI revision 标签可验证。
3. GitHub 账号 `zhuce30` 可读取私有仓库和对应 GHCR 包。

正常生产部署必须输入成功 Actions 运行对应的完整 40 位 `DEPLOY_SHA`。`ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}` 只用于查找镜像；事务会核对 `org.opencontainers.image.revision`，解析匹配的 `RepoDigest`，并把 `ghcr.io/zhuce30/a3-frontend@sha256:...` 写入 `A3_FRONTEND_IMAGE`。digest 才是部署和回滚的不可变身份。生产切换不使用 `latest`；Compose 中的默认 `latest` 仅用于首次引导，不属于本手册允许的生产切换路径。

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

检查最多执行 12 次，每次失败后等待 5 秒；所有公开 HTTP 请求都限制 3 秒连接时间和 10 秒总时间。失败会停止子 shell，不会退出当前交互 shell。临时文件只保存公开响应头，并由 trap 清理。

```bash
(
  set -euo pipefail
  COMPOSE_ARGS=(--env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)

  verify_public_runtime() (
    set -uo pipefail
    local attempt root_headers root_status task_status expected_services running_services
    root_headers="$(mktemp)" || exit 1
    trap 'rm -f "$root_headers"' EXIT

    for attempt in {1..12}; do
      : >"$root_headers"
      root_status=''
      task_status=''
      expected_services="$(printf '%s\n' backend caddy celery celery-beat frontend mysql redis | sort)"

      if root_status="$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -D "$root_headers" -w '%{http_code}' https://a3.zhuce.work/)" &&
         test "$root_status" = '308' &&
         tr -d '\r' <"$root_headers" | grep -Eiq '^location:[[:space:]]*/a3$' &&
         curl -fsS --connect-timeout 3 --max-time 10 https://api.zhuce.work/api/auth/csrf/ |
           python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True' &&
         task_status="$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)" &&
         test "$task_status" = '401' &&
         running_services="$(
           sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" ps --status running --services |
             sort
         )" &&
         test "$running_services" = "$expected_services"; then
        printf 'verification passed: HTTP assertions and exact seven running services\n'
        exit 0
      fi

      if [ "$attempt" -lt 12 ]; then
        sleep 5
      fi
    done

    printf 'verification failed after 12 attempts\n' >&2
    exit 1
  )

  verify_public_runtime
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

部署源码清洁检查只覆盖 `OpenMAIC`、两个 Compose 文件、`Caddyfile` 和 `.github`。因此 `.env.production` 及其他已知控制面运行时文件不会误阻塞部署，但任何相关源码、编排或代理配置改动都会立即终止事务。

`switch_frontend_image` 的固定顺序是：用完整 SHA 拉取标签、核对 OCI revision、解析唯一匹配的 `RepoDigest`、验证环境文件、创建 `root:root 0600` 快照、把 digest 同目录原子写入、只重建 frontend、重启 Caddy、执行有界 HTTP 和七服务断言，验证通过后才删除快照并标记成功。

`EXIT/HUP/INT/TERM` 共用恢复处理器。处理器先禁用全部 trap，再分别记录配置恢复、旧 frontend 重建、Caddy 重启和七服务检查状态。四步都成功时才删除快照，并保留原失败或信号状态退出；任一步失败都会打印独立的 `ROLLBACK FAILED`，保留快照路径并用恢复失败状态退出。数据库和队列服务不会被停止或重建。

```bash
(
  set -euo pipefail
  cd /opt/A3

  ENV_FILE='/opt/A3/.env.production'
  INTEGRATION_BRANCH='codex/a3-latest-integration'
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)
  SNAPSHOT=''
  TRANSACTION_SUCCESS=0

  verify_running_services() {
    local expected_services running_services
    expected_services="$(printf '%s\n' backend caddy celery celery-beat frontend mysql redis | sort)"
    running_services="$(
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" ps --status running --services |
        sort
    )" || return 1
    test "$running_services" = "$expected_services"
  }

  verify_runtime() (
    set -uo pipefail
    local attempt root_headers root_status task_status
    root_headers="$(mktemp)" || exit 1
    trap 'rm -f "$root_headers"' EXIT

    for attempt in {1..12}; do
      : >"$root_headers"
      root_status=''
      task_status=''

      if root_status="$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -D "$root_headers" -w '%{http_code}' https://a3.zhuce.work/)" &&
         test "$root_status" = '308' &&
         tr -d '\r' <"$root_headers" | grep -Eiq '^location:[[:space:]]*/a3$' &&
         curl -fsS --connect-timeout 3 --max-time 10 https://api.zhuce.work/api/auth/csrf/ |
           python3 -c 'import json, sys; assert json.load(sys.stdin).get("success") is True' &&
         task_status="$(curl -sS --connect-timeout 3 --max-time 10 -o /dev/null -w '%{http_code}' https://a3.zhuce.work/api/a3/tasks)" &&
         test "$task_status" = '401' &&
         verify_running_services; then
        exit 0
      fi

      if [ "$attempt" -lt 12 ]; then
        sleep 5
      fi
    done

    printf 'public readiness failed after 12 attempts\n' >&2
    exit 1
  )

  recover_transaction() {
    local rc=$?
    local trigger=$1
    trap - EXIT HUP INT TERM
    set +e

    local restore_status=0
    local frontend_status=0
    local caddy_status=0
    local running_status=0

    case "$trigger" in
      HUP) rc=129 ;;
      INT) rc=130 ;;
      TERM) rc=143 ;;
    esac

    if [ "$TRANSACTION_SUCCESS" -eq 1 ]; then
      exit "$rc"
    fi

    if [ -z "$SNAPSHOT" ] || ! sudo test -f "$SNAPSHOT"; then
      printf 'ROLLBACK FAILED: snapshot unavailable; manual recovery required\n' >&2
      exit 125
    fi

    sudo install -o root -g root -m 0600 "$SNAPSHOT" "$ENV_FILE" || restore_status=$?
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps --force-recreate frontend || frontend_status=$?
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy || caddy_status=$?
    verify_running_services || running_status=$?

    if [ "$restore_status" -eq 0 ] &&
       [ "$frontend_status" -eq 0 ] &&
       [ "$caddy_status" -eq 0 ] &&
       [ "$running_status" -eq 0 ] &&
       sudo rm -f "$SNAPSHOT"; then
      SNAPSHOT=''
      printf 'rollback succeeded; preserving original exit status %s\n' "$rc" >&2
      exit "$rc"
    fi

    printf 'ROLLBACK FAILED: restore=%s frontend=%s caddy=%s running=%s; snapshot retained at %s\n' \
      "$restore_status" "$frontend_status" "$caddy_status" "$running_status" "$SNAPSHOT" >&2
    exit 125
  }

  assert_relevant_paths_clean() {
    local dirty_paths
    dirty_paths="$(
      sudo -H -u admin git -C /opt/A3 status --porcelain --untracked-files=all -- OpenMAIC docker-compose.yml docker-compose.prod.yml Caddyfile .github
    )"
    if [ -n "$dirty_paths" ]; then
      printf 'deployment paths are not clean:\n%s\n' "$dirty_paths" >&2
      return 1
    fi
  }

  prepare_deploy_source() {
    local current_branch
    current_branch="$(sudo -H -u admin git -C /opt/A3 symbolic-ref --short HEAD)"
    test "$current_branch" = "$INTEGRATION_BRANCH"
    assert_relevant_paths_clean
    sudo -H -u admin git -C /opt/A3 fetch --prune origin "$INTEGRATION_BRANCH"
    sudo -H -u admin git -C /opt/A3 pull --ff-only origin "$INTEGRATION_BRANCH"
    test "$(sudo -H -u admin git -C /opt/A3 rev-parse HEAD)" = "$DEPLOY_SHA"
    assert_relevant_paths_clean
  }

  resolve_verified_digest() {
    local tag_ref=$1
    local expected_revision=$2
    local image_revision
    local digest_matches=()

    image_revision="$(
      sudo -H env -u DOCKER_CONFIG docker image inspect \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$tag_ref"
    )"
    test "$image_revision" = "$expected_revision"

    mapfile -t digest_matches < <(
      sudo -H env -u DOCKER_CONFIG docker image inspect \
        --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag_ref" |
        grep -E '^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$' |
        sort -u
    )
    test "${#digest_matches[@]}" -eq 1
    printf '%s\n' "${digest_matches[0]}"
  }

  switch_frontend_image() {
    local tag_ref=$1
    local expected_revision=$2
    local digest_ref

    [[ "$tag_ref" =~ ^ghcr\.io/zhuce30/a3-frontend:[0-9a-f]{40}$ ]]
    [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]]
    sudo test -f "$ENV_FILE"
    test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'

    sudo -H env -u DOCKER_CONFIG docker pull "$tag_ref"
    digest_ref="$(resolve_verified_digest "$tag_ref" "$expected_revision")"
    [[ "$digest_ref" =~ ^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$ ]]

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

    trap 'recover_transaction EXIT' EXIT
    trap 'recover_transaction HUP' HUP
    trap 'recover_transaction INT' INT
    trap 'recover_transaction TERM' TERM

    sudo bash -s -- "$ENV_FILE" "$digest_ref" <<'ROOT_UPSERT'
set -euo pipefail
env_file=$1
digest_ref=$2
tmp="$(mktemp "${env_file}.new.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk -v digest_ref="$digest_ref" '
  /^A3_FRONTEND_IMAGE=/ {
    if (!seen) {
      print "A3_FRONTEND_IMAGE=" digest_ref
      seen = 1
    }
    next
  }
  { print }
  END {
    if (!seen) {
      print "A3_FRONTEND_IMAGE=" digest_ref
    }
  }
' "$env_file" >"$tmp"
chown root:root "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$env_file"
trap - EXIT
ROOT_UPSERT

    test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'
    sudo grep -Fxq "A3_FRONTEND_IMAGE=$digest_ref" "$ENV_FILE"
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps --force-recreate frontend
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy
    verify_runtime

    sudo rm -f "$SNAPSHOT"
    SNAPSHOT=''
    TRANSACTION_SUCCESS=1
    trap - EXIT HUP INT TERM
  }

  read -rp "操作模式（deploy/rollback）: " OPERATION
  case "$OPERATION" in
    deploy)
      read -rp "DEPLOY_SHA（本次成功 Actions 的完整提交 SHA）: " DEPLOY_SHA
      if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'DEPLOY_SHA 必须是 40 位小写十六进制提交 SHA\n' >&2
        exit 1
      fi
      prepare_deploy_source
      TARGET_SHA="$DEPLOY_SHA"
      IMAGE_TAG="ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}"
      ;;
    rollback)
      read -rp "ROLLBACK_SHA（此前成功 Actions 的完整提交 SHA）: " ROLLBACK_SHA
      if [[ ! "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'ROLLBACK_SHA 必须是 40 位小写十六进制提交 SHA\n' >&2
        exit 1
      fi
      TARGET_SHA="$ROLLBACK_SHA"
      IMAGE_TAG="ghcr.io/zhuce30/a3-frontend:${ROLLBACK_SHA}"
      ;;
    *)
      printf '操作模式只能是 deploy 或 rollback\n' >&2
      exit 1
      ;;
  esac
  unset OPERATION

  switch_frontend_image "$IMAGE_TAG" "$TARGET_SHA"
  unset DEPLOY_SHA ROLLBACK_SHA TARGET_SHA IMAGE_TAG
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
- 目标完整 SHA 标签在配置快照和变更之前预拉取并验证 revision/digest；任一验证失败时当前 frontend 服务和配置保持不变。
- 配置变更后出现命令失败、正常异常退出或 `HUP/INT/TERM` 信号时，恢复处理器会从快照恢复旧 digest，并只重建旧 frontend、重启 Caddy。
- 自动恢复未完整成功时，不要删除输出的快照；终端会显示 `ROLLBACK FAILED` 和保留路径，供人工检查和恢复。
- 前端启动、恢复或代理异常时保留终端错误输出，并查看日志：

```bash
sudo -H env -u DOCKER_CONFIG docker compose --env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml logs --tail=200 frontend caddy
```
