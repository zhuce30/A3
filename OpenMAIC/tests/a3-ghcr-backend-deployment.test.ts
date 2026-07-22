import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  uses?: string;
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type WorkflowDocument = {
  on?: { push?: { branches?: string[]; paths?: string[] } };
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { if?: unknown; steps?: WorkflowStep[] }>;
};

type ComposeService = {
  image?: unknown;
  command?: unknown;
  healthcheck?: {
    test?: unknown;
    interval?: unknown;
    timeout?: unknown;
    retries?: unknown;
    start_period?: unknown;
  };
  depends_on?: Record<string, { condition?: unknown }>;
  logging?: {
    driver?: unknown;
    options?: Record<string, unknown>;
  };
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

const resetSequenceType = new yaml.Type('!reset', {
  kind: 'sequence',
  construct: (data: unknown[]) => data ?? [],
});
const composeSchema = yaml.DEFAULT_SCHEMA.extend([resetSequenceType]);
const root = path.resolve(process.cwd(), '..');
const workflowPath = path.join(root, '.github/workflows/build-backend-image.yml');
const composePath = path.join(root, 'docker-compose.prod.yml');
const envTemplatePath = path.join(root, '.env.production.template');
const backendDockerignorePath = path.join(root, 'backend/.dockerignore');

describe('A3 private GHCR backend deployment', () => {
  it('builds the amd64 backend image without injecting runtime secrets', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    const source = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(source) as WorkflowDocument;
    const job = workflow.jobs?.['build-and-push'];
    const buildStep = job?.steps?.find((step) =>
      step.uses?.startsWith('docker/build-push-action@'),
    );

    expect(workflow.on?.push).toEqual({
      branches: ['codex/a3-latest-integration'],
      paths: [
        'backend/**',
        'docker-compose.yml',
        'docker-compose.prod.yml',
        '.env.production.template',
        '.github/workflows/build-backend-image.yml',
      ],
    });
    expect(workflow.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(job?.if).toBe("${{ github.ref == 'refs/heads/codex/a3-latest-integration' }}");
    expect(buildStep?.with).toMatchObject({
      context: 'backend',
      file: 'backend/Dockerfile',
      platforms: 'linux/amd64',
      push: true,
    });
    expect(String(buildStep?.with?.tags)).toContain('ghcr.io/zhuce30/a3-backend:${{ github.sha }}');
    expect(source).not.toMatch(/EMAIL_HOST_PASSWORD|A3_LLM_API_KEY|DJANGO_SECRET_KEY|MYSQL_PASSWORD/);
    expect(fs.readFileSync(backendDockerignorePath, 'utf8').split(/\r?\n/)).toContain('.env');
  });

  it('runs all Python services from one verified backend digest', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as { services?: Record<string, { image?: unknown }> };
    const expectedImage = '${A3_BACKEND_IMAGE:-ghcr.io/zhuce30/a3-backend:latest}';

    expect(compose.services?.backend?.image).toBe(expectedImage);
    expect(compose.services?.celery?.image).toBe(expectedImage);
    expect(compose.services?.['celery-beat']?.image).toBe(expectedImage);
    expect(fs.readFileSync(envTemplatePath, 'utf8')).toMatch(
      /^A3_BACKEND_IMAGE=ghcr\.io\/zhuce30\/a3-backend@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST$/m,
    );
  });

  it('bounds production Celery worker memory without changing Celery Beat', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as { services?: Record<string, { command?: unknown }> };

    expect(compose.services?.celery?.command).toEqual([
      'celery',
      '-A',
      'backend.config',
      'worker',
      '-l',
      'info',
      '--concurrency=1',
      '--max-tasks-per-child=5',
      '--max-memory-per-child=900000',
    ]);
    expect(compose.services?.['celery-beat']?.command).toBeUndefined();
  });

  it('keeps one web worker available while another is recycled on the 8 GB host', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;

    expect(compose.services?.backend?.command).toEqual([
      'uvicorn',
      'backend.config.asgi:application',
      '--host',
      '0.0.0.0',
      '--port',
      '8000',
      '--workers',
      '2',
      '--limit-max-requests',
      '500',
      '--limit-max-requests-jitter',
      '50',
    ]);
  });

  it('validates the merged production Compose document in CI', () => {
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as WorkflowDocument;
    const step = workflow.jobs?.['build-and-push']?.steps?.find(
      (item) => item.name === 'Validate production Compose merge',
    );

    expect(step?.run).toContain('docker compose');
    expect(step?.run).toContain('cp .env.production.template .env.production');
    expect(step?.run).toContain('--env-file .env.production');
    expect(step?.run).toContain('-f docker-compose.yml');
    expect(step?.run).toContain('-f docker-compose.prod.yml');
    expect(step?.run).toContain('config --quiet');
    expect(step?.env).toBeUndefined();
  });

  it('gates backend consumers on the public readiness probe', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const backendHealthcheck = compose.services?.backend?.healthcheck;

    expect(backendHealthcheck).toEqual({
      test: [
        'CMD',
        'python',
        '-c',
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/system/ready/', timeout=3)",
      ],
      interval: '15s',
      timeout: '5s',
      retries: 6,
      start_period: '45s',
    });
    expect(compose.services?.frontend?.depends_on?.backend?.condition).toBe(
      'service_healthy',
    );
    expect(
      compose.services?.['realtime-proxy']?.depends_on?.backend?.condition,
    ).toBe('service_healthy');
  });

  it('rotates json-file logs for every production service', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const productionServices = [
      'mysql',
      'redis',
      'backend',
      'celery',
      'celery-beat',
      'frontend',
      'realtime-proxy',
      'caddy',
    ];

    for (const serviceName of productionServices) {
      expect(compose.services?.[serviceName]?.logging, serviceName).toEqual({
        driver: 'json-file',
        options: { 'max-size': '10m', 'max-file': '3' },
      });
    }
  });
});
