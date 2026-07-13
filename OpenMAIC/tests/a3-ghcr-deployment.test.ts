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
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<
    string,
    { concurrency?: Record<string, unknown>; if?: unknown; steps?: WorkflowStep[] }
  >;
};

type ComposeDocument = {
  services?: Record<string, { image?: unknown }>;
};

const resetSequenceType = new yaml.Type('!reset', {
  kind: 'sequence',
  construct: (data: unknown[]) => data ?? [],
});
const composeSchema = yaml.DEFAULT_SCHEMA.extend([resetSequenceType]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(root, '.github/workflows/build-frontend-image.yml');
const composePath = path.join(root, 'docker-compose.prod.yml');
const envTemplatePath = path.join(root, '.env.production.template');

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
  it('builds and publishes amd64 latest and immutable frontend tags', () => {
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

    expect(buildJob?.if).toBe("${{ github.ref == 'refs/heads/codex/a3-latest-integration' }}");
    expect(buildJob?.concurrency).toEqual({
      group: 'a3-frontend-image',
      'cancel-in-progress': true,
    });
    expect(workflow.concurrency).toBeUndefined();
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
    expect(workflowSource).not.toMatch(
      /EMAIL_HOST_PASSWORD|A3_LLM_API_KEY|DJANGO_SECRET_KEY|MYSQL_PASSWORD/,
    );
  });

  it('uses the published image through the production environment', () => {
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'), {
      schema: composeSchema,
    }) as ComposeDocument;
    const envTemplate = fs.readFileSync(envTemplatePath, 'utf8');
    expect(compose.services?.frontend?.image).toBe(
      '${A3_FRONTEND_IMAGE:-ghcr.io/zhuce30/a3-frontend:latest}',
    );
    expect(envTemplate).toContain('A3_FRONTEND_IMAGE=ghcr.io/zhuce30/a3-frontend:latest');
  });
});
