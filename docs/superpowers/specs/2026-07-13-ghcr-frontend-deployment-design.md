# A3 Frontend GHCR Deployment Design

## Goal

Build the OpenMAIC frontend on GitHub Actions and publish it as a private GHCR image so the 2 vCPU / 4 GiB production VPS never runs `docker compose build` again.

## Scope

- Build only the `frontend` image from `OpenMAIC/Dockerfile`.
- Publish to `ghcr.io/zhuce30/a3-frontend`.
- Keep the existing backend, Celery, MySQL, Redis, and Caddy deployment unchanged.
- Keep production secrets exclusively in `/opt/A3/.env.production` on the server.

## GitHub Actions Workflow

The workflow runs on:

- pushes to `codex/a3-latest-integration` that affect `OpenMAIC`, the frontend Dockerfile, or the workflow;
- manual `workflow_dispatch` runs.

It uses GitHub's `GITHUB_TOKEN` with `contents: read` and `packages: write`, builds for `linux/amd64`, and pushes two tags:

- `ghcr.io/zhuce30/a3-frontend:latest`
- `ghcr.io/zhuce30/a3-frontend:<full-commit-sha>`

The build receives only the public build argument:

```text
NEXT_PUBLIC_A3_API_BASE_URL=https://api.zhuce.work
```

No SMTP password, provider API key, Django secret, or database credential is passed into the image build.

## Compose Integration

The production Compose override reads the frontend image from `A3_FRONTEND_IMAGE`. The checked-in Compose fallback remains available for initial configuration discovery, but every production switch writes an immutable verified digest:

```text
A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend@sha256:<verified-64-hex-digest>
```

The full `DEPLOY_SHA` tag is a mutable lookup handle, not the deployed identity. The server pulls `ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}` once during a normal deploy, resolves the matching `RepoDigest` with `docker image inspect`, and requires the image label `org.opencontainers.image.revision` to equal `DEPLOY_SHA`. Only that `repo@sha256:...` value is persisted in `A3_FRONTEND_IMAGE`.

The existing `build` definition remains available for local development and emergency use, but production deployment commands always use `up --no-build`. Production never switches to `latest`.

Runtime secrets continue to enter the frontend and backend containers from `.env.production`. Updating that file requires container recreation, not image rebuilding.

## Server Authentication

The GHCR package remains private. The server uses a classic GitHub personal access token with only the `read:packages` scope. The GitHub account that owns the token must be able to read `zhuce30/A3` and its container package.

The token is entered interactively through `docker login ghcr.io --password-stdin`; it is never stored in Git, Compose files, shell history, or documentation. Docker stores the resulting credential under the root user's Docker configuration because deployment commands run with `sudo`.

## Deployment Flow

1. GitHub Actions builds and publishes the frontend image.
2. The server verifies that the relevant deployment paths are clean, fetches and fast-forward pulls `codex/a3-latest-integration` as `admin`, and requires repository `HEAD` to equal the full `DEPLOY_SHA`. Runtime control files outside `OpenMAIC`, the Compose files, `Caddyfile`, and `.github` do not block the path-scoped cleanliness check.
3. The server pulls the full-SHA lookup tag once, verifies `org.opencontainers.image.revision`, resolves the matching GHCR `RepoDigest`, and snapshots `.env.production`.
4. The transaction writes the digest to `A3_FRONTEND_IMAGE`, recreates only `frontend`, and restarts Caddy without building.
5. A bounded 12-attempt, 5-second readiness loop uses curl connect/max timeouts and requires the root `308` redirect to `/a3`, successful CSRF response, unauthenticated tasks `401`, and exactly seven running Compose services.
6. After readiness passes, a normal deploy appends UTC timestamp, `DEPLOY_SHA`, and verified `RepoDigest` to the root-owned `0600` deployment history file. No secrets or runtime environment values are recorded.
7. The transaction sets its success marker and disables all recovery traps before snapshot cleanup. Cleanup failure emits an explicit warning and retains the snapshot without rolling back the verified deployment.

The database and queues remain running during frontend deployment.

## Rollback

Rollback requires a paired `ROLLBACK_SHA` and 64-character lowercase hexadecimal `ROLLBACK_DIGEST` selected from one deployment history line. It constructs `ghcr.io/zhuce30/a3-frontend@sha256:${ROLLBACK_DIGEST}`, pulls that digest directly, verifies `org.opencontainers.image.revision == ROLLBACK_SHA`, and switches using the same immutable digest. Rollback never pulls or resolves the SHA lookup tag again. No source rebuild or database operation is involved.

Automatic transaction recovery disables traps before doing any work and records config restore, frontend recreation, Caddy restart, and running-service check statuses independently. It deletes the snapshot only when all recovery steps succeed and then exits with the original failure or signal status. Incomplete recovery prints `ROLLBACK FAILED`, retains the snapshot path for manual repair, and exits with a distinct recovery-failure status.

## Failure Handling

- A failed Actions build publishes no new `latest` image.
- A failed full-SHA pull, missing/mismatched OCI revision, or missing matching `RepoDigest` occurs before the environment snapshot and leaves the running deployment untouched.
- A failed frontend start is diagnosed through `docker compose logs frontend caddy`; recovery restores the previous digest from the retained snapshot.
- Production deployment never runs `build` or `--build`, preventing another VPS resource-exhaustion incident.

## Verification

Repository checks:

```text
docker build metadata resolves the linux/amd64 image and public API build argument
docker compose production config resolves the GHCR frontend image
frontend TypeScript and targeted deployment contract tests pass
```

Production checks:

```text
all seven Compose services are Up
https://a3.zhuce.work redirects to /a3
https://api.zhuce.work/api/auth/csrf/ returns success
unauthenticated /api/a3/tasks returns 401 instead of 500
authenticated /api/a3/tasks returns 200
```
