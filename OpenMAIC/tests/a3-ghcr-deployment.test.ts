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
