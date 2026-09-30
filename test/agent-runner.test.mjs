import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  allowedToolsForMode,
  assertGlobalModelAllowed,
  buildAgentInvocation,
  buildAgentSystemPrompt,
  buildOpenCodeInvocation,
  buildProgressOnLine,
  buildTaskkillInvocation,
  buildQuebragalhoCodeInvocation,
  buildChildEnv,
  createNativeEventParser,
  formatAgentFailure,
  globallyAllowedModels,
  normalizeAgentRequest,
  parseOpenCodeEvents,
  parseQuebragalhoCodeEvents,
  resolveAgentExecutor,
  resolveAllowedCwd,
  resolveNativeCliBin,
  resetAgentSlots,
  resetModelRuntimeState,
  runQuebragalhoAgent,
  waitForAgentSlot,
} from '../agent-runner.mjs';
import { readProjectMemory } from '../memory-store.mjs';
import { recordUsage, todayLocalDate, usageFileForDate } from '../usage-store.mjs';

const MODELS = ['deepseek-v4.1-flash', 'glm-5.3'];

function spawnFixture(command, args, options) {
  return process.platform === 'win32'
    ? spawn(process.execPath, [command, ...args], options)
    : spawn(command, args, options);
}

function spawnJsonlFixture(events) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${events.map(JSON.stringify).join('\n')}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
}

function spawnNativeTimeoutFixture(events, trailingLine = '') {
  return () => {
    const child = new EventEmitter();
    child.pid = 45123;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.write(`${events.map(JSON.stringify).join('\n')}\n${trailingLine}`);
    });
    return child;
  };
}

async function createStreamingJsonlFixture(base) {
  const script = path.join(base, 'stream-jsonl.mjs');
  await writeFile(script, [
    "import { once } from 'node:events';",
    'const targetBytes = Number(process.argv[2]);',
    'const lineFor = (padding) => JSON.stringify({ type: "system", subtype: "heartbeat", padding: "x".repeat(padding) }) + "\\n";',
    'const overhead = Buffer.byteLength(lineFor(0));',
    'const unitBytes = 64 * 1024;',
    'const unitLine = lineFor(unitBytes - overhead);',
    'let unitCount = Math.floor(targetBytes / unitBytes);',
    'let remainder = targetBytes - (unitCount * unitBytes);',
    'if (remainder > 0 && remainder < overhead) { unitCount -= 1; remainder += unitBytes; }',
    'const emit = async (line) => { if (!process.stdout.write(line)) await once(process.stdout, "drain"); };',
    'for (let index = 0; index < unitCount; index += 1) await emit(unitLine);',
    'if (remainder > 0) await emit(lineFor(remainder - overhead));',
    'await emit(JSON.stringify({ type: "result", session_id: "stream_limit", result: "Fluxo concluído." }) + "\\n");',
    'process.stdout.end();',
  ].join('\n'));
  return script;
}

function spawnStreamingJsonlFixture(script, targetBytes) {
  return (_command, _args, options) => spawn(
    process.execPath,
    [script, String(targetBytes)],
    options,
  );
}

test('normaliza request com defaults seguros', () => {
  assert.deepEqual(
    normalizeAgentRequest({ prompt: ' revise ', cwd: '/repo' }, MODELS),
    {
      prompt: 'revise',
      cwd: '/repo',
      mode: 'read_only',
      model: 'auto',
      timeoutSeconds: 600,
    },
  );
});

test('rejeita modelo, modo e timeout fora da allowlist', () => {
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', model: 'inventado' }, MODELS),
    /Modelo desconhecido/,
  );
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', mode: 'root' }, MODELS),
    /mode deve ser/,
  );
  assert.throws(
    () => normalizeAgentRequest({ prompt: 'x', cwd: '/repo', timeout_seconds: 2 }, MODELS),
    /timeout_seconds/,
  );
});

test('executor pode ser escolhido por chamada e usa native como padrão', () => {
  assert.equal(resolveAgentExecutor(undefined, {}), 'native');
  assert.equal(
    resolveAgentExecutor(undefined, { QUEBRAGALHO_AGENT_EXECUTOR: 'opencode' }),
    'opencode',
  );
  assert.equal(
    resolveAgentExecutor('native', { QUEBRAGALHO_AGENT_EXECUTOR: 'opencode' }),
    'native',
  );
  assert.equal(
    resolveAgentExecutor('opencode', { QUEBRAGALHO_AGENT_EXECUTOR: 'native' }),
    'opencode',
  );
  assert.throws(
    () => resolveAgentExecutor('inventado', {}),
    /executor deve ser/,
  );
});

test('cwd precisa estar dentro de uma raiz autorizada após realpath', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-agent-'));
  const allowed = path.join(base, 'allowed');
  const sibling = path.join(base, 'allowed-escape');
  const project = path.join(allowed, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(sibling);

  assert.equal(await resolveAllowedCwd(project, allowed), await realpath(project));
  await assert.rejects(() => resolveAllowedCwd(sibling, allowed), /fora das raízes/);
  await assert.rejects(() => resolveAllowedCwd(project, ''), /não foi configurada/);
});

test('invocação usa OpenCode puro e mantém prompt com aparência de opção como posicional', () => {
  const request = {
    prompt: '--file=/etc/passwd',
    cwd: '/repo',
    mode: 'write',
    model: 'glm-5.3',
  };
  const invocation = buildOpenCodeInvocation(request, '/opt/opencode');

  assert.equal(invocation.command, '/opt/opencode');
  assert.deepEqual(invocation.args.slice(0, 9), [
    'run',
    '--pure',
    '--format',
    'json',
    '--model',
    'quebragalho/glm-5.3',
    '--agent',
    'quebragalho-bridge-agent',
    '--dir',
  ]);
  assert.equal(invocation.args.at(-2), '--');
  assert.equal(invocation.args.at(-1), request.prompt);
  assert.ok(!invocation.args.includes('--dangerously-skip-permissions'));

  const config = JSON.parse(invocation.inlineConfig);
  const permission = config.agent['quebragalho-bridge-agent'].permission;
  assert.equal(permission['*'], 'deny');
  assert.equal(permission.bash, 'deny');
  assert.deepEqual(permission.read, {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '**/*.env': 'deny',
    '**/*.env.*': 'deny',
    '*.env.example': 'allow',
    '**/*.env.example': 'allow',
  });
  assert.deepEqual(permission.edit, permission.read);
});

test('read_only usa default deny e libera somente ferramentas de inspeção', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  const permission = JSON.parse(invocation.inlineConfig)
    .agent['quebragalho-bridge-agent'].permission;

  assert.equal(permission['*'], 'deny');
  assert.equal(permission.edit, 'deny');
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.external_directory, 'deny');
  for (const tool of ['glob', 'list']) {
    assert.equal(permission[tool], 'allow');
  }
  assert.equal(permission.grep, 'deny');
  assert.equal(permission.read['*.env'], 'deny');
  assert.equal(permission.read['**/*.env.*'], 'deny');
  assert.equal(permission.lsp, 'deny');
  assert.equal(permission.webfetch, 'deny');
  assert.equal(permission.task, 'deny');
});

test('invocação nativa usa Quebragalho Code headless com ferramentas delimitadas', () => {
  const request = {
    prompt: '--file=/etc/passwd',
    cwd: '/repo',
    mode: 'write',
    model: 'glm-5.3',
  };
  const invocation = buildQuebragalhoCodeInvocation(
    request,
    '/opt/node',
    '/opt/claude-code/cli.mjs',
  );

  assert.equal(invocation.executor, 'native');
  assert.equal(invocation.command, '/opt/node');
  assert.equal(invocation.args[0], '/opt/claude-code/cli.mjs');
  assert.ok(invocation.args.includes('stream-json'));
  assert.equal(
    invocation.args[invocation.args.indexOf('--permission-mode') + 1],
    'bypassPermissions',
  );
  assert.equal(
    invocation.args[invocation.args.indexOf('--model') + 1],
    'glm-5.3',
  );
  assert.ok(invocation.args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(!invocation.args.includes('--allowedTools'));
  const disallowed = invocation.args[
    invocation.args.indexOf('--disallowed-tools') + 1
  ].split(',');
  assert.ok(['Bash', 'WebFetch', 'Task', 'ToolSearch'].every(
    (tool) => disallowed.includes(tool),
  ));
  assert.ok(!disallowed.includes('Edit'));
  assert.ok(!disallowed.includes('Write'));
  assert.equal(invocation.args.at(-2), '--');
  assert.equal(invocation.args.at(-1), request.prompt);

  const settings = JSON.parse(invocation.args[invocation.args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.ok(settings.permissions.allow.includes('Read(/repo/**)'));
  assert.ok(settings.permissions.allow.includes('Edit(/repo/**)'));
  assert.ok(settings.permissions.allow.includes('Write(/repo/**)'));
  assert.ok(settings.permissions.deny.includes('Read(/repo/**/.env.*)'));
  assert.ok(settings.permissions.deny.includes('Bash'));
  assert.ok(settings.permissions.deny.includes('ToolSearch'));
});

test('invocação nativa read_only usa bypass sem liberar escrita', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  assert.equal(
    invocation.args[invocation.args.indexOf('--permission-mode') + 1],
    'bypassPermissions',
  );
  assert.equal(
    invocation.args[invocation.args.indexOf('--tools') + 1],
    'Read,Glob,Grep',
  );
  const disallowed = invocation.args[
    invocation.args.indexOf('--disallowed-tools') + 1
  ].split(',');
  assert.ok([
    'Edit',
    'Write',
    'Bash',
    'MultiEdit',
    'NotebookEdit',
    'TodoWrite',
    'Skill',
    'ToolSearch',
    'AskUserQuestion',
    'EnterPlanMode',
    'ListMcpResourcesTool',
  ].every((tool) => disallowed.includes(tool)));
  const settings = JSON.parse(invocation.args[invocation.args.indexOf('--settings') + 1]);
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.ok(settings.permissions.deny.includes('Edit'));
  assert.ok(settings.permissions.deny.includes('Write'));
  assert.ok(settings.permissions.deny.includes('Bash'));
  assert.ok(settings.permissions.deny.includes('ToolSearch'));
});

test('subprocesso desativa config de projeto e recebe apenas ambiente necessário', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      USERPROFILE: '/windows/profile',
      APPDATA: '/windows/appdata',
      LOCALAPPDATA: '/windows/localappdata',
      SystemRoot: '/windows',
      ComSpec: '/windows/cmd.exe',
      TEMP: '/windows/temp',
      TMP: '/windows/tmp',
      PATHEXT: '.EXE;.CMD',
      QUEBRAGALHO_API_KEY: 'qg-test-key',
      GITHUB_TOKEN: 'nao-deve-vazar',
      AWS_SECRET_ACCESS_KEY: 'nao-deve-vazar',
      OPENCODE_DISABLE_PROJECT_CONFIG: '0',
    },
    invocation,
  );

  assert.deepEqual(env, {
    HOME: '/home/test',
    PATH: '/bin',
    USERPROFILE: '/windows/profile',
    APPDATA: '/windows/appdata',
    LOCALAPPDATA: '/windows/localappdata',
    SystemRoot: '/windows',
    ComSpec: '/windows/cmd.exe',
    TEMP: '/windows/temp',
    TMP: '/windows/tmp',
    PATHEXT: '.EXE;.CMD',
    QUEBRAGALHO_API_KEY: 'qg-test-key',
    OPENCODE_CONFIG_CONTENT: invocation.inlineConfig,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  });
});

test('taskkill usa árvore, força encerramento e não abre shell', () => {
  const systemRoot = path.join(path.parse(process.cwd()).root, 'windows');
  const invocation = buildTaskkillInvocation(321, {
    env: { SystemRoot: systemRoot },
    realpathImpl: (value) => value,
  });
  assert.deepEqual(invocation, {
    command: path.join(systemRoot, 'System32', 'taskkill.exe'),
    args: ['/pid', '321', '/t', '/f'],
    options: {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    },
  });
  assert.throws(
    () => buildTaskkillInvocation(321, {
      env: { SystemRoot: systemRoot },
      realpathImpl: (value) => (
        value.endsWith('taskkill.exe')
          ? path.join(path.parse(systemRoot).root, 'tmp', 'taskkill.exe')
          : value
      ),
    }),
    (error) => error.code === 'TASKKILL_INVALID',
  );
});

test('executor nativo recebe credencial do gateway como ANTHROPIC sem vazar o resto', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      QUEBRAGALHO_API_KEY: 'qg-chave-do-gateway',
      QUEBRAGALHO_BASE_URL: 'https://api.quebragalho.dev/v1',
      GITHUB_TOKEN: 'nao-deve-vazar',
    },
    invocation,
  );

  assert.deepEqual(env, {
    HOME: '/home/test',
    PATH: '/bin',
    ANTHROPIC_BASE_URL: 'https://api.quebragalho.dev',
    ANTHROPIC_AUTH_TOKEN: 'qg-chave-do-gateway',
    QUEBRAGALHO_DISABLE_EARLY_INPUT: '1',
  });
});

test('executor nativo respeita ANTHROPIC_* explícito do servidor', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  const env = buildChildEnv(
    {
      HOME: '/home/test',
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://gateway-proprio.example',
      ANTHROPIC_AUTH_TOKEN: 'token-proprio',
    },
    invocation,
  );

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gateway-proprio.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token-proprio');
  assert.equal(env.QUEBRAGALHO_API_KEY, undefined);
});

test('parser retorna resposta final, sessão e artefatos internos', () => {
  const cwd = path.resolve('/repo');
  const artifact = path.join(cwd, 'src', 'app.js');
  const outside = path.join(path.parse(cwd).root, 'outside', 'passwd');
  const raw = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_123' }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        tool: 'read',
        state: { status: 'completed', input: { filePath: artifact } },
      },
    }),
    JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_123',
      part: {
        tool: 'read',
        state: { status: 'completed', input: { filePath: outside } },
      },
    }),
    JSON.stringify({
      type: 'text',
      sessionID: 'ses_123',
      part: { text: '<think>oculto</think>\nConcluído.' },
    }),
  ].join('\n');

  assert.deepEqual(parseOpenCodeEvents(raw, cwd), {
    sessionId: 'ses_123',
    result: 'Concluído.',
    artifacts: [artifact],
    toolsUsed: ['read'],
    successfulTools: ['read'],
  });
});

test('parser nativo confirma somente ferramentas concluídas e artefatos internos', () => {
  const cwd = path.resolve('/repo');
  const artifact = path.join(cwd, 'src', 'app.js');
  const outside = path.join(path.parse(cwd).root, 'outside', 'passwd');
  const raw = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native_123' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'native_123',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool_ok',
            name: 'Edit',
            input: { file_path: artifact },
          },
          {
            type: 'tool_use',
            id: 'tool_failed',
            name: 'Read',
            input: { file_path: outside },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      session_id: 'native_123',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_ok', content: 'ok' },
          {
            type: 'tool_result',
            tool_use_id: 'tool_failed',
            content: 'denied',
            is_error: true,
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      session_id: 'native_123',
      result: '<think>oculto</think>\nConcluído nativamente.',
    }),
  ].join('\n');

  assert.deepEqual(parseQuebragalhoCodeEvents(raw, cwd), {
    sessionId: 'native_123',
    result: 'Concluído nativamente.',
    artifacts: [artifact],
    toolsUsed: ['Edit', 'Read'],
    successfulTools: ['Edit'],
  });
});

test('write com edit falho retorna warning, não sucesso falso', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-warning-'));
  const fakeOpenCode = path.join(base, 'opencode');
  await writeFile(
    fakeOpenCode,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'tool_use',
  sessionID: 'ses_warning',
  part: {
    tool: 'edit',
    state: {
      status: 'error',
      input: { filePath: 'broken.js' },
      error: 'falhou'
    }
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'text',
  sessionID: 'ses_warning',
  part: { text: 'Eu criaria o arquivo.' }
}) + '\\n');
`,
  );
  await chmod(fakeOpenCode, 0o755);

  const result = await runQuebragalhoAgent(
    {
      prompt: 'crie um arquivo',
      cwd: base,
      executor: 'opencode',
      mode: 'write',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
        QUEBRAGALHO_AGENT_EXECUTOR: 'native',
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_OPENCODE_BIN: fakeOpenCode,
      },
      spawnImpl: spawnFixture,
    },
  );

  assert.equal(result.status, 'warning');
  assert.equal(result.executor, 'opencode');
  assert.match(result.summary, /nenhuma mudança foi confirmada/);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.tools_used, ['edit']);
});

test('write OpenCode confirma content tool_call concluído por tool_result', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-content-write-'));
  const fakeOpenCode = path.join(base, 'opencode');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${[
        {
          type: 'content',
          content_type: 'tool_call',
          sessionID: 'ses_content_write',
          name: 'Edit',
        },
        {
          type: 'tool_result',
          sessionID: 'ses_content_write',
          call_id: 'generated_on_result',
        },
        {
          type: 'text',
          sessionID: 'ses_content_write',
          part: { text: 'Alteração concluída.' },
        },
      ].map(JSON.stringify).join('\n')}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'edite um arquivo',
      cwd: base,
      executor: 'opencode',
      mode: 'write',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_OPENCODE_BIN: fakeOpenCode,
      },
      spawnImpl,
    },
  );

  assert.equal(result.status, 'success');
  assert.deepEqual(result.tools_used, ['Edit']);
});

test('write falha fechado sem feature gate server-side', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-write-gate-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      { prompt: 'edite um arquivo', cwd: base, mode: 'write' },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      },
    ),
    (error) => error.code === 'WRITE_DISABLED',
  );
});

test('executor opencode exige API key por chamada, mas native não', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-opencode-key-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      },
    ),
    (error) => error.code === 'QUEBRAGALHO_API_KEY_REQUIRED',
  );
});

test('runQuebragalhoAgent seleciona executor nativo e retorna contrato E2E', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-'));
  const fakeQuebragalho = path.join(base, 'quebragalho-code');
  await writeFile(
    fakeQuebragalho,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('status.txt', 'updated');
process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'native_run'
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'assistant',
  session_id: 'native_run',
  message: {
    content: [{
      type: 'tool_use',
      id: 'edit_1',
      name: 'Edit',
      input: { file_path: 'status.txt' }
    }]
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'user',
  session_id: 'native_run',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'edit_1',
      content: 'ok'
    }]
  }
}) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: 'native_run',
  result: 'Alteração concluída.'
}) + '\\n');
`,
  );
  await chmod(fakeQuebragalho, 0o755);

  const result = await runQuebragalhoAgent(
    {
      prompt: 'edite status.txt',
      cwd: base,
      executor: 'native',
      mode: 'write',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
        QUEBRAGALHO_AGENT_EXECUTOR: 'opencode',
        QUEBRAGALHO_CODE_BIN: fakeQuebragalho,
      },
      spawnImpl: spawnFixture,
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.executor, 'native');
  assert.equal(result.session_id, 'native_run');
  assert.deepEqual(result.tools_used, ['Edit']);
  assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'status.txt')]);
  assert.equal(await readFile(path.join(base, 'status.txt'), 'utf8'), 'updated');
});

test('issue #14 / PR #17: Edit real e Bash negada preservam contrato para revisão', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-denied-bash-'));
  const artifact = path.join(base, 'src', 'audit.md');
  const artifactEventPath = path.relative(base, artifact);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, 'audit');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${[
        {
          type: 'assistant', session_id: 'native_denied_bash', message: { content: [
            { type: 'tool_use', id: 'edit_1', name: 'Edit', input: { file_path: artifactEventPath } },
            { type: 'tool_use', id: 'bash_1', name: 'Bash', input: { command: 'pwd' } },
          ] },
        },
        {
          type: 'user', session_id: 'native_denied_bash', message: { content: [
            { type: 'tool_result', tool_use_id: 'edit_1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'bash_1', content: 'denied', is_error: true },
          ] },
        },
        {
          type: 'assistant', session_id: 'native_denied_bash', message: { content: [
            { type: 'tool_use', id: 'bash_2', name: 'Bash', input: { command: 'whoami' } },
          ] },
        },
        {
          type: 'user', session_id: 'native_denied_bash', message: { content: [
            { type: 'tool_result', tool_use_id: 'bash_2', content: 'denied', is_error: true },
          ] },
        },
        {
          type: 'result',
          session_id: 'native_denied_bash',
          result: 'Resultado canônico.',
          permission_denials: [
            { tool_name: 'Bash', tool_use_id: 'bash_1' },
            { tool_name: 'Bash', tool_use_id: 'bash_2' },
          ],
        },
      ].map(JSON.stringify).join('\n')}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'edite sem shell', cwd: base, executor: 'native', mode: 'write',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
      },
      spawnImpl,
    },
  );

  assert.equal(result.status, 'warning');
  assert.match(result.summary, /negadas/i);
  assert.match(result.summary, /alteração|artefato/i);
  assert.match(result.summary, /revis/i);
  assert.doesNotMatch(result.summary, /nenhuma mudança foi confirmada/i);
  assert.equal(result.result, 'Resultado canônico.');
  assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'src', 'audit.md')]);
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.executor, 'native');
});

test('PR #17: warning exige permission_denials exata no resultado final', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-denial-proof-'));
  const events = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'read_ok', name: 'Read' },
      { type: 'tool_use', id: 'bash_1', name: 'Bash' },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_ok', is_error: false },
      { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
    ] } },
  ];
  const run = (finalEvent) => runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnJsonlFixture([...events, finalEvent]),
    },
  );
  const finalResult = (permissionDenials, sessionId = 's1') => ({
    type: 'result',
    session_id: sessionId,
    result: 'Resultado.',
    ...(permissionDenials === undefined
      ? {}
      : { permission_denials: permissionDenials }),
  });

  await t.test('prova exata permite warning', async () => {
    const result = await run(finalResult([
      { tool_name: 'Bash', tool_use_id: 'bash_1' },
    ]));
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /negadas/i);
  });

  const invalidProofs = [
    ['permission_denials ausente', finalResult()],
    ['tool_use_id diferente', finalResult([
      { tool_name: 'Bash', tool_use_id: 'bash_other' },
    ])],
    ['tool_name diferente', finalResult([
      { tool_name: 'Read', tool_use_id: 'bash_1' },
    ])],
    ['sessão diferente', finalResult([
      { tool_name: 'Bash', tool_use_id: 'bash_1' },
    ], 's2')],
  ];
  for (const [name, finalEvent] of invalidProofs) {
    await t.test(name, async () => {
      await assert.rejects(
        () => run(finalEvent),
        (error) => error.code === 'FORBIDDEN_TOOL_USED',
      );
    });
  }
});

test('PR #17: result terminal encerra o fluxo nativo', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-terminal-result-'));
  const run = (events) => runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnJsonlFixture(events),
    },
  );
  const deniedBash = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'bash_1', name: 'Bash' },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
    ] } },
  ];
  const terminal = {
    type: 'result',
    session_id: 's1',
    result: 'Resultado.',
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'bash_1' }],
  };

  await t.test('tool_use rejeitada antes do result termina em warning', async () => {
    const result = await run([...deniedBash, terminal]);
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /negadas/i);
  });
  await t.test('permission_denial antecipada não autoriza tool_use posterior', async () => {
    await assert.rejects(
      () => run([terminal, ...deniedBash]),
      (error) => ['INVALID_EVENT', 'FORBIDDEN_TOOL_USED'].includes(error.code),
    );
  });
  await t.test('evento substantivo após result terminal é inválido', async () => {
    await assert.rejects(
      () => run([
        { type: 'result', session_id: 's1', result: 'Primeiro.' },
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'text', text: 'Texto tardio.' },
        ] } },
      ]),
      (error) => error.code === 'INVALID_EVENT',
    );
  });
  await t.test('segundo result terminal é inválido', async () => {
    await assert.rejects(
      () => run([
        { type: 'result', session_id: 's1', result: 'Primeiro.' },
        { type: 'result', session_id: 's1', result: 'Segundo.' },
      ]),
      (error) => error.code === 'INVALID_EVENT',
    );
  });
});

test('PR #17: ruído de Read não contamina negação explícita de Bash', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-denial-noise-'));
  const run = (noisyToolUseId) => runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnJsonlFixture([
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'read_1', name: 'Read' },
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'read_1', is_error: false },
          { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
          { type: 'tool_result', tool_use_id: noisyToolUseId, is_error: true },
        ] } },
        {
          type: 'result',
          session_id: 's1',
          result: 'Resultado.',
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 'bash_1' }],
        },
      ]),
    },
  );

  await t.test('tool_result duplicado de Read mantém warning', async () => {
    const result = await run('read_1');
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /negadas/i);
  });
  await t.test('tool_result duplicado de Bash mantém fail-closed', async () => {
    await assert.rejects(
      () => run('bash_1'),
      (error) => error.code === 'FORBIDDEN_TOOL_USED',
    );
  });
});

test('issue #14: Bash sem negação inequívoca por tentativa continua fail-closed', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-bash-proof-'));
  const allowedPrefix = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'read_ok', name: 'Read', input: { file_path: 'README.md' } },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_ok', content: 'ok' },
    ] } },
  ];
  const cases = [
    {
      name: 'sem tool_result',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
      ],
    },
    {
      name: 'tool_result bem-sucedido',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_1', is_error: false },
        ] } },
      ],
    },
    {
      name: 'Bash negada e Bash sem resultado',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_denied', name: 'Bash' },
          { type: 'tool_use', id: 'bash_missing', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_denied', is_error: true },
        ] } },
      ],
    },
    {
      name: 'id de tool_use duplicado',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_duplicate', name: 'Bash' },
          { type: 'tool_use', id: 'bash_duplicate', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_duplicate', is_error: true },
        ] } },
      ],
    },
    {
      name: 'tool_use_id reutilizado sequencialmente na mesma sessão',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_reused', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_reused', is_error: true },
        ] } },
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_reused', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_reused', is_error: true },
        ] } },
      ],
    },
    {
      name: 'id desconhecido',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: 'unknown', is_error: true },
        ] } },
      ],
    },
    {
      name: 'sessão diferente',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's2', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
        ] } },
      ],
    },
  ];

  for (const { name, events } of cases) {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.end(`${[...allowedPrefix, ...events, {
          type: 'result', session_id: 's1', result: 'Não deveria concluir.',
        }].map(JSON.stringify).join('\n')}\n`);
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    };

    await assert.rejects(
      () => runQuebragalhoAgent(
        {
          prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
          model: 'deepseek-v4.1-flash', timeout_seconds: 10,
        },
        { availableModels: MODELS, env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base }, spawnImpl },
      ),
      (error) => error.code === 'FORBIDDEN_TOOL_USED' && /Bash/.test(error.message),
      name,
    );
  }
});

test('issue #14 high: tool_result forjado por assistant não prova negação', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-forged-result-'));
  const events = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'read_ok', name: 'Read' },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_ok', is_error: false },
    ] } },
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'bash_1', name: 'Bash' },
    ] } },
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
    ] } },
    { type: 'result', session_id: 's1', result: 'Não deveria concluir.' },
  ];

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnJsonlFixture(events),
      },
    ),
    (error) => error.code === 'FORBIDDEN_TOOL_USED' && /Bash/.test(error.message),
  );
});

test('issue #14 high: chave composta com NUL não correlaciona sessões distintas', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-nul-key-'));
  const events = [
    { type: 'assistant', session_id: 'a', message: { content: [
      { type: 'tool_use', id: 'read_ok', name: 'Read' },
    ] } },
    { type: 'user', session_id: 'a', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_ok', is_error: false },
    ] } },
    { type: 'assistant', session_id: 'a', message: { content: [
      { type: 'tool_use', id: 'b\0c', name: 'Bash' },
    ] } },
    { type: 'user', session_id: 'a\0b', message: { content: [
      { type: 'tool_result', tool_use_id: 'c', is_error: true },
    ] } },
    { type: 'result', session_id: 'a', result: 'Não deveria concluir.' },
  ];

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnJsonlFixture(events),
      },
    ),
    (error) => error.code === 'FORBIDDEN_TOOL_USED' && /Bash/.test(error.message),
  );
});

test('issue #14 high: IDs nativos não aceitam coerção de tipos', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-id-types-'));
  const prefix = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'read_ok', name: 'Read' },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_ok', is_error: false },
    ] } },
  ];
  const run = (events, permissionDenials) => runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnJsonlFixture([
        ...prefix,
        ...events,
        {
          type: 'result',
          session_id: 's1',
          result: 'Resultado.',
          permission_denials: permissionDenials,
        },
      ]),
    },
  );

  await t.test('strings legítimas correlacionam a negação', async () => {
    const result = await run([
      { type: 'assistant', session_id: 's1', message: { content: [
        { type: 'tool_use', id: 'bash_1', name: 'Bash' },
      ] } },
      { type: 'user', session_id: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
      ] } },
    ], [{ tool_name: 'Bash', tool_use_id: 'bash_1' }]);
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /negadas/i);
  });

  const cases = [
    {
      name: 'session_id número não correlaciona com string',
      denialId: 'bash_1',
      events: [
        { type: 'assistant', session_id: 1, message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash' },
        ] } },
        { type: 'user', session_id: '1', message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_1', is_error: true },
        ] } },
      ],
    },
    {
      name: 'tool_use_id número não correlaciona com string',
      denialId: '1',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: 1, name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: '1', is_error: true },
        ] } },
      ],
    },
    {
      name: 'tool_use_id objeto não correlaciona com string',
      denialId: '[object Object]',
      events: [
        { type: 'assistant', session_id: 's1', message: { content: [
          { type: 'tool_use', id: { value: 'bash_1' }, name: 'Bash' },
        ] } },
        { type: 'user', session_id: 's1', message: { content: [
          { type: 'tool_result', tool_use_id: '[object Object]', is_error: true },
        ] } },
      ],
    },
  ];
  for (const { name, denialId, events } of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => run(events, [{
          tool_name: 'Bash',
          tool_use_id: denialId,
        }]),
        (error) => error.code === 'INVALID_EVENT',
      );
    });
  }
});

test('issue #14 high: session e tool_use_id têm limite de 4096 bytes', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-key-bytes-'));
  const atLimit = '🚀'.repeat(1_024);
  const aboveLimit = `${atLimit}x`;
  assert.equal(Buffer.byteLength(atLimit), 4_096);
  assert.equal(Buffer.byteLength(aboveLimit), 4_097);
  assert.ok(atLimit.length < 4_096);

  const runWith = (field, value) => {
    const sessionId = field === 'session_id' ? value : 's1';
    const toolUseId = field === 'tool_use_id' ? value : 'read_1';
    const events = [
      { type: 'assistant', session_id: sessionId, message: { content: [
        { type: 'tool_use', id: toolUseId, name: 'Read' },
      ] } },
      { type: 'user', session_id: sessionId, message: { content: [
        { type: 'tool_result', tool_use_id: toolUseId, is_error: false },
      ] } },
      { type: 'result', session_id: sessionId, result: 'Dentro do limite.' },
    ];
    return runQuebragalhoAgent(
      {
        prompt: 'audite', cwd: base, executor: 'native', mode: 'read_only',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnJsonlFixture(events),
      },
    );
  };

  for (const field of ['session_id', 'tool_use_id']) {
    await t.test(`${field} aceita 4096 bytes`, async () => {
      const result = await runWith(field, atLimit);
      assert.equal(result.status, 'success');
      assert.equal(result.result, 'Dentro do limite.');
    });
    await t.test(`${field} rejeita 4097 bytes`, async () => {
      await assert.rejects(
        () => runWith(field, aboveLimit),
        (error) => error.code === 'OUTPUT_LIMIT',
      );
    });
  }
});

test('issue #14 high: IDs nativos excedentes falham bounded sem evicção', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-id-limit-'));
  const events = [];
  for (let index = 0; index <= 4_096; index += 1) {
    const id = `read_${index}`;
    events.push(
      { type: 'assistant', session_id: 's1', message: { content: [
        { type: 'tool_use', id, name: 'Read' },
      ] } },
      { type: 'user', session_id: 's1', message: { content: [
        { type: 'tool_result', tool_use_id: id, is_error: false },
      ] } },
    );
  }
  events.push(
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'read_0', name: 'Bash' },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'read_0', is_error: true },
    ] } },
    { type: 'result', session_id: 's1', result: 'Não deveria concluir.' },
  );

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnJsonlFixture(events),
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT' && /4096|4_096/.test(error.message),
  );
});

test('issue #14 high: memory_note isolada mantém fallback factual da execução', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-memory-fallback-'));
  const artifact = path.join(base, 'status.txt');
  const artifactEventPath = path.relative(base, artifact);
  await writeFile(artifact, 'status');
  const events = [
    { type: 'assistant', session_id: 's1', message: { content: [
      { type: 'tool_use', id: 'edit_1', name: 'Edit', input: { file_path: artifactEventPath } },
    ] } },
    { type: 'user', session_id: 's1', message: { content: [
      { type: 'tool_result', tool_use_id: 'edit_1', is_error: false },
    ] } },
    {
      type: 'result',
      session_id: 's1',
      result: '<memory_note>O status foi atualizado.</memory_note>',
    },
  ];

  const result = await runQuebragalhoAgent(
    {
      prompt: 'atualize o status', cwd: base, executor: 'native', mode: 'write',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
      },
      spawnImpl: spawnJsonlFixture(events),
    },
  );

  assert.match(result.result, /Ferramentas concluídas: Edit\./);
  assert.match(result.result, /Artefatos registrados: 1\./);
  assert.doesNotMatch(result.result, /memory_note|Execução concluída sem mensagem final/);
  assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'status.txt')]);
});

test('PR #17: fallback factual maior que MAX_RESULT_TEXT_BYTES falha bounded', () => {
  const parser = createNativeEventParser('/repo');
  const sharedName = 'x'.repeat(821 * 1024);
  let retainedNameBytes = 0;
  for (let index = 0; index < 5; index += 1) {
    const name = `${index}${sharedName}`;
    const toolUse = {
      type: 'assistant',
      session_id: 's1',
      message: { content: [{ type: 'tool_use', id: `t${index}`, name }] },
    };
    retainedNameBytes += Buffer.byteLength(name);
    assert.ok(Buffer.byteLength(JSON.stringify(toolUse)) < 1024 * 1024);
    parser.feed(JSON.stringify(toolUse));
    parser.feed(JSON.stringify({
      type: 'user',
      session_id: 's1',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: `t${index}`,
        is_error: false,
      }] },
    }));
  }
  assert.ok(retainedNameBytes > 4 * 1024 * 1024);
  assert.throws(
    () => parser.finish(),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
});

test('PR #17: file_path respeita limites de bytes e componentes', async (t) => {
  const parsePath = (filePath) => parseQuebragalhoCodeEvents([
    JSON.stringify({
      type: 'assistant',
      session_id: 's1',
      message: { content: [{
        type: 'tool_use',
        id: 'read_1',
        name: 'Read',
        input: { file_path: filePath },
      }] },
    }),
    JSON.stringify({
      type: 'user',
      session_id: 's1',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'read_1',
        is_error: false,
      }] },
    }),
    JSON.stringify({ type: 'result', session_id: 's1', result: 'Resultado.' }),
  ].join('\n'), '/repo');
  const pathAtByteLimit = Array(17).fill('x'.repeat(240)).join('/');
  const pathAboveByteLimit = `${pathAtByteLimit}x`;
  const pathAtComponentLimit = Array(256).fill('x').join('/');
  const pathAboveComponentLimit = Array(257).fill('x').join('/');
  assert.equal(Buffer.byteLength(pathAtByteLimit), 4_096);
  assert.equal(Buffer.byteLength(pathAboveByteLimit), 4_097);

  await t.test('aceita 4096 bytes e 256 componentes', () => {
    assert.equal(parsePath(pathAtByteLimit).result, 'Resultado.');
    assert.equal(parsePath(pathAtComponentLimit).result, 'Resultado.');
  });
  await t.test('rejeita 4097 bytes antes de resolver o caminho', () => {
    assert.throws(
      () => parsePath(pathAboveByteLimit),
      (error) => error.code === 'OUTPUT_LIMIT',
    );
  });
  await t.test('rejeita 257 componentes antes de resolver o caminho', () => {
    assert.throws(
      () => parsePath(pathAboveComponentLimit),
      (error) => error.code === 'INVALID_EVENT',
    );
  });
});

test('PR #17: OpenCode limita filePath e path antes de resolver artefatos', async (t) => {
  const parsePath = (field, value) => parseOpenCodeEvents(JSON.stringify({
    type: 'tool_use',
    sessionID: 's1',
    part: {
      tool: 'read',
      state: { status: 'completed', input: { [field]: value } },
    },
  }), '/repo');
  const pathAtByteLimit = Array(17).fill('x'.repeat(240)).join('/');
  const pathAboveByteLimit = `${pathAtByteLimit}x`;
  const pathAtComponentLimit = Array(256).fill('x').join('/');
  const pathAboveComponentLimit = Array(257).fill('x').join('/');
  assert.equal(Buffer.byteLength(pathAtByteLimit), 4_096);
  assert.equal(Buffer.byteLength(pathAboveByteLimit), 4_097);

  for (const field of ['filePath', 'path']) {
    await t.test(`${field} aceita os limites`, () => {
      assert.deepEqual(parsePath(field, pathAtByteLimit).successfulTools, ['read']);
      assert.deepEqual(parsePath(field, pathAtComponentLimit).successfulTools, ['read']);
    });
    await t.test(`${field} rejeita 4097 bytes`, () => {
      assert.throws(
        () => parsePath(field, pathAboveByteLimit),
        (error) => error.code === 'OUTPUT_LIMIT',
      );
    });
    await t.test(`${field} rejeita 257 componentes`, () => {
      assert.throws(
        () => parsePath(field, pathAboveComponentLimit),
        (error) => error.code === 'OUTPUT_LIMIT',
      );
    });
  }
});

test('PR #17: warning write distingue ausência e confirmação de mudança', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-write-warning-'));
  const artifact = path.join(base, 'status.txt');
  await writeFile(artifact, 'status');
  const run = (withEdit) => {
    const toolUses = [{ type: 'tool_use', id: 'bash_1', name: 'Bash' }];
    const toolResults = [{
      type: 'tool_result',
      tool_use_id: 'bash_1',
      is_error: true,
    }];
    if (withEdit) {
      toolUses.unshift({
        type: 'tool_use',
        id: 'edit_1',
        name: 'Edit',
        input: { file_path: 'status.txt' },
      });
      toolResults.unshift({
        type: 'tool_result',
        tool_use_id: 'edit_1',
        is_error: false,
      });
    }
    return runQuebragalhoAgent(
      {
        prompt: 'atualize sem shell', cwd: base, executor: 'native', mode: 'write',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
        },
        spawnImpl: spawnJsonlFixture([
          { type: 'assistant', session_id: 's1', message: { content: toolUses } },
          { type: 'user', session_id: 's1', message: { content: toolResults } },
          {
            type: 'result',
            session_id: 's1',
            result: 'Resultado.',
            permission_denials: [{ tool_name: 'Bash', tool_use_id: 'bash_1' }],
          },
        ]),
      },
    );
  };

  await t.test('sem Edit ou Write confirma ausência de mudança', async () => {
    const result = await run(false);
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /nenhuma mudança foi confirmada/i);
    assert.deepEqual(result.artifacts, []);
  });
  await t.test('com Edit confirmada orienta revisão do artefato', async () => {
    const result = await run(true);
    assert.equal(result.status, 'warning');
    assert.match(result.summary, /revis/i);
    assert.match(result.summary, /alteração|artefato/i);
    assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'status.txt')]);
  });
});

test('PR #17: artefato resiste a troca TOCTOU por symlink', {
  skip: process.platform === 'win32'
    ? 'requer semântica de symlink POSIX'
    : false,
}, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-artifact-toctou-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-artifact-outside-'));
  const outsideFile = path.join(outside, 'secret.txt');
  await writeFile(outsideFile, 'outside');
  const run = (spawnImpl) => runQuebragalhoAgent(
    {
      prompt: 'grave o arquivo', cwd: base, executor: 'native', mode: 'write',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
      },
      spawnImpl,
    },
  );

  await t.test('arquivo interno real continua sendo publicado', async () => {
    const internal = path.join(base, 'internal.txt');
    await writeFile(internal, 'inside');
    const result = await run(spawnJsonlFixture([
      { type: 'assistant', session_id: 's1', message: { content: [{
        type: 'tool_use',
        id: 'write_1',
        name: 'Write',
        input: { file_path: 'internal.txt' },
      }] } },
      { type: 'user', session_id: 's1', message: { content: [{
        type: 'tool_result',
        tool_use_id: 'write_1',
        is_error: false,
      }] } },
      { type: 'result', session_id: 's1', result: 'Concluído.' },
    ]));
    assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'internal.txt')]);
  });

  await t.test('symlink que passa a escapar antes do tool_result não é publicado', async () => {
    const link = path.join(base, 'link.txt');
    const target = path.join(base, 'target.txt');
    await symlink('target.txt', link);
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(async () => {
        child.stdout.write(`${JSON.stringify({
          type: 'assistant',
          session_id: 's1',
          message: { content: [{
            type: 'tool_use',
            id: 'write_1',
            name: 'Write',
            input: { file_path: 'link.txt' },
          }] },
        })}\n`);
        await symlink(outsideFile, target);
        child.stdout.end(`${[
          { type: 'user', session_id: 's1', message: { content: [{
            type: 'tool_result',
            tool_use_id: 'write_1',
            is_error: false,
          }] } },
          { type: 'result', session_id: 's1', result: 'Concluído.' },
        ].map(JSON.stringify).join('\n')}\n`);
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    };

    const outcome = await run(spawnImpl).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    assert.equal(await realpath(link), await realpath(outsideFile));
    if (outcome.error) {
      assert.ok(
        ['INVALID_EVENT', 'ARTIFACT_OUTSIDE_CWD'].includes(outcome.error.code),
      );
    } else {
      assert.deepEqual(outcome.result.artifacts, []);
    }
  });
});

test('executor nativo falha fechado se reportar ferramenta proibida', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-forbidden-'));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${[
        {
          type: 'assistant',
          session_id: 'native_forbidden',
          message: {
            content: [{
              type: 'tool_use',
              id: 'bash_1',
              name: 'Bash',
              input: { command: 'pwd' },
            }],
          },
        },
        {
          type: 'user',
          session_id: 'native_forbidden',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'bash_1',
              content: base,
            }],
          },
        },
        {
          type: 'result',
          session_id: 'native_forbidden',
          result: 'Não deveria concluir.',
        },
      ].map(JSON.stringify).join('\n')}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite sem shell',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          ...process.env,
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        },
        spawnImpl,
      },
    ),
    (error) => error.code === 'FORBIDDEN_TOOL_USED' && /Bash/.test(error.message),
  );
});

test('OpenCode falha fechado para tool_call fora da allowlist efetiva', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-opencode-forbidden-'));

  for (const [mode, tool, category] of [
    ['read_only', 'bash', 'Bash'],
    ['write', 'Write', 'Write'],
  ]) {
    const spawnImpl = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        child.stdout.end(`${JSON.stringify({
          type: 'content',
          content_type: 'tool_call',
          sessionID: 'opencode_forbidden',
          name: tool,
        })}\n`);
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    };

    await assert.rejects(
      () => runQuebragalhoAgent(
        {
          prompt: 'não use ferramenta fora da política',
          cwd: base,
          executor: 'opencode',
          mode,
          model: 'deepseek-v4.1-flash',
          timeout_seconds: 10,
        },
        {
          availableModels: MODELS,
          env: {
            ...process.env,
            QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
            QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
            QUEBRAGALHO_API_KEY: 'test-key',
          },
          spawnImpl,
        },
      ),
      (error) => (
        error.code === 'FORBIDDEN_TOOL_USED'
        && error.message.includes(`categorias: ${category}`)
      ),
    );
  }
});

test('runQuebragalhoAgent persiste nota e injeta memória na execução seguinte', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-memory-'));
  const fakeQuebragalho = path.join(base, 'quebragalho-code');
  await writeFile(
    fakeQuebragalho,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1);
const recalled = prompt.includes('O projeto usa filas idempotentes.');
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: recalled ? 'memory_recalled' : 'memory_created',
  result: recalled
    ? 'Memória recuperada. <memory_note>Manter filas idempotentes.</memory_note>'
    : 'Decisão concluída. <memory_note>O projeto usa filas idempotentes.</memory_note>'
}) + '\\n');
`,
  );
  await chmod(fakeQuebragalho, 0o755);
  const env = {
    ...process.env,
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
    QUEBRAGALHO_CODE_BIN: fakeQuebragalho,
    QUEBRAGALHO_MEMORY_ENABLED: '1',
    QUEBRAGALHO_MEMORY_DIR: path.join(base, 'memory'),
  };

  const first = await runQuebragalhoAgent(
    {
      prompt: 'Defina a estratégia de filas.',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    { availableModels: MODELS, env, spawnImpl: spawnFixture },
  );
  const second = await runQuebragalhoAgent(
    {
      prompt: 'Revise a estratégia anterior.',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    { availableModels: MODELS, env, spawnImpl: spawnFixture },
  );

  assert.equal(first.result, 'Decisão concluída.');
  assert.equal(first.memory.persisted, true);
  assert.equal(first.memory.injected_project_entries, 0);
  assert.equal(second.session_id, 'memory_recalled');
  assert.equal(second.memory.injected_project_entries, 1);
  assert.equal((await readProjectMemory(await realpath(base), env)).length, 2);
});

test('falha de persistência da memória não mascara execução bem-sucedida', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-memory-failure-'));
  const fakeQuebragalho = path.join(base, 'quebragalho-code');
  const blockedMemoryPath = path.join(base, 'memory-is-a-file');
  await writeFile(blockedMemoryPath, 'bloqueio');
  await writeFile(
    fakeQuebragalho,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: 'result',
  session_id: 'memory_failure',
  result: 'Alteração concluída. <memory_note>Persistir esta decisão.</memory_note>'
}) + '\\n');
`,
  );
  await chmod(fakeQuebragalho, 0o755);

  const result = await runQuebragalhoAgent(
    {
      prompt: 'Revise a decisão.',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_CODE_BIN: fakeQuebragalho,
        QUEBRAGALHO_MEMORY_ENABLED: '1',
        QUEBRAGALHO_MEMORY_DIR: blockedMemoryPath,
      },
      spawnImpl: spawnFixture,
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.result, 'Alteração concluída.');
  assert.equal(result.memory.persisted, false);
  assert.equal(result.memory.warning.code, 'MEMORY_PERSIST_FAILED');
  assert.deepEqual(result.warnings, [result.memory.warning]);
});

test('model auto tenta fallback recuperável e relata todas as tentativas', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-model-fallback-'));
  const invokedModels = [];
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    invokedModels.push(args[args.indexOf('--model') + 1]);
    setImmediate(() => {
      if (invokedModels.length === 1) {
        child.stderr.end('Selected model is at capacity. Please try a different model.\n');
        child.stdout.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_fallback',
        part: { text: 'Auditoria concluída pelo fallback.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'Faça uma auditoria de segurança complexa da arquitetura.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'auto',
      timeout_seconds: 10,
    },
    {
      availableModels: [
        'deepseek-v4.1-flash',
        'glm-5.3',
        'mimo-v2.6-flash',
      ],
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '2',
        QUEBRAGALHO_MODEL_COOLDOWN_SECONDS: '30',
      },
      spawnImpl,
    },
  );

  assert.deepEqual(invokedModels, [
    'quebragalho/glm-5.3',
    'quebragalho/deepseek-v4.1-flash',
  ]);
  assert.equal(result.status, 'success');
  assert.equal(result.model, 'deepseek-v4.1-flash');
  assert.equal(result.routing.strategy, 'auto');
  assert.equal(result.routing.attempts.length, 2);
  assert.equal(result.routing.attempts[0].status, 'error');
  assert.equal(result.routing.attempts[0].code, 'MODEL_AT_CAPACITY');
  assert.equal(result.routing.attempts[1].status, 'success');
  assert.match(result.routing.reason, /^Fallback após 1 falha/);
  assert.match(result.routing.reason, /segurança 8\/10/);
  assert.doesNotMatch(result.routing.reason, /segurança 10\/10/);
});

test('modelo manual lotado faz fallback em leitura sem repetir o modelo', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-manual-capacity-'));
  const invokedModels = [];
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    invokedModels.push(args[args.indexOf('--model') + 1]);
    setImmediate(() => {
      if (invokedModels.length === 1) {
        child.stderr.end('Selected model is at capacity. Please try a different model.\n');
        child.stdout.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_manual_fallback',
        part: { text: 'Fallback concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'Revise a arquitetura.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'glm-5.3',
      timeout_seconds: 10,
    },
    {
      availableModels: [
        'deepseek-v4.1-flash',
        'glm-5.3',
        'mimo-v2.6-flash',
      ],
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '2',
        QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS: '1',
      },
      spawnImpl,
    },
  );

  assert.equal(invokedModels[0], 'quebragalho/glm-5.3');
  assert.notEqual(invokedModels[1], 'quebragalho/glm-5.3');
  assert.equal(result.status, 'success');
  assert.equal(result.routing.attempts[0].code, 'MODEL_AT_CAPACITY');
  assert.equal(result.routing.attempts[1].status, 'success');
  assert.equal(result.routing.auto_include_premium_models, true);
});

test('falha de capacidade explica o fallback quando não há segundo modelo', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-capacity-message-'));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stderr.end('Selected model is at capacity. Please try a different model.\n');
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  };

  let captured;
  try {
    await runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'glm-5.3',
        timeout_seconds: 10,
      },
      {
        availableModels: ['glm-5.3'],
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
      },
    );
  } catch (error) {
    captured = error;
  }

  assert.equal(captured?.code, 'MODEL_AT_CAPACITY');
  assert.match(
    formatAgentFailure(captured).next_actions.join(' '),
    /outro modelo elegível automaticamente/,
  );
});

test('sugestão genérica de outro modelo não é confundida com capacidade', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-invalid-model-message-'));
  let spawnCalls = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    spawnCalls += 1;
    setImmediate(() => {
      child.stderr.end('Selected model is incompatible. Please try a different model.\n');
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'glm-5.3',
        timeout_seconds: 10,
      },
      {
        availableModels: ['glm-5.3', 'deepseek-v4.1-flash'],
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
      },
    ),
    (error) => error.code === 'EXIT_ERROR',
  );
  assert.equal(spawnCalls, 1);
});

test('timeout_seconds é orçamento total da chamada com fallback', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-total-timeout-'));
  let spawnCalls = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    spawnCalls += 1;
    setImmediate(() => {
      child.stderr.end('modelo indisponível\n');
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  };
  const timestamps = [0, 0, 10_001];
  const now = () => timestamps.shift() ?? 10_001;

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Faça uma auditoria de segurança complexa da arquitetura.',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'auto',
        timeout_seconds: 10,
      },
      {
        availableModels: ['deepseek-v4.1-flash', 'glm-5.3'],
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
          QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '2',
        },
        spawnImpl,
        now,
      },
    ),
    (error) => (
      error.code === 'TIMEOUT'
      && error.routing.attempts.length === 1
    ),
  );
  assert.equal(spawnCalls, 1);
});

test('model auto nunca tenta fallback depois de execução write falhar', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-write-no-fallback-'));
  let spawnCalls = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    spawnCalls += 1;
    setImmediate(() => {
      child.stderr.end('falha depois de possível edição\n');
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Implemente a correção no código.',
        cwd: base,
        executor: 'opencode',
        mode: 'write',
        model: 'auto',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_AGENT_WRITE_ENABLED: '1',
          QUEBRAGALHO_API_KEY: 'test-key',
          QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '3',
        },
        spawnImpl,
      },
    ),
    (error) => (
      error.code === 'EXIT_ERROR'
      && error.routing.attempts.length === 1
    ),
  );
  assert.equal(spawnCalls, 1);
});

test('model auto inclui variantes premium somente com QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS=1', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-premium-auto-'));
  const request = {
    prompt: 'Implemente uma refatoração grande com testes.',
    cwd: base,
    executor: 'opencode',
    mode: 'read_only',
    model: 'auto',
    timeout_seconds: 10,
  };
  const options = {
    availableModels: ['deepseek-v4-pro'],
    env: {
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
      QUEBRAGALHO_API_KEY: 'test-key',
    },
    spawnImpl: spawnJsonlFixture([
      { type: 'text', sessionID: 'premium_auto', part: { text: 'Concluído.' } },
    ]),
  };

  await assert.rejects(
    () => runQuebragalhoAgent(request, options),
    (error) => error.code === 'MODEL_ROUTE_EMPTY',
  );
  for (const nonOptInValue of ['0', ' 1 ', '1\n']) {
    await assert.rejects(
      () => runQuebragalhoAgent(request, {
        ...options,
        env: {
          ...options.env,
          QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS: nonOptInValue,
        },
      }),
      (error) => error.code === 'MODEL_ROUTE_EMPTY',
    );
  }

  const result = await runQuebragalhoAgent(request, {
    ...options,
    env: { ...options.env, QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS: '1' },
  });
  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(result.routing.selected_model, 'deepseek-v4-pro');
  assert.equal(result.routing.auto_include_premium_models, true);
});

test('modelo manual respeita allowlist e tiers administrativos', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-model-policy-'));
  const request = {
    prompt: 'Revise a arquitetura.',
    cwd: base,
    executor: 'native',
    mode: 'read_only',
    model: 'glm-5.3',
    timeout_seconds: 10,
  };

  await assert.rejects(
    () => runQuebragalhoAgent(request, {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
      },
    }),
    (error) => error.code === 'MODEL_NOT_ALLOWED' && /ALLOWLIST/.test(error.message),
  );

  await assert.rejects(
    () => runQuebragalhoAgent(request, {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_MODEL_TIERS: 'pro',
      },
    }),
    (error) => error.code === 'MODEL_NOT_ALLOWED' && /TIERS/.test(error.message),
  );
});

test('denylist global filtra seleção automática e rejeita seleção manual', () => {
  const env = {
    QUEBRAGALHO_MODEL_DENYLIST: 'muse-spark-1.3-contributor,glm-5.3-flash,glm-5.3',
  };

  assert.deepEqual(
    globallyAllowedModels(
      ['deepseek-v4.1-flash', 'muse-spark-1.3-contributor', 'glm-5.3-flash', 'glm-5.3'],
      env,
    ),
    ['deepseek-v4.1-flash'],
  );
  assert.throws(
    () => assertGlobalModelAllowed('muse-spark-1.3-contributor', env),
    (error) => error.code === 'MODEL_NOT_ALLOWED' && /DENYLIST/.test(error.message),
  );
  assert.throws(
    () => assertGlobalModelAllowed('glm-5.3', env),
    (error) => error.code === 'MODEL_NOT_ALLOWED' && /DENYLIST/.test(error.message),
  );
});

test('allowlist por executor impede fallback silencioso do OAuth nativo', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-models-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'glm-5.3',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
        },
      },
    ),
    (error) => (
      error.code === 'MODEL_NOT_ALLOWED'
      && /executor native/.test(error.message)
    ),
  );
});

test('allowlist por executor rejeita modelo desconhecido com recuperação acionável', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-invalid-native-models-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4-flahs',
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'MODEL_POLICY_INVALID');
      assert.match(error.message, /QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST/);
      assert.match(formatAgentFailure(error).next_actions[0], /QUEBRAGALHO_MODEL_/);
      return true;
    },
  );
});

test('erro manual por executor aponta a allowlist correta na recuperação', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-recovery-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'glm-5.3',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
        },
      },
    ),
    (error) => {
      assert.match(
        formatAgentFailure(error).next_actions[0],
        /QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST/,
      );
      return true;
    },
  );
});

test('allowlist do OpenCode rejeita modelo indisponível e orienta a política correta', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-opencode-models-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'glm-5.3',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
          QUEBRAGALHO_OPENCODE_MODEL_ALLOWLIST: 'deepseek-v4.1-flash',
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_ALLOWED');
      assert.match(
        formatAgentFailure(error).next_actions[0],
        /QUEBRAGALHO_OPENCODE_MODEL_ALLOWLIST/,
      );
      return true;
    },
  );
});

test('allowlist por executor sem interseção falha com rota vazia', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-empty-executor-route-'));

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'Revise a arquitetura.',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: ['deepseek-v4.1-flash'],
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST: 'glm-5.3',
        },
      },
    ),
    (error) => {
      assert.equal(error.code, 'MODEL_ROUTE_EMPTY');
      assert.match(error.message, /executor native/);
      assert.match(
        formatAgentFailure(error).next_actions[0],
        /QUEBRAGALHO_NATIVE_MODEL_ALLOWLIST/,
      );
      return true;
    },
  );
});

test('rejeita política administrativa com modelo ou tier desconhecido', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-invalid-policy-'));
  const request = {
    prompt: 'Revise a arquitetura.',
    cwd: base,
    executor: 'native',
    mode: 'read_only',
    timeout_seconds: 10,
  };

  await assert.rejects(
    () => runQuebragalhoAgent(request, {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_MODEL_ALLOWLIST: 'modelo-inexistente',
      },
    }),
    (error) => error.code === 'MODEL_POLICY_INVALID' && /ALLOWLIST/.test(error.message),
  );
  await assert.rejects(
    () => runQuebragalhoAgent(request, {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_MODEL_TIERS: 'premium',
      },
    }),
    (error) => error.code === 'MODEL_POLICY_INVALID' && /TIERS/.test(error.message),
  );
});

test('falha de infraestrutura não coloca o modelo em cooldown', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-infra-no-cooldown-'));
  const fakeQuebragalho = path.join(base, 'quebragalho-code');
  await writeFile(
    fakeQuebragalho,
    `#!/usr/bin/env node
process.stderr.write('Não autenticado no Quebragalho. Execute quebragalho auth login.\\n');
process.exit(1);
`,
  );
  await chmod(fakeQuebragalho, 0o755);
  const prompt = 'Faça uma auditoria de segurança complexa de frontend e UX.';
  const availableModels = ['muse-spark-1.3-contributor', 'kimi-k3'];
  let failedModel;

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt,
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels,
        env: {
          ...process.env,
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_CODE_BIN: fakeQuebragalho,
          QUEBRAGALHO_MODEL_COOLDOWN_SECONDS: '3600',
        },
        spawnImpl: spawnFixture,
      },
    ),
    (error) => {
      assert.equal(error.code, 'QUEBRAGALHO_AUTH_REQUIRED');
      failedModel = error.routing.attempts[0].model;
      return true;
    },
  );

  let retriedModel;
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    retriedModel = args[args.indexOf('--model') + 1].replace('quebragalho/', '');
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_after_infra',
        part: { text: 'Concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  await runQuebragalhoAgent(
    {
      prompt,
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
    {
      availableModels,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
      },
      spawnImpl,
    },
  );

  assert.equal(retriedModel, failedModel);
});

test('executor nativo traduz credencial rejeitada em recuperação acionável', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-auth-'));
  const fakeQuebragalho = path.join(base, 'quebragalho-code');
  await writeFile(
    fakeQuebragalho,
    `#!/usr/bin/env node
process.stderr.write('Não autenticado no Quebragalho. Execute quebragalho auth login.\\n');
process.exit(1);
`,
  );
  await chmod(fakeQuebragalho, 0o755);

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          ...process.env,
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_CODE_BIN: fakeQuebragalho,
        },
        spawnImpl: spawnFixture,
      },
    ),
    (error) => {
      assert.equal(error.code, 'QUEBRAGALHO_AUTH_REQUIRED');
      assert.deepEqual(formatAgentFailure(error).next_actions, [
        'Configure QUEBRAGALHO_API_KEY com a chave qg- do gateway Quebragalho; o bridge a repassa como ANTHROPIC_AUTH_TOKEN à CLI nativa.',
        'Depois reinicie o cliente MCP para que o executor receba a credencial atualizada.',
      ]);
      return true;
    },
  );
});

test('limite global rejeita concorrência com AGENT_BUSY e libera o slot', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-concurrency-'));
  let release;
  let markStarted;
  let markStartedAgain;
  let spawnCalls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const startedAgain = new Promise((resolve) => { markStartedAgain = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    release = () => {
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_concurrency',
        part: { text: 'Concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    };
    spawnCalls += 1;
    if (spawnCalls === 1) markStarted();
    if (spawnCalls === 2) markStartedAgain();
    return child;
  };
  const options = {
    availableModels: MODELS,
    env: {
      QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
      QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '1',
      QUEBRAGALHO_API_KEY: 'test-key',
    },
    spawnImpl,
  };

  const first = runQuebragalhoAgent(
    {
      prompt: 'primeira',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
    options,
  );
  await started;
  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'segunda',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      options,
    ),
    (error) => error.code === 'AGENT_BUSY',
  );

  release();
  assert.equal((await first).status, 'success');

  const afterRelease = runQuebragalhoAgent(
    {
      prompt: 'terceira',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
    options,
  );
  await startedAgain;
  release();
  assert.equal((await afterRelease).status, 'success');
});

test('limite de saída encerra o grupo POSIX com TERM, graça e KILL', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-process-group-'));
  const signals = [];
  let spawnOptions;
  let child;
  const spawnImpl = (_command, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.pid = 43210;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.stdout.write(Buffer.alloc((4 * 1024 * 1024) + 1)));
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null));
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );

  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals, [
    [-43210, 'SIGTERM'],
    [-43210, 'SIGKILL'],
  ]);
});

test('fechamento do processo direto após TERM não cancela KILL do grupo POSIX', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-orphan-group-'));
  const signals = [];
  let forceKilled;
  const didForceKill = new Promise((resolve) => { forceKilled = resolve; });
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 54321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.stdout.write(Buffer.alloc((4 * 1024 * 1024) + 1)));
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null));
    if (signal === 'SIGKILL') forceKilled();
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );

  assert.deepEqual(signals, [[-54321, 'SIGTERM']]);
  await didForceKill;
  assert.deepEqual(signals, [
    [-54321, 'SIGTERM'],
    [-54321, 'SIGKILL'],
  ]);
});

test('cancelamento Windows encerra árvore mesmo se a raiz fechar logo depois', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-windows-abort-'));
  const controller = new AbortController();
  const killedTrees = [];
  let spawnOptions;
  let child;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = (_command, _args, options) => {
    spawnOptions = options;
    child = new EventEmitter();
    child.pid = 24680;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => assert.fail('não deve usar child.kill quando taskkill está disponível');
    started();
    return child;
  };
  const killTreeImpl = (pid) => {
    killedTrees.push(pid);
    setImmediate(() => child.emit('close', null));
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
      },
      spawnImpl,
      killTreeImpl,
      killGraceMs: 5,
      platform: 'win32',
      signal: controller.signal,
    },
  );

  await didStart;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.equal(spawnOptions.detached, false);
  assert.deepEqual(killedTrees, [24680]);
});

test('timeout Windows chama taskkill e força a raiz se o helper não encerrar', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-windows-timeout-'));
  const killedTrees = [];
  const signals = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 13579;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    return child;
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'aguarde',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
        killTreeImpl: (pid) => { killedTrees.push(pid); },
        killGraceMs: 0,
        platform: 'win32',
        timeoutMs: 0,
      },
    ),
    (error) => error.code === 'TIMEOUT',
  );
  assert.deepEqual(killedTrees, [13579]);
  assert.deepEqual(signals, ['SIGKILL']);
});

test('falha assíncrona do taskkill força a raiz uma única vez', async () => {
  for (const failure of ['close', 'error_then_close']) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-windows-taskkill-exit-'));
    const signals = [];
    let child;
    const spawnImpl = () => {
      child = new EventEmitter();
      child.pid = 86420;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        signals.push(signal);
        setImmediate(() => child.emit('close', null));
        return true;
      };
      return child;
    };
    const killTreeImpl = () => {
      const treeKill = new EventEmitter();
      setImmediate(() => {
        if (failure === 'error_then_close') {
          treeKill.emit('error', new Error('taskkill falhou'));
        }
        treeKill.emit('close', 1);
      });
      return treeKill;
    };

    await assert.rejects(
      () => runQuebragalhoAgent(
        {
          prompt: 'aguarde',
          cwd: base,
          executor: 'opencode',
          mode: 'read_only',
          model: 'deepseek-v4.1-flash',
          timeout_seconds: 10,
        },
        {
          availableModels: MODELS,
          env: {
            QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
            QUEBRAGALHO_API_KEY: 'test-key',
          },
          spawnImpl,
          killTreeImpl,
          killGraceMs: 50,
          platform: 'win32',
          timeoutMs: 0,
        },
      ),
      (error) => error.code === 'TIMEOUT',
    );
    assert.deepEqual(signals, ['SIGKILL'], failure);
  }
});

test('falha síncrona do taskkill usa TERM/KILL no processo raiz', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-windows-taskkill-fallback-'));
  const signals = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 97531;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };
    return child;
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'aguarde',
        cwd: base,
        executor: 'opencode',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
          QUEBRAGALHO_API_KEY: 'test-key',
        },
        spawnImpl,
        killTreeImpl: () => { throw new Error('taskkill indisponível'); },
        killGraceMs: 0,
        platform: 'win32',
        timeoutMs: 0,
      },
    ),
    (error) => error.code === 'TIMEOUT',
  );
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('falha tem contrato de recuperação determinístico', () => {
  const error = new Error('OpenCode não encontrado');
  error.code = 'OPENCODE_NOT_FOUND';
  assert.deepEqual(formatAgentFailure(error), {
    status: 'error',
    summary: 'OpenCode não encontrado',
    result: '',
    next_actions: [
      'Instale o OpenCode ou configure QUEBRAGALHO_OPENCODE_BIN com o caminho absoluto.',
    ],
    artifacts: [],
    session_id: null,
  });
});

test('waitForAgentSlot: resolve imediatamente quando slot disponivel', async () => {
  resetAgentSlots();
  const env = { QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '2' };
  const release = await waitForAgentSlot(env);
  assert.equal(typeof release, 'function');
  release();
});

test('runQuebragalhoAgent libera slot fornecido quando o preflight falha', async () => {
  let releases = 0;
  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'edite',
        cwd: '/repo',
        mode: 'write',
      },
      {
        availableModels: MODELS,
        env: {},
        slotRelease: () => { releases += 1; },
      },
    ),
    (error) => error.code === 'WRITE_DISABLED',
  );
  assert.equal(releases, 1);
});

test('runQuebragalhoAgent valida chamada síncrona antes de disputar slot interno', async () => {
  resetAgentSlots();
  const env = { QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '1' };
  const release = await waitForAgentSlot(env);
  await assert.rejects(
    () => runQuebragalhoAgent(
      { prompt: '', cwd: '/repo' },
      { availableModels: MODELS, env },
    ),
    (error) => error.code === 'PROMPT_REQUIRED',
  );
  release();
});

test('waitForAgentSlot: release e idempotente', async () => {
  resetAgentSlots();
  const env = { QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '1' };
  const firstRelease = await waitForAgentSlot(env);
  firstRelease();
  firstRelease();

  const secondRelease = await waitForAgentSlot(env);
  const thirdController = new AbortController();
  let thirdResolved = false;
  const third = waitForAgentSlot(env, thirdController.signal)
    .then((release) => {
      thirdResolved = true;
      release();
    });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdResolved, false);
  secondRelease();
  await third;
});

test('waitForAgentSlot: rejeita quando signal ja aborted', async () => {
  resetAgentSlots();
  const env = { QUEBRAGALHO_AGENT_MAX_CONCURRENCY: '1' };
  const ac = new AbortController();
  ac.abort();
  try {
    await waitForAgentSlot(env, ac.signal);
    assert.fail('Deveria ter rejeitado');
  } catch (err) {
    assert.equal(err.code, 'CANCELLED');
  }
});

test('configuredConcurrency: default 4', async () => {
  resetAgentSlots();
  const env = {};
  const releases = [];
  for (let i = 0; i < 4; i++) {
    releases.push(await waitForAgentSlot(env));
    assert.equal(typeof releases[i], 'function');
  }
  for (const r of releases) r();
});

test('runQuebragalhoAgent propaga cancelamento ao subprocesso', {
  skip: process.platform === 'win32',
}, async () => {
  resetAgentSlots();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-abort-signal-'));
  const controller = new AbortController();
  const signals = [];
  let child;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 65432;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    started();
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null));
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
      },
      spawnImpl,
      killImpl,
      killGraceMs: 5,
      signal: controller.signal,
    },
  );

  await didStart;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.deepEqual(signals, [
    [-65432, 'SIGTERM'],
    [-65432, 'SIGKILL'],
  ]);
});

test('cancelamento fecha a execução mesmo quando child nunca emite close', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-hard-settle-'));
  const controller = new AbortController();
  const signals = [];
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 76543;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    started();
    return child;
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde', cwd: base, executor: 'opencode', mode: 'read_only', model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
      killImpl: (pid, signal) => { signals.push([pid, signal]); },
      killGraceMs: 0,
      signal: controller.signal,
    },
  );

  await didStart;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.deepEqual(signals, [[-76543, 'SIGTERM'], [-76543, 'SIGKILL']]);
});

test('close após SIGTERM rejeita sem aguardar SIGKILL', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-term-close-'));
  const controller = new AbortController();
  const signals = [];
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') child.emit('close', null);
      return true;
    };
    started();
    return child;
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde', cwd: base, executor: 'opencode', mode: 'read_only', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
      killGraceMs: 0,
      signal: controller.signal,
    },
  );

  await didStart;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  assert.deepEqual(signals, ['SIGTERM']);
});

test('close tardio não altera o resultado já encerrado', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-late-close-'));
  const controller = new AbortController();
  const signals = [];
  let child;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 87654;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    started();
    return child;
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde', cwd: base, executor: 'opencode', mode: 'read_only', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
      killImpl: (pid, signal) => { signals.push([pid, signal]); },
      killGraceMs: 0,
      signal: controller.signal,
    },
  );

  await didStart;
  controller.abort();
  await assert.rejects(running, (error) => error.code === 'CANCELLED');
  child.emit('close', 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, [[-87654, 'SIGTERM'], [-87654, 'SIGKILL']]);
});

test('timeout seguido de abort antes do hard-settle encerra uma única vez', {
  skip: process.platform === 'win32',
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-abort-timeout-race-'));
  const controller = new AbortController();
  const signals = [];
  let abortFired = false;
  let started;
  const didStart = new Promise((resolve) => { started = resolve; });
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 98765;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    started();
    return child;
  };

  const running = runQuebragalhoAgent(
    {
      prompt: 'aguarde', cwd: base, executor: 'opencode', mode: 'read_only', model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
      killImpl: (pid, signal) => { signals.push([pid, signal]); },
      killGraceMs: 0,
      timeoutMs: 0,
      signal: controller.signal,
    },
  );

  await didStart;
  setTimeout(() => {
    abortFired = true;
    controller.abort();
  }, 0);
  await assert.rejects(running, (error) => error.code === 'TIMEOUT');
  assert.equal(abortFired, true);
  assert.deepEqual(signals, [[-98765, 'SIGTERM'], [-98765, 'SIGKILL']]);
});

// ── Progress / onProgress ───────────────────────────────────────────────

test('onProgress recebe routing e generating em execucao bem-sucedida', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-onprogress-ok-'));
  const phases = [];

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_progress',
        part: { text: 'Concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  await runQuebragalhoAgent(
    {
      prompt: 'Revise o código.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'auto',
      timeout_seconds: 10,
      // Simula o __onProgress que JobQueue injeta via #executeJob
      get __onProgress() {
        return (update) => { phases.push(update); };
      },
    },
    {
      availableModels: ['deepseek-v4.1-flash', 'glm-5.3'],
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '1',
      },
      spawnImpl,
    },
  );

  assert.ok(phases.length >= 2, 'deve ter pelo menos 2 chamadas onProgress');
  assert.equal(phases[0].phase, 'routing');
  const generating = phases.find((p) => p.phase === 'generating');
  assert.ok(generating, 'deve ter fase generating');
  assert.ok(generating.model, 'generating deve ter model');
  assert.ok(generating.attempts, 'generating deve ter attempts');
  assert.equal(generating.attempts.current, 1);
  assert.equal(generating.attempts.total, 1);
});

test('onProgress nao afeta execucao quando ausente', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-onprogress-missing-'));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_no_op',
        part: { text: 'Ok.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    { prompt: 'Ok.', cwd: base, executor: 'opencode', mode: 'read_only', timeout_seconds: 10 },
    {
      availableModels: ['deepseek-v4.1-flash', 'glm-5.3'],
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
    },
  );
  assert.equal(result.status, 'success');
});

test('onProgress recebe waiting_model, executing_tool e processing_result', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-onprogress-phases-'));
  const updates = [];
  let subprocessClosed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${[
        {
          type: 'tool_use',
          sessionID: 'ses_full',
          part: { id: 't1', tool: 'read', state: { status: 'running' } },
        },
        {
          type: 'tool_use',
          sessionID: 'ses_full',
          part: { id: 't1', tool: 'read', state: { status: 'completed' } },
        },
        {
          type: 'text',
          sessionID: 'ses_full',
          part: { text: 'Análise completa.' },
        },
      ].map(JSON.stringify).join('\n')}\n`);
      child.stderr.end();
      subprocessClosed = true;
      child.emit('close', 0);
    });
    return child;
  };

  await runQuebragalhoAgent(
    {
      prompt: 'Analise o código.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
      __onProgress: (update) => {
        updates.push({ ...update, subprocessClosed });
      },
    },
    {
      availableModels: ['deepseek-v4.1-flash', 'glm-5.3'],
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
    },
  );

  const phases = updates.map((u) => u.phase);
  assert.ok(phases.includes('routing'));
  assert.ok(phases.includes('generating'));
  assert.ok(phases.includes('waiting_model'));
  assert.ok(phases.includes('executing_tool'));
  assert.ok(phases.includes('processing_result'));
  assert.ok(
    updates
      .filter((update) => update.phase === 'processing_result')
      .every((update) => update.subprocessClosed),
    'processing_result só pode ser emitido depois do close',
  );
});

test('onProgress inclui attempt info em fallback', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-onprogress-fallback-'));
  const updates = [];
  let callCount = 0;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    callCount += 1;
    setImmediate(() => {
      if (callCount === 1) {
        child.stderr.end('Selected model is at capacity. Please try a different model.\n');
        child.stdout.end();
        child.emit('close', 1);
        return;
      }
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_fb',
        part: { text: 'Fallback OK.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  await runQuebragalhoAgent(
    {
      prompt: 'Analise.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'auto',
      timeout_seconds: 10,
      __onProgress: (update) => { updates.push(update); },
    },
    {
      availableModels: ['deepseek-v4.1-flash', 'glm-5.3'],
      env: {
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
        QUEBRAGALHO_AGENT_MAX_MODEL_ATTEMPTS: '2',
      },
      spawnImpl,
    },
  );

  const generatingCalls = updates.filter((u) => u.phase === 'generating');
  assert.ok(generatingCalls.length >= 1, 'deve ter ao menos um generating');
  const lastGenerating = generatingCalls[generatingCalls.length - 1];
  assert.equal(lastGenerating.attempts.current, 2);
  assert.equal(lastGenerating.attempts.total, 2);
});

test('onProgress processa linha JSON dividida entre chunks', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-progress-chunks-'));
  const updates = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      const tool = JSON.stringify({ type: 'tool_use', part: { tool: 'read' } });
      child.stdout.write(tool.slice(0, 12));
      child.stdout.write(`${tool.slice(12)}\n`);
      child.stdout.end(`${JSON.stringify({
        type: 'text',
        sessionID: 'ses_chunks',
        part: { text: 'Concluído.' },
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  await runQuebragalhoAgent(
    {
      prompt: 'Revise.',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
      __onProgress: (update) => { updates.push(update); },
    },
    {
      availableModels: ['deepseek-v4.1-flash'],
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_API_KEY: 'test-key' },
      spawnImpl,
    },
  );

  const toolUpdate = updates.find((update) => update.tool_counts);
  assert.ok(toolUpdate);
  assert.equal(toolUpdate.phase, 'executing_tool');
  assert.equal(toolUpdate.tool_counts.Read.total, 1);
});

test('stream preserva UTF-8 quando um code point cruza chunks', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-utf8-chunks-'));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      const payload = Buffer.from(`${JSON.stringify({
        type: 'result',
        session_id: 'utf8_chunks',
        result: 'Ação 🚀 concluída.',
      })}\n`);
      const emojiOffset = payload.indexOf(Buffer.from('🚀'));
      child.stdout.write(payload.subarray(0, emojiOffset + 1));
      child.stdout.end(payload.subarray(emojiOffset + 1));
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'Revise.',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl,
    },
  );

  assert.equal(result.result, 'Ação 🚀 concluída.');
  assert.equal(result.session_id, 'utf8_chunks');
});

// ── Parser multi-bloco (Gate 1) ─────────────────────────────────────────

test('parseOpenCodeEvents preserva multiplos blocos text em ordem', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'Primeiro bloco.\n' } }),
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'Segundo bloco.\n' } }),
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'Terceiro.' } }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Primeiro bloco.\nSegundo bloco.\nTerceiro.');
});

test('parseOpenCodeEvents preserva espaço entre fragmentos adjacentes', () => {
  const raw = [
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'This is ' } }),
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'an answer' } }),
  ].join('\n');
  assert.equal(parseOpenCodeEvents(raw, '/repo').result, 'This is an answer');
});

test('parseOpenCodeEvents remove bloco think dividido entre multiplos fragmentos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'Início.\n<think>pensando na ' } }),
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'solução complexa...</think>Resultado.' } }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Início.\nResultado.');
});

test('parseQuebragalhoCodeEvents usa result canônico após múltiplos blocos assistant', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'Analisei.\n' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'Encontrei um bug.\n' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's2', result: 'Concluído.' }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Concluído.');
});

test('parseQuebragalhoCodeEvents preserva espaço no fallback assistant sem result', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'This is ' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'an answer' },
    ] } }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'This is an answer');
});

test('parseQuebragalhoCodeEvents remove bloco think dividido entre multiplos fragmentos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'Analise:\n<think>raciocínio ' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's2', message: { content: [
      { type: 'text', text: 'profundo...</think>Sucesso.' },
    ] } }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Analise:\nSucesso.');
});

test('buildProgressOnLine correlaciona tool_use sem id por sessão e ferramenta', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0 },
  );

  cb(JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_anon',
    part: { tool: 'read', state: { status: 'running', input: { path: 'a.js' } } },
  }));
  cb(JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_anon',
    part: {
      tool: 'read',
      state: { status: 'completed', input: { path: 'a.js', bytes: 120 } },
    },
  }));

  cb(JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_anon',
    part: { tool: 'read', state: { status: 'running', input: { path: 'a.js' } } },
  }));
  cb(JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_anon',
    part: { tool: 'read', state: { status: 'completed', input: { path: 'a.js' } } },
  }));

  const last = updates.at(-1).tool_counts;
  assert.deepEqual(last.total, { total: 2, succeeded: 2, failed: 0 });
  assert.deepEqual(last.Read, { total: 2, succeeded: 2, failed: 0 });
});

test('buildProgressOnLine finaliza content tool_call concorrente na ordem da sessão', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, executor: 'opencode' },
  );

  cb(JSON.stringify({
    type: 'content',
    content_type: 'tool_call',
    sessionID: 'ses_content',
    name: 'read',
  }));
  cb(JSON.stringify({
    type: 'content',
    content_type: 'tool_call',
    sessionID: 'ses_content',
    name: 'read',
  }));
  cb(JSON.stringify({
    type: 'content',
    content_type: 'tool_call',
    sessionID: 'ses_content',
    name: 'glob',
  }));
  cb(JSON.stringify({
    type: 'tool_result',
    sessionID: 'ses_content',
    call_id: 'id-primeiro-adicionado-no-resultado',
  }));
  cb(JSON.stringify({
    type: 'tool_result',
    sessionID: 'ses_content',
    call_id: 'id-segundo-adicionado-no-resultado',
  }));
  cb(JSON.stringify({
    type: 'tool_result',
    sessionID: 'ses_content',
    call_id: 'id-terceiro-adicionado-no-resultado',
  }));

  assert.deepEqual(
    updates.at(-1).tool_counts.Read,
    { total: 2, succeeded: 2, failed: 0 },
  );
  assert.deepEqual(
    updates.at(-1).tool_counts.Glob,
    { total: 1, succeeded: 1, failed: 0 },
  );
});

test('buildProgressOnLine limita fila content anônima de uma única sessão', () => {
  const cb = buildProgressOnLine(
    () => {},
    { minIntervalMs: 0, executor: 'opencode' },
  );

  assert.throws(
    () => {
      for (let index = 0; index < 4_097; index += 1) {
        cb(JSON.stringify({
          type: 'content',
          content_type: 'tool_call',
          sessionID: 'ses_content_limit',
          name: 'read',
        }));
      }
    },
    (error) => (
      error.code === 'OUTPUT_LIMIT'
      && error.message.includes('Ferramentas content pendentes')
    ),
  );
});

test('buildProgressOnLine libera limite ao consumir content tool_result', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { executor: 'opencode' },
  );

  for (let index = 0; index < 5_000; index += 1) {
    cb(JSON.stringify({
      type: 'content',
      content_type: 'tool_call',
      sessionID: 'ses_content_consumed',
      name: 'read',
    }));
    cb(JSON.stringify({
      type: 'tool_result',
      sessionID: 'ses_content_consumed',
      call_id: `result_${index}`,
    }));
  }
  cb.flush();

  assert.deepEqual(
    updates.at(-1).tool_counts.Read,
    { total: 5_000, succeeded: 5_000, failed: 0 },
  );
});

// ── onLine incremental tool_counts ──────────────────────────────────────

test('buildProgressOnLine detecta tool_use e chama onProgress com tool_counts', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0 },
  );
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'read' } }));
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'edit' } }));
  cb(JSON.stringify({ type: 'text', part: { text: 'Feito.' } }));
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'glob' } }));
  const tcs = updates.filter((u) => u.tool_counts);
  assert.equal(tcs.length, 4);
  assert.equal(tcs[0].tool_counts.total.total, 1);
  assert.equal(tcs[0].tool_counts.Read.total, 1);
  assert.equal(tcs[1].tool_counts.total.total, 2);
  assert.equal(tcs[1].tool_counts.Edit.total, 1);
  assert.equal(tcs[2].tool_counts.total.total, 2);
  assert.equal(tcs[3].tool_counts.total.total, 3);
  assert.equal(tcs[3].tool_counts.Glob.total, 1);
});

test('buildProgressOnLine correlaciona resultado nativo e OpenCode por id', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0 },
  );

  cb(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'native-ok', name: 'read' },
        { type: 'tool_use', id: 'native-fail', name: 'edit' },
      ],
    },
  }));
  cb(JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'native-ok', is_error: false },
        { type: 'tool_result', tool_use_id: 'native-fail', is_error: true },
      ],
    },
  }));
  cb(JSON.stringify({
    type: 'tool_use',
    part: { id: 'opencode-ok', tool: 'glob', state: { status: 'running' } },
  }));
  cb(JSON.stringify({
    type: 'tool_use',
    part: { id: 'opencode-ok', tool: 'glob', state: { status: 'completed' } },
  }));

  const last = updates.at(-1).tool_counts;
  assert.deepEqual(last.total, { total: 3, succeeded: 2, failed: 1 });
  assert.deepEqual(last.Read, { total: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(last.Edit, { total: 1, succeeded: 0, failed: 1 });
  assert.deepEqual(last.Glob, { total: 1, succeeded: 1, failed: 0 });
});

test('buildProgressOnLine limita emissões, faz flush e ignora evento tardio', () => {
  const updates = [];
  let clock = 0;
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 100, now: () => clock },
  );
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'read' } }));
  clock = 10;
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'edit' } }));
  clock = 20;
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'glob' } }));
  assert.equal(updates.length, 1);

  cb.flush();
  assert.equal(updates.length, 2);
  assert.equal(updates[1].tool_counts.total.total, 3);
  assert.equal(updates[1].tool_counts.Read.total, 1);
  assert.equal(updates[1].tool_counts.Edit.total, 1);
  assert.equal(updates[1].tool_counts.Glob.total, 1);

  cb.close();
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'write' } }));
  assert.equal(updates.length, 2);
});

test('buildProgressOnLine nao falha com JSON invalido', () => {
  let called = false;
  const onLine = buildProgressOnLine(() => { called = true; });
  onLine('not json');
  onLine('{"malformed"');
  assert.equal(called, false);
});

// ── Think filter: backtick literal, fragment split, EOF incomplete ──────

test('parseOpenCodeEvents preserva <think> literal envolto em backticks', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'Use `<think>` para blocos de raciocinio.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Use `<think>` para blocos de raciocinio.');
});

test('parseOpenCodeEvents preserva </think> literal envolto em backticks', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'Feche com `</think>` no final.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Feche com `</think>` no final.');
});

test('parseOpenCodeEvents remove think real mas preserva referencia em backticks', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: '<think>analisando</think>Use `<think>` para blocos.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Use `<think>` para blocos.');
});

test('parseOpenCodeEvents nao fecha think com </think> em backticks', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: '<think>use `</think>` literal</think>Resultado.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Resultado.');
});

test('parseOpenCodeEvents fecha think após backtick solto', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: '<think>rascunho termina com `</think>Resultado.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Resultado.');
});

test('parseQuebragalhoCodeEvents preserva <think> e </think> literais em backticks', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{ type: 'text', text: 'Padrao `<think>` e `</think>` sao literais.' }],
      },
    }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Padrao `<think>` e `</think>` sao literais.');
});

test('parseQuebragalhoCodeEvents remove think real com </think> em backticks no meio', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{
          type: 'text',
          text: '<think>use `</think>` como ref</think>Pronto.',
        }],
      },
    }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Pronto.');
});

test('parseOpenCodeEvents nao vaza bloco think incompleto no fim do fluxo', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'Inicio.\n<think>raciocinio incompleto' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Inicio.');
});

test('parseQuebragalhoCodeEvents nao vaza bloco think incompleto no fim do fluxo', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{ type: 'text', text: 'Inicio.\n<think>raciocinio incompleto' }],
      },
    }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Inicio.');
});

test('parseOpenCodeEvents trata <think> partido entre dois fragmentos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'Antes do<thi' },
    }),
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'nk>raciocinio</think>Depois.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Antes doDepois.');
});

test('parseOpenCodeEvents trata </think> partido entre dois fragmentos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: '<think>pensando</thi' },
    }),
    JSON.stringify({
      type: 'text', sessionID: 's1',
      part: { text: 'nk>Final.' },
    }),
  ].join('\n');
  const parsed = parseOpenCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Final.');
});

test('parseQuebragalhoCodeEvents trata think partido entre dois fragmentos', () => {
  const cwd = '/repo';
  const raw = [
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{ type: 'text', text: '<think>racioc' }],
      },
    }),
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{ type: 'text', text: 'inio profun' }],
      },
    }),
    JSON.stringify({
      type: 'assistant', session_id: 's2', message: {
        content: [{ type: 'text', text: 'do</think>Fim.' }],
      },
    }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, cwd);
  assert.equal(parsed.result, 'Fim.');
});

// ── allowedToolsForMode ─────────────────────────────────────────────────

test('allowedToolsForMode retorna Read/Glob/Grep para read_only', () => {
  assert.deepEqual(allowedToolsForMode('read_only'), ['Read', 'Glob', 'Grep']);
});

test('allowedToolsForMode inclui Edit/Write para write', () => {
  assert.deepEqual(allowedToolsForMode('write'), ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
});

test('allowedToolsForMode reflete a política do executor OpenCode', () => {
  assert.deepEqual(
    allowedToolsForMode('read_only', 'opencode'),
    ['Read', 'Glob', 'List'],
  );
  assert.deepEqual(
    allowedToolsForMode('write', 'opencode'),
    ['Read', 'Glob', 'List', 'Edit'],
  );
});

// ── buildQuebragalhoCodeInvocation com --include-partial-messages ────────────

test('buildQuebragalhoCodeInvocation inclui --include-partial-messages', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'teste',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  assert.ok(invocation.args.includes('--include-partial-messages'));
});

test('buildQuebragalhoCodeInjection omite --append-system-prompt sem systemPrompt', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'teste',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  assert.ok(!invocation.args.includes('--append-system-prompt'));
});

test('buildQuebragalhoCodeInvocation injeta systemPrompt em --append-system-prompt', () => {
  const systemPrompt = 'You are restricted.';
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'teste',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
    systemPrompt,
  });
  const idx = invocation.args.indexOf('--append-system-prompt');
  assert.ok(idx !== -1, 'deve incluir --append-system-prompt');
  assert.equal(invocation.args[idx + 1], systemPrompt);
});

test('inlineConfig do OpenCode inclui prompt do agente com restrições', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
  });
  const config = JSON.parse(invocation.inlineConfig);
  const agent = config.agent['quebragalho-bridge-agent'];
  assert.ok(typeof agent.prompt === 'string' && agent.prompt.length > 0);
  assert.ok(agent.prompt.includes('Read'));
  assert.ok(agent.prompt.includes('Glob'));
  assert.ok(agent.prompt.includes('List'));
  assert.ok(!agent.prompt.includes('Grep'));
});

test('inlineConfig do OpenCode em modo write lista Edit mas não Write', () => {
  const invocation = buildOpenCodeInvocation({
    prompt: 'edite',
    cwd: '/repo',
    mode: 'write',
    model: 'deepseek-v4.1-flash',
  });
  const config = JSON.parse(invocation.inlineConfig);
  const prompt = config.agent['quebragalho-bridge-agent'].prompt;
  assert.ok(prompt.includes('Edit'));
  assert.ok(!prompt.includes('Write'));
});

test('buildQuebragalhoCodeInvocation posiciona o systemPrompt logo apos a flag', () => {
  const invocation = buildQuebragalhoCodeInvocation({
    prompt: 'audite',
    cwd: '/repo',
    mode: 'read_only',
    model: 'deepseek-v4.1-flash',
    systemPrompt: 'placeholder',
  });
  const idx = invocation.args.indexOf('--append-system-prompt');
  assert.equal(invocation.args[idx + 1], 'placeholder');
});

// O system prompt e a unica barreira que o MODELO enxerga (o resto e bloqueio
// tecnico pos-hoc). Se ele anunciar ferramenta que a policy nega, o subagente
// tenta e leva FORBIDDEN_TOOL_USED; se omitir ferramenta permitida, o subagente
// se auto-limita a toa. Por isso a lista anunciada e testada contra a fonte de
// verdade (allowedToolsForMode) em vez de contra literais duplicados aqui.
for (const executor of ['native', 'opencode']) {
  for (const mode of ['read_only', 'write']) {
    test(`system prompt (${executor}/${mode}) anuncia exatamente as ferramentas permitidas`, () => {
      const prompt = buildAgentSystemPrompt(mode, executor);
      const esperadas = allowedToolsForMode(mode, executor);

      for (const tool of esperadas) {
        assert.ok(
          prompt.includes(tool),
          `system prompt deveria anunciar "${tool}" em ${executor}/${mode}`,
        );
      }

      const todas = ['Read', 'Glob', 'Grep', 'List', 'Edit', 'Write'];
      for (const tool of todas.filter((t) => !esperadas.includes(t))) {
        assert.ok(
          !new RegExp(`\\b${tool}\\b`).test(prompt.split('Authorized tools')[1] ?? ''),
          `system prompt NAO deveria anunciar "${tool}" em ${executor}/${mode}`,
        );
      }
    });
  }
}

test('system prompt sempre proibe shell explicitamente, nos dois modos', () => {
  // Regressao: o motivo original desta feature foi subagente tentando Bash sem
  // saber que era proibido, resultando em FORBIDDEN_TOOL_USED.
  for (const mode of ['read_only', 'write']) {
    const prompt = buildAgentSystemPrompt(mode, 'native');
    assert.match(prompt, /do NOT have access to a shell/i);
    assert.match(prompt, /bash/i);
  }
});

test('system prompt em modo write proibe validacao pos-edicao', () => {
  const prompt = buildAgentSystemPrompt('write', 'native');
  assert.match(prompt, /NEVER run post-edit validation/i);
});

// ── buildProgressOnLine: allowed_tools e stream_event ───────────────────

test('buildProgressOnLine inclui allowed_tools no progresso', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'read' } }));
  const update = updates.find((u) => u.allowed_tools);
  assert.ok(update);
  assert.deepEqual(update.allowed_tools, ['Read', 'Glob', 'Grep']);
});

test('buildProgressOnLine allowed_tools reflete mode write', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'write' },
  );
  cb(JSON.stringify({ type: 'tool_use', part: { tool: 'edit' } }));
  const update = updates.find((u) => u.allowed_tools);
  assert.ok(update);
  assert.deepEqual(update.allowed_tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write']);
});

test('buildProgressOnLine conta List do OpenCode como inspeção Glob', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only', executor: 'opencode' },
  );
  cb(JSON.stringify({
    type: 'tool_use',
    part: { id: 'list-1', tool: 'list', state: { status: 'completed' } },
  }));
  const update = updates.at(-1);
  assert.deepEqual(update.allowed_tools, ['Read', 'Glob', 'List']);
  assert.deepEqual(update.tool_counts.Glob, { total: 1, succeeded: 1, failed: 0 });
});

test('buildProgressOnLine transiciona executing_tool -> waiting_model após tool_result', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );

  cb(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
  }));

  cb(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  }));

  const phases = updates.map((u) => u.phase);
  assert.ok(phases.includes('executing_tool'), 'deve ter executing_tool');
  assert.equal(phases.at(-1), 'waiting_model', 'tool_result devolve a fase ao modelo');
  assert.ok(
    !phases.includes('processing_result'),
    'processing_result é exclusivo do fechamento do subprocesso',
  );
});

test('buildProgressOnLine alterna waiting_model/executing_tool em ciclos de ferramenta', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );

  cb(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] },
  }));
  cb(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] },
  }));
  cb(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't2', name: 'Grep' }] },
  }));
  cb(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't2' }] },
  }));

  const phases = updates.map((u) => u.phase);
  assert.deepEqual(phases, [
    'executing_tool',
    'waiting_model',
    'executing_tool',
    'waiting_model',
  ]);
});

test('buildProgressOnLine processa stream_event content_block_start tool_use', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );

  cb(JSON.stringify({
    type: 'stream_event',
    session_id: 'ses_stream',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'stream_t1', name: 'Read', input: { file_path: 'x.js' } },
    },
  }));

  const update = updates.find((u) => u.tool_counts);
  assert.ok(update, 'deve emitir progresso após stream_event');
  assert.equal(update.phase, 'executing_tool', 'stream_event tool_use transiciona para executing_tool');
  assert.equal(update.tool_counts.Read.total, 1);
});

test('buildProgressOnLine deduplica tool_use de stream_event quando assistant chega depois', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );

  // stream_event anuncia tool_use primeiro
  cb(JSON.stringify({
    type: 'stream_event',
    session_id: 'ses_dedup',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'dedup_1', name: 'Read', input: { file_path: 'x.js' } },
    },
  }));

  // assistant message chega com o mesmo tool_use — não deve duplicar
  cb(JSON.stringify({
    type: 'assistant',
    session_id: 'ses_dedup',
    message: { content: [{ type: 'tool_use', id: 'dedup_1', name: 'Read', input: { file_path: 'x.js' } }] },
  }));

  // tool_result
  cb(JSON.stringify({
    type: 'user',
    session_id: 'ses_dedup',
    message: { content: [{ type: 'tool_result', tool_use_id: 'dedup_1' }] },
  }));

  const last = updates.at(-1).tool_counts;
  assert.equal(last.total.total, 1, 'tool_use não deve ser duplicado');
  assert.equal(last.Read.total, 1);
  assert.equal(last.Read.succeeded, 1);
});

test('buildProgressOnLine registra atividade sem expor thinking_delta nem texto', () => {
  const updates = [];
  const cb = buildProgressOnLine(
    (update) => { updates.push(update); },
    { minIntervalMs: 0, mode: 'read_only' },
  );

  // stream_event com thinking_delta — atividade sem conteúdo sensível
  cb(JSON.stringify({
    type: 'stream_event',
    session_id: 'ses_think',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'raciocinio secreto' },
    },
  }));

  // stream_event com texto — atividade sem conteúdo
  cb(JSON.stringify({
    type: 'stream_event',
    session_id: 'ses_text',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'texto incremental' },
    },
  }));

  const toolUpdates = updates.filter((u) => u.tool_counts);
  assert.equal(toolUpdates.length, 2, 'cada fragmento válido deve renovar o heartbeat');
  assert.ok(toolUpdates.every((update) => update.phase === 'waiting_model'));
  assert.ok(toolUpdates.every((update) => update.tool_counts.total.total === 0));
  assert.ok(toolUpdates.every((update) => !('text' in update) && !('thinking' in update)));
});

// ── Streaming parser: dedup assistant/result e limites bounded ────────────

test('parseQuebragalhoCodeEvents deduplica assistant idêntico ao result agregado', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Resposta final.' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Resposta final.' }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'Resposta final.');
});

test('parseQuebragalhoCodeEvents trata result que agrega múltiplos blocos assistant parciais', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Resposta' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: ' final.' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Resposta final.' }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'Resposta final.');
});

test('parseQuebragalhoCodeEvents resolve sobreposição parcial de assistant para result', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Resposta fina' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Resposta final.' }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'Resposta final.');
});

test('parseQuebragalhoCodeEvents usa result canônico e preserva correlação de tools', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Primeira.\n' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/a.js' } },
    ] } }),
    JSON.stringify({ type: 'user', session_id: 's9', message: { content: [
      { type: 'tool_result', tool_use_id: 'r1', content: 'ok' },
    ] } }),
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Segunda.' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Segunda.' }),
  ].join('\n');
  const parsed = parseQuebragalhoCodeEvents(raw, '/repo');
  assert.equal(parsed.result, 'Segunda.');
  assert.deepEqual(parsed.successfulTools, ['Read']);
});

test('parseQuebragalhoCodeEvents substitui texto assistant por result canônico distinto', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: 'Análise.' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Conclusão diferente.' }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'Conclusão diferente.');
});

test('parseQuebragalhoCodeEvents filtra result canônico sem herdar think incompleto', () => {
  const raw = [
    JSON.stringify({ type: 'assistant', session_id: 's9', message: { content: [
      { type: 'text', text: '<think>rascunho incompleto' },
    ] } }),
    JSON.stringify({ type: 'result', session_id: 's9', result: 'Resultado canônico.' }),
  ].join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'Resultado canônico.');
});

test('texto público acumulado além do limite falha bounded com OUTPUT_LIMIT', () => {
  const bigText = 'x'.repeat(512 * 1024);
  const raw = Array.from({ length: 9 }, () => JSON.stringify({
    type: 'assistant',
    session_id: 's9',
    message: { content: [{ type: 'text', text: bigText }] },
  })).join('\n');
  assert.throws(
    () => parseQuebragalhoCodeEvents(raw, '/repo'),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
});

test('fluxo cumulativo acima de 4 MiB com resultado pequeno conclui sem OUTPUT_LIMIT', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-bigstream-'));
  const script = await createStreamingJsonlFixture(base);

  const result = await runQuebragalhoAgent(
    {
      prompt: 'leia os arquivos',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 30,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
      },
      spawnImpl: spawnStreamingJsonlFixture(script, (4 * 1024 * 1024) + 1),
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.result, 'Fluxo concluído.');
  assert.equal(result.session_id, 'stream_limit');
  assert.deepEqual(result.tools_used, []);
  assert.deepEqual(result.artifacts, []);
});

test('fluxo cumulativo um byte acima de 32 MiB falha com OUTPUT_LIMIT antes do timeout', {
  timeout: 5_000,
}, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-stream-limit-'));
  const script = await createStreamingJsonlFixture(base);

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'processe o fluxo',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 30,
      },
      {
        availableModels: MODELS,
        env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnStreamingJsonlFixture(script, (32 * 1024 * 1024) + 1),
        killGraceMs: 0,
        platform: 'linux',
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
});

test('OpenCode processa mais de 4 MiB e correlaciona tools por part.sessionID', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-opencode-bigstream-'));
  const bigToolOutput = 'x'.repeat(32 * 1024);
  const events = [];
  for (let i = 0; i < 70; i += 1) {
    events.push(
      {
        type: 'content',
        content_type: 'tool_call',
        name: 'Read',
        part: { sessionID: 'session_a' },
      },
      {
        type: 'content',
        content_type: 'tool_call',
        name: 'Read',
        part: { sessionID: 'session_b' },
      },
      {
        type: 'tool_result',
        part: { sessionID: 'session_b', is_error: false },
        content: bigToolOutput,
      },
      {
        type: 'tool_result',
        part: { sessionID: 'session_a', is_error: false },
        content: bigToolOutput,
      },
    );
  }
  events.push(
    {
      type: 'tool_use',
      part: {
        sessionID: 'session_b',
        id: 'final_read',
        tool: 'Read',
        state: { status: 'completed', input: { filePath: 'src/a.js' } },
      },
    },
    {
      type: 'text',
      part: { sessionID: 'session_b', text: 'Leitura OpenCode concluída.' },
    },
  );
  const streamPayload = `${events.map(JSON.stringify).join('\n')}\n`;
  assert.ok(Buffer.byteLength(streamPayload) > 4 * 1024 * 1024);

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(streamPayload);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };

  const result = await runQuebragalhoAgent(
    {
      prompt: 'leia os arquivos',
      cwd: base,
      executor: 'opencode',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 30,
    },
    {
      availableModels: MODELS,
      env: {
        ...process.env,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        QUEBRAGALHO_API_KEY: 'test-key',
      },
      spawnImpl,
    },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.result, 'Leitura OpenCode concluída.');
  assert.equal(result.session_id, 'session_a');
  assert.deepEqual(result.tools_used, ['Read']);
  assert.deepEqual(result.artifacts, [path.join(await realpath(base), 'src/a.js')]);
});

test('parser nativo limpa tool pendente após tool_result', () => {
  const cwd = path.resolve('/repo');
  const artifact = path.join(cwd, 'src', 'a.js');
  const events = [];
  for (let i = 0; i < 5_000; i += 1) {
    events.push(
      {
        type: 'assistant',
        message: { content: [{
          type: 'tool_use',
          id: `read_${i}`,
          name: 'Read',
          input: { file_path: artifact },
        }] },
      },
      {
        type: 'user',
        message: { content: [{
          type: 'tool_result',
          tool_use_id: `read_${i}`,
        }] },
      },
    );
  }
  const parsed = parseQuebragalhoCodeEvents(events.map(JSON.stringify).join('\n'), cwd);
  assert.deepEqual(parsed.successfulTools, ['Read']);
  assert.deepEqual(parsed.artifacts, [artifact]);
});

test('parser nativo limita coleção de tools pendentes', () => {
  const raw = Array.from({ length: 4_097 }, (_, index) => JSON.stringify({
    type: 'assistant',
    message: { content: [{
      type: 'tool_use',
      id: `read_${index}`,
      name: 'Read',
      input: { file_path: '/repo/src/a.js' },
    }] },
  })).join('\n');
  assert.throws(
    () => parseQuebragalhoCodeEvents(raw, '/repo'),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
});

test('parser agrega muitos fragmentos pequenos dentro do limite de bytes', () => {
  const raw = Array.from({ length: 4_097 }, () => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x' }] },
  })).join('\n');
  assert.equal(parseQuebragalhoCodeEvents(raw, '/repo').result, 'x'.repeat(4_097));
});

test('linha JSONL individual excessiva falha bounded com OUTPUT_LIMIT', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-bigline-'));
  const signals = [];
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 61234;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write(JSON.stringify({
        type: 'assistant',
        session_id: 'big_line',
        message: { content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] },
      }));
    });
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 'SIGTERM') setImmediate(() => child.emit('close', null));
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          ...process.env,
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
        platform: 'linux',
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
  assert.ok(signals.some(([pid, signal]) => signal === 'SIGTERM' && pid === -61234));
});

test('último evento sem newline rejeita se exceder texto público acumulado', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-final-line-limit-'));
  const signals = [];
  const piece = 'x'.repeat(512 * 1024);
  const completeLines = Array.from({ length: 8 }, () => JSON.stringify({
    type: 'assistant',
    session_id: 'final_line',
    message: { content: [{ type: 'text', text: piece }] },
  }));
  const finalLine = JSON.stringify({
    type: 'assistant',
    session_id: 'final_line',
    message: { content: [{ type: 'text', text: 'y' }] },
  });
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 61235;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(`${completeLines.join('\n')}\n${finalLine}`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
  };

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'audite',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: {
          ...process.env,
          QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
        },
        spawnImpl,
        killImpl,
        killGraceMs: 5,
        platform: 'linux',
      },
    ),
    (error) => error.code === 'OUTPUT_LIMIT',
  );
  assert.ok(signals.some(([pid, signal]) => signal === 'SIGTERM' && pid === -61235));
});

test('timeout nativo com Read e texto seguro retorna apenas fallback factual', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-partial-'));
  const freeText = 'Diagnóstico seguro.';
  const result = await runQuebragalhoAgent(
    {
      prompt: 'revise o projeto',
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'deepseek-v4.1-flash',
      timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnNativeTimeoutFixture(
        [
          { type: 'system', subtype: 'init', session_id: 'timeout_partial' },
          { type: 'assistant', session_id: 'timeout_partial', message: { content: [
            { type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: 'README.md' } },
          ] } },
          { type: 'user', session_id: 'timeout_partial', message: { content: [
            { type: 'tool_result', tool_use_id: 'read_1', content: 'ok' },
          ] } },
          { type: 'assistant', session_id: 'timeout_partial', message: { content: [
            { type: 'text', text: freeText },
          ] } },
        ],
        '{"type":"assistant","message":{"content":[{"type":"text","text":"vazamento incompleto',
      ),
      timeoutMs: 20,
      killGraceMs: 0,
      platform: 'linux',
    },
  );

  assert.equal(result.status, 'warning');
  assert.match(result.result, /Read/);
  assert.ok(!result.result.includes(freeText));
  assert.deepEqual(result.warnings.map(({ code }) => code), ['TIMEOUT']);
  assert.deepEqual(result.tools_used, ['Read']);
  assert.equal(result.session_id, null);
  assert.deepEqual(result.artifacts, []);
  assert.ok(!result.tools_used.includes('Edit'));
  assert.ok(!result.tools_used.includes('Write'));
  assert.ok(!result.result.includes('vazamento incompleto'));
});

test('timeout parcial preserva cooldown do modelo para a próxima rota auto', async () => {
  resetModelRuntimeState();
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-cooldown-'));
  const prompt = 'Faça uma auditoria de segurança complexa da arquitetura.';
  const availableModels = ['glm-5.3', 'deepseek-v4.1-flash'];
  const env = {
    ...process.env,
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
    QUEBRAGALHO_MODEL_COOLDOWN_SECONDS: '3600',
  };

  const partial = await runQuebragalhoAgent(
    {
      prompt,
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'glm-5.3',
      timeout_seconds: 10,
    },
    {
      availableModels,
      env,
      spawnImpl: spawnNativeTimeoutFixture([
        { type: 'assistant', session_id: 'timeout_cooldown', message: { content: [
          { type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: 'README.md' } },
        ] } },
        { type: 'user', session_id: 'timeout_cooldown', message: { content: [
          { type: 'tool_result', tool_use_id: 'read_1', content: 'ok' },
        ] } },
      ]),
      timeoutMs: 20,
      killGraceMs: 0,
      platform: 'linux',
    },
  );
  assert.equal(partial.status, 'warning');
  assert.deepEqual(partial.warnings.map(({ code }) => code), ['TIMEOUT']);

  let routedModel;
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    routedModel = args[args.indexOf('--model') + 1];
    setImmediate(() => {
      child.stdout.end(`${JSON.stringify({
        type: 'result',
        session_id: 'after_timeout',
        result: 'Concluído.',
      })}\n`);
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  const next = await runQuebragalhoAgent(
    {
      prompt,
      cwd: base,
      executor: 'native',
      mode: 'read_only',
      model: 'auto',
      timeout_seconds: 10,
    },
    // platform pinado como na primeira chamada: o spawn aqui é fake e lê args
    // por posição; no win32 real a invocação nativa pode vir embrulhada em cmd.
    { availableModels, env, spawnImpl, platform: 'linux' },
  );

  assert.equal(routedModel, 'deepseek-v4.1-flash');
  assert.equal(next.model, 'deepseek-v4.1-flash');
  assert.ok(next.routing.ranking
    .find(({ model }) => model === 'glm-5.3')
    .penalties.some((penalty) => penalty.includes('cooldown')));
});

test('timeout nativo ignora session_id e artefato inexistente controlados pelo stream', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-untrusted-fields-'));
  const sessionSecret = 'session-secret-REDACT-ME';
  const artifactSecret = 'artifact-secret-REDACT-ME.txt';
  const result = await runQuebragalhoAgent(
    {
      prompt: 'revise o projeto', cwd: base, executor: 'native', mode: 'write',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base, QUEBRAGALHO_AGENT_WRITE_ENABLED: '1' },
      spawnImpl: spawnNativeTimeoutFixture([
        { type: 'assistant', session_id: sessionSecret, message: { content: [
          { type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: artifactSecret } },
        ] } },
        { type: 'user', session_id: sessionSecret, message: { content: [
          { type: 'tool_result', tool_use_id: 'write_1', content: 'ok' },
        ] } },
      ]),
      timeoutMs: 20, killGraceMs: 0, platform: 'linux',
    },
  );

  assert.equal(result.status, 'warning');
  assert.equal(result.session_id, null);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.tools_used, ['Write']);
  assert.ok(!JSON.stringify(result).includes(sessionSecret));
  assert.ok(!JSON.stringify(result).includes(artifactSecret));
});

test('timeout com ferramenta proibida negada ainda sanitiza o resultado parcial', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-denied-tool-'));
  const sessionSecret = 'session-denied-secret-REDACT-ME';
  const artifactSecret = 'artifact-denied-secret-REDACT-ME.txt';
  const result = await runQuebragalhoAgent(
    {
      prompt: 'revise o projeto', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnNativeTimeoutFixture([
        { type: 'assistant', session_id: sessionSecret, message: { content: [
          { type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: artifactSecret } },
        ] } },
        { type: 'user', session_id: sessionSecret, message: { content: [
          { type: 'tool_result', tool_use_id: 'read_1', content: 'ok' },
        ] } },
        { type: 'assistant', session_id: sessionSecret, message: { content: [
          { type: 'tool_use', id: 'bash_1', name: 'Bash', input: {} },
        ] } },
        { type: 'user', session_id: sessionSecret, message: { content: [
          { type: 'tool_result', tool_use_id: 'bash_1', content: 'denied', is_error: true },
        ] } },
        {
          type: 'result',
          session_id: sessionSecret,
          result: 'texto não confiável',
          permission_denials: [{ tool_name: 'Bash', tool_use_id: 'bash_1' }],
        },
      ]),
      timeoutMs: 20, killGraceMs: 0, platform: 'linux',
    },
  );

  assert.equal(result.status, 'warning');
  assert.deepEqual(result.warnings.map(({ code }) => code), ['TIMEOUT']);
  assert.equal(result.session_id, null);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.tools_used, ['Read']);
  assert.ok(!JSON.stringify(result).includes(sessionSecret));
  assert.ok(!JSON.stringify(result).includes(artifactSecret));
});

test('negação comprovada sem timeout categoriza nome adversarial em tools_used', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-denied-tool-secret-'));
  const toolSecret = 'tool-secret-REDACT-ME';
  const finalText = 'Análise legítima preservada.';
  const result = await runQuebragalhoAgent(
    {
      prompt: 'revise o projeto', cwd: base, executor: 'native', mode: 'read_only',
      model: 'deepseek-v4.1-flash', timeout_seconds: 10,
    },
    {
      availableModels: MODELS,
      env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
      spawnImpl: spawnJsonlFixture([
        { type: 'assistant', session_id: 'safe', message: { content: [
          { type: 'tool_use', id: 'read_1', name: 'Read', input: {} },
        ] } },
        { type: 'user', session_id: 'safe', message: { content: [
          { type: 'tool_result', tool_use_id: 'read_1', content: 'ok' },
        ] } },
        { type: 'assistant', session_id: 'safe', message: { content: [
          { type: 'tool_use', id: 'denied_1', name: toolSecret, input: {} },
        ] } },
        { type: 'user', session_id: 'safe', message: { content: [
          { type: 'tool_result', tool_use_id: 'denied_1', content: 'denied', is_error: true },
        ] } },
        {
          type: 'result',
          session_id: 'safe',
          result: finalText,
          permission_denials: [{ tool_name: toolSecret, tool_use_id: 'denied_1' }],
        },
      ]),
    },
  );

  assert.equal(result.status, 'warning');
  assert.equal(result.result, finalText);
  assert.deepEqual(result.tools_used, ['Other', 'Read']);
  assert.equal(result.warnings, undefined);
  assert.ok(!JSON.stringify(result).includes(toolSecret));
  assert.ok(!JSON.stringify(result.routing).includes(toolSecret));
});

test('ferramenta proibida não publica nome controlado pelo stream', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-forbidden-tool-secret-'));
  const toolSecret = 'tool-secret-REDACT-ME';
  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'revise o projeto', cwd: base, executor: 'native', mode: 'read_only',
        model: 'deepseek-v4.1-flash', timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnJsonlFixture([
          { type: 'assistant', session_id: 'safe', message: { content: [
            { type: 'tool_use', id: 'forbidden_1', name: toolSecret, input: {} },
          ] } },
          { type: 'user', session_id: 'safe', message: { content: [
            { type: 'tool_result', tool_use_id: 'forbidden_1', content: 'ok' },
          ] } },
        ]),
      },
    ),
    (error) => (
      error.code === 'FORBIDDEN_TOOL_USED'
      && !error.message.includes(toolSecret)
      && !JSON.stringify(error.routing).includes(toolSecret)
      && error.routing.attempts[0].summary.includes('categorias: Other')
    ),
  );
});

test('timeout nativo sem conteúdo material continua rejeitando TIMEOUT', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-empty-'));
  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'revise o projeto',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnNativeTimeoutFixture(
          [{ type: 'system', subtype: 'init', session_id: 'timeout_empty' }],
          '{"type":"assistant","message":{"content":[',
        ),
        timeoutMs: 20,
        killGraceMs: 0,
        platform: 'linux',
      },
    ),
    (error) => error.code === 'TIMEOUT' && error.result === undefined,
  );
});

const TIMEOUT_REDACTION_CASES = [
  ['sk-live', 'sk-live-REDACT-ME-123456'],
  ['sk-live multilinha', 'sk-live-\nREDACT-ME-123456'],
  ['Bearer multilinha', 'Authorization: Bearer\nZXlKaGJHY2lPaJIUzI1NiJ9'],
  ['TOKEN', 'TOKEN=nao-expor-123456'],
  ['api_key', 'marcador-api-key-sem-credencial'],
  ['password', 'password=nao-expor-123456'],
];

for (const [label, secret] of TIMEOUT_REDACTION_CASES) {
  test(`timeout nativo com apenas conteúdo ${label} continua TIMEOUT`, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-secret-only-'));

    await assert.rejects(
      () => runQuebragalhoAgent(
        {
          prompt: 'revise o projeto',
          cwd: base,
          executor: 'native',
          mode: 'read_only',
          model: 'deepseek-v4.1-flash',
          timeout_seconds: 10,
        },
        {
          availableModels: MODELS,
          env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
          spawnImpl: spawnNativeTimeoutFixture([
            { type: 'assistant', session_id: 'secret_only', message: { content: [
              { type: 'text', text: secret },
            ] } },
          ]),
          timeoutMs: 20,
          killGraceMs: 0,
          platform: 'linux',
        },
      ),
      (error) => (
        error.code === 'TIMEOUT'
        && error.result === undefined
        && !error.message.includes(secret)
      ),
    );
  });
}

for (const [label, secret] of TIMEOUT_REDACTION_CASES) {
  test(`timeout nativo com Read e conteúdo ${label} usa apenas fallback factual`, async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-secret-mixed-'));
    const freeText = `Diagnóstico do modelo. ${secret}`;

    const result = await runQuebragalhoAgent(
      {
        prompt: 'revise o projeto',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnNativeTimeoutFixture([
          { type: 'assistant', session_id: 'secret_mixed', message: { content: [
            { type: 'tool_use', id: 'read_secret', name: 'Read', input: { file_path: 'README.md' } },
          ] } },
          { type: 'user', session_id: 'secret_mixed', message: { content: [
            { type: 'tool_result', tool_use_id: 'read_secret', content: 'ok' },
          ] } },
          { type: 'assistant', session_id: 'secret_mixed', message: { content: [
            { type: 'text', text: freeText },
          ] } },
        ]),
        timeoutMs: 20,
        killGraceMs: 0,
        platform: 'linux',
      },
    );

    assert.equal(result.status, 'warning');
    assert.match(result.result, /Read/);
    assert.ok(!result.result.includes('Diagnóstico do modelo.'));
    assert.ok(!result.result.includes(secret));
    assert.deepEqual(result.tools_used, ['Read']);
    assert.deepEqual(result.warnings.map(({ code }) => code), ['TIMEOUT']);
  });
}

test('timeout nativo com apenas texto benigno continua TIMEOUT', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-timeout-benign-token-'));
  const text = 'Análise de sk-security-review concluída com segurança.';

  await assert.rejects(
    () => runQuebragalhoAgent(
      {
        prompt: 'revise o projeto',
        cwd: base,
        executor: 'native',
        mode: 'read_only',
        model: 'deepseek-v4.1-flash',
        timeout_seconds: 10,
      },
      {
        availableModels: MODELS,
        env: { ...process.env, QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base },
        spawnImpl: spawnNativeTimeoutFixture([
          { type: 'assistant', session_id: 'benign_token', message: { content: [
            { type: 'text', text },
          ] } },
        ]),
        timeoutMs: 20,
        killGraceMs: 0,
        platform: 'linux',
      },
    ),
    (error) => error.code === 'TIMEOUT' && !error.message.includes(text),
  );
});

// ── resolveNativeCliBin / buildAgentInvocation (P2-1: shims .cmd no Windows) ──

// Os stubs são arquivos comuns: no posix precisam de +x para passar na
// checagem de acesso; no Windows a permissão de execução não existe.
// mkdtemp canônico: no CI Windows o TEMP vem em forma 8.3 (RUNNER~1) e o
// realpath do stub devolve a forma longa — canonicalizar o diretório evita
// comparar alias diferentes do mesmo caminho.
async function createTempBinDir(prefix) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function createBinStub(dir, name, ext) {
  const file = path.join(dir, name + ext);
  await writeFile(file, '@echo off\r\n', 'utf8');
  if (process.platform !== 'win32') await chmod(file, 0o755);
  return file;
}

test('resolveNativeCliBin resolve claude.exe com precedência sobre .cmd', async () => {
  const dir = await createTempBinDir('qg-native-bin-exe-');
  try {
    const exe = await createBinStub(dir, 'claude', '.exe');
    await createBinStub(dir, 'claude', '.cmd');
    assert.deepEqual(
      resolveNativeCliBin('claude', { PATH: dir }, { platform: 'win32' }),
      { file: await realpath(exe), kind: 'exe' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveNativeCliBin resolve shim .cmd no win32 varrendo cada diretório', async () => {
  const empty = await createTempBinDir('qg-native-bin-empty-');
  const dir = await createTempBinDir('qg-native-bin-cmd-');
  try {
    const cmd = await createBinStub(dir, 'claude', '.cmd');
    // Delimitador injetado: a ordem dos diretórios é do PATH fake mesmo fora
    // do Windows; o primeiro diretório não contém o binário.
    assert.deepEqual(
      resolveNativeCliBin(
        'claude',
        { PATH: `${empty};${dir}` },
        { platform: 'win32', pathDelimiter: ';' },
      ),
      { file: await realpath(cmd), kind: 'cmd' },
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveNativeCliBin não consulta o PATH para caminho explícito', () => {
  const relative = path.join('ferramentas', 'claude.cmd');
  assert.deepEqual(
    resolveNativeCliBin(relative, { PATH: '' }, { platform: 'win32' }),
    { file: relative, kind: 'path' },
  );
  const absolute = path.join(path.parse(process.cwd()).root, 'tools', 'claude.exe');
  assert.deepEqual(
    resolveNativeCliBin(absolute, { PATH: '' }, { platform: 'win32' }),
    { file: absolute, kind: 'path' },
  );
});

test('resolveNativeCliBin retorna null quando nada é encontrado', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qg-native-bin-miss-'));
  try {
    assert.equal(
      resolveNativeCliBin('claude', { PATH: dir }, { platform: 'win32' }),
      null,
    );
    // PATH vazio/ausente: nenhum diretório a percorrer.
    assert.equal(
      resolveNativeCliBin('claude', { PATH: '' }, { platform: 'win32' }),
      null,
    );
    assert.equal(resolveNativeCliBin('claude', {}, { platform: 'win32' }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveNativeCliBin no posix procura bin sem extensões do Windows', {
  // Simular posix num host Windows não é fiel: X_OK não tem semântica de
  // execução lá (e stub recém-escrito pode falhar transitório em varredura
  // antivírus). O ramo posix é coberto de verdade no CI linux/macos.
  skip: process.platform === 'win32',
}, async () => {
  const dir = await createTempBinDir('qg-native-bin-posix-');
  try {
    const bare = await createBinStub(dir, 'claude', '');
    await createBinStub(dir, 'claude', '.cmd');
    assert.deepEqual(
      resolveNativeCliBin(
        'claude',
        { PATH: dir },
        { platform: 'linux', pathDelimiter: ':' },
      ),
      { file: await realpath(bare), kind: 'bare' },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentInvocation no win32 embrulha shim .cmd com ComSpec /d /s /c', async () => {
  const dir = await createTempBinDir('qg-native-invocation-cmd-');
  try {
    const cmd = await createBinStub(dir, 'claude', '.cmd');
    const invocation = buildAgentInvocation(
      {
        prompt: 'diga "oi" agora',
        cwd: '/repo',
        mode: 'read_only',
        model: 'glm-5.3',
      },
      'native',
      { PATH: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      { platform: 'win32' },
    );
    assert.equal(invocation.executor, 'native');
    assert.equal(invocation.command, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(invocation.args.length, 4);
    const line = invocation.args[3];
    assert.ok(
      line.startsWith(await realpath(cmd)),
      `linha deve começar com o caminho resolvido do .cmd: ${line}`,
    );
    // Padrão conservador: arg com espaço/aspas envolto em aspas duplas com
    // aspas internas dobradas.
    assert.ok(
      line.endsWith('"diga ""oi"" agora"'),
      `prompt deve ficar aspado com aspas dobradas: ${line}`,
    );
    // Sem ComSpec no ambiente, o padrão é cmd.exe.
    const fallback = buildAgentInvocation(
      { prompt: 'audite', cwd: '/repo', mode: 'read_only', model: 'glm-5.3' },
      'native',
      { PATH: dir },
      { platform: 'win32' },
    );
    assert.equal(fallback.command, 'cmd.exe');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentInvocation no win32 usa .exe resolvido direto no spawn', async () => {
  const dir = await createTempBinDir('qg-native-invocation-exe-');
  try {
    const exe = await createBinStub(dir, 'claude', '.exe');
    const invocation = buildAgentInvocation(
      { prompt: 'audite', cwd: '/repo', mode: 'read_only', model: 'glm-5.3' },
      'native',
      { PATH: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      { platform: 'win32' },
    );
    assert.equal(invocation.command, await realpath(exe));
    assert.equal(invocation.args[0], '-p');
    assert.ok(!invocation.args.includes('/c'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentInvocation no win32 mantém o bin original quando não resolve', () => {
  const invocation = buildAgentInvocation(
    { prompt: 'audite', cwd: '/repo', mode: 'read_only', model: 'glm-5.3' },
    'native',
    { PATH: '' },
    { platform: 'win32' },
  );
  assert.equal(invocation.command, 'claude');
  assert.equal(invocation.args[0], '-p');
});

test('buildAgentInvocation mantém node+entrypoint no win32 mesmo com shim .cmd', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qg-native-invocation-entry-'));
  try {
    await createBinStub(dir, 'claude', '.cmd');
    const invocation = buildAgentInvocation(
      { prompt: 'audite', cwd: '/repo', mode: 'read_only', model: 'glm-5.3' },
      'native',
      {
        PATH: dir,
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        QUEBRAGALHO_CODE_BIN: 'node',
        QUEBRAGALHO_CODE_ENTRYPOINT: '/opt/claude-code/cli.mjs',
      },
      { platform: 'win32' },
    );
    assert.equal(invocation.command, 'node');
    assert.equal(invocation.args[0], '/opt/claude-code/cli.mjs');
    assert.ok(!invocation.args.includes('/c'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildAgentInvocation no posix não resolve nem embrulha', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qg-native-invocation-posix-'));
  try {
    // Mesmo com um "claude" executável no PATH, o ramo posix é inalterado.
    await createBinStub(dir, 'claude', '');
    const invocation = buildAgentInvocation(
      { prompt: 'audite', cwd: '/repo', mode: 'read_only', model: 'glm-5.3' },
      'native',
      { PATH: dir },
      { platform: 'linux', pathDelimiter: ':' },
    );
    assert.equal(invocation.command, 'claude');
    assert.equal(invocation.args[0], '-p');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── P1-2/P1-3: usage do executor nativo e guard de orçamento ─────────────

test('parser nativo captura usage do evento result, aninhada ou solta', () => {
  const cwd = path.resolve('/repo');
  const aninhada = parseQuebragalhoCodeEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({
      type: 'result',
      session_id: 's1',
      result: 'Concluído.',
      usage: { input_tokens: 120, output_tokens: 45 },
    }),
  ].join('\n'), cwd);
  assert.deepEqual(aninhada, {
    sessionId: 's1',
    result: 'Concluído.',
    artifacts: [],
    toolsUsed: [],
    successfulTools: [],
    usage: { in: 120, out: 45 },
  });

  const solta = parseQuebragalhoCodeEvents([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's2' }),
    JSON.stringify({
      type: 'result',
      session_id: 's2',
      result: 'Concluído.',
      input_tokens: 10,
      output_tokens: 7,
    }),
  ].join('\n'), cwd);
  assert.deepEqual(solta.usage, { in: 10, out: 7 });
});

test('parser nativo sem usage não quebra e não expõe a chave', () => {
  const cwd = path.resolve('/repo');
  for (const extra of [{}, { usage: {} }, { usage: { input_tokens: 'muito' } }]) {
    const parsed = parseQuebragalhoCodeEvents([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's3' }),
      JSON.stringify({ type: 'result', session_id: 's3', result: 'Concluído.', ...extra }),
    ].join('\n'), cwd);
    assert.equal(parsed.usage, undefined);
    assert.deepEqual(parsed, {
      sessionId: 's3',
      result: 'Concluído.',
      artifacts: [],
      toolsUsed: [],
      successfulTools: [],
    });
  }
});

function usageTestEnv(base, usageDir, extra = {}) {
  return {
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: base,
    QUEBRAGALHO_USAGE_DIR: usageDir,
    ...extra,
  };
}

async function lerLinhas(file) {
  const raw = await readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('runQuebragalhoAgent grava usage nativa no diário e avisa em 80% do teto', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-usage-'));
  const usageDir = path.join(base, 'usage');
  // Pré-popula 0.90 USD de teto de 1 USD (30M in * 0.03/M no gpt-6-luna).
  await recordUsage(
    { model: 'gpt-6-luna', executor: 'direct', inTokens: 30_000_000, outTokens: 0 },
    { QUEBRAGALHO_USAGE_DIR: usageDir },
  );
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'result',
      session_id: 's1',
      result: 'Pronto.',
      usage: { input_tokens: 500, output_tokens: 200 },
    },
  ];
  const result = await runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'gpt-6-luna', timeout_seconds: 10,
    },
    {
      availableModels: ['gpt-6-luna'],
      env: usageTestEnv(base, usageDir, { QUEBRAGALHO_MAX_SPEND_USD: '1' }),
      spawnImpl: spawnJsonlFixture(events),
    },
  );
  assert.equal(result.status, 'success');
  const warning = (result.warnings ?? []).find(({ code }) => code === 'BUDGET_WARNING');
  assert.ok(warning, 'deveria anexar BUDGET_WARNING entre 80% e 100% do teto');
  assert.match(warning.message, /Aviso de orçamento/);

  // Gravação é fire-and-forget: aguarda a linha do executor nativo aparecer.
  const file = usageFileForDate({ QUEBRAGALHO_USAGE_DIR: usageDir }, todayLocalDate());
  let nativa;
  for (let attempt = 0; attempt < 100 && !nativa; attempt += 1) {
    try {
      nativa = (await lerLinhas(file)).find((line) => line.executor === 'native');
    } catch {
      // append ainda não ocorreu
    }
    if (!nativa) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(nativa, 'linha do executor native deveria ser gravada');
  assert.equal(nativa.model, 'gpt-6-luna');
  assert.equal(nativa.in_tokens, 500);
  assert.equal(nativa.out_tokens, 200);
  assert.equal(nativa.requests, 1);
  assert.ok(!Number.isNaN(Date.parse(nativa.timestamp)), 'timestamp ISO válido');
  assert.deepEqual(Object.keys(nativa).sort(), [
    'executor', 'in_tokens', 'model', 'out_tokens', 'requests', 'timestamp',
  ]);
});

test('runQuebragalhoAgent falha fechado com BUDGET_EXCEEDED antes de spawnar', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-budget-'));
  const usageDir = path.join(base, 'usage');
  // Pré-popula 0.03 USD (1M in * 0.03/M) contra teto de 0.01 USD.
  await recordUsage(
    { model: 'gpt-6-luna', executor: 'direct', inTokens: 1_000_000, outTokens: 0 },
    { QUEBRAGALHO_USAGE_DIR: usageDir },
  );
  let spawned = 0;
  const countingSpawn = (...args) => {
    spawned += 1;
    return spawnJsonlFixture([])(...args);
  };
  const error = await runQuebragalhoAgent(
    {
      prompt: 'não deve executar', cwd: base, executor: 'native', mode: 'read_only',
      model: 'gpt-6-luna', timeout_seconds: 10,
    },
    {
      availableModels: ['gpt-6-luna'],
      env: usageTestEnv(base, usageDir, { QUEBRAGALHO_MAX_SPEND_USD: '0.01' }),
      spawnImpl: countingSpawn,
    },
  ).then(
    () => { throw new Error('runQuebragalhoAgent deveria bloquear por orçamento'); },
    (err) => err,
  );
  assert.equal(error.code, 'BUDGET_EXCEEDED');
  assert.match(error.message, /QUEBRAGALHO_MAX_SPEND_USD/);
  assert.match(error.message, /virar o dia local/);
  assert.equal(spawned, 0, 'guard pré-voo não pode spawnar o executor');
  assert.ok(
    formatAgentFailure(error).next_actions.some((action) => /QUEBRAGALHO_MAX_SPEND_USD/.test(action)),
    'recuperação do formato de falha cita a env do teto',
  );
});

test('runQuebragalhoAgent sem teto configurado não bloqueia com gasto alto', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-native-nolimit-'));
  const usageDir = path.join(base, 'usage');
  await recordUsage(
    { model: 'gpt-6-luna', executor: 'direct', inTokens: 100_000_000, outTokens: 0 },
    { QUEBRAGALHO_USAGE_DIR: usageDir },
  );
  const events = [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'result', session_id: 's1', result: 'Concluído sem teto.' },
  ];
  const result = await runQuebragalhoAgent(
    {
      prompt: 'audite sem shell', cwd: base, executor: 'native', mode: 'read_only',
      model: 'gpt-6-luna', timeout_seconds: 10,
    },
    {
      availableModels: ['gpt-6-luna'],
      env: usageTestEnv(base, usageDir),
      spawnImpl: spawnJsonlFixture(events),
    },
  );
  assert.equal(result.status, 'success');
  assert.equal(result.warnings, undefined);
});
