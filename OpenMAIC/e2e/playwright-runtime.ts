import path from 'node:path';

type PlaywrightEnvironment = Record<string, string | undefined>;

function resolvePort(value?: string) {
  if (!value) return 3002;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid A3_PLAYWRIGHT_PORT: ${value}`);
  }
  return port;
}

function quoteCommandPath(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function resolveA3PlaywrightRuntime(
  environment: PlaywrightEnvironment = process.env,
  frontendRoot = process.cwd(),
) {
  const baseURLPort = environment.A3_PLAYWRIGHT_BASE_URL
    ? new URL(environment.A3_PLAYWRIGHT_BASE_URL).port
    : undefined;
  const port = resolvePort(environment.A3_PLAYWRIGHT_PORT ?? baseURLPort);
  const baseURL = environment.A3_PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
  const useExistingServers = environment.A3_PLAYWRIGHT_USE_EXISTING === '1';
  const backendProjectRoot = path.resolve(
    environment.A3_BACKEND_PROJECT_ROOT ?? path.resolve(frontendRoot, '..'),
  );
  const backendPython = path.resolve(
    environment.A3_BACKEND_PYTHON ??
      path.join(backendProjectRoot, 'backend', '.venv', 'Scripts', 'python.exe'),
  );
  const backendManagePy = path.join(backendProjectRoot, 'backend', 'manage.py');
  const frontendCommand = environment.CI
    ? `pnpm build && pnpm start -- -p ${port}`
    : `cmd /c node_modules\\.bin\\next.CMD dev -p ${port}`;
  const backendCommand = [
    'cmd /c set A3_KB_SYNC_INDEX_ON_UPLOAD=1&&',
    quoteCommandPath(backendPython),
    quoteCommandPath(backendManagePy),
    'runserver 127.0.0.1:8000 --noreload',
  ].join(' ');

  return {
    backendCommand,
    backendManagePy,
    backendProjectRoot,
    backendPython,
    baseURL,
    frontendCommand,
    port,
    useExistingServers,
  };
}
