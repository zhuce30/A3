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

## 一次性登录 GHCR

为 `zhuce30` 创建 classic PAT，仅授予 `read:packages`。令牌只在终端静默输入，不写入 Git、文档或 shell 历史；部署使用 `sudo docker`，登录凭据因此保存在 root 的 Docker 配置中。

```bash
read -rsp "GitHub PAT: " GHCR_TOKEN
printf '\n'
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u zhuce30 --password-stdin
unset GHCR_TOKEN
```

不要把 PAT 直接放在命令参数、环境文件或脚本中。令牌撤销或失效后，重复以上安全登录流程。

## 仅拉取部署

```bash
cd /opt/A3
sudo -u admin git pull origin codex/a3-latest-integration
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

该流程只替换 `frontend` 并重启 Caddy。MySQL、Redis、backend、Celery worker 和 Celery beat 保持运行，不要对数据库或队列服务执行 `down`、重建或重启。

`/opt/A3/.env.production` 是服务器持久化运行时配置，不由镜像携带，也不应被 `git pull` 覆盖。修改运行时密钥后必须重建受影响的容器，才能让新值生效；无需重新构建镜像。例如只更新前端运行时密钥时执行：

```bash
cd /opt/A3
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps --force-recreate frontend
```

## 验证

先确认 7 个服务 `mysql`、`redis`、`backend`、`celery`、`celery-beat`、`frontend`、`caddy` 均为 `Up`：

```bash
cd /opt/A3
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml ps
```

检查根路径返回 `308` 且 `Location` 为 `/a3`，CSRF 接口返回 HTTP 2xx 且 JSON 中 `success` 为 `true`，未登录任务接口必须返回 `401` 而不是 `500`：

```bash
curl -sS -o /dev/null -D - https://a3.zhuce.work/
curl -fsS https://api.zhuce.work/api/auth/csrf/
curl -sS -o /dev/null -w 'unauthenticated tasks: %{http_code}\n' https://a3.zhuce.work/api/a3/tasks
```

最后用有效 A3 账号验证已登录任务接口返回 `200`。下面的 Bash 流程静默读取密码、使用临时 Cookie 文件，并在结束时清理认证材料；主机需有 `python3`：

```bash
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"; unset A3_IDENTIFIER A3_PASSWORD CSRF_TOKEN LOGIN_HTTP SESSION_ID' EXIT

read -rp "A3 登录账号: " A3_IDENTIFIER
read -rsp "A3 登录密码: " A3_PASSWORD
printf '\n'

CSRF_TOKEN="$(
  curl -fsS -c "$COOKIE_JAR" https://api.zhuce.work/api/auth/csrf/ |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["csrfToken"])'
)"
export A3_IDENTIFIER A3_PASSWORD
LOGIN_HTTP="$(
  python3 -c 'import json, os; print(json.dumps({"identifier": os.environ["A3_IDENTIFIER"], "password": os.environ["A3_PASSWORD"]}))' |
    curl -sS -o /dev/null -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
      -H 'Content-Type: application/json' -H "X-CSRFToken: $CSRF_TOKEN" \
      --data-binary @- https://api.zhuce.work/api/auth/login/
)"
unset A3_IDENTIFIER A3_PASSWORD
test "$LOGIN_HTTP" = "200"

SESSION_ID="$(awk '$6 == "sessionid" {print $7}' "$COOKIE_JAR" | tail -n 1)"
test -n "$SESSION_ID"
curl -sS -o /dev/null -w 'authenticated tasks: %{http_code}\n' \
  -H "Cookie: sessionid=$SESSION_ID" https://a3.zhuce.work/api/a3/tasks

rm -f "$COOKIE_JAR"
unset CSRF_TOKEN LOGIN_HTTP SESSION_ID COOKIE_JAR
trap - EXIT
```

预期最后一行是 `authenticated tasks: 200`。

## 回滚到成功镜像

从此前成功的 `Build frontend image` Actions 运行中取得完整 40 位提交 SHA。以下流程会验证 `ROLLBACK_SHA`，并在 `.env.production` 中更新或新增 `A3_FRONTEND_IMAGE`，然后只拉取和重建前端：

```bash
set -euo pipefail
cd /opt/A3
read -rp "ROLLBACK_SHA（此前成功 Actions 的完整提交 SHA）: " ROLLBACK_SHA
case "$ROLLBACK_SHA" in
  ""|*[!0-9a-f]*) printf 'ROLLBACK_SHA 必须是小写十六进制完整提交 SHA\n' >&2; exit 1 ;;
esac
test "${#ROLLBACK_SHA}" -eq 40

IMAGE_REF="ghcr.io/zhuce30/a3-frontend:${ROLLBACK_SHA}"
if sudo grep -q '^A3_FRONTEND_IMAGE=' .env.production; then
  sudo sed -i "s|^A3_FRONTEND_IMAGE=.*$|A3_FRONTEND_IMAGE=${IMAGE_REF}|" .env.production
else
  printf '\nA3_FRONTEND_IMAGE=%s\n' "$IMAGE_REF" | sudo tee -a .env.production >/dev/null
fi
unset IMAGE_REF ROLLBACK_SHA

sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

按“验证”章节重新检查服务和 HTTP 状态。

## 恢复到最新镜像

确认 `codex/a3-latest-integration` 的最新 Actions 已成功后，将镜像变量恢复为 `latest`；此流程同样兼容变量原本不存在的情况：

```bash
set -euo pipefail
cd /opt/A3
IMAGE_REF='ghcr.io/zhuce30/a3-frontend:latest'
if sudo grep -q '^A3_FRONTEND_IMAGE=' .env.production; then
  sudo sed -i "s|^A3_FRONTEND_IMAGE=.*$|A3_FRONTEND_IMAGE=${IMAGE_REF}|" .env.production
else
  printf '\nA3_FRONTEND_IMAGE=%s\n' "$IMAGE_REF" | sudo tee -a .env.production >/dev/null
fi
unset IMAGE_REF

sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

## 失败处理

- Actions 失败不会发布新的可部署标签，也不会改变 VPS 当前服务。
- `pull frontend` 失败发生在容器重建之前，当前 frontend 服务和本地镜像继续运行；排除 GHCR 权限、网络或标签问题后再拉取。
- 前端启动或代理异常时查看日志，再回滚到此前成功的 SHA 镜像：

```bash
cd /opt/A3
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml logs --tail=200 frontend caddy
```
