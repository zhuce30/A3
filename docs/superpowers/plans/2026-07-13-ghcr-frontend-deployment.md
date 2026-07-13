# A3 Frontend GHCR Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the A3 frontend as a private GHCR image from GitHub Actions and deploy it to the production VPS without running builds on the VPS.

**Architecture:** A branch-scoped GitHub Actions workflow builds `OpenMAIC/Dockerfile` for `linux/amd64` and publishes full-SHA plus `latest` lookup tags to GHCR. Normal deploy accepts a full `DEPLOY_SHA`, fast-forward updates the clean integration branch to that exact `HEAD`, resolves the lookup tag once, verifies `org.opencontainers.image.revision`, persists the immutable `repo@sha256` identity through `A3_FRONTEND_IMAGE`, and writes a root-only deployment history record. Rollback consumes paired `ROLLBACK_SHA` and `ROLLBACK_DIGEST` values from that history and pulls the digest directly. Runtime secrets remain in the server-only `.env.production`; deployment and recovery are one bounded, recoverable transaction.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Docker Compose, Vitest, Next.js 16

---

## File Map

- Create `.github/workflows/build-frontend-image.yml`: build and publish the private frontend image.
- Modify `docker-compose.prod.yml`: select the prebuilt GHCR image in production.
- Modify `.env.production.template`: document the verified digest image reference without adding credentials.
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
  it('builds and publishes amd64 latest and full-SHA lookup tags', () => {
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
    expect(envTemplate).toContain(
      'A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST',
    );
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

- [ ] **Step 2: Document the verified image identity in the environment template**

Add under the public domain variables:

```dotenv
# Resolve the full DEPLOY_SHA tag, verify its OCI revision, and store the verified RepoDigest.
A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST
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

The unified transaction must require a clean path-scoped integration branch, fetch and `pull --ff-only` as `admin`, and require `HEAD == DEPLOY_SHA`. It pulls the full-SHA tag, verifies `org.opencontainers.image.revision`, resolves `.RepoDigests`, writes the matching digest to `A3_FRONTEND_IMAGE`, and recreates only the frontend with `--no-build` before restarting Caddy.

The runbook must state explicitly that production must not execute `docker compose build`, `docker compose up --build`, or `pnpm build`.

- [ ] **Step 3: Document verification and rollback**

Verification commands:

```bash
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml ps
curl -I --connect-timeout 3 --max-time 10 https://a3.zhuce.work
curl -sS --connect-timeout 3 --max-time 10 https://api.zhuce.work/api/auth/csrf/
curl -i --connect-timeout 3 --max-time 10 https://a3.zhuce.work/api/a3/tasks
```

Rollback requires `ROLLBACK_SHA` and `ROLLBACK_DIGEST` selected from the same root-owned `0600` deployment history line. It pulls `ghcr.io/zhuce30/a3-frontend@sha256:${ROLLBACK_DIGEST}` directly, verifies the OCI revision equals `ROLLBACK_SHA`, and persists that already immutable digest; it must not resolve the SHA tag or write `latest` to `A3_FRONTEND_IMAGE`.

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

### Task 6: Final review hardening

**Files:**
- Modify: `OpenMAIC/tests/a3-ghcr-deployment.test.ts`
- Modify: `.env.production.template`
- Modify: `docs/A3_GHCR前端镜像部署.md`
- Modify: `docs/superpowers/specs/2026-07-13-ghcr-frontend-deployment-design.md`
- Modify: `docs/superpowers/plans/2026-07-13-ghcr-frontend-deployment.md`

- [ ] **Step 1: Harden the deployment contract first**

Assert the workflow's integration-branch/path/manual triggers, `contents: read`, OCI source/revision labels, and existing pinned-action/build boundaries. Assert that the runbook binds branch `HEAD` to `DEPLOY_SHA`, resolves a matching `RepoDigest`, verifies `org.opencontainers.image.revision`, persists a digest in `A3_FRONTEND_IMAGE`, records successful deploy history without secrets, never switches production to `latest`, bounds curl readiness, and retains snapshots after failed recovery.

- [ ] **Step 2: Observe RED and commit the contract independently**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-deployment.test.ts
```

Expected: the new assertions fail against the tag-based, single-attempt runbook and template. Commit only the test as `test: cover digest-based frontend deployment`.

- [ ] **Step 3: Implement verified digest deployment**

The operator enters a full 40-character `DEPLOY_SHA`. As `admin`, require a clean path-scoped deployment tree, fetch and `pull --ff-only` the integration branch, then require `HEAD == DEPLOY_SHA`. Pull `ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}`, inspect `.RepoDigests`, verify `org.opencontainers.image.revision == DEPLOY_SHA`, and persist the unique matching `ghcr.io/zhuce30/a3-frontend@sha256:...` value.

Rollback requires paired `ROLLBACK_SHA` and `ROLLBACK_DIGEST` values from deployment history, pulls the digest directly, and verifies its revision. It never repeats the mutable SHA tag lookup; SHA tags are deploy-time lookup handles while the digest is the immutable runtime identity.

- [ ] **Step 4: Bound readiness and make recovery auditable**

Run readiness at most 12 times with a 5-second interval. Every curl uses `--connect-timeout 3 --max-time 10`; success requires root `308` with `Location: /a3`, CSRF `success: true`, unauthenticated tasks `401`, and exactly the seven expected services.

Recovery disables traps first, records restore/frontend/Caddy/running-check statuses, deletes the snapshot only after complete recovery, preserves the original status on successful recovery, and prints distinct `ROLLBACK FAILED` output with the retained snapshot path when any recovery step fails. On a successful deployment, append the deployment history first, then set `TRANSACTION_SUCCESS=1` and disable all traps before best-effort snapshot cleanup; cleanup failure prints a warning and cannot trigger recovery.

- [ ] **Step 5: Verify and commit documentation implementation**

Run the focused deployment and tasks tests, syntax-check every runbook Bash fence, run targeted TypeScript/lint checks as practical, then run diff, ownership-scope, placeholder-secret, and `latest` switch scans. Commit the four documentation/template files as `docs: deploy frontend by verified image digest`.
