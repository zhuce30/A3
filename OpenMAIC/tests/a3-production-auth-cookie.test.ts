import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

type ComposeService = {
  environment?: Record<string, unknown>;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

const resetSequenceType = new yaml.Type('!reset', {
  kind: 'sequence',
  construct: (data: unknown[]) => data ?? [],
});
const composeSchema = yaml.DEFAULT_SCHEMA.extend([resetSequenceType]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('A3 production authentication cookie', () => {
  it('trusts the public A3 origin for same-site POST routes behind the reverse proxy', () => {
    const compose = yaml.load(
      fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8'),
      { schema: composeSchema },
    ) as ComposeDocument;
    const envTemplate = fs.readFileSync(
      path.join(root, '.env.production.template'),
      'utf8',
    );

    expect(compose.services?.frontend?.environment?.A3_TRUSTED_ORIGINS).toBe(
      '${A3_TRUSTED_ORIGINS:-https://a3.zhuce.work}',
    );
    expect(envTemplate).toMatch(/^A3_TRUSTED_ORIGINS=https:\/\/a3\.zhuce\.work$/m);
  });

  it('shares a secure, migration-safe session cookie across A3 subdomains', () => {
    const compose = yaml.load(
      fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8'),
      { schema: composeSchema },
    ) as ComposeDocument;
    const settingsSource = fs.readFileSync(
      path.join(root, 'backend/config/settings.py'),
      'utf8',
    );
    const envTemplate = fs.readFileSync(
      path.join(root, '.env.production.template'),
      'utf8',
    );

    for (const serviceName of ['backend', 'celery', 'celery-beat']) {
      const environment = compose.services?.[serviceName]?.environment;
      expect(environment?.DJANGO_SESSION_COOKIE_NAME).toBe(
        '${DJANGO_SESSION_COOKIE_NAME:-a3_sessionid}',
      );
      expect(environment?.DJANGO_SESSION_COOKIE_DOMAIN).toBe(
        '${DJANGO_SESSION_COOKIE_DOMAIN:-.zhuce.work}',
      );
      expect(environment?.DJANGO_SESSION_COOKIE_SECURE).toBe(
        '${DJANGO_SESSION_COOKIE_SECURE:-1}',
      );
    }

    expect(settingsSource).toContain('SESSION_COOKIE_NAME = os.getenv("DJANGO_SESSION_COOKIE_NAME", "sessionid")');
    expect(settingsSource).toContain('SESSION_COOKIE_DOMAIN = os.getenv("DJANGO_SESSION_COOKIE_DOMAIN") or None');
    expect(settingsSource).toContain('SESSION_COOKIE_SECURE = env_bool("DJANGO_SESSION_COOKIE_SECURE", False)');
    expect(envTemplate).toMatch(/^DJANGO_SESSION_COOKIE_NAME=a3_sessionid$/m);
    expect(envTemplate).toMatch(/^DJANGO_SESSION_COOKIE_DOMAIN=\.zhuce\.work$/m);
    expect(envTemplate).toMatch(/^DJANGO_SESSION_COOKIE_SECURE=1$/m);
  });
});
