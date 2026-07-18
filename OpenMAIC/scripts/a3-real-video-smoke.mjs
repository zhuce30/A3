import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

loadLocalEnv();

const enabled = process.env.A3_RUN_REAL_VIDEO_SMOKE === '1';
const provider = process.env.A3_VIDEO_SMOKE_PROVIDER || 'seedance';
const baseUrl = process.env.A3_VIDEO_SMOKE_BASE_URL || 'http://localhost:3002';
const envKeyName = `VIDEO_${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
const hasProviderKey = Boolean(process.env[envKeyName] || process.env.A3_VIDEO_SMOKE_API_KEY);
const providerBaseUrlName = `VIDEO_${provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
const reportPath = path.resolve(process.cwd(), 'tmp', 'a3-openmaic-smoke-report.json');

if (isDirectRun()) {
  await main();
}

async function main() {
  if (!enabled) {
    const report = buildReport('skipped', {
      reason: 'set A3_RUN_REAL_VIDEO_SMOKE=1 to run real video provider smoke test',
    });
    writeReport(report);
    console.log(`SKIP: ${report.reason}. Report: ${report.reportPath}`);
    process.exit(0);
  }

  if (!hasProviderKey) {
    const report = buildReport('skipped', {
      reason: `missing ${envKeyName} or A3_VIDEO_SMOKE_API_KEY for provider ${provider}`,
    });
    writeReport(report);
    console.log(`SKIP: ${report.reason}. Report: ${report.reportPath}`);
    process.exit(0);
  }

  const startedAtMs = Date.now();
  let response;
  try {
    response = await fetch(new URL('/api/generate/video', baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-video-provider': provider,
        ...(process.env.A3_VIDEO_SMOKE_API_KEY ? { 'x-api-key': process.env.A3_VIDEO_SMOKE_API_KEY } : {}),
        ...(process.env.A3_VIDEO_SMOKE_PROVIDER_BASE_URL || process.env[providerBaseUrlName]
          ? { 'x-base-url': process.env.A3_VIDEO_SMOKE_PROVIDER_BASE_URL || process.env[providerBaseUrlName] }
          : {}),
      },
      body: JSON.stringify({
        prompt: 'A3 learning demo: explain feedback control with a simple diagram, safe educational content.',
        duration: 5,
        aspectRatio: '16:9',
        resolution: '720p',
      }),
    });
  } catch (error) {
    const report = buildReport('failed', {
      elapsedMs: Date.now() - startedAtMs,
      reason: error instanceof Error ? error.message : String(error),
    });
    writeReport(report);
    console.error(JSON.stringify(sanitizeReportForConsole(report), null, 2));
    process.exit(1);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success || !payload.result?.url) {
    const report = buildReport('failed', {
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAtMs,
      reason: payload.error || 'video smoke failed without JSON error',
    });
    writeReport(report);
    console.error(JSON.stringify(sanitizeReportForConsole(report), null, 2));
    process.exit(1);
  }

  const report = buildReport('succeeded', {
    elapsedMs: Date.now() - startedAtMs,
    videoUrl: payload.result.url,
    duration: payload.result.duration || 0,
    width: payload.result.width || 0,
    height: payload.result.height || 0,
  });
  writeReport(report);
  console.log(JSON.stringify(sanitizeReportForConsole(report), null, 2));
}

function loadLocalEnv() {
  for (const filename of ['.env.local', '.env']) {
    const filePath = path.resolve(process.cwd(), filename);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}

function buildReport(status, extra = {}) {
  return {
    schemaVersion: 'a3.openmaic-video-smoke-report.v1',
    status,
    success: status === 'succeeded',
    provider,
    baseUrl,
    checkedAt: new Date().toISOString(),
    command: 'A3_RUN_REAL_VIDEO_SMOKE=1 pnpm smoke:a3-video',
    hasProviderKey,
    reportPath: 'tmp/a3-openmaic-smoke-report.json',
    ...extra,
  };
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function sanitizeReportForConsole(report) {
  const { videoUrl, ...safeReport } = report;
  return {
    ...safeReport,
    hasVideoUrl: Boolean(videoUrl),
  };
}

function isDirectRun() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
