# A3 Frontend GHCR Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the A3 frontend as a private GHCR image from GitHub Actions and deploy it to the production VPS without running builds on the VPS.

**Architecture:** A branch-scoped GitHub Actions workflow builds `OpenMAIC/Dockerfile` for `linux/amd64` and publishes immutable SHA plus `latest` tags to GHCR. The production Compose override selects that image through `A3_FRONTEND_IMAGE`, while runtime secrets remain in the server-only `.env.production`; a concise runbook covers login, pull, deploy, verification, and rollback.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Docker Compose, Vitest, Next.js 16

---

## File Map

- Create `.github/workflows/build-frontend-image.yml`: build and publish the private frontend image.
- Modify `docker-compose.prod.yml`: select the prebuilt GHCR image in production.
- Modify `.env.production.template`: document the image reference without adding credentials.
- Create `OpenMAIC/tests/a3-ghcr-deployment.test.ts`: enforce workflow, image, secret-boundary, and no-server-build contracts.
- Create `docs/A3_GHCR前端镜像部署.md`: operator commands for authentication, deployment, verification, and rollback.

### Task 1: Add a failing GHCR deployment contract

**Files:**
- Create: `OpenMAIC/tests/a3-ghcr-deployment.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd(), '..');
const workflowPath = path.join(root, '.github/workflows/build-frontend-image.yml');
const composePath = path.join(root, 'docker-compose.prod.yml');
const envTemplatePath = path.join(root, '.env.production.template');

describe('A3 private GHCR frontend deployment', () => {
  it('builds and publishes amd64 latest and immutable frontend tags', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('docker/login-action@v3');
    expect(workflow).toContain('docker/build-push-action@v6');
    expect(workflow).toContain('platforms: linux/amd64');
    expect(workflow).toContain('ghcr.io/zhuce30/a3-frontend:latest');
    expect(workflow).toContain('ghcr.io/zhuce30/a3-frontend:${{ github.sha }}');
    expect(workflow).toContain('NEXT_PUBLIC_A3_API_BASE_URL=https://api.zhuce.work');
    expect(workflow).not.toMatch(/EMAIL_HOST_PASSWORD|A3_LLM_API_KEY|DJANGO_SECRET_KEY|MYSQL_PASSWORD/);
  });

  it('uses the published image through the production environment', () => {
    const compose = fs.readFileSync(composePath, 'utf8');
    const envTemplate = fs.readFileSync(envTemplatePath, 'utf8');
    expect(compose).toContain('image: ${A3_FRONTEND_IMAGE:-ghcr.io/zhuce30/a3-frontend:latest}');
    expect(envTemplate).toContain('A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:latest');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-deployment.test.ts
```

Expected: FAIL because `.github/workflows/build-frontend-image.yml` does not exist and the production Compose file has no `A3_FRONTEND_IMAGE`.

- [ ] **Step 3: Commit the red test**

```bash
git add OpenMAIC/tests/a3-ghcr-deployment.test.ts
git commit -m "test: define GHCR frontend deployment contract"
```

### Task 2: Publish the frontend image from GitHub Actions

**Files:**
- Create: `.github/workflows/build-frontend-image.yml`

- [ ] **Step 1: Add the workflow**

```yaml
name: Build frontend image

on:
  workflow_dispatch:
  push:
    branches:
      - codex/a3-latest-integration
    paths:
      - OpenMAIC/**
      - .github/workflows/build-frontend-image.yml

permissions:
  contents: read
  packages: write

concurrency:
  group: a3-frontend-image-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push frontend
        uses: docker/build-push-action@v6
        with:
          context: OpenMAIC
          file: OpenMAIC/Dockerfile
          platforms: linux/amd64
          push: true
          tags: |
            ghcr.io/zhuce30/a3-frontend:latest
            ghcr.io/zhuce30/a3-frontend:${{ github.sha }}
          build-args: |
            NEXT_PUBLIC_A3_API_BASE_URL=https://api.zhuce.work
          cache-from: type=gha
          cache-to: type=gha,mode=max
          labels: |
            org.opencontainers.image.source=https://github.com/zhuce30/A3
            org.opencontainers.image.revision=${{ github.sha }}
```

- [ ] **Step 2: Run the contract test and confirm only Compose assertions remain red**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-deployment.test.ts
```

Expected: the workflow test passes; the production image selection test still fails.

- [ ] **Step 3: Commit the workflow**

```bash
git add .github/workflows/build-frontend-image.yml
git commit -m "ci: publish A3 frontend image to GHCR"
```

### Task 3: Select the prebuilt image in production

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `.env.production.template`

- [ ] **Step 1: Add the production image selector**

Add this directly under the `frontend:` service key, before `restart`:

```yaml
    image: ${A3_FRONTEND_IMAGE:-ghcr.io/zhuce30/a3-frontend:latest}
```

Keep the existing `build.args` block for local and emergency builds. Production commands must continue to use `--no-build`.

- [ ] **Step 2: Document the default image in the environment template**

Add under the public domain variables:

```dotenv
# Prebuilt frontend image. Use an immutable SHA tag for rollback.
A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:latest
```

- [ ] **Step 3: Run the deployment contract and verify GREEN**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-deployment.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 4: Commit the Compose integration**

```bash
git add docker-compose.prod.yml .env.production.template
git commit -m "deploy: use prebuilt GHCR frontend image"
```

### Task 4: Add the production operator runbook

**Files:**
- Create: `docs/A3_GHCR前端镜像部署.md`

- [ ] **Step 1: Document one-time GHCR authentication**

The runbook must instruct the operator to create a classic PAT with `read:packages`, then run this without placing the token directly in shell history:

```bash
read -rsp "GitHub PAT: " GHCR_TOKEN
echo
printf '%s' "$GHCR_TOKEN" | sudo docker login ghcr.io -u zhuce30 --password-stdin
unset GHCR_TOKEN
```

- [ ] **Step 2: Document pull-only deployment**

```bash
cd /opt/A3
sudo -u admin git pull origin codex/a3-latest-integration
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml restart caddy
```

The runbook must state explicitly that production must not execute `docker compose build`, `docker compose up --build`, or `pnpm build`.

- [ ] **Step 3: Document verification and rollback**

Verification commands:

```bash
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml ps
curl -I https://a3.zhuce.work
curl -sS https://api.zhuce.work/api/auth/csrf/
curl -i https://a3.zhuce.work/api/a3/tasks
```

Rollback commands use `ROLLBACK_SHA`, selected from a previously successful GitHub Actions run:

```bash
test -n "$ROLLBACK_SHA"
sed -i "s|^A3_FRONTEND_IMAGE=.*|A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:${ROLLBACK_SHA}|" .env.production
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml pull frontend
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --no-build --no-deps frontend
```

- [ ] **Step 4: Commit the runbook**

```bash
git add docs/A3_GHCR前端镜像部署.md
git commit -m "docs: add pull-only frontend deployment runbook"
```

### Task 5: Verify and publish the deployment change

**Files:**
- Verify only; no new files expected.

- [ ] **Step 1: Run focused and baseline frontend checks**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-deployment.test.ts tests/a3-unified-tasks-api.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: tests and TypeScript pass; lint has zero errors and only the repository's documented historical warnings.

- [ ] **Step 2: Check secret boundaries and staged scope**

```bash
git diff --check
git status --short --branch
git grep -n "EMAIL_HOST_PASSWORD=.*[^=]" -- .github docker-compose.prod.yml docs || true
git grep -n "A3_LLM_API_KEY=.*[^=]" -- .github docker-compose.prod.yml docs || true
```

Expected: no secret values appear in tracked deployment files; runtime Celery files remain unstaged.

- [ ] **Step 3: Push the deployment branch**

```bash
git push origin codex/a3-latest-integration
```

- [ ] **Step 4: Verify the GitHub Actions run**

```bash
gh run list --workflow build-frontend-image.yml --branch codex/a3-latest-integration --limit 1
gh run watch --exit-status
```

Expected: the newest workflow run completes successfully and publishes both frontend tags.

- [ ] **Step 5: Hand off the one-time server PAT login and pull-only deployment**

The operator follows `docs/A3_GHCR前端镜像部署.md`, confirms all seven services are `Up`, then verifies that unauthenticated `/api/a3/tasks` returns `401` rather than `500`.
