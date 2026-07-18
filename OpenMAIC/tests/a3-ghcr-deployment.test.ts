import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowDocument = {
  on?: {
    workflow_dispatch?: unknown;
    push?: {
      branches?: string[];
      paths?: string[];
    };
  };
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<
    string,
    { concurrency?: Record<string, unknown>; if?: unknown; steps?: WorkflowStep[] }
  >;
};

type ComposeDocument = {
  services?: Record<
    string,
    { image?: unknown; command?: unknown; environment?: unknown; volumes?: unknown }
  >;
  volumes?: Record<string, unknown>;
};

const resetSequenceType = new yaml.Type('!reset', {
  kind: 'sequence',
  construct: (data: unknown[]) => data ?? [],
});
const composeSchema = yaml.DEFAULT_SCHEMA.extend([resetSequenceType]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(root, '.github/workflows/build-frontend-image.yml');
const backendWorkflowPath = path.join(root, '.github/workflows/build-backend-image.yml');
const composePath = path.join(root, 'docker-compose.prod.yml');
const dockerfilePath = path.join(root, 'OpenMAIC/Dockerfile');
const envTemplatePath = path.join(root, '.env.production.template');
const runbookPath = path.join(root, 'docs/A3_GHCR前端镜像部署.md');
const designPath = path.join(
  root,
  'docs/superpowers/specs/2026-07-13-ghcr-frontend-deployment-design.md',
);
const planPath = path.join(
  root,
  'docs/superpowers/plans/2026-07-13-ghcr-frontend-deployment.md',
);

function parseLines(value: unknown, field: string): string[] {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a multiline string`);
  }

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKeyValueLines(value: unknown, field: string): Array<readonly [string, string]> {
  return parseLines(value, field).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new TypeError(`${field} entry must use KEY=VALUE: ${line}`);
    }

    return [line.slice(0, separator), line.slice(separator + 1)] as const;
  });
}

describe('A3 private GHCR frontend deployment', () => {
  it('builds and publishes amd64 latest and full-SHA lookup tags', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(workflowSource) as WorkflowDocument;
    const buildJob = workflow.jobs?.['build-and-push'];
    const steps = buildJob?.steps ?? [];
    const checkoutStep = steps.find(
      (step) =>
        step.uses === 'actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5',
    );
    const setupBuildxStep = steps.find(
      (step) =>
        step.uses ===
        'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
    );
    const loginStep = steps.find(
      (step) =>
        step.uses === 'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
    );
    const buildStep = steps.find(
      (step) =>
        step.uses ===
        'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
    );

    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on?.push).toEqual({
      branches: ['codex/a3-latest-integration'],
      paths: ['OpenMAIC/**', '.github/workflows/build-frontend-image.yml'],
    });
    expect(buildJob?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/codex/a3-latest-integration' }}",
    );
    expect(buildJob?.concurrency).toEqual({
      group: 'a3-frontend-image',
      'cancel-in-progress': true,
    });
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.permissions?.contents).toBe('read');
    expect(workflow.permissions?.packages).toBe('write');
    expect(checkoutStep?.with).toMatchObject({
      'persist-credentials': false,
    });
    expect(setupBuildxStep).toBeDefined();
    expect(loginStep?.with).toMatchObject({
      registry: 'ghcr.io',
      username: '${{ github.actor }}',
      password: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(buildStep?.with).toMatchObject({
      context: 'OpenMAIC',
      file: 'OpenMAIC/Dockerfile',
      platforms: 'linux/amd64',
      push: true,
    });
    expect(parseLines(buildStep?.with?.tags, 'tags')).toEqual([
      'ghcr.io/zhuce30/a3-frontend:latest',
      'ghcr.io/zhuce30/a3-frontend:${{ github.sha }}',
    ]);

    const buildArgsSource = buildStep?.with?.['build-args'];
    const buildArgs = parseKeyValueLines(buildArgsSource, 'build-args');
    expect(buildArgs.map(([key]) => key)).toEqual(['NEXT_PUBLIC_A3_API_BASE_URL']);
    expect(Object.fromEntries(buildArgs)).toEqual({
      NEXT_PUBLIC_A3_API_BASE_URL: 'https://api.zhuce.work',
    });
    expect(buildArgsSource).not.toMatch(/\$\{\{\s*secrets\./);
    expect(Object.fromEntries(parseKeyValueLines(buildStep?.with?.labels, 'labels'))).toEqual({
      'org.opencontainers.image.source': '${{ github.server_url }}/${{ github.repository }}',
      'org.opencontainers.image.revision': '${{ github.sha }}',
    });
    expect(workflowSource).not.toMatch(
      /EMAIL_HOST_PASSWORD|A3_LLM_API_KEY|DJANGO_SECRET_KEY|MYSQL_PASSWORD/,
    );
  });

  it('uses a verified digest through the production environment', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const envTemplate = fs.readFileSync(envTemplatePath, 'utf8');
    expect(compose.services?.frontend?.image).toBe(
      '${A3_FRONTEND_IMAGE:-ghcr.io/zhuce30/a3-frontend:latest}',
    );
    expect(compose.services?.['realtime-proxy']?.image).toBe(
      '${A3_FRONTEND_IMAGE:-ghcr.io/zhuce30/a3-frontend:latest}',
    );
    expect(envTemplate).toMatch(
      /^A3_FRONTEND_IMAGE=ghcr\.io\/zhuce30\/a3-frontend@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST$/m,
    );
    expect(envTemplate).toContain('full DEPLOY_SHA tag');
    expect(envTemplate).toContain('verified RepoDigest');
    expect(envTemplate).not.toMatch(/^A3_FRONTEND_IMAGE=.*:latest$/m);
  });

  it('allows fixed-SHA manual image builds from an explicitly selected branch', () => {
    const backendWorkflow = yaml.load(fs.readFileSync(backendWorkflowPath, 'utf8')) as WorkflowDocument;
    const backendBuildJob = backendWorkflow.jobs?.['build-and-push'];

    expect(backendWorkflow.on).toHaveProperty('workflow_dispatch');
    expect(backendBuildJob?.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || github.ref == 'refs/heads/codex/a3-latest-integration' }}",
    );
  });

  it('shares the video worker token and internal frontend URL across production services', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const envTemplate = fs.readFileSync(envTemplatePath, 'utf8');

    for (const serviceName of ['backend', 'celery', 'frontend']) {
      expect(compose.services?.[serviceName]?.environment).toMatchObject({
        A3_VIDEO_WORKER_TOKEN: '${A3_VIDEO_WORKER_TOKEN:?set A3_VIDEO_WORKER_TOKEN in .env.production}',
      });
    }
    expect(compose.services?.celery?.environment).toMatchObject({
      A3_INTERNAL_FRONTEND_BASE_URL: 'http://frontend:3000',
    });
    expect(compose.services?.backend?.environment).toMatchObject({
      A3_INTERNAL_FRONTEND_BASE_URL: 'http://frontend:3000',
    });
    expect(envTemplate).toMatch(/^A3_VIDEO_WORKER_TOKEN=change-me-to-32-random-bytes$/m);
    expect(envTemplate).toContain('python -c "import secrets; print(secrets.token_urlsafe(32))"');
  });

  it('documents the durable video worker rollout and stale-job recovery sequence', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');

    expect(runbook).toContain('A3_VIDEO_WORKER_TOKEN');
    expect(runbook).toContain("python3 -c 'import secrets; print(secrets.token_urlsafe(32))'");
    expect(runbook).toMatch(/manage\.py migrate/);
    expect(runbook).toContain('backend celery celery-beat frontend');
    expect(runbook).toContain('manage.py recover_video_jobs --stale-minutes 5');
    expect(runbook).toContain('已有 provider taskId 的片段只会继续轮询');
  });

  it('documents immutable Cloudflare caching for versioned digital-human assets', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');

    expect(runbook).toContain('teacher.optimized.vrm?v=20260718-v1');
    expect(runbook).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(runbook).toContain('Caching -> Cache Rules');
    expect(runbook).toContain('ends_with(http.request.uri.path, ".vrm")');
    expect(runbook).toContain('ends_with(http.request.uri.path, ".vrma")');
    expect(runbook).toContain('ends_with(http.request.uri.path, ".webp")');
    expect(runbook).toMatch(/query string/i);
  });

  it('keeps OpenMAIC classroom job storage writable and persistent in production', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');

    expect(compose.services?.frontend?.volumes).toContain('a3-frontend-data:/app/data');
    expect(compose.volumes).toHaveProperty('a3-frontend-data');
    expect(dockerfile).toMatch(/mkdir -p \/app\/data/);
    expect(dockerfile).toMatch(/chown -R nextjs:nodejs \/app\/data/);
  });

  it('ties deployment source and image identity to the full deployment SHA', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');

    expect(runbook).toContain("INTEGRATION_BRANCH='codex/a3-latest-integration'");
    expect(runbook).toMatch(/git -C \/opt\/A3 symbolic-ref --short HEAD/);
    expect(runbook).toMatch(/git -C \/opt\/A3 fetch --prune origin "\$INTEGRATION_BRANCH"/);
    expect(runbook).toMatch(/git -C \/opt\/A3 pull --ff-only origin "\$INTEGRATION_BRANCH"/);
    expect(runbook).toMatch(/git -C \/opt\/A3 rev-parse HEAD[^\n]*DEPLOY_SHA/);
    expect(runbook).toMatch(
      /git -C \/opt\/A3 status --porcelain --untracked-files=all -- OpenMAIC docker-compose\.yml docker-compose\.prod\.yml Caddyfile \.github/,
    );

    expect(runbook).toContain('ghcr.io/zhuce30/a3-frontend:${DEPLOY_SHA}');
    expect(runbook).toContain('.RepoDigests');
    expect(runbook).toContain('org.opencontainers.image.revision');
    expect(runbook).toMatch(/test "\$image_revision" = "\$expected_revision"/);
    expect(runbook).toMatch(/A3_FRONTEND_IMAGE=.*\$digest_ref/);
    expect(runbook).toMatch(/ghcr\\\.io\/zhuce30\/a3-frontend@sha256:/);
    expect(runbook).not.toMatch(/(?:IMAGE_REF|image_ref)=['"]?ghcr\.io\/zhuce30\/a3-frontend:latest/);
  });

  it('uses bounded public readiness checks with strict HTTP and service assertions', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const curlLines = runbook
      .split(/\r?\n/)
      .filter((line) => /\bcurl\b/.test(line) && !line.trimStart().startsWith('#'));

    expect(runbook).toContain('for attempt in {1..12}');
    expect(runbook).toContain('sleep 5');
    expect(curlLines.length).toBeGreaterThanOrEqual(3);
    for (const line of curlLines) {
      expect(line).toContain('--connect-timeout 3');
      expect(line).toContain('--max-time 10');
    }
    expect(runbook).toContain("test \"$root_status\" = '308'");
    expect(runbook).toMatch(/location:\[\[:space:\]\]\*\/a3\$/);
    expect(runbook).toContain('.get("success") is True');
    expect(runbook).toContain("test \"$task_status\" = '401'");
    expect(runbook).toContain(
      "printf '%s\\n' backend caddy celery celery-beat frontend mysql realtime-proxy redis | sort",
    );
  });

  it('retains the snapshot and reports a distinct rollback failure until recovery succeeds', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const recoveryStart = runbook.indexOf('recover_transaction()');
    const recoveryEnd = runbook.indexOf('switch_frontend_image()', recoveryStart);
    const recovery = runbook.slice(recoveryStart, recoveryEnd);

    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    expect(recovery.indexOf('trap - EXIT HUP INT TERM')).toBeLessThan(
      recovery.indexOf('set +e'),
    );
    expect(recovery).toContain('restore_status=');
    expect(recovery).toContain('frontend_status=');
    expect(recovery).toContain('caddy_status=');
    expect(recovery).toContain('running_status=');
    expect(recovery).toContain('install -o root -g root -m 0600 "$SNAPSHOT" "$ENV_FILE"');
    expect(recovery).not.toContain('mv -f "$SNAPSHOT" "$ENV_FILE"');
    expect(recovery).toContain('ROLLBACK FAILED');
    expect(recovery).toContain('snapshot retained at');
    expect(recovery).toContain('exit "$rc"');
    expect(recovery.indexOf('sudo rm -f "$SNAPSHOT"')).toBeGreaterThan(
      recovery.indexOf('running_status='),
    );
  });

  it('records successful deploys and rolls back directly by recorded digest', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const rollbackStart = runbook.indexOf('    rollback)');
    const rollbackEnd = runbook.indexOf('      ;;', rollbackStart);
    const rollbackCase = runbook.slice(rollbackStart, rollbackEnd);

    expect(runbook).toContain(
      "HISTORY_FILE='/var/lib/a3-deploy/frontend-image-history.log'",
    );
    expect(runbook).toContain('append_deployment_history()');
    expect(runbook).toContain('install -o root -g root -m 0600 /dev/null "$history_file"');
    expect(runbook).toContain("date -u +'%Y-%m-%dT%H:%M:%SZ'");
    expect(runbook).toContain("printf '%s DEPLOY_SHA=%s RepoDigest=%s\\n'");
    expect(runbook).toContain('sudo tail -n 20 "$HISTORY_FILE"');

    expect(rollbackStart).toBeGreaterThanOrEqual(0);
    expect(rollbackEnd).toBeGreaterThan(rollbackStart);
    expect(rollbackCase).toContain('ROLLBACK_SHA');
    expect(rollbackCase).toContain('ROLLBACK_DIGEST');
    expect(rollbackCase).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(rollbackCase).toContain(
      'ROLLBACK_IMAGE="ghcr.io/zhuce30/a3-frontend@sha256:${ROLLBACK_DIGEST}"',
    );
    expect(rollbackCase).toContain('pull_verified_digest "$ROLLBACK_IMAGE" "$ROLLBACK_SHA"');
    expect(rollbackCase).not.toContain('resolve_deploy_digest');
    expect(rollbackCase).not.toContain('RepoDigests');
    expect(runbook).not.toContain('ghcr.io/zhuce30/a3-frontend:${ROLLBACK_SHA}');
  });

  it('marks success and disables recovery traps before snapshot cleanup', () => {
    const runbook = fs.readFileSync(runbookPath, 'utf8');
    const switchStart = runbook.indexOf('switch_frontend_image()');
    const switchEnd = runbook.indexOf('  read -rp', switchStart);
    const imageSwitch = runbook.slice(switchStart, switchEnd);
    const verifyIndex = imageSwitch.indexOf('verify_runtime');
    const historyIndex = imageSwitch.indexOf('append_deployment_history');
    const successIndex = imageSwitch.indexOf('TRANSACTION_SUCCESS=1');
    const trapIndex = imageSwitch.indexOf('trap - EXIT HUP INT TERM', successIndex);
    const cleanupIndex = imageSwitch.indexOf('sudo rm -f "$SNAPSHOT"', trapIndex);

    expect(verifyIndex).toBeGreaterThanOrEqual(0);
    expect(historyIndex).toBeGreaterThan(verifyIndex);
    expect(successIndex).toBeGreaterThan(historyIndex);
    expect(trapIndex).toBeGreaterThan(successIndex);
    expect(cleanupIndex).toBeGreaterThan(trapIndex);
    expect(imageSwitch).toContain('WARNING: deployment succeeded but snapshot cleanup failed');
  });

  it('documents SHA tag lookup and digest identity without a latest production switch', () => {
    const sources = [
      fs.readFileSync(designPath, 'utf8'),
      fs.readFileSync(planPath, 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('DEPLOY_SHA');
      expect(source).toContain('RepoDigest');
      expect(source).toContain('org.opencontainers.image.revision');
      expect(source).toContain('A3_FRONTEND_IMAGE');
      expect(source).toContain('ROLLBACK_DIGEST');
      expect(source).toMatch(/deployment history/i);
      expect(source).toMatch(/digest/i);
      expect(source).not.toMatch(/set `?A3_FRONTEND_IMAGE`? to a known-good SHA tag/i);
      expect(source).not.toMatch(/Rollback performs the same tag lookup/i);
    }
  });
});
