import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { realpathSync, symlinkSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MODEL_CATALOG } from '../model-router.mjs';
import { todayLocalDate, usageFileForDate } from '../usage-store.mjs';

test('MCP expõe quebragalho_agent e falha fechado fora da allowlist', async (t) => {
  const repo = path.resolve('.');
  const outside = path.dirname(repo);
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-memory-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash,glm-5.3',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_DENYLIST: '',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '1',
      QUEBRAGALHO_MEMORY_DIR: memoryDir,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => { try { await client.close(); } catch {} });
  await client.connect(transport);

  assert.match(client.getInstructions() ?? '', /subagente externo/);
  assert.match(client.getInstructions() ?? '', /quebragalho_agent_start por padrão em App\/IDE/);
  assert.match(client.getInstructions() ?? '', /mostre o job_id/);
  assert.match(client.getInstructions() ?? '', /continue trabalhando e consulte quebragalho_job/);
  assert.match(client.getInstructions() ?? '', /Reserve quebragalho_agent síncrono para tarefa curta/);
  assert.match(client.getInstructions() ?? '', /nunca execute a CLI no shell/);
  assert.match(client.getInstructions() ?? '', /reporte erro de configuração/);

  const listed = await client.listTools();
  const routeTool = listed.tools.find((tool) => tool.name === 'quebragalho_route');
  const agentTool = listed.tools.find((tool) => tool.name === 'quebragalho_agent');
  const agentStartTool = listed.tools.find((tool) => tool.name === 'quebragalho_agent_start');
  const jobTool = listed.tools.find((tool) => tool.name === 'quebragalho_job');
  const memoryTool = listed.tools.find((tool) => tool.name === 'quebragalho_memory');
  assert.ok(routeTool);
  assert.ok(agentTool);
  assert.ok(agentStartTool);
  assert.ok(jobTool);
  assert.ok(memoryTool);
  assert.match(agentTool.description, /forma síncrona e bloqueia até concluir/);
  assert.match(agentTool.description, /use apenas para tarefa curta/);
  assert.match(agentStartTool.description, /padrão para App\/IDE/);
  assert.match(agentStartTool.description, /Mostre o job_id/);
  assert.match(jobTool.description, /Nunca reenvie a tarefa/);
  assert.deepEqual(routeTool.inputSchema.properties.executor.enum, [
    'opencode',
    'native',
  ]);
  assert.equal(routeTool.inputSchema.properties.executor.default, 'native');
  assert.deepEqual(agentTool.inputSchema.properties.executor.enum, [
    'opencode',
    'native',
  ]);
  assert.equal(agentTool.inputSchema.properties.executor.default, 'native');
  assert.equal(agentTool.inputSchema.properties.model.default, 'auto');
  assert.deepEqual(agentTool.inputSchema.properties.model.enum, [
    'auto',
    'deepseek-v4.1-flash',
  ]);
  assert.deepEqual(memoryTool.inputSchema.properties.action.enum, [
    'status',
    'read',
    'remember',
  ]);

  const remembered = await client.callTool({
    name: 'quebragalho_memory',
    arguments: {
      action: 'remember',
      cwd: repo,
      note: 'O bridge usa memória isolada por projeto.',
    },
  });
  assert.notEqual(remembered.isError, true);
  assert.equal(JSON.parse(remembered.content[0].text).persisted, true);

  const recalled = await client.callTool({
    name: 'quebragalho_memory',
    arguments: { action: 'read', cwd: repo },
  });
  const recalledPayload = JSON.parse(recalled.content[0].text);
  assert.equal(recalledPayload.enabled, true);
  assert.equal(recalledPayload.entries.length, 1);
  assert.equal(
    recalledPayload.entries[0].note,
    'O bridge usa memória isolada por projeto.',
  );

  const routed = await client.callTool({
    name: 'quebragalho_route',
    arguments: {
      prompt: 'Faça uma auditoria de segurança complexa da arquitetura.',
      mode: 'read_only',
    },
  });
  assert.notEqual(routed.isError, true);
  const routePayload = JSON.parse(routed.content[0].text);
  assert.equal(routePayload.executor, 'native');
  assert.equal(routePayload.selected_model, 'deepseek-v4.1-flash');
  assert.deepEqual(
    routePayload.ranking.map((candidate) => candidate.model),
    ['deepseek-v4.1-flash'],
  );

  const oversizedRoute = await client.callTool({
    name: 'quebragalho_route',
    arguments: { prompt: 'x'.repeat(100_001) },
  });
  assert.equal(oversizedRoute.isError, true);
  assert.match(oversizedRoute.content[0].text, /limite de 100000 caracteres/);

  const result = await client.callTool({
    name: 'quebragalho_agent',
    arguments: { prompt: 'audite', cwd: outside, mode: 'read_only' },
  });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.status, 'error');
  assert.match(payload.summary, /fora das raízes autorizadas/);
});

test('MCP aplica denylist em tools, schemas, recursos e chamadas antigas', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_DENYLIST: 'muse-spark-1.3-contributor,glm-5.3-flash,glm-5.3',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  assert.ok(!toolNames.includes('quebragalho_muse_spark_1_3_contributor'));
  assert.ok(!toolNames.includes('quebragalho_glm_5_3_flash'));
  for (const name of ['quebragalho_code', 'quebragalho_review']) {
    const modelEnum = listed.tools.find((tool) => tool.name === name)
      .inputSchema.properties.model.enum;
    assert.ok(!modelEnum.includes('muse-spark-1.3-contributor'));
    assert.ok(!modelEnum.includes('glm-5.3-flash'));
    assert.ok(!modelEnum.includes('glm-5.3'));
  }
  for (const name of ['quebragalho_route', 'quebragalho_agent', 'quebragalho_agent_start']) {
    const schema = listed.tools.find((tool) => tool.name === name).inputSchema;
    const modelEnum = schema.properties.model?.enum
      ?? schema.properties.exclude_models.items.enum;
    assert.ok(!modelEnum.includes('muse-spark-1.3-contributor'));
    assert.ok(!modelEnum.includes('glm-5.3-flash'));
    assert.ok(!modelEnum.includes('glm-5.3'));
  }

  const modelsResource = await client.readResource({ uri: 'quebragalho://models' });
  const modelIds = JSON.parse(modelsResource.contents[0].text)
    .map((model) => model.id);
  assert.ok(!modelIds.includes('muse-spark-1.3-contributor'));
  assert.ok(!modelIds.includes('glm-5.3-flash'));
  assert.ok(!modelIds.includes('glm-5.3'));

  const staleDirectCall = await client.callTool({
    name: 'quebragalho_muse_spark_1_3_contributor',
    arguments: { prompt: 'não deve executar' },
  });
  assert.equal(staleDirectCall.isError, true);
  assert.match(staleDirectCall.content[0].text, /DENYLIST/);

  const staleGlm52Call = await client.callTool({
    name: 'quebragalho_glm_5_3',
    arguments: { prompt: 'não deve executar' },
  });
  assert.equal(staleGlm52Call.isError, true);
  assert.match(staleGlm52Call.content[0].text, /DENYLIST/);

  const deniedAsyncCall = await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: {
      prompt: 'não deve enfileirar',
      cwd: repo,
      model: 'glm-5.3-flash',
    },
  });
  assert.equal(deniedAsyncCall.isError, true);
  assert.match(deniedAsyncCall.content[0].text, /DENYLIST/);
  assert.equal(JSON.parse(deniedAsyncCall.content[0].text).job_id, undefined);

  const deniedGlm52Call = await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: {
      prompt: 'não deve enfileirar',
      cwd: repo,
      model: 'glm-5.3',
    },
  });
  assert.equal(deniedGlm52Call.isError, true);
  assert.match(deniedGlm52Call.content[0].text, /DENYLIST/);
  assert.equal(JSON.parse(deniedGlm52Call.content[0].text).job_id, undefined);
});

test('MCP inclui modelos premium no roteamento somente com opt-in e informa a configuração', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4-pro',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4-pro',
      QUEBRAGALHO_MODEL_TIERS: 'max',
      QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS: '1',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const routed = await client.callTool({
    name: 'quebragalho_route',
    arguments: {
      prompt: 'Implemente uma refatoração grande com testes.',
      mode: 'write',
      executor: 'native',
    },
  });
  assert.notEqual(routed.isError, true);
  const routePayload = JSON.parse(routed.content[0].text);
  assert.equal(routePayload.selected_model, 'deepseek-v4-pro');
  assert.equal(routePayload.auto_include_premium_models, true);

  const statusRead = await client.readResource({ uri: 'quebragalho://status' });
  const statusPayload = JSON.parse(statusRead.contents[0].text);
  assert.equal(statusPayload.auto_include_premium_models, true);
});

test('MCP quebragalho_agent_start enfileira e quebragalho_job cancela execução em andamento', async (t) => {
  const repo = path.resolve('.');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-agent-'));
  const fakeAgent = path.join(fixture, 'fake-agent.mjs');
  await writeFile(
    fakeAgent,
    [
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
      QUEBRAGALHO_CODE_BIN: process.execPath,
      QUEBRAGALHO_CODE_ENTRYPOINT: fakeAgent,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  // quebragalho_agent_start
  const enqueued = await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: { prompt: 'lista arquivos', cwd: repo, mode: 'read_only', timeout_seconds: 30 },
  });
  const enqueuedPayload = JSON.parse(enqueued.content[0].text);
  assert.ok(enqueuedPayload.job_id);
  assert.equal(enqueuedPayload.error, undefined);

  let runningPayload;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const runningResult = await client.callTool({
      name: 'quebragalho_job',
      arguments: { action: 'status', job_id: enqueuedPayload.job_id },
    });
    runningPayload = JSON.parse(runningResult.content[0].text);
    if (runningPayload.status === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(runningPayload.status, 'running');

  // quebragalho_job action=cancel — cancela deterministicamente o agente fake.
  const cancelResult = await client.callTool({
    name: 'quebragalho_job',
    arguments: { action: 'cancel', job_id: enqueuedPayload.job_id },
  });
  const cancelPayload = JSON.parse(cancelResult.content[0].text);
  assert.equal(cancelPayload.status, 'cancelled');

  // quebragalho_job action=status
  const statusResult = await client.callTool({
    name: 'quebragalho_job',
    arguments: { action: 'status', job_id: enqueuedPayload.job_id },
  });
  const statusPayload = JSON.parse(statusResult.content[0].text);
  assert.equal(statusPayload.status, 'cancelled');
  assert.ok(statusPayload.finished_at, 'cancelled deve ter finished_at');

  // quebragalho_job action=list
  const listResult = await client.callTool({
    name: 'quebragalho_job',
    arguments: { action: 'list' },
  });
  const listPayload = JSON.parse(listResult.content[0].text);
  assert.ok(Array.isArray(listPayload.jobs));

  // quebragalho_job action=result com job inexistente
  const missingResult = await client.callTool({
    name: 'quebragalho_job',
    arguments: { action: 'result', job_id: '00000000-0000-0000-0000-000000000000' },
  });
  const missingPayload = JSON.parse(missingResult.content[0].text);
  assert.equal(missingPayload.error, 'NOT_FOUND');
  assert.equal(missingResult.isError, true);
});

test('MCP SIGTERM repetido encerra uma vez, persiste jobs e não deixa runner órfão', {
  skip: process.platform === 'win32',
}, async (t) => {
  const repo = path.resolve('.');
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-shutdown-'));
  const storeDir = path.join(fixture, 'jobs');
  const fakeAgent = path.join(fixture, 'fake-agent.mjs');
  const runnerPidFile = path.join(fixture, 'runner.pid');
  const bridgeExitFile = path.join(fixture, 'bridge-exit.json');
  const bridgeWrapper = path.join(fixture, 'bridge-wrapper.mjs');
  await writeFile(
    fakeAgent,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));`,
      "process.on('SIGTERM', () => process.exit(0));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  await writeFile(
    bridgeWrapper,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const child = spawn(process.execPath, [${JSON.stringify(path.join(repo, 'index.mjs'))}], {`,
      "  env: process.env,",
      "  stdio: 'inherit',",
      '});',
      "process.on('SIGTERM', () => child.kill('SIGTERM'));",
      "child.on('exit', (code, signal) => {",
      `  writeFileSync(${JSON.stringify(bridgeExitFile)}, JSON.stringify({ code, signal }));`,
      '  process.exitCode = code ?? 1;',
      '});',
    ].join('\n'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeWrapper],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
      QUEBRAGALHO_CODE_BIN: process.execPath,
      QUEBRAGALHO_CODE_ENTRYPOINT: fakeAgent,
      QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '1',
      QUEBRAGALHO_JOB_STORE_DIR: storeDir,
      QUEBRAGALHO_JOB_SHUTDOWN_TIMEOUT_MS: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    try { await client.close(); } catch {}
    await import('node:fs/promises').then(({ rm }) => rm(fixture, { recursive: true, force: true }));
  });
  await client.connect(transport);

  const running = JSON.parse((await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: { prompt: 'running', cwd: repo, mode: 'read_only', timeout_seconds: 30 },
  })).content[0].text);
  let runningStatus;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    runningStatus = JSON.parse((await client.callTool({
      name: 'quebragalho_job',
      arguments: { action: 'status', job_id: running.job_id },
    })).content[0].text);
    if (runningStatus.status === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runningStatus.status, 'running');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(runnerPidFile);
      break;
    } catch {
      if (attempt === 199) throw new Error('runner fake não iniciou');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const queued = JSON.parse((await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: { prompt: 'queued', cwd: repo, mode: 'read_only', timeout_seconds: 30 },
  })).content[0].text);
  const wrapperPid = transport.pid;
  const closed = new Promise((resolve) => { client.onclose = resolve; });
  process.kill(wrapperPid, 'SIGTERM');
  process.kill(wrapperPid, 'SIGTERM');
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('bridge não encerrou após SIGTERM')),
      5_000,
    )),
  ]);

  assert.throws(() => process.kill(wrapperPid, 0), { code: 'ESRCH' });
  assert.match(stderr, /Shutdown da fila excedeu o tempo limite/);
  const { readFile } = await import('node:fs/promises');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(bridgeExitFile);
      break;
    } catch {
      if (attempt === 99) throw new Error('wrapper não registrou a saída do bridge');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.deepEqual(JSON.parse(await readFile(bridgeExitFile, 'utf8')), {
    code: 1,
    signal: null,
  });
  for (const jobId of [running.job_id, queued.job_id]) {
    const stored = JSON.parse(await readFile(path.join(storeDir, `${jobId}.json`), 'utf8'));
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.error.code, 'BRIDGE_SHUTDOWN');
  }
  const runnerPid = Number(await readFile(runnerPidFile, 'utf8'));
  assert.throws(() => process.kill(runnerPid, 0), { code: 'ESRCH' });
});

test('MCP transport close aciona um único shutdown', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => {
    try { await client.close(); } catch {}
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);

  const stderrEnded = new Promise((resolve) => transport.stderr.once('end', resolve));
  const closed = new Promise((resolve) => { client.onclose = resolve; });
  await transport.close();
  await closed;
  await stderrEnded;
  assert.equal(
    stderr.match(/Encerrando bridge/g)?.length,
    1,
    `shutdown deveria iniciar uma vez, stderr: ${stderr}`,
  );
});

test('MCP quebragalho://status resource contem capacity/queued/running/total', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const resources = await client.listResources();
  const statusResource = resources.resources.find((r) => r.uri === 'quebragalho://status');
  assert.ok(statusResource);

  const statusRead = await client.readResource({ uri: 'quebragalho://status' });
  const statusPayload = JSON.parse(statusRead.contents[0].text);
  assert.ok(statusPayload.version);
  assert.ok(statusPayload.job_queue);
  assert.equal(typeof statusPayload.job_queue.concurrency, 'number');
  assert.equal(typeof statusPayload.job_queue.queued, 'number');
  assert.equal(typeof statusPayload.job_queue.running, 'number');
  assert.equal(typeof statusPayload.job_queue.total, 'number');
  assert.equal(statusPayload.auto_include_premium_models, false);
});


function makeValidateClientEnv(extra) {
  return {
    ...process.env,
    QUEBRAGALHO_API_KEY: 'test-key',
    QUEBRAGALHO_MEMORY_ENABLED: '0',
    ...extra,
  };
}

async function connectValidateClient(t, env) {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);
  return client;
}

async function callValidate(client, cwd, commands, extra = {}) {
  const result = await client.callTool({
    name: 'quebragalho_validate',
    arguments: { cwd, commands, ...extra },
  });
  return { result, payload: JSON.parse(result.content[0].text) };
}

// Fake npm controlado: NUNCA roda o npm real nem scripts do repositório.
// Imprime o próprio caminho, o node real, HOME e a presença da API key,
// provando executáveis fixados, isolamento de env e precedência de PATH.
const FAKE_NPM_SCRIPT = [
  '#!/usr/bin/env should-not-run',
  "console.log(`FAKE_NPM_PATH:${process.argv[1]}`);",
  "console.log(`FAKE_NODE_PATH:${process.execPath}`);",
  "console.log(`FAKE_NPM_HOME:${process.env.HOME}`);",
  "console.log(`FAKE_NPM_KEY:${process.env.QUEBRAGALHO_API_KEY ?? 'empty'}`);",
  "const args = process.argv.slice(2).join(' ');",
  "if (args === 'run fail') process.exit(3);",
  "if (args === 'run big') process.stdout.write('x'.repeat(70000));",
  "if (args === 'run huge') process.stdout.write('x'.repeat(2_200_000));",
  "if (args === 'run slow') setTimeout(() => {}, 30000);",
  "if (args === 'run stubborn') { process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000); }",
  "if (args === 'run leak') console.log('Bearer abcdef123456');",
  '',
].join('\n');

async function makeValidateFixture() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-validate-'));
  const binDir = path.join(fixture, 'bin');
  const hijackDir = path.join(fixture, 'bin-hijack');
  const projectDir = path.join(fixture, 'proj');
  await mkdir(binDir, { recursive: true });
  await mkdir(hijackDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  symlinkSync(process.execPath, path.join(binDir, 'node'));
  await writeFile(path.join(binDir, 'npm'), FAKE_NPM_SCRIPT, { mode: 0o755 });
  await writeFile(
    path.join(hijackDir, 'npm'),
    '#!/bin/sh\necho "HIJACKED_NPM:$0"\nexit 0\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(hijackDir, 'should-not-run'),
    '#!/bin/sh\necho "HIJACKED_SHEBANG:$0"\nexit 0\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(projectDir, 'ok.js'), 'module.exports = 1;\n');
  return { fixture, binDir, hijackDir, projectDir };
}

function validateEnv(binDir, projectDir, extra = {}) {
  return makeValidateClientEnv({
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: projectDir,
    QUEBRAGALHO_AGENT_VERIFY_ENABLED: '1',
    QUEBRAGALHO_AGENT_VERIFY_NPM_SCRIPTS: 'ok,fail,big,huge,slow,stubborn,leak',
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...extra,
  });
}

test('MCP quebragalho_validate falha fechado sem opt-in e anota ação não read-only', async (t) => {
  const repo = path.resolve('.');
  const client = await connectValidateClient(t, makeValidateClientEnv({
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
    QUEBRAGALHO_AGENT_VERIFY_ENABLED: '0',
  }));

  const listed = await client.listTools();
  const validateTool = listed.tools.find((tool) => tool.name === 'quebragalho_validate');
  assert.ok(validateTool);
  assert.match(validateTool.description, /QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1/);
  assert.match(validateTool.description, /Não é read-only/);
  assert.match(validateTool.description, /shell:false/);
  assert.match(validateTool.description, /Sem isolamento de filesystem ou rede/);
  assert.match(validateTool.description, /mesmo usuário do bridge/);
  assert.match(validateTool.description, /Nunca oferece comandos de commit, push, publish ou deploy/);
  assert.deepEqual(
    validateTool.inputSchema.properties.commands.items.properties.cmd.enum,
    ['npm', 'node', 'git'],
  );
  assert.equal(validateTool.inputSchema.properties.stop_on_failure.default, true);
  assert.equal(validateTool.annotations?.readOnlyHint, false);
  assert.equal(validateTool.annotations?.destructiveHint, true);
  assert.equal(validateTool.annotations?.openWorldHint, true);

  const { result, payload } = await callValidate(client, repo, [
    { cmd: 'node', args: ['--check', 'index.mjs'] },
  ]);
  assert.equal(result.isError, true);
  assert.equal(payload.status, 'error');
  assert.match(payload.error, /QUEBRAGALHO_AGENT_VERIFY_ENABLED=1/);
});

test('MCP quebragalho_validate git estático não executa fsmonitor do repositório', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const initialized = spawnSync('git', ['init', '--quiet', projectDir]);
  assert.equal(initialized.status, 0, initialized.stderr.toString());
  const marker = path.join(projectDir, 'fsmonitor-executed');
  const fsmonitor = path.join(projectDir, '.git', 'malicious-fsmonitor');
  await writeFile(
    fsmonitor,
    `#!/bin/sh\nprintf executed > "${marker}"\nprintf 'last_update_token=\\n'\n`,
    { mode: 0o755 },
  );
  const configured = spawnSync('git', ['-C', projectDir, 'config', 'core.fsmonitor', fsmonitor]);
  assert.equal(configured.status, 0, configured.stderr.toString());

  const client = await connectValidateClient(t, validateEnv(binDir, projectDir));
  const { result, payload } = await callValidate(client, projectDir, [
    { cmd: 'git', args: ['status', '--porcelain=v1'] },
  ]);

  assert.equal(result.isError, false);
  assert.equal(payload.status, 'ok');
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('MCP quebragalho_validate separa perfil estático de project-code com segundo gate', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '0' }),
  );

  const projectCode = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['test'] },
  ]);
  assert.equal(projectCode.result.isError, true);
  assert.equal(projectCode.payload.status, 'error');
  assert.match(projectCode.payload.error, /QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1/);
  assert.deepEqual(projectCode.payload.executed, []);

  const staticProfile = await callValidate(client, projectDir, [
    { cmd: 'node', args: ['--check', 'ok.js'] },
  ]);
  assert.equal(staticProfile.payload.status, 'ok');
  assert.equal(staticProfile.payload.results[0].exit_code, 0);
});

test('MCP quebragalho_validate executa binário resolvido e rejeita política adversarial', async (t) => {
  const { binDir, hijackDir, projectDir } = await makeValidateFixture();
  // O npm permitido vem primeiro, mas seu shebang aponta para um interpretador
  // disponível apenas em hijackDir. Executá-lo com node absoluto deve ignorar
  // tanto o npm adversarial quanto o shebang adversarial.
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, {
      QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '1',
      PATH: `${binDir}${path.delimiter}${hijackDir}${path.delimiter}${process.env.PATH}`,
    }),
  );
  const expectedNpm = realpathSync(path.join(binDir, 'npm'));
  const expectedNode = realpathSync(path.join(binDir, 'node'));

  const happy = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['test'] },
    { cmd: 'npm', args: ['run', 'ok'] },
    { cmd: 'node', args: ['--check', 'ok.js'] },
  ]);
  assert.equal(happy.payload.status, 'ok');
  assert.deepEqual(happy.payload.results.map((item) => item.exit_code), [0, 0, 0]);

  const stdout = happy.payload.results[0].stdout;
  assert.ok(
    stdout.includes(`FAKE_NPM_PATH:${expectedNpm}`),
    `binário executado deve ser o resolvido (${expectedNpm}), stdout: ${stdout}`,
  );
  assert.ok(
    stdout.includes(`FAKE_NODE_PATH:${expectedNode}`),
    `npm deve executar com o node absoluto resolvido (${expectedNode})`,
  );
  assert.ok(!stdout.includes('HIJACKED_NPM'), 'PATH hijack não pode vencer a resolução');
  assert.ok(!stdout.includes('HIJACKED_SHEBANG'), 'shebang do npm não pode escolher outro interpretador');
  assert.ok(stdout.includes('FAKE_NPM_KEY:empty'), 'env do filho não pode conter QUEBRAGALHO_API_KEY');
  assert.ok(stdout.includes('quebragalho-verify-home-'), 'HOME do filho deve ser isolado');
  assert.ok(!stdout.includes(`FAKE_NPM_HOME:${os.homedir()}`), 'HOME real do host vazou');

  symlinkSync('/etc/passwd', path.join(projectDir, 'link-escape.js'));
  const denials = [
    { cmd: 'bash', args: ['-c', 'id'] },
    { cmd: 'sh', args: ['-c', 'id'] },
    { cmd: 'npx', args: ['--no-install', 'jest'] },
    { cmd: 'npm', args: ['run', 'evil'] },
    { cmd: 'npm', args: ['test', '--', '--watch'] },
    { cmd: 'npm', args: ['install', 'left-pad'] },
    { cmd: 'node', args: ['-e', 'process.exit(0)'] },
    { cmd: 'node', args: ['--check', '../outside.js'] },
    { cmd: 'node', args: ['--check', '/etc/passwd'] },
    { cmd: 'node', args: ['--check', 'link-escape.js'] },
    { cmd: 'git', args: ['push'] },
    { cmd: 'git', args: ['config', 'user.email', 'x@y.z'] },
    { cmd: 'git', args: ['status', '--porcelain=v1', ';', 'rm', '-rf', '/'] },
  ];
  for (const bad of denials) {
    const { result, payload } = await callValidate(client, projectDir, [bad]);
    assert.equal(result.isError, true, `deveria negar: ${bad.cmd} ${bad.args.join(' ')}`);
    assert.equal(payload.status, 'error');
    assert.deepEqual(payload.executed, []);
    assert.ok(!String(payload.error).includes(projectDir), 'erro não expõe path interno');
  }
});

test('MCP quebragalho_validate stop_on_failure, timeout total, truncamento e redaction', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '1' }),
  );

  const stopped = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'fail'] },
    { cmd: 'npm', args: ['run', 'ok'] },
  ]);
  assert.equal(stopped.payload.status, 'failed');
  assert.equal(stopped.payload.stopped_early, true);
  assert.equal(stopped.payload.results.length, 1);
  assert.equal(stopped.payload.results[0].exit_code, 3);

  const continued = await callValidate(
    client,
    projectDir,
    [
      { cmd: 'npm', args: ['run', 'fail'] },
      { cmd: 'npm', args: ['run', 'ok'] },
    ],
    { stop_on_failure: false },
  );
  assert.equal(continued.payload.status, 'failed');
  assert.equal(continued.payload.stopped_early, false);
  assert.equal(continued.payload.results.length, 2);
  assert.equal(continued.payload.results[1].exit_code, 0);

  const timed = await callValidate(
    client,
    projectDir,
    [{ cmd: 'npm', args: ['run', 'slow'] }],
    { timeout_seconds: 1 },
  );
  assert.equal(timed.payload.status, 'failed');
  assert.equal(timed.payload.results[0].timed_out, true);
  assert.ok(
    timed.payload.results[0].duration_ms < 20000,
    `processo deveria ser cancelado cedo: ${timed.payload.results[0].duration_ms}ms`,
  );

  // Timeout TOTAL: comando que ignora SIGTERM estoura o orçamento da sequência
  // (deadline = 1s por comando × 2), e o segundo comando nem inicia.
  const total = await callValidate(
    client,
    projectDir,
    [
      { cmd: 'npm', args: ['run', 'stubborn'] },
      { cmd: 'npm', args: ['run', 'ok'] },
    ],
    { timeout_seconds: 1, stop_on_failure: false },
  );
  assert.equal(total.payload.status, 'failed');
  assert.equal(total.payload.stop_reason, 'total_timeout');
  assert.equal(total.payload.results.length, 1);
  assert.equal(total.payload.results[0].timed_out, true);

  const big = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'big'] },
  ]);
  assert.equal(big.payload.results[0].stdout_truncated, true);
  assert.ok(big.payload.results[0].stdout.length <= 8192);

  const leak = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'leak'] },
  ]);
  assert.equal(leak.payload.status, 'ok');
  assert.ok(!leak.payload.results[0].stdout.includes('abcdef123456'));
  assert.match(leak.payload.results[0].stdout, /Bearer <redacted>/);
});

test('MCP falha fechado com MODEL_POLICY_EMPTY quando política exclui todos os modelos', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MODEL_ALLOWLIST: '',
      QUEBRAGALHO_MODEL_DENYLIST: Object.keys(MODEL_CATALOG).join(','),
      QUEBRAGALHO_MODEL_TIERS: 'pro,max,ultra',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name);
  // Tools dependentes de modelo não são expostas
  assert.ok(!toolNames.includes('quebragalho_code'), 'quebragalho_code não deve existir com política vazia');
  assert.ok(!toolNames.includes('quebragalho_review'), 'quebragalho_review não deve existir com política vazia');
  assert.ok(!toolNames.includes('quebragalho_route'), 'quebragalho_route não deve existir com política vazia');
  // Tools não-modelo permanecem disponíveis
  assert.ok(toolNames.includes('quebragalho_agent'));
  assert.ok(toolNames.includes('quebragalho_agent_start'));
  assert.ok(toolNames.includes('quebragalho_job'));
  assert.ok(toolNames.includes('quebragalho_memory'));
  assert.ok(toolNames.includes('quebragalho_validate'));

  // Recurso quebragalho://models retorna erro MODEL_POLICY_EMPTY
  const modelsResource = await client.readResource({ uri: 'quebragalho://models' });
  const modelsPayload = JSON.parse(modelsResource.contents[0].text);
  assert.equal(modelsPayload.error, 'MODEL_POLICY_EMPTY');

  const direct = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'não executar' },
  });
  assert.equal(direct.isError, true);
  assert.match(direct.content[0].text, /MODEL_POLICY_EMPTY/);

  await assert.rejects(
    client.getPrompt({
      name: 'explicar',
      arguments: { codigo: 'const x = 1;' },
    }),
    /MODEL_POLICY_EMPTY/,
  );
});

test('MCP quebragalho_validate saída >1 MiB é truncada corretamente', async (t) => {
  const { binDir, projectDir } = await makeValidateFixture();
  const client = await connectValidateClient(
    t,
    validateEnv(binDir, projectDir, { QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED: '1' }),
  );

  const huge = await callValidate(client, projectDir, [
    { cmd: 'npm', args: ['run', 'huge'] },
  ]);
  assert.equal(huge.payload.status, 'ok');
  assert.equal(huge.payload.results[0].exit_code, 0);
  assert.equal(huge.payload.results[0].stdout_truncated, true);
  assert.ok(
    huge.payload.results[0].stdout.length <= 8192,
    `saída deve ser truncada em 8 KiB, recebido ${huge.payload.results[0].stdout.length}`,
  );
});

test('MCP sincroniza catálogo via GET /models quando QUEBRAGALHO_MODEL_SYNC=1', async (t) => {
  const repo = path.resolve('.');
  let receivedAuth = null;
  const gateway = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      receivedAuth = req.headers.authorization ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'modelo-novo-sync', object: 'model' },
          { id: 'deepseek-v4.1-flash', context_length: 262144 },
        ],
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${gateway.address().port}/v1`,
      QUEBRAGALHO_MODEL_SYNC: '1',
      QUEBRAGALHO_API_TIMEOUT_MS: '5000',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => {
    try { await client.close(); } catch {}
    // O fetch do bridge usa keep-alive; destruir os sockets evita que
    // gateway.close() espere o timeout de keep-alive do undici.
    gateway.closeAllConnections?.();
    await new Promise((resolve) => gateway.close(resolve));
  });
  await client.connect(transport);

  // O sync roda pós-connect no bridge: polling no status até concluir
  // (ran_at não-nulo e sem erro), com teto de ~5s.
  let statusPayload;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const statusRead = await client.readResource({ uri: 'quebragalho://status' });
    statusPayload = JSON.parse(statusRead.contents[0].text);
    if (statusPayload.model_sync?.ran_at != null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(statusPayload.model_sync.enabled, true);
  assert.ok(statusPayload.model_sync.ran_at, 'sync deveria ter rodado após o connect');
  assert.equal(statusPayload.model_sync.error, null);
  assert.deepEqual(statusPayload.model_sync.added, ['modelo-novo-sync']);
  assert.deepEqual(statusPayload.model_sync.updated, ['deepseek-v4.1-flash']);
  assert.equal(statusPayload.model_sync.total, 18);
  assert.equal(receivedAuth, 'Bearer test-key');

  const modelsRead = await client.readResource({ uri: 'quebragalho://models' });
  const models = JSON.parse(modelsRead.contents[0].text);

  const novo = models.find((m) => m.id === 'modelo-novo-sync');
  assert.ok(novo, 'modelo novo do sync deve aparecer no recurso');
  assert.equal(novo.source, 'synced');
  assert.equal(novo.tier, 'pro');
  assert.equal(novo.context_window, 131072);
  assert.equal(novo.max_output, 8192);

  const deepseek = models.find((m) => m.id === 'deepseek-v4.1-flash');
  assert.equal(deepseek.context_window, 262144, 'ctx do deepseek deve adotar o valor do sync');
  assert.equal(deepseek.tier, 'pro', 'metadados locais são preservados');
  assert.equal(deepseek.source, 'synced');

  const glm = models.find((m) => m.id === 'glm-5.3');
  assert.ok(glm, 'modelo local ausente do remoto é mantido');
  assert.equal(glm.source, 'local');
});

test('MCP sem QUEBRAGALHO_MODEL_SYNC não sincroniza e informa model_sync desabilitado', async (t) => {
  const repo = path.resolve('.');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
      QUEBRAGALHO_MEMORY_ENABLED: '0',
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => client.close());
  await client.connect(transport);

  const statusRead = await client.readResource({ uri: 'quebragalho://status' });
  const statusPayload = JSON.parse(statusRead.contents[0].text);
  assert.deepEqual(statusPayload.model_sync, { enabled: false, ran_at: null, error: null });

  const modelsRead = await client.readResource({ uri: 'quebragalho://models' });
  const models = JSON.parse(modelsRead.contents[0].text);
  assert.ok(models.every((m) => m.source === 'local'));
});

// ── P1-2/P1-3: rastreio de uso (quebragalho://usage) e guard de orçamento ──

function startUsageGateway() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'deepseek-v4.1-flash',
        choices: [{ message: { role: 'assistant', content: 'resposta do gateway fake' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      }));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function connectUsageBridge(t, server, usageDir, extraEnv = {}) {
  const repo = path.resolve('.');
  const { port } = server.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'index.mjs')],
    env: {
      ...process.env,
      QUEBRAGALHO_API_KEY: 'test-key',
      QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${port}/v1`,
      QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      QUEBRAGALHO_MODEL_TIERS: 'pro',
      QUEBRAGALHO_MEMORY_ENABLED: '0',
      QUEBRAGALHO_USAGE_DIR: usageDir,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'quebragalho-bridge-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => {
    try { await client.close(); } catch { /* já fechado */ }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect(transport);
  return client;
}

// Pré-popula o JSONL do dia corrente com 1 requisição deepseek (in * 0.14/M).
async function preencherGasto(usageDir, inTokens) {
  await mkdir(usageDir, { recursive: true });
  const file = usageFileForDate({ QUEBRAGALHO_USAGE_DIR: usageDir }, todayLocalDate());
  await writeFile(file, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    model: 'deepseek-v4.1-flash',
    executor: 'direct',
    in_tokens: inTokens,
    out_tokens: 0,
    requests: 1,
  })}\n`);
}

test('MCP grava usage de quebragalho_code e reflete em quebragalho://usage', async (t) => {
  const gateway = await startUsageGateway();
  const usageDir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-usage-ok-'));
  const client = await connectUsageBridge(t, gateway, usageDir, {
    QUEBRAGALHO_MAX_SPEND_USD: '100',
  });

  const listed = await client.listResources();
  assert.ok(listed.resources.some((resource) => resource.uri === 'quebragalho://usage'));

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'tarefa confidencial que nao pode ser persistida' },
  });
  assert.notEqual(result.isError, true);

  // Gravação é fire-and-forget: consulta o recurso até a linha aparecer.
  let payload;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await client.readResource({ uri: 'quebragalho://usage' });
    payload = JSON.parse(read.contents[0].text);
    if ((payload.days.at(-1).total.requests ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(payload.today, todayLocalDate());
  assert.equal(payload.days.length, 7);
  assert.equal(payload.max_spend_usd, 100);
  assert.equal(payload.budget_exceeded, false);
  assert.deepEqual(payload.days.at(-1).models['deepseek-v4.1-flash'], {
    in_tokens: 1000,
    out_tokens: 500,
    requests: 1,
  });
  assert.deepEqual(payload.days.at(-1).total, {
    in_tokens: 1000,
    out_tokens: 500,
    requests: 1,
  });
  // 1000*0.14/M + 500*0.56/M = 0.00042 USD.
  assert.ok(
    Math.abs(payload.spend_today_usd - 0.00042) < 1e-9,
    `spend inesperado: ${payload.spend_today_usd}`,
  );

  // Contrato de conteúdo do JSONL: somente contadores/identificadores; o prompt
  // nunca é persistido.
  const file = usageFileForDate({ QUEBRAGALHO_USAGE_DIR: usageDir }, todayLocalDate());
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('confidencial'), 'prompt não pode vazar para o diário de uso');
  for (const line of raw.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(), [
      'executor', 'in_tokens', 'model', 'out_tokens', 'requests', 'timestamp',
    ]);
    assert.equal(entry.executor, 'direct');
  }
});

test('MCP bloqueia com BUDGET_EXCEEDED quando o gasto atinge o teto', async (t) => {
  const gateway = await startUsageGateway();
  const usageDir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-usage-cap-'));
  // 100.000 in * 0.14/M = 0.014 USD contra teto de 0.01 USD.
  await preencherGasto(usageDir, 100_000);
  const repo = path.resolve('.');
  const client = await connectUsageBridge(t, gateway, usageDir, {
    QUEBRAGALHO_MAX_SPEND_USD: '0.01',
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repo,
  });

  const code = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'não deve gastar' },
  });
  assert.equal(code.isError, true);
  assert.match(code.content[0].text, /BUDGET_EXCEEDED/);
  assert.match(code.content[0].text, /QUEBRAGALHO_MAX_SPEND_USD/);
  assert.match(code.content[0].text, /virar o dia local/);

  const agent = await client.callTool({
    name: 'quebragalho_agent',
    arguments: { prompt: 'não deve executar', cwd: repo },
  });
  assert.equal(agent.isError, true);
  const agentPayload = JSON.parse(agent.content[0].text);
  assert.equal(agentPayload.status, 'error');
  assert.match(agentPayload.summary, /BUDGET_EXCEEDED/);
  assert.ok(
    agentPayload.next_actions.some((action) => /QUEBRAGALHO_MAX_SPEND_USD/.test(action)),
  );

  const agentStart = await client.callTool({
    name: 'quebragalho_agent_start',
    arguments: { prompt: 'não deve enfileirar', cwd: repo },
  });
  assert.equal(agentStart.isError, true);
  const startPayload = JSON.parse(agentStart.content[0].text);
  assert.match(startPayload.summary, /BUDGET_EXCEEDED/);
  assert.equal(startPayload.job_id, undefined, 'nada pode ser enfileirado sem orçamento');

  const usagePayload = JSON.parse(
    (await client.readResource({ uri: 'quebragalho://usage' })).contents[0].text,
  );
  assert.equal(usagePayload.budget_exceeded, true);

  // A chamada bloqueada não grava nova linha no diário.
  const file = usageFileForDate({ QUEBRAGALHO_USAGE_DIR: usageDir }, todayLocalDate());
  const linhas = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  assert.equal(linhas.length, 1);
});

test('MCP sem QUEBRAGALHO_MAX_SPEND_USD nada bloqueia (regressão)', async (t) => {
  const gateway = await startUsageGateway();
  const usageDir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-usage-free-'));
  await preencherGasto(usageDir, 100_000_000); // gasto alto acumulado
  const client = await connectUsageBridge(t, gateway, usageDir, {
    QUEBRAGALHO_MAX_SPEND_USD: '', // ausente/vazia = sem limite
  });

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'deve executar mesmo com gasto acumulado' },
  });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /resposta do gateway fake/);
  assert.ok(!result.content[0].text.includes('Aviso de orçamento'));

  const usagePayload = JSON.parse(
    (await client.readResource({ uri: 'quebragalho://usage' })).contents[0].text,
  );
  assert.equal(usagePayload.max_spend_usd, null);
  assert.equal(usagePayload.budget_exceeded, false);
});

test('MCP avisa no rodapé das tools diretas ao cruzar 80% do teto', async (t) => {
  const gateway = await startUsageGateway();
  const usageDir = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-mcp-usage-warn-'));
  // 6.000.000 in * 0.14/M = 0.84 USD = 84% do teto de 1 USD.
  await preencherGasto(usageDir, 6_000_000);
  const client = await connectUsageBridge(t, gateway, usageDir, {
    QUEBRAGALHO_MAX_SPEND_USD: '1',
  });

  const result = await client.callTool({
    name: 'quebragalho_code',
    arguments: { prompt: 'resposta com aviso' },
  });
  assert.notEqual(result.isError, true, '84% do teto avisa, não bloqueia');
  assert.match(
    result.content[0].text,
    /Aviso de orçamento: US\$ 0\.8400 de US\$ 1\.00 USD usados hoje/,
  );
});
