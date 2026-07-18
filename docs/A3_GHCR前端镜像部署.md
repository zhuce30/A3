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

正常生产部署必须输入成功 Actions 运行对应的完整 40 位 `DEPLOY_SHA`。`ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}` 只用于部署时的一次查找；事务会核对 `org.opencontainers.image.revision`，解析匹配的 `RepoDigest`，并把 `ghcr.io/zhuce30/a3-frontend@sha256:...` 写入 `A3_FRONTEND_IMAGE`。验证成功后，事务把时间、`DEPLOY_SHA` 和 `RepoDigest` 追加到 root 专属部署历史。digest 才是部署和回滚的不可变身份。生产切换不使用 `latest`；Compose 中的默认 `latest` 仅用于首次引导，不属于本手册允许的生产切换路径。

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

## Cloudflare 数字人静态资源缓存

数字教师模型和动作文件都使用带版本参数的 URL，例如：

```text
/a3/assets/teacher-avatar/teacher.optimized.vrm?v=20260718-v1
/a3/assets/teacher-avatar/idle.vrma?v=20260710-arms-down
```

Next.js 仅对 `/a3/assets/teacher-avatar/:path*` 返回：

```text
Cache-Control: public, max-age=31536000, immutable
```

在 Cloudflare Dashboard 的 **Caching -> Cache Rules** 新建规则 `A3 teacher avatar immutable assets`，使用以下自定义表达式：

```text
(http.host eq "a3.zhuce.work" and starts_with(http.request.uri.path, "/a3/assets/teacher-avatar/") and (ends_with(http.request.uri.path, ".vrm") or ends_with(http.request.uri.path, ".vrma") or ends_with(http.request.uri.path, ".webp")))
```

规则设置：

1. `Cache eligibility` 设为 `Eligible for cache`。
2. `Edge TTL` 选择尊重源站 `Cache-Control`；若控制台必须填写固定值，则设为 `1 year`。
3. `Browser TTL` 选择尊重源站；不要缩短 `immutable` 资源的浏览器缓存时间。
4. 缓存键保留默认设置并包含全部 query string。不要启用 `Ignore query string`，版本参数变化必须得到新的缓存对象。
5. 规则范围不得扩大到整个 `/a3/*`，更不能缓存 `/api/*`、登录页或带会话的 HTML 响应。

发布新模型时必须先修改代码中的版本参数，再部署新镜像；不要用同一个版本 URL 覆盖不同内容。上线后验证两次请求，第二次通常应出现 `CF-Cache-Status: HIT`，同时必须保留一年期源站缓存头：

```bash
curl -sSI --connect-timeout 3 --max-time 10 'https://a3.zhuce.work/a3/assets/teacher-avatar/teacher.optimized.vrm?v=20260718-v1' |
  grep -Ei '^(HTTP/|cache-control:|cf-cache-status:|content-length:)'
```

首次请求显示 `MISS` 属正常现象。若内容版本填写错误，使用 Cloudflare 按精确 URL 清除缓存，不要全站 Purge Everything。

## 持久化视频任务首次上线

这一节只在包含持久化视频 Job/Segment 数据表和内部 provider bridge 的前后端镜像都已通过 Actions、已按固定 SHA/digest 拉取并写入 `.env.production` 后执行。不要对只有一半新镜像的运行环境创建视频任务。

backend、Celery worker 和 frontend 必须读取同一个 `A3_VIDEO_WORKER_TOKEN`。该值只用于 Docker 内网中的 provider bridge，不是 Seedance API key，也不能提交到 Git。首次上线时生成 32 字节随机值，并原子写入服务器环境文件：

```bash
(
  set -euo pipefail
  cd /opt/A3
  ENV_FILE='/opt/A3/.env.production'
  VIDEO_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

  sudo env VIDEO_TOKEN="$VIDEO_TOKEN" python3 - "$ENV_FILE" <<'PY'
import os
import pathlib
import sys
import tempfile

env_path = pathlib.Path(sys.argv[1])
token = os.environ["VIDEO_TOKEN"]
lines = env_path.read_text(encoding="utf-8").splitlines()
lines = [line for line in lines if not line.startswith("A3_VIDEO_WORKER_TOKEN=")]
lines.append(f"A3_VIDEO_WORKER_TOKEN={token}")
fd, temporary_name = tempfile.mkstemp(prefix=f"{env_path.name}.", dir=env_path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    os.chmod(temporary_name, 0o600)
    os.replace(temporary_name, env_path)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
  unset VIDEO_TOKEN
  sudo chown root:root "$ENV_FILE"
  sudo chmod 0600 "$ENV_FILE"
)
```

使用已经验证过 digest 的新镜像执行迁移，再重建使用该 token 的服务。恢复命令只扫描超过 5 分钟没有推进的活动任务；已有 provider taskId 的片段只会继续轮询，不会再次向 Seedance 提交并产生重复费用。

```bash
(
  set -euo pipefail
  cd /opt/A3
  COMPOSE_ARGS=(--env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml)

  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    run --rm --no-deps backend python manage.py migrate
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-build --force-recreate backend celery celery-beat frontend
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    exec -T backend python manage.py recover_video_jobs --stale-minutes 5
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    ps backend celery celery-beat frontend
)
```

正常输出应包含 `恢复派发 N 个视频任务`。该命令可以在 Celery/Redis 故障恢复后再次执行；刚刚仍在轮询的任务不会被重复入队。

## 旧视频失败片段迁移上线与验收

旧视频迁移同时依赖 Django 导入接口和前端确认、轮询逻辑，因此本次发布必须把同一完整提交 SHA 构建出的 backend、frontend 镜像作为一组切换。禁止只更新其中一个镜像，也不要使用本文后面的“仅前端镜像切换”事务发布本功能。先在 GitHub Actions 确认两个镜像均成功，再将两个不可变 RepoDigest 和它们共同的完整 `DEPLOY_SHA` 填入下面命令。

本功能复用已有 `VideoGenerationJob` 和 `VideoGenerationSegment` 表，预期不会产生新 migration；上线仍必须执行 `makemigrations --check --dry-run` 和 `migrate --plan`，防止代码与数据库状态意外漂移。预期前一条输出 `No changes detected`，后一条输出 `No planned migration operations`。

```bash
(
  set -euo pipefail
  cd /opt/A3

  DEPLOY_SHA='<40 位完整提交 SHA>'
  BACKEND_IMAGE='ghcr.io/zhuce30/a3-backend@sha256:<64 位 digest>'
  FRONTEND_IMAGE='ghcr.io/zhuce30/a3-frontend@sha256:<64 位 digest>'
  ENV_FILE='/opt/A3/.env.production'
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml)
  SNAPSHOT=''
  RELEASE_OK=0

  verify_revision() {
    local image_ref=$1
    local revision
    revision="$(
      sudo -H env -u DOCKER_CONFIG docker image inspect \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref"
    )"
    test "$revision" = "$DEPLOY_SHA"
  }

  rollback_release() {
    local rc=$?
    trap - EXIT HUP INT TERM
    if [ "$RELEASE_OK" -eq 1 ]; then
      exit "$rc"
    fi
    if [ -n "$SNAPSHOT" ] && sudo test -f "$SNAPSHOT"; then
      sudo install -o root -g root -m 0600 "$SNAPSHOT" "$ENV_FILE"
      sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
        up -d --no-build --force-recreate backend celery celery-beat frontend
      printf 'paired backend/frontend rollback completed\n' >&2
    else
      printf 'ROLLBACK FAILED: environment snapshot unavailable\n' >&2
      exit 125
    fi
    exit "$rc"
  }

  [[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
  [[ "$BACKEND_IMAGE" =~ ^ghcr\.io/zhuce30/a3-backend@sha256:[0-9a-f]{64}$ ]]
  [[ "$FRONTEND_IMAGE" =~ ^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$ ]]
  sudo test -f "$ENV_FILE"
  test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'

  sudo -H env -u DOCKER_CONFIG docker pull "$BACKEND_IMAGE"
  sudo -H env -u DOCKER_CONFIG docker pull "$FRONTEND_IMAGE"
  verify_revision "$BACKEND_IMAGE"
  verify_revision "$FRONTEND_IMAGE"

  SNAPSHOT="$(sudo mktemp /opt/A3/.env.production.legacy-video.XXXXXX)"
  sudo install -o root -g root -m 0600 "$ENV_FILE" "$SNAPSHOT"
  trap rollback_release EXIT HUP INT TERM

  sudo env BACKEND_IMAGE="$BACKEND_IMAGE" FRONTEND_IMAGE="$FRONTEND_IMAGE" \
    python3 - "$ENV_FILE" <<'PY'
import os
import pathlib
import tempfile
import sys

env_path = pathlib.Path(sys.argv[1])
replacements = {
    "A3_BACKEND_IMAGE": os.environ["BACKEND_IMAGE"],
    "A3_FRONTEND_IMAGE": os.environ["FRONTEND_IMAGE"],
}
lines = env_path.read_text(encoding="utf-8").splitlines()
output = []
seen = set()
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in replacements:
        if key not in seen:
            output.append(f"{key}={replacements[key]}")
            seen.add(key)
        continue
    output.append(line)
for key, value in replacements.items():
    if key not in seen:
        output.append(f"{key}={value}")
fd, temporary_name = tempfile.mkstemp(prefix=f"{env_path.name}.", dir=env_path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(output) + "\n")
    os.chmod(temporary_name, 0o600)
    os.replace(temporary_name, env_path)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
PY
  sudo chown root:root "$ENV_FILE"
  sudo chmod 0600 "$ENV_FILE"

  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    run --rm --no-deps backend python manage.py makemigrations --check --dry-run
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    run --rm --no-deps backend python manage.py migrate --plan
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    run --rm --no-deps backend python manage.py migrate
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-build --force-recreate backend celery celery-beat frontend
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    exec -T backend python manage.py recover_video_jobs --stale-minutes 5
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    ps backend celery celery-beat frontend

  RELEASE_OK=1
  trap - EXIT HUP INT TERM
  sudo rm -f "$SNAPSHOT"
)
```

### 迁移前哈希基线

当前生产验收对象是资源包 `80df56875cca4f23be7df8816ed8736c`：片段 1、2 失败，片段 3-6 已成功。执行迁移前只记录成功 URL 的 SHA-256，不得把签名 URL 写入终端、文件、工单或聊天记录。以下脚本读取服务器拥有的 artifact，并将只含片段索引、状态和 URL 哈希的基线保存为 `root:root 0600` 文件：

```bash
(
  set -euo pipefail
  cd /opt/A3
  PACK_ID='80df56875cca4f23be7df8816ed8736c'
  HASH_DIR='/var/lib/a3-deploy'
  HASH_FILE="${HASH_DIR}/legacy-video-${PACK_ID}.sha256.json"
  TMP_FILE="$(mktemp)"
  trap 'rm -f "$TMP_FILE"' EXIT
  COMPOSE_ARGS=(--env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml)

  sudo install -d -o root -g root -m 0700 "$HASH_DIR"
  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    exec -T -e PACK_ID="$PACK_ID" backend python manage.py shell <<'PY' >"$TMP_FILE"
import hashlib
import json
import os

from backend.apps.compat.resource_generation import get_resource_pack
from backend.apps.compat.video_jobs import eligible_legacy_video_artifact
from backend.apps.learning.models import ResourcePackLog

pack_id = os.environ["PACK_ID"]
log = ResourcePackLog.objects.filter(task_id=f"resource-pack:{pack_id}").select_related("user").get()
artifact = eligible_legacy_video_artifact(get_resource_pack(log.user, pack_id) or {})
if artifact is None:
    raise SystemExit("未找到可迁移的旧视频 artifact")
segments = sorted(artifact["segments"], key=lambda item: int(item["index"]))
failed = [int(item["index"]) for item in segments if item.get("status") == "failed"]
succeeded = [item for item in segments if item.get("status") == "succeeded" and item.get("videoUrl")]
if failed != [1, 2] or [int(item["index"]) for item in succeeded] != [3, 4, 5, 6]:
    raise SystemExit("生产旧任务不是预期的 2 失败/4 保留状态")
print(json.dumps({
    "resourcePackId": pack_id,
    "failedIndexes": failed,
    "preserved": [
        {
            "index": int(item["index"]),
            "status": "succeeded",
            "urlSha256": hashlib.sha256(str(item["videoUrl"]).encode("utf-8")).hexdigest(),
        }
        for item in succeeded
    ],
}, ensure_ascii=True, sort_keys=True))
PY
  sudo install -o root -g root -m 0600 "$TMP_FILE" "$HASH_FILE"
  sudo python3 -m json.tool "$HASH_FILE"
)
```

### 页面操作与数据库验收

1. 使用原资源包所属学生账号打开视频详情页。确认迁移提示显示“补生成 2 段，保留 4 段”。
2. 点击迁移按钮后先取消确认，在浏览器 Network 中确认没有发出导入 `PATCH`。
3. 再次操作并确认一次。不要双击，也不要在请求未返回时重复确认。
4. 页面出现任务进度后记录公开 `jobId`；它必须以 `a3_legacy_video_` 开头。
5. 刷新页面。页面必须恢复同一个 `jobId` 并继续轮询，不能创建第二个任务，也不能重新弹出付费提交。
6. 等待片段 1、2 已提交给 provider 后执行下面验收。脚本断言只有一个 legacy job，provider task ID 仅存在于原失败片段 1、2，片段 3-6 仍为 succeeded 且 URL 哈希与迁移前完全一致。脚本只输出布尔值、状态和哈希，不输出 provider task ID 内容或签名 URL。

```bash
(
  set -euo pipefail
  cd /opt/A3
  PACK_ID='80df56875cca4f23be7df8816ed8736c'
  HASH_FILE="/var/lib/a3-deploy/legacy-video-${PACK_ID}.sha256.json"
  COMPOSE_ARGS=(--env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml)
  sudo test -f "$HASH_FILE"
  test "$(sudo stat -c '%U:%G %a' "$HASH_FILE")" = 'root:root 600'
  BASELINE_JSON="$(sudo cat "$HASH_FILE")"

  sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" \
    exec -T -e PACK_ID="$PACK_ID" -e BASELINE_JSON="$BASELINE_JSON" \
    backend python manage.py shell <<'PY'
import hashlib
import json
import os

from backend.apps.compat.models import VideoGenerationJob

pack_id = os.environ["PACK_ID"]
baseline = json.loads(os.environ["BASELINE_JSON"])
jobs = list(
    VideoGenerationJob.objects.filter(
        resource_pack_id=pack_id,
        job_id__startswith="a3_legacy_video_",
    ).prefetch_related("segments")
)
if len(jobs) != 1:
    raise SystemExit(f"legacy job 数量异常：{len(jobs)}")
job = jobs[0]
segments = {segment.index: segment for segment in job.segments.all()}
if sorted(segments) != [1, 2, 3, 4, 5, 6]:
    raise SystemExit("任务片段索引不是 1-6")
if not all(segments[index].provider_task_id for index in (1, 2)):
    raise SystemExit("失败片段尚未全部取得 provider task ID，请稍后重试验收")
if any(segments[index].provider_task_id for index in (3, 4, 5, 6)):
    raise SystemExit("保留片段不应存在 provider task ID")
current_hashes = {
    index: hashlib.sha256(segments[index].video_url.encode("utf-8")).hexdigest()
    for index in (3, 4, 5, 6)
}
expected_hashes = {int(item["index"]): item["urlSha256"] for item in baseline["preserved"]}
if current_hashes != expected_hashes:
    raise SystemExit("保留片段 URL 哈希发生变化")
if any(segments[index].status != "succeeded" for index in (3, 4, 5, 6)):
    raise SystemExit("保留片段状态发生变化")
print(json.dumps({
    "jobId": job.job_id,
    "jobCount": 1,
    "failedSegmentProviderTaskIdsPresent": True,
    "preservedSegmentProviderTaskIdsAbsent": True,
    "preservedStatuses": {str(index): segments[index].status for index in (3, 4, 5, 6)},
    "preservedUrlSha256": {str(index): current_hashes[index] for index in (3, 4, 5, 6)},
}, ensure_ascii=True, sort_keys=True, indent=2))
PY
  unset BASELINE_JSON
)
```

哈希基线通过进程环境临时传入 backend 容器，只包含资源包 ID、失败索引和四个 SHA-256 值；命令结束后立即清除 shell 变量。最终任务完成后，再确认新 `openmaic_video` artifact 含同一个 `jobId` 和 6 个片段状态。

### 恢复与回滚边界

- 页面刷新只恢复同一持久化 job 的轮询，不应触发新的 Seedance 提交。若刷新后 jobId 改变，立即停止页面操作并检查数据库中的 legacy job 数量。
- Celery/Redis 或网络故障恢复后执行 `python manage.py recover_video_jobs --stale-minutes 5`。已有 provider task ID 的片段只继续轮询；该命令不会重新生成已保留的 3-6 段。
- 代码或运行时验收失败时，恢复 `.env.production` 快照并把 backend、celery、celery-beat、frontend 四个服务一起重建到上一组已验证 digest。不要只回滚前端或后端。
- 数据库中已创建的 legacy job 是付费任务审计记录，镜像回滚时不要删除。回滚后先停止新的迁移操作；修复并重新发布后用恢复命令继续处理已有任务。
- 原旧 artifact 在新任务最终写回前保持不变；不要手工覆盖其成功片段 URL，也不要把签名 URL加入部署日志。

## 自动化验证

以下检查真实断言：

- 根路径状态为 `308` 且 `Location` 为 `/a3`。
- CSRF JSON 的 `success` 为 `true`。
- 未登录任务接口为 `401`，不能是 `500`。
- 运行中的 Compose 服务恰好为 `backend`、`caddy`、`celery`、`celery-beat`、`frontend`、`mysql`、`realtime-proxy`、`redis`。

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
      expected_services="$(printf '%s\n' backend caddy celery celery-beat frontend mysql realtime-proxy redis | sort)"

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
        printf 'verification passed: HTTP assertions and exact eight running services\n'
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
- `rollback`：回滚，必须从部署历史选择配对的 `ROLLBACK_SHA` 和 64 位小写十六进制 `ROLLBACK_DIGEST`；只拉取该 digest，不再解析 SHA 标签。

部署源码清洁检查只覆盖 `OpenMAIC`、两个 Compose 文件、`Caddyfile` 和 `.github`。因此 `.env.production` 及其他已知控制面运行时文件不会误阻塞部署，但任何相关源码、编排或代理配置改动都会立即终止事务。

部署路径先用完整 SHA 标签解析一次唯一 `RepoDigest`；回滚路径直接使用历史中的 digest。两条路径都会验证 digest 镜像的 OCI revision，再创建 `root:root 0600` 配置快照、把 digest 同目录原子写入、只重建 frontend 与 realtime-proxy、重启 Caddy 并执行有界 HTTP 和八服务断言。正常部署还必须成功追加部署历史，随后立即标记事务成功并禁用恢复 trap，最后才清理快照。

`EXIT/HUP/INT/TERM` 共用恢复处理器。处理器先禁用全部 trap，再分别记录配置恢复、旧 frontend/realtime-proxy 重建、Caddy 重启和八服务检查状态。四步都成功时才删除快照，并保留原失败或信号状态退出；任一步失败都会打印独立的 `ROLLBACK FAILED`，保留快照路径并用恢复失败状态退出。数据库和队列服务不会被停止或重建。

```bash
(
  set -euo pipefail
  cd /opt/A3

  ENV_FILE='/opt/A3/.env.production'
  HISTORY_FILE='/var/lib/a3-deploy/frontend-image-history.log'
  INTEGRATION_BRANCH='codex/a3-latest-integration'
  COMPOSE_ARGS=(--env-file "$ENV_FILE" -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml)
  SNAPSHOT=''
  TRANSACTION_SUCCESS=0

  verify_running_services() {
    local expected_services running_services
    expected_services="$(printf '%s\n' backend caddy celery celery-beat frontend mysql realtime-proxy redis | sort)"
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
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps --force-recreate frontend realtime-proxy || frontend_status=$?
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

  verify_image_revision() {
    local image_ref=$1
    local expected_revision=$2
    local image_revision

    image_revision="$(
      sudo -H env -u DOCKER_CONFIG docker image inspect \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref"
    )"
    test "$image_revision" = "$expected_revision"
  }

  resolve_deploy_digest() {
    local tag_ref=$1
    local expected_revision=$2
    local digest_matches=()
    local digest_ref

    [[ "$tag_ref" =~ ^ghcr\.io/zhuce30/a3-frontend:[0-9a-f]{40}$ ]]
    [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]]
    sudo -H env -u DOCKER_CONFIG docker pull "$tag_ref" >&2
    verify_image_revision "$tag_ref" "$expected_revision"

    mapfile -t digest_matches < <(
      sudo -H env -u DOCKER_CONFIG docker image inspect \
        --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag_ref" |
        grep -E '^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$' |
        sort -u
    )
    test "${#digest_matches[@]}" -eq 1
    digest_ref="${digest_matches[0]}"
    verify_image_revision "$digest_ref" "$expected_revision"
    printf '%s\n' "$digest_ref"
  }

  pull_verified_digest() {
    local digest_ref=$1
    local expected_revision=$2

    [[ "$digest_ref" =~ ^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$ ]]
    [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]]
    sudo -H env -u DOCKER_CONFIG docker pull "$digest_ref"
    verify_image_revision "$digest_ref" "$expected_revision"
  }

  append_deployment_history() {
    local deploy_sha=$1
    local digest_ref=$2

    sudo bash -s -- "$HISTORY_FILE" "$deploy_sha" "$digest_ref" <<'ROOT_HISTORY'
set -euo pipefail
history_file=$1
deploy_sha=$2
digest_ref=$3
history_dir="${history_file%/*}"
[[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$digest_ref" =~ ^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$ ]]
install -d -o root -g root -m 0700 "$history_dir"
if [ ! -e "$history_file" ]; then
  install -o root -g root -m 0600 /dev/null "$history_file"
fi
test "$(stat -c '%U:%G %a' "$history_file")" = 'root:root 600'
timestamp="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf '%s DEPLOY_SHA=%s RepoDigest=%s\n' "$timestamp" "$deploy_sha" "$digest_ref" >>"$history_file"
ROOT_HISTORY
  }

  switch_frontend_image() {
    local digest_ref=$1
    local expected_revision=$2
    local history_sha=$3

    [[ "$digest_ref" =~ ^ghcr\.io/zhuce30/a3-frontend@sha256:[0-9a-f]{64}$ ]]
    [[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]]
    if [ -n "$history_sha" ]; then
      test "$history_sha" = "$expected_revision"
    fi
    sudo test -f "$ENV_FILE"
    test "$(sudo stat -c '%U:%G %a' "$ENV_FILE")" = 'root:root 600'
    verify_image_revision "$digest_ref" "$expected_revision"

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
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" up -d --no-build --no-deps --force-recreate frontend realtime-proxy
    sudo -H env -u DOCKER_CONFIG docker compose "${COMPOSE_ARGS[@]}" restart caddy
    verify_runtime

    if [ -n "$history_sha" ]; then
      append_deployment_history "$history_sha" "$digest_ref"
    fi

    TRANSACTION_SUCCESS=1
    trap - EXIT HUP INT TERM
    if sudo rm -f "$SNAPSHOT"; then
      SNAPSHOT=''
    else
      printf 'WARNING: deployment succeeded but snapshot cleanup failed; retained at %s\n' "$SNAPSHOT" >&2
    fi
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
      DEPLOY_TAG="ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}"
      TARGET_DIGEST="$(resolve_deploy_digest "$DEPLOY_TAG" "$DEPLOY_SHA")"
      HISTORY_SHA="$DEPLOY_SHA"
      ;;
    rollback)
      read -rp "ROLLBACK_SHA（从部署历史选择完整提交 SHA）: " ROLLBACK_SHA
      if [[ ! "$ROLLBACK_SHA" =~ ^[0-9a-f]{40}$ ]]; then
        printf 'ROLLBACK_SHA 必须是 40 位小写十六进制提交 SHA\n' >&2
        exit 1
      fi
      read -rp "ROLLBACK_DIGEST（同一条历史记录的 64 位 digest）: " ROLLBACK_DIGEST
      if [[ ! "$ROLLBACK_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
        printf 'ROLLBACK_DIGEST 必须是 64 位小写十六进制 digest\n' >&2
        exit 1
      fi
      ROLLBACK_IMAGE="ghcr.io/zhuce30/a3-frontend@sha256:${ROLLBACK_DIGEST}"
      pull_verified_digest "$ROLLBACK_IMAGE" "$ROLLBACK_SHA"
      TARGET_SHA="$ROLLBACK_SHA"
      TARGET_DIGEST="$ROLLBACK_IMAGE"
      HISTORY_SHA=''
      ;;
    *)
      printf '操作模式只能是 deploy 或 rollback\n' >&2
      exit 1
      ;;
  esac
  unset OPERATION

  switch_frontend_image "$TARGET_DIGEST" "$TARGET_SHA" "$HISTORY_SHA"
  unset DEPLOY_SHA DEPLOY_TAG ROLLBACK_SHA ROLLBACK_DIGEST ROLLBACK_IMAGE TARGET_SHA TARGET_DIGEST HISTORY_SHA
)
```

## 查看部署历史

部署历史文件只记录 UTC 时间、完整 `DEPLOY_SHA` 和已验证 `RepoDigest`，不记录环境变量、令牌或其他密钥。文件固定为 `root:root 0600`，父目录固定为 `root:root 0700`。选择回滚参数时必须从同一行取出 SHA 和 digest；不要自行重新解析 SHA 标签。

```bash
(
  set -euo pipefail
  HISTORY_FILE='/var/lib/a3-deploy/frontend-image-history.log'
  sudo test -f "$HISTORY_FILE"
  test "$(sudo stat -c '%U:%G %a' "$HISTORY_FILE")" = 'root:root 600'
  sudo tail -n 20 "$HISTORY_FILE"
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
  sudo -H env -u DOCKER_CONFIG docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps --force-recreate frontend realtime-proxy
)
```

不要为前端镜像或密钥变更执行数据库迁移，也不要停止、重建 MySQL、Redis、backend、Celery worker 或 Celery beat。

## 失败处理

- Actions 失败不会产生可部署的 SHA 镜像，不要执行生产事务。
- 正常部署在配置快照和变更之前用完整 SHA 标签解析并验证 digest；回滚直接拉取历史中的 digest 并验证 revision。任一验证失败时当前 frontend 服务和配置保持不变。
- 配置变更后出现命令失败、正常异常退出或 `HUP/INT/TERM` 信号时，恢复处理器会从快照恢复旧 digest，并只重建旧 frontend/realtime-proxy、重启 Caddy。
- 自动恢复未完整成功时，不要删除输出的快照；终端会显示 `ROLLBACK FAILED` 和保留路径，供人工检查和恢复。
- 前端启动、恢复或代理异常时保留终端错误输出，并查看日志：

```bash
sudo -H env -u DOCKER_CONFIG docker compose --env-file /opt/A3/.env.production -f /opt/A3/docker-compose.yml -f /opt/A3/docker-compose.prod.yml logs --tail=200 frontend realtime-proxy caddy
```
