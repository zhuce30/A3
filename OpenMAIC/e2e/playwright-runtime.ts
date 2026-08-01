import path from 'node:path';

type PlaywrightEnvironment = Record<string, string | undefined>;

function resolvePort(value?: string, name = 'A3_PLAYWRIGHT_PORT') {
  if (!value) return 3002;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return port;
}

function readExplicitURLPort(value: string) {
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i)?.[1];
  const host = authority?.split('@').at(-1);
  const port = host?.match(/:(\d+)$/)?.[1];
  return port ? resolvePort(port) : undefined;
}

function serializeBaseURL(url: URL) {
  const value = url.toString();
  return url.pathname === '/' && !url.search && !url.hash ? value.slice(0, -1) : value;
}

function quoteCommandPath(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function resolveA3PlaywrightRuntime(
  environment: PlaywrightEnvironment = process.env,
  frontendRoot = process.cwd(),
) {
  const explicitPort = environment.A3_PLAYWRIGHT_PORT
    ? resolvePort(environment.A3_PLAYWRIGHT_PORT)
    : undefined;
  const configuredBaseURL = environment.A3_PLAYWRIGHT_BASE_URL;
  const parsedBaseURL = new URL(configuredBaseURL ?? 'http://localhost');
  const baseURLPort = configuredBaseURL ? readExplicitURLPort(configuredBaseURL) : undefined;
  if (explicitPort && baseURLPort && explicitPort !== baseURLPort) {
    throw new Error(
      `A3_PLAYWRIGHT_BASE_URL port ${baseURLPort} conflicts with A3_PLAYWRIGHT_PORT ${explicitPort}`,
    );
  }
  const port = explicitPort ?? baseURLPort ?? 3002;
  const backendPort = environment.A3_PLAYWRIGHT_BACKEND_PORT
    ? resolvePort(environment.A3_PLAYWRIGHT_BACKEND_PORT, 'A3_PLAYWRIGHT_BACKEND_PORT')
    : 8000;
  const backendURL = `http://localhost:${backendPort}`;
  parsedBaseURL.port = String(port);
  const baseURL = serializeBaseURL(parsedBaseURL);
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
    : `cmd /c "node_modules\\.bin\\next.CMD dev --webpack -p ${port}"`;
  const backendCommand = [
    `cmd /c "set DJANGO_DEBUG=1&& set DJANGO_SETTINGS_MODULE=backend.config.test_sqlite_settings&& set CORS_ALLOWED_ORIGINS=http://localhost:${port},http://127.0.0.1:${port}&& set A3_KB_SYNC_INDEX_ON_UPLOAD=1&&`,
    quoteCommandPath(backendPython),
    quoteCommandPath(backendManagePy),
    'migrate --noinput&&',
    quoteCommandPath(backendPython),
    quoteCommandPath(backendManagePy),
    `runserver localhost:${backendPort} --noreload"`,
  ].join(' ');

  return {
    backendCommand,
    backendPort,
    backendURL,
    backendManagePy,
    backendProjectRoot,
    backendPython,
    baseURL,
    frontendCommand,
    port,
    useExistingServers,
  };
}
