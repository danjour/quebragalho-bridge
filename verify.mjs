import { spawn, execFile } from 'node:child_process';
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveAllowedCwd } from './agent-runner.mjs';

// ── Safe Validation (quebragalho_validate) ────────────────────────────────────
// Validação de repositório SEM iniciar agente/job, em dois perfis: estático
// (node --check, git read-only) sob QUEBRAGALHO_AGENT_VERIFY_ENABLED=1 e
// project-code (npm test/npm run allowlistado) que exige ADICIONALMENTE
// QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1 por executar código do projeto
// (escrita, caches, rede). Execução só pelo binário absoluto resolvido na
// validação, argv estrito com shell:false, cwd realpath, HOME isolado e
// timeouts por comando e total. Não é read-only; não há isolamento de rede.

const VERIFY_ENABLED = process.env.QUEBRAGALHO_AGENT_VERIFY_ENABLED === '1';
const VERIFY_PROJECT_CODE_ENABLED = process.env.QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED === '1';
const VERIFY_MAX_COMMANDS = 10;
const VERIFY_MAX_ARGS = 20;
const VERIFY_MAX_ARG_LEN = 200;
const VERIFY_OUTPUT_LIMIT = 8 * 1024;
const VERIFY_MAX_TIMEOUT_SECONDS = 600;
const VERIFY_DEFAULT_TIMEOUT_SECONDS = 120;
const VERIFY_TOTAL_MAX_SECONDS = 600;
const VERIFY_KILL_GRACE_MS = 1500;
const VERIFY_HARD_SETTLE_MS = 2000;

function verifyAllowlist(envVar) {
  return new Set(
    String(process.env[envVar] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function verifyChildEnv(homeDir, cmd) {
  const env = {
    PATH: process.env.PATH,
    HOME: homeDir,
    TMPDIR: homeDir,
    CI: 'true',
    NO_COLOR: '1',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot;
    env.USERPROFILE = homeDir;
  }
  if (cmd === 'git') {
    // `status` pode chamar o fsmonitor configurado pelo próprio repositório.
    // Config de escopo command vence a local; locks opcionais evitam refresh do index.
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: path.join(homeDir, 'git-hooks-disabled'),
      GIT_OPTIONAL_LOCKS: '0',
    });
  }
  return env;
}

function redactVerifyOutput(text, apiKey) {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('<redacted>');
  return out.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
}

// Resolve o binário no MESMO PATH entregue ao processo filho e devolve o
// caminho absoluto realpath que será executado - o PATH do filho nunca pode
// selecionar outro executável depois da validação.
function resolveVerifyBinary(cmd, pathEnv) {
  if (!/^[A-Za-z0-9._-]+$/.test(cmd)) {
    throw new Error('nome de binário inválido');
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const resolved = realpathSync(path.join(dir, cmd + ext));
        accessSync(resolved, constants.X_OK);
        return resolved;
      } catch { /* próximo candidato */ }
    }
  }
  throw new Error(`binário de validação não encontrado: ${cmd}`);
}

function resolveVerifyExecutable(cmd, pathEnv) {
  const bin = resolveVerifyBinary(cmd, pathEnv);
  if (cmd !== 'npm') {
    return { bin, prefixArgs: [], supportFiles: [] };
  }

  // npm é um script. Execute-o sempre com o mesmo node absoluto resolvido
  // agora, sem deixar "#!/usr/bin/env node" consultar o PATH no spawn.
  let npmCli = bin;
  try {
    if (process.platform === 'win32' && bin.toLowerCase().endsWith('.cmd')) {
      npmCli = realpathSync(
        path.join(path.dirname(bin), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      );
    }
  } catch {
    throw new Error('npm.cmd sem npm-cli.js verificável');
  }
  return {
    bin: resolveVerifyBinary('node', pathEnv),
    prefixArgs: [npmCli],
    supportFiles: [npmCli],
  };
}

function validateVerifyArgs(args) {
  if (args.length > VERIFY_MAX_ARGS) {
    throw new Error(`muitos argumentos (max ${VERIFY_MAX_ARGS})`);
  }
  for (const arg of args) {
    if (arg.length > VERIFY_MAX_ARG_LEN) {
      throw new Error(`argumento excede ${VERIFY_MAX_ARG_LEN} caracteres`);
    }
    if (/[;&|<>$`]/.test(arg)) {
      throw new Error('argumento com metacaractere proibido');
    }
  }
}

function validateNpmVerifyArgs(args) {
  if (args.length === 1 && args[0] === 'test') return;
  if (
    args.length === 2
    && args[0] === 'run'
    && /^[A-Za-z0-9:_-]+$/.test(args[1])
  ) {
    if (verifyAllowlist('QUEBRAGALHO_AGENT_VERIFY_NPM_SCRIPTS').has(args[1])) return;
    throw new Error('script npm fora da allowlist administrativa');
  }
  throw new Error('comando npm fora da política de validação');
}

function resolveNodeCheckFile(args, cwd) {
  if (args.length !== 2 || args[0] !== '--check') {
    throw new Error('comando node fora da política de validação');
  }
  let file;
  try {
    file = realpathSync(path.resolve(cwd, args[1]));
  } catch {
    throw new Error('arquivo de verificação inexistente');
  }
  if (file === cwd || !file.startsWith(cwd + path.sep)) {
    throw new Error('arquivo de verificação fora do diretório autorizado');
  }
  return file;
}

function validateGitVerifyArgs(args) {
  // Allowlist positiva exata: qualquer flag/pathspec/config não modelada
  // (-c, --git-dir, --work-tree, pager, pathspec magic) é rejeitada.
  const allowed = [
    ['diff', '--check'],
    ['diff', '--cached', '--check'],
    ['status', '--porcelain=v1'],
    ['log', '--oneline'],
  ];
  const exactMatch = allowed.some(
    (spec) => spec.length === args.length
      && spec.every((value, index) => value === args[index]),
  );
  const boundedLog = args.length === 4
    && args[0] === 'log'
    && args[1] === '--oneline'
    && args[2] === '-n'
    && /^\d{1,3}$/.test(args[3])
    && Number(args[3]) <= 100;
  if (!exactMatch && !boundedLog) {
    throw new Error('comando git fora da política de validação');
  }
}

function normalizeVerifyCommand(command, cwd, pathEnv) {
  const cmd = String(command?.cmd ?? '');
  const args = Array.isArray(command?.args) ? command.args.map(String) : [];
  validateVerifyArgs(args);
  let file = null;
  switch (cmd) {
    case 'npm':
      validateNpmVerifyArgs(args);
      break;
    case 'node':
      file = resolveNodeCheckFile(args, cwd);
      break;
    case 'git':
      validateGitVerifyArgs(args);
      break;
    default:
      throw new Error(`comando fora da política de validação: ${cmd}`);
  }
  const executable = resolveVerifyExecutable(cmd, pathEnv);
  const normalizedArgs = file ? ['--check', file] : args;
  return {
    cmd,
    args: normalizedArgs,
    execArgs: [...executable.prefixArgs, ...normalizedArgs],
    bin: executable.bin,
    file,
    supportFiles: executable.supportFiles,
  };
}

// Revalida imediatamente antes do spawn: o binário/arquivo resolvido não pode
// ter sido trocado (ex.: symlink re-apontado) entre a validação e a execução.
function recheckVerifyTarget(command) {
  try {
    if (realpathSync(command.bin) !== command.bin) {
      return 'binário de validação alterado após a política';
    }
    accessSync(command.bin, constants.X_OK);
    if (command.file && realpathSync(command.file) !== command.file) {
      return 'arquivo de verificação alterado após a política';
    }
    for (const supportFile of command.supportFiles) {
      if (realpathSync(supportFile) !== supportFile) {
        return 'suporte do executável alterado após a política';
      }
    }
    return null;
  } catch {
    return 'alvo de validação indisponível na revalidação';
  }
}

function killWindowsVerifyTree(child, signal) {
  if (process.platform !== 'win32' || !child.pid) return false;
  try {
    const systemRoot = realpathSync(
      process.env.SystemRoot || String.raw`C:\Windows`,
    );
    const taskkill = realpathSync(path.join(systemRoot, 'System32', 'taskkill.exe'));
    if (!taskkill.toLowerCase().startsWith(systemRoot.toLowerCase() + path.sep)) {
      throw new Error('taskkill fora de SystemRoot');
    }
    execFile(
      taskkill,
      ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
      { shell: false, windowsHide: true },
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}

function killUnixVerifyGroup(child, signal) {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, signal); // grupo de processo (detached)
    return true;
  } catch {
    return false;
  }
}

function killVerifyChild(child, signal) {
  if (killWindowsVerifyTree(child, signal)) return;
  if (killUnixVerifyGroup(child, signal)) return;
  try { child.kill(signal); } catch { /* processo já encerrado */ }
}

function emptyVerifyResult() {
  return {
    exit_code: null,
    signal: null,
    timed_out: false,
    hard_settled: false,
    duration_ms: 0,
    stdout: '',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
  };
}

function runVerifyCommand(command, cwd, env, timeoutMs, apiKey) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command.bin, command.execArgs, {
        cwd,
        shell: false,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({
        ...emptyVerifyResult(),
        duration_ms: Date.now() - startedAt,
        error: 'falha ao iniciar o processo de validação',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let finished = false;
    let timedOut = false;

    const collect = (current, chunk) => {
      const text = chunk.toString('utf8');
      if (current.length + text.length > VERIFY_OUTPUT_LIMIT) {
        return { text: current + text.slice(0, Math.max(0, VERIFY_OUTPUT_LIMIT - current.length)), truncated: true };
      }
      return { text: current + text, truncated: false };
    };
    child.stdout.on('data', (chunk) => {
      const next = collect(stdout, chunk);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on('data', (chunk) => {
      const next = collect(stderr, chunk);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    function finish(extra) {
      if (finished) return;
      finished = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      resolve({
        ...emptyVerifyResult(),
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout: redactVerifyOutput(stdout, apiKey),
        stderr: redactVerifyOutput(stderr, apiKey),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        ...extra,
      });
    }

    // SIGTERM → SIGKILL → hard-settle: resolve mesmo que `close` nunca chegue.
    const termTimer = setTimeout(() => {
      timedOut = true;
      killVerifyChild(child, 'SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (timedOut) killVerifyChild(child, 'SIGKILL');
    }, timeoutMs + VERIFY_KILL_GRACE_MS);
    const settleTimer = setTimeout(() => {
      if (timedOut) finish({ signal: 'SIGKILL', hard_settled: true });
    }, timeoutMs + VERIFY_KILL_GRACE_MS + VERIFY_HARD_SETTLE_MS);

    child.on('error', () => finish({ error: 'processo de validação falhou ao iniciar' }));
    child.on('close', (code, signal) => finish({ exit_code: code, signal }));
  });
}

function verifyCommandFailed(result) {
  return Boolean(result.error) || result.timed_out || result.exit_code !== 0;
}

async function executeVerifyBatch({
  normalized,
  cwd,
  isolatedHome,
  perCommandMs,
  stopOnFailure,
  apiKey,
}) {
  const deadline = Date.now()
    + Math.min(perCommandMs * normalized.length, VERIFY_TOTAL_MAX_SECONDS * 1000);
  const results = [];
  let stoppedEarly = false;
  let stopReason = null;
  for (const command of normalized) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      stoppedEarly = true;
      stopReason = 'total_timeout';
      break;
    }
    const recheckError = recheckVerifyTarget(command);
    const result = recheckError
      ? { ...emptyVerifyResult(), error: recheckError }
      : await runVerifyCommand(
        command,
        cwd,
        verifyChildEnv(isolatedHome, command.cmd),
        Math.min(perCommandMs, remainingMs),
        apiKey,
      );
    results.push({ cmd: command.cmd, args: command.args, ...result });
    if (verifyCommandFailed(result) && stopOnFailure && results.length < normalized.length) {
      stoppedEarly = true;
      stopReason = 'failure';
      break;
    }
  }
  return {
    stoppedEarly,
    stopReason,
    results,
    anyFailure: stoppedEarly || results.some(verifyCommandFailed),
  };
}

async function runQuebragalhoValidate(args, { apiKey } = {}) {
  if (!VERIFY_ENABLED) {
    return {
      status: 'error',
      error: 'quebragalho_validate desabilitado; exige opt-in administrativo QUEBRAGALHO_AGENT_VERIFY_ENABLED=1.',
    };
  }
  let cwd;
  try {
    cwd = realpathSync(await resolveAllowedCwd(
      String(args.cwd ?? ''),
      process.env.QUEBRAGALHO_AGENT_ALLOWED_ROOTS,
    ));
  } catch {
    return { status: 'error', error: 'cwd fora das raízes autorizadas ou inexistente.' };
  }
  const commands = Array.isArray(args.commands) ? args.commands : [];
  if (commands.length < 1 || commands.length > VERIFY_MAX_COMMANDS) {
    return {
      status: 'error',
      error: `commands deve ter entre 1 e ${VERIFY_MAX_COMMANDS} itens.`,
    };
  }
  if (
    commands.some((command) => String(command?.cmd ?? '') === 'npm')
    && !VERIFY_PROJECT_CODE_ENABLED
  ) {
    return {
      status: 'error',
      error: 'perfil project-code (npm) exige opt-in adicional QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1.',
      executed: [],
    };
  }
  const timeoutSeconds = Number.isInteger(args.timeout_seconds)
    ? Math.min(Math.max(args.timeout_seconds, 1), VERIFY_MAX_TIMEOUT_SECONDS)
    : VERIFY_DEFAULT_TIMEOUT_SECONDS;
  const stopOnFailure = args.stop_on_failure !== false;

  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'quebragalho-verify-home-'));
  try {
    // Valida TODA a sequência antes de executar qualquer comando: violação de
    // política falha fechado, sem efeito parcial no repositório.
    let normalized;
    try {
      normalized = commands.map((command) => normalizeVerifyCommand(
        command,
        cwd,
        verifyChildEnv(isolatedHome).PATH,
      ));
    } catch (err) {
      return { status: 'error', error: err.message, executed: [] };
    }
    const perCommandMs = timeoutSeconds * 1000;
    const {
      stoppedEarly,
      stopReason,
      results,
      anyFailure,
    } = await executeVerifyBatch({
      normalized,
      cwd,
      isolatedHome,
      perCommandMs,
      stopOnFailure,
      apiKey,
    });
    return {
      status: anyFailure ? 'failed' : 'ok',
      cwd,
      timeout_seconds: timeoutSeconds,
      stopped_early: stoppedEarly,
      stop_reason: stopReason,
      results,
    };
  } finally {
    try {
      rmSync(isolatedHome, { recursive: true, force: true });
    } catch { /* limpeza do HOME isolado é best-effort */ }
  }
}

export { runQuebragalhoValidate };
