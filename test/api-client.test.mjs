// Testes do cliente da API Quebragalho (callQuebragalho em index.mjs), no
// caminho direto das tools quebragalho_code/quebragalho_review. Tudo roda
// contra um servidor http local (node:http) — SEM rede externa. Cada teste
// sobe a bridge real (index.mjs) via stdio apontando QUEBRAGALHO_BASE_URL
// para o fake e observa o comportamento de timeout, retry e parsing SSE.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.resolve('.');

function startFakeApi(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeFakeApi(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

async function connectBridge(t, server, extraEnv = {}) {
  const { port } = server.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${port}/v1`,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => { try { await client.close(); } catch { /* já fechado */ } });
  await client.connect(transport);
  return client;
}

function callCode(client, args = {}) {
  return client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'tarefa de teste', ...args },
  });
}

function readBodyJson(req, onEnd) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => onEnd(raw === '' ? {} : JSON.parse(raw)));
}

function jsonCompletion(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    model: 'deepseek-v4.1-flash',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

// ── P0-1: timeout ────────────────────────────────────────────────────────

test('API client aborta com API_TIMEOUT quando o gateway nunca responde', async (t) => {
  let requests = 0;
  const server = await startFakeApi((req, res) => {
    requests += 1;
    req.resume();
    // Nunca responde: mantém a conexão aberta até o timeout do fetch abortar.
    res.on('close', () => {});
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, {
    QUEBRAGALHO_API_TIMEOUT_MS: '1000',
    QUEBRAGALHO_API_RETRIES: '0',
  });

  const startedAt = Date.now();
  const result = await callCode(client);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /API_TIMEOUT/);
  assert.match(result.content[0].text, /QUEBRAGALHO_API_TIMEOUT_MS/);
  assert.ok(
    elapsedMs < 10_000,
    `timeout deveria abortar cedo, mas levou ${elapsedMs}ms`,
  );
  assert.equal(requests, 1, 'timeout não é retentado');
});

// ── P1-5: retry com backoff para 429/5xx ────────────────────────────────

test('API client repete 429 respeitando Retry-After e converge para sucesso', async (t) => {
  const attempts = [];
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => {
      attempts.push(Date.now());
      if (attempts.length <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
        res.end(JSON.stringify({ error: { message: 'rate limited' } }));
        return;
      }
      jsonCompletion(res, 'ok depois de duas retries');
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '2' });

  const result = await callCode(client);

  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /ok depois de duas retries/);
  assert.equal(attempts.length, 3, 'deve fazer 1 tentativa + 2 retries');
});

test('API client aplica backoff exponencial para 5xx sem Retry-After', async (t) => {
  const attempts = [];
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => {
      attempts.push(Date.now());
      if (attempts.length === 1) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('erro interno');
        return;
      }
      jsonCompletion(res, 'recuperou apos backoff');
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '2' });

  const result = await callCode(client);

  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /recuperou apos backoff/);
  assert.equal(attempts.length, 2);
  assert.ok(
    attempts[1] - attempts[0] >= 450,
    `segunda tentativa deveria esperar o backoff de 500ms, esperou ${attempts[1] - attempts[0]}ms`,
  );
});

test('API client nunca repete 4xx: 401 falha na primeira tentativa', async (t) => {
  let requests = 0;
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => {
      requests += 1;
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('chave invalida');
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '5' });

  const result = await callCode(client);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /API 401/);
  assert.equal(requests, 1, '4xx não pode ser retentado, mesmo com retries=5');
});

test('API client cita o número de tentativas ao esgotar retries em 5xx', async (t) => {
  let requests = 0;
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => {
      requests += 1;
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '0' });
      res.end('servico indisponivel');
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '1' });

  const result = await callCode(client);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /API 503/);
  assert.match(result.content[0].text, /2 tentativas/);
  assert.equal(requests, 2, 'deve fazer 1 tentativa + 1 retry antes de propagar o erro');
});

// ── P0-2: parseSSE tolerante ─────────────────────────────────────────────

test('API client rejeita stream SSE com linha inválida sem vazar conteúdo', async (t) => {
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        'data: {"choices":[{"delta":{"content":"parte visivel"}}]}',
        '',
        'data: {"secret-token":"sk-conteudo-sigiloso"} linha corrompida',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '0' });

  const result = await callCode(client);
  const text = result.content[0].text;

  assert.equal(result.isError, true);
  assert.match(text, /API_BAD_STREAM/);
  assert.match(text, /1 linha/);
  assert.ok(!text.includes('sk-conteudo-sigiloso'), 'linha inválida não pode vazar no erro');
  assert.ok(!text.includes('parte visivel'), 'resposta com stream corrompido deve ser descartada');
});

// ── P1-4: max_tokens default seguro ─────────────────────────────────────

test('API client usa default seguro de max_tokens e aceita valor explícito', async (t) => {
  const bodies = [];
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, (body) => {
      bodies.push(body);
      jsonCompletion(res, 'feito');
    });
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server, { QUEBRAGALHO_API_RETRIES: '0' });

  const listed = await client.listTools();
  const codeTool = listed.tools.find((tool) => tool.name === 'quebragalho_code');
  assert.equal(codeTool.inputSchema.properties.max_tokens.default, 8192);

  await callCode(client);
  await callCode(client, { max_tokens: 1234 });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].max_tokens, 8192, 'sem max_tokens o gateway deve receber 8192');
  assert.equal(bodies[1].max_tokens, 1234, 'valor explícito deve ser repassado');
});
