// Testes do suporte a imagens nas tools de prompt direto (P3-3): parâmetro
// `images` de quebragalho_code e das tools por modelo legadas, flag `vision`
// do catálogo e erros MODEL_NO_VISION / IMAGES_INVALID. Tudo contra um
// gateway fake http local (node:http) — SEM rede externa.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MODEL_CATALOG, mergeModelSync } from '../model-router.mjs';

const REPO = path.resolve('.');
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// Assinatura PNG + alguns bytes de "conteúdo": basta para validar o
// round-trip base64, não é uma imagem válida de verdade (o gateway fake
// não decodifica nada, só reflete o body).
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

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

// Allowlist inclui modelos com e sem visão para exercitar os dois caminhos.
async function connectBridge(t, server, extraEnv = {}) {
  const { port } = server.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${port}/v1`,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash,glm-5.3,mimo-v2.6-flash,kimi-k3,gpt-6-luna',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro,ultra,max',
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

async function withImageDir(t, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

function readBodyJson(req, onEnd) {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => onEnd(raw === '' ? {} : JSON.parse(raw)));
}

function jsonCompletion(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    model: 'glm-5.3',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function captureBodies() {
  const bodies = [];
  return {
    bodies,
    handler(req, res) {
      readBodyJson(req, (body) => {
        bodies.push(body);
        jsonCompletion(res, 'feito');
      });
    },
  };
}

test('catálogo marca exatamente kimi-k3, gpt-6-luna e glm-5.3 com vision: true', () => {
  const withVision = Object.keys(MODEL_CATALOG)
    .filter((id) => MODEL_CATALOG[id].vision === true)
    .sort();
  assert.deepEqual(withVision, ['glm-5.3', 'gpt-6-luna', 'kimi-k3']);

  // Demais modelos: flag ausente (não apenas falsy) = sem visão.
  for (const [id, meta] of Object.entries(MODEL_CATALOG)) {
    if (!['kimi-k3', 'gpt-6-luna', 'glm-5.3'].includes(id)) {
      assert.ok(!('vision' in meta), `${id} não deve declarar vision`);
    }
  }
});

test('mergeModelSync nunca concede visão a modelo adicionado por sincronização', (t) => {
  const snapshot = Object.fromEntries(
    Object.entries(MODEL_CATALOG).map(([id, meta]) => [id, {
      ...meta,
      capabilities: { ...meta.capabilities },
    }]),
  );
  t.after(() => {
    for (const key of Object.keys(MODEL_CATALOG)) delete MODEL_CATALOG[key];
    Object.assign(MODEL_CATALOG, snapshot);
  });

  mergeModelSync([
    { id: 'modelo-visual-sync', vision: true }, // remoto "anuncia" visão
    { id: 'glm-5.3' }, // update de modelo local conhecido
  ]);

  assert.ok(!('vision' in MODEL_CATALOG['modelo-visual-sync']),
    'modelo de sync não pode nascer com vision, mesmo com o remoto anunciando');
  assert.equal(MODEL_CATALOG['glm-5.3'].vision, true,
    'update de sync preserva metadados locais, inclusive vision');
});

test('quebragalho_code com { path } envia content array com image_url data URL decodificável', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);
  const dir = await withImageDir(t, { 'foto.png': PNG_BYTES });

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'descreva esta imagem',
      system: 'Você é um analista de imagens.',
      model: 'glm-5.3',
      images: [{ path: path.join(dir, 'foto.png') }],
    },
  });

  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(bodies.length, 1);
  const messages = bodies[0].messages;
  assert.equal(messages.length, 2);
  // system permanece content string; só o papel user vira array multimodal
  assert.equal(messages[0].role, 'system');
  assert.equal(typeof messages[0].content, 'string');
  assert.deepEqual(messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'descreva esta imagem' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } },
    ],
  });
  const part = messages[1].content[1];
  assert.match(part.image_url.url, /^data:image\/png;base64,/);
  const decoded = Buffer.from(part.image_url.url.slice('data:image/png;base64,'.length), 'base64');
  assert.ok(decoded.equals(PNG_BYTES), 'base64 deve decodificar de volta aos bytes originais');
});

test('quebragalho_code com { url } repassa a URL direto na parte image_url', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'o que há nesta imagem?',
      model: 'kimi-k3',
      images: [{ url: 'https://exemplo/img.png' }],
    },
  });

  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.deepEqual(bodies[0].messages.at(-1), {
    role: 'user',
    content: [
      { type: 'text', text: 'o que há nesta imagem?' },
      { type: 'image_url', image_url: { url: 'https://exemplo/img.png' } },
    ],
  });
});

test('tool por modelo legada também aceita images (string pura tratada como path)', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);
  const dir = await withImageDir(t, { 'gato.gif': Buffer.from([0x47, 0x49, 0x46, 0x38]) });

  const result = await client.callTool({
    name: 'quebragalho_glm_5_3',
    arguments: {
      prompt: 'relate a imagem',
      images: [path.join(dir, 'gato.gif')],
    },
  });

  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const [textPart, imagePart] = bodies[0].messages.at(-1).content;
  assert.deepEqual(textPart, { type: 'text', text: 'relate a imagem' });
  assert.equal(imagePart.type, 'image_url');
  assert.match(imagePart.image_url.url, /^data:image\/gif;base64,/);
});

test('modelo sem visão com images falha com MODEL_NO_VISION e sugere alternativas', async (t) => {
  let requests = 0;
  const server = await startFakeApi((req, res) => {
    requests += 1;
    readBodyJson(req, () => jsonCompletion(res, 'nunca'));
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'descreva',
      model: 'mimo-v2.6-flash',
      images: [{ url: 'https://exemplo/img.png' }],
    },
  });

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /MODEL_NO_VISION/);
  assert.match(text, /mimo-v2\.6-flash/);
  assert.match(text, /use um de: glm-5\.3, kimi-k3, gpt-6-luna/);
  assert.equal(requests, 0, 'não deve chamar o gateway');
});

test('extensão proibida e arquivo inexistente falham com IMAGES_INVALID distintos', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);
  const dir = await withImageDir(t, { 'nota.txt': Buffer.from('conteudo textual') });

  const badExt = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'x',
      model: 'glm-5.3',
      images: [{ path: path.join(dir, 'nota.txt') }],
    },
  });
  assert.equal(badExt.isError, true);
  assert.match(badExt.content[0].text, /IMAGES_INVALID/);
  assert.match(badExt.content[0].text, /extensão "txt" não suportada/);
  assert.ok(!badExt.content[0].text.includes('conteudo textual'), 'conteúdo do arquivo não pode vazar no erro');

  const missing = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'x',
      model: 'glm-5.3',
      images: [{ path: path.join(dir, 'ausente.png') }],
    },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /IMAGES_INVALID/);
  assert.match(missing.content[0].text, /arquivo não encontrado/);

  assert.notEqual(
    badExt.content[0].text,
    missing.content[0].text,
    'mensagens de extensão proibida e arquivo inexistente devem ser distintas',
  );
  assert.equal(bodies.length, 0, 'nenhuma imagem válida → nada chega ao gateway');
});

test('acima de 5 MiB falha com IMAGES_INVALID sem ler o conteúdo no erro', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);
  const dir = await withImageDir(t, {
    'grande.png': Buffer.alloc(IMAGE_MAX_BYTES + 1, 0x61),
  });

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'x',
      model: 'glm-5.3',
      images: [{ path: path.join(dir, 'grande.png') }],
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /IMAGES_INVALID/);
  assert.match(result.content[0].text, /5242880 bytes \(5 MiB\)/);
  assert.equal(bodies.length, 0);
});

test('6 imagens falha com erro de limite (1 a 5)', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: {
      prompt: 'x',
      model: 'gpt-6-luna',
      images: Array.from({ length: 6 }, () => ({ url: 'https://exemplo/img.png' })),
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /IMAGES_INVALID/);
  assert.match(result.content[0].text, /entre 1 e 5 itens \(recebidos: 6\)/);
  assert.equal(bodies.length, 0);
});

test('sem images o payload permanece content string exatamente como antes', async (t) => {
  const { bodies, handler } = captureBodies();
  const server = await startFakeApi(handler);
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'tarefa sem imagens', model: 'deepseek-v4.1-flash' },
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(bodies[0].messages, [
    { role: 'user', content: 'tarefa sem imagens' },
  ]);
});

test('schema: quebragalho_code expõe images (1 a 5) e quebragalho_review não', async (t) => {
  const server = await startFakeApi((req, res) => {
    readBodyJson(req, () => jsonCompletion(res, 'ok'));
  });
  t.after(() => closeFakeApi(server));
  const client = await connectBridge(t, server);

  const listed = await client.listTools();
  const codeTool = listed.tools.find((tool) => tool.name === 'quebragalho_code');
  const reviewTool = listed.tools.find((tool) => tool.name === 'quebragalho_review');

  const images = codeTool.inputSchema.properties.images;
  assert.equal(images.type, 'array');
  assert.equal(images.minItems, 1);
  assert.equal(images.maxItems, 5);
  assert.match(images.description, /path/);
  assert.match(images.description, /url/);
  assert.match(images.description, /vis/); // menciona exigência de modelo com visão
  assert.ok(!('images' in reviewTool.inputSchema.properties),
    'quebragalho_review não recebe imagens neste card');
});
