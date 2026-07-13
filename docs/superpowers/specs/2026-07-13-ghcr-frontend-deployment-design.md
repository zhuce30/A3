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

The production Compose override assigns the frontend image through:

```text
A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:latest
```

The existing `build` definition remains available for local development and emergency use, but production deployment commands use `docker compose pull frontend` followed by `up --no-build`.

Runtime secrets continue to enter the frontend and backend containers from `.env.production`. Updating that file requires container recreation, not image rebuilding.

## Server Authentication

The GHCR package remains private. The server uses a classic GitHub personal access token with only the `read:packages` scope. The GitHub account that owns the token must be able to read `zhuce30/A3` and its container package.

The token is entered interactively through `docker login ghcr.io --password-stdin`; it is never stored in Git, Compose files, shell history, or documentation. Docker stores the resulting credential under the root user's Docker configuration because deployment commands run with `sudo`.

## Deployment Flow

1. GitHub Actions builds and publishes the frontend image.
2. The server pulls the latest deployment branch.
3. The server pulls `A3_FRONTEND_IMAGE` from GHCR.
4. Compose recreates only `frontend` and restarts Caddy without building.
5. Health checks verify the frontend, root redirect, backend CSRF endpoint, and `/api/a3/tasks` behavior.

The database and queues remain running during frontend deployment.

## Rollback

Every image is tagged with its source commit SHA. To roll back, set `A3_FRONTEND_IMAGE` to a known-good SHA tag in `.env.production`, pull that image, and recreate only the frontend container. No source rebuild or database operation is involved.

## Failure Handling

- A failed Actions build publishes no new `latest` image.
- A failed `docker compose pull frontend` leaves the currently running image untouched.
- A failed frontend start is diagnosed through `docker compose logs frontend caddy`; rollback uses the previous SHA tag.
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
