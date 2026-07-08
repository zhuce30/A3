import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.resolve(__dirname, '..', '.env.local'));

const port = Number(process.env.A3_REALTIME_WS_PROXY_PORT || 3003);
const bindHost = process.env.A3_REALTIME_WS_PROXY_HOST || '127.0.0.1';
const djangoBaseUrl = process.env.A3_API_BASE_URL || process.env.NEXT_PUBLIC_A3_API_BASE_URL || 'http://localhost:8000';
const dashScopeUrl = process.env.DASHSCOPE_REALTIME_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const dashScopeModel = process.env.DASHSCOPE_REALTIME_MODEL || 'qwen3.5-omni-plus-realtime';
const dashScopeApiKey = process.env.DASHSCOPE_API_KEY;

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      provider: 'dashscope_qwen_omni_realtime',
      upstreamConfigured: Boolean(dashScopeApiKey && dashScopeUrl),
    }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ success: false, error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, socket, head) => {
  try {
    if (!request.url?.startsWith('/a3/realtime/ws')) {
      socket.destroy();
      return;
    }
    if (!dashScopeApiKey) {
      sendUpgradeError(socket, 'DASHSCOPE_API_KEY 未配置');
      return;
    }
    const auth = await validateA3Cookie(request.headers.cookie || '');
    if (!auth.success) {
      sendUpgradeError(socket, '请先登录后使用实时辅导');
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (client) => {
  const upstreamUrl = withModel(dashScopeUrl, dashScopeModel);
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${dashScopeApiKey}`,
    },
  });
  const pendingMessages = [];

  upstream.on('open', () => {
    client.send(JSON.stringify({
      type: 'a3.proxy.ready',
      provider: 'dashscope_qwen_omni_realtime',
      model: dashScopeModel,
    }));
    upstream.send(JSON.stringify({
      event_id: `a3_session_${Date.now()}`,
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        voice: process.env.DASHSCOPE_REALTIME_VOICE || 'Tina',
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        turn_detection: {
          type: process.env.DASHSCOPE_REALTIME_VAD || 'server_vad',
          threshold: Number(process.env.DASHSCOPE_REALTIME_VAD_THRESHOLD || 0.5),
          silence_duration_ms: Number(process.env.DASHSCOPE_REALTIME_SILENCE_MS || 800),
        },
        instructions: '你是 A3 智学引擎的实时面对面辅导 Agent，请使用简体中文，回答要结合本地知识库证据。',
      },
    }));
    while (pendingMessages.length) upstream.send(pendingMessages.shift());
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('error', (error) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'a3.proxy.error',
        error: error instanceof Error ? error.message : 'DashScope WebSocket 连接失败',
      }));
    }
  });

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'a3.proxy.closed',
        code,
        reason: reason.toString(),
      }));
      client.close();
    }
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) {
      pendingMessages.push(data);
      return;
    }
    upstream.send(data, { binary: isBinary });
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  });
});

server.listen(port, bindHost, () => {
  console.log(`A3 DashScope realtime proxy listening on ws://${bindHost}:${port}/a3/realtime/ws`);
  console.log(`DashScope upstream configured: ${Boolean(dashScopeApiKey && dashScopeUrl)}`);
});

function withModel(baseUrl, model) {
  const url = new URL(baseUrl);
  if (!url.searchParams.has('model')) url.searchParams.set('model', model);
  return url.toString();
}

async function validateA3Cookie(cookie) {
  try {
    const response = await fetch(`${djangoBaseUrl}/api/auth/me/`, {
      headers: { cookie },
    });
    if (!response.ok) return { success: false };
    const payload = await response.json();
    return { success: Boolean(payload?.user) };
  } catch {
    return { success: false };
  }
}

function sendUpgradeError(socket, message) {
  const body = JSON.stringify({ success: false, error: message });
  socket.write([
    'HTTP/1.1 401 Unauthorized',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'));
  socket.destroy();
}

function loadEnvFile(filePath) {
  try {
    const content = fsRead(filePath);
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (process.env[key]) continue;
      process.env[key] = rest.join('=').trim();
    }
  } catch {
    // Next.js owns .env loading in the app; this standalone proxy loads it only when present.
  }
}

function fsRead(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}
