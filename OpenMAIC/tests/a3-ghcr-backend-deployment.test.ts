import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

type WorkflowStep = {
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowDocument = {
  on?: { push?: { branches?: string[]; paths?: string[] } };
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { if?: unknown; steps?: WorkflowStep[] }>;
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
      paths: ['backend/**', '.github/workflows/build-backend-image.yml'],
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
});
