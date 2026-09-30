#!/usr/bin/env node
// Diagnóstico do ambiente do quebragalho-bridge: verifica chave do gateway,
// CLI nativa, raízes permitidas, diretórios de estado e versão do Node.
// Sai com 0 quando tudo está ok e 1 quando qualquer verificação falha.

import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveNativeCliBin } from '../agent-runner.mjs';

const DEFAULT_BASE_URL = 'https://api.quebragalho.dev/v1';
const MODELS_TIMEOUT_MS = 10_000;
const MIN_NODE_MAJOR = 18;
const KEY_FIX =
  'crie a chave com `npx quebragalho init` ou no app.quebragalho.dev e exporte QUEBRAGALHO_API_KEY';

const USAGE = `quebragalho-doctor — diagnóstico do ambiente quebragalho-bridge

Uso:
  quebragalho-doctor [--json] [--help]

Verificações:
  1. Chave do gateway      QUEBRAGALHO_API_KEY contra GET {QUEBRAGALHO_BASE_URL}/models
  2. CLI nativa            resolve claude (ou QUEBRAGALHO_CODE_BIN) no PATH
  3. Raízes permitidas     QUEBRAGALHO_AGENT_ALLOWED_ROOTS existem no disco
  4. Diretórios de estado  QUEBRAGALHO_JOB_STORE_DIR / _MEMORY_DIR / _USAGE_DIR
  5. Versão do Node        exige Node >= ${MIN_NODE_MAJOR}

Opções:
  --json   imprime o resultado como JSON (array de {check, ok, detail, fix})
  --help   mostra esta ajuda

Códigos de saída: 0 tudo ok; 1 alguma verificação falhou.

A chave NUNCA é impressa por completo (apenas os 4 primeiros caracteres).
`;

function parseArgs(argv) {
  const flags = { json: false, help: false, invalid: null };
  for (const arg of argv) {
    if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else flags.invalid ??= arg;
  }
  return flags;
}

// Nunca imprime o valor completo da chave — só os 4 primeiros chars + '...'.
function maskKey(key) {
  return `${String(key).slice(0, 4)}...`;
}

function baseUrl(env) {
  return String(env.QUEBRAGALHO_BASE_URL ?? '').trim().replace(/\/+$/, '')
    || DEFAULT_BASE_URL;
}

async function checkApiKey(env) {
  const key = String(env.QUEBRAGALHO_API_KEY ?? '').trim();
  if (!key) {
    return {
      check: 'chave-gateway',
      ok: false,
      detail: 'QUEBRAGALHO_API_KEY não configurada.',
      fix: KEY_FIX,
    };
  }

  const url = `${baseUrl(env)}/models`;
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.code ?? error?.name;
    return {
      check: 'chave-gateway',
      ok: false,
      detail: `sem resposta do gateway em ${url} (${cause ?? 'erro desconhecido'}; chave ${maskKey(key)}).`,
      fix: `confira conectividade/base URL e ${KEY_FIX.charAt(0).toLowerCase()}${KEY_FIX.slice(1)}`,
    };
  }

  if (response.ok) {
    let models = 0;
    try {
      const body = await response.json();
      if (Array.isArray(body?.data)) models = body.data.length;
    } catch { /* corpo ignorado: só a contagem interessa */ }
    return {
      check: 'chave-gateway',
      ok: true,
      detail: `chave válida, ${models} modelos visíveis (${maskKey(key)}).`,
      fix: null,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      check: 'chave-gateway',
      ok: false,
      detail: `chave inválida ou sem crédito (HTTP ${response.status}; chave ${maskKey(key)}).`,
      fix: KEY_FIX,
    };
  }

  return {
    check: 'chave-gateway',
    ok: false,
    detail: `gateway respondeu HTTP ${response.status} em ${url} (corpo ignorado; chave ${maskKey(key)}).`,
    fix: `verifique QUEBRAGALHO_BASE_URL e o status do gateway; se persistir, ${KEY_FIX}`,
  };
}

function checkNativeCli(env) {
  const configured = String(env.QUEBRAGALHO_CODE_BIN ?? '').trim() || 'claude';
  const binName = path.basename(configured);
  const resolved = resolveNativeCliBin(binName, env);
  if (resolved) {
    return {
      check: 'cli-nativa',
      ok: true,
      detail: `${binName} resolvido em ${resolved.file} (${resolved.kind}).`,
      fix: null,
    };
  }
  return {
    check: 'cli-nativa',
    ok: false,
    detail: `${binName} não encontrado no PATH.`,
    fix: 'instale a CLI Claude Code (`npm install --global @anthropic-ai/claude-code`) ou configure QUEBRAGALHO_CODE_BIN',
  };
}

function checkAllowedRoots(env) {
  const raw = String(env.QUEBRAGALHO_AGENT_ALLOWED_ROOTS ?? '').trim();
  if (!raw) {
    return {
      check: 'raizes-permitidas',
      ok: false,
      detail: 'QUEBRAGALHO_AGENT_ALLOWED_ROOTS ausente/vazia — sem ela quebragalho_agent falha fechado (ALLOWED_ROOTS_MISSING).',
      fix: 'configure QUEBRAGALHO_AGENT_ALLOWED_ROOTS com raízes explícitas e reinicie o cliente MCP',
    };
  }

  const roots = raw
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const missing = roots.filter((root) => {
    try {
      realpathSync(root);
      return false;
    } catch {
      return true;
    }
  });

  if (missing.length === 0) {
    return {
      check: 'raizes-permitidas',
      ok: true,
      detail: `${roots.length} raiz(es) configurada(s) e existente(s) no disco.`,
      fix: null,
    };
  }

  return {
    check: 'raizes-permitidas',
    ok: false,
    detail: `raízes inexistentes: ${missing.join(', ')}.`,
    fix: 'crie os diretórios ou corrija/remova as raízes inexistentes em QUEBRAGALHO_AGENT_ALLOWED_ROOTS',
  };
}

function defaultStateDir(env, leaf) {
  return path.join(
    env.HOME || os.homedir(),
    '.local',
    'share',
    'quebragalho-bridge',
    leaf,
  );
}

function inspectStateDir(env, varName, notConfiguredNote) {
  const configured = String(env[varName] ?? '').trim();
  if (!configured) {
    return { ok: true, text: `${varName}: não configurado — ${notConfiguredNote}` };
  }

  let stats;
  try {
    stats = statSync(configured);
  } catch {
    return {
      ok: false,
      text: `${varName}: ${configured} não existe.`,
      fix: `crie o diretório ${configured} ou aponte ${varName} para um caminho existente`,
    };
  }
  if (!stats.isDirectory()) {
    return {
      ok: false,
      text: `${varName}: ${configured} não é um diretório.`,
      fix: `aponte ${varName} para um diretório`,
    };
  }
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o700) {
    return {
      ok: false,
      text: `${varName}: ${configured} existe, mas o modo ${(stats.mode & 0o777).toString(8)} não é 0700.`,
      fix: `chmod 700 ${configured}`,
    };
  }
  return { ok: true, text: `${varName}: ${configured} ok.` };
}

function checkStateDirs(env) {
  const inspected = [
    inspectStateDir(
      env,
      'QUEBRAGALHO_JOB_STORE_DIR',
      'persistência de jobs desativada (QUEBRAGALHO_JOB_PERSIST_RESULTS=1 exige configurá-lo).',
    ),
    inspectStateDir(
      env,
      'QUEBRAGALHO_MEMORY_DIR',
      `memória usará o default ${defaultStateDir(env, 'memory')}.`,
    ),
    inspectStateDir(
      env,
      'QUEBRAGALHO_USAGE_DIR',
      `diário de uso usará o default ${defaultStateDir(env, 'usage')}.`,
    ),
  ];

  const failed = inspected.filter((item) => !item.ok);
  return {
    check: 'diretorios-estado',
    ok: failed.length === 0,
    detail: inspected.map((item) => item.text).join(' '),
    fix: failed.length === 0 ? null : failed.map((item) => item.fix).join('; '),
  };
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return {
      check: 'versao-node',
      ok: true,
      detail: `Node ${process.version} (>= ${MIN_NODE_MAJOR}).`,
      fix: null,
    };
  }
  return {
    check: 'versao-node',
    ok: false,
    detail: `Node ${process.version} é anterior ao mínimo exigido (${MIN_NODE_MAJOR}).`,
    fix: `atualize o Node para >= ${MIN_NODE_MAJOR} (https://nodejs.org)`,
  };
}

function renderHuman(results) {
  const labels = {
    'chave-gateway': 'Chave do gateway',
    'cli-nativa': 'CLI nativa',
    'raizes-permitidas': 'Raízes permitidas',
    'diretorios-estado': 'Diretórios de estado',
    'versao-node': 'Versão do Node',
  };
  const lines = ['quebragalho-doctor — diagnóstico do ambiente quebragalho-bridge', ''];
  for (const result of results) {
    const mark = result.ok ? '✔' : '✖';
    lines.push(`${mark} ${labels[result.check] ?? result.check}: ${result.detail}`);
    if (!result.ok && result.fix) lines.push(`   correção: ${result.fix}`);
  }
  const passed = results.filter((result) => result.ok).length;
  lines.push('');
  lines.push(
    passed === results.length
      ? `Resumo: ${passed}/${results.length} verificações ok. Ambiente pronto.`
      : `Resumo: ${passed}/${results.length} verificações ok. Corrija os itens ✖ acima.`,
  );
  return lines.join('\n');
}

const flags = parseArgs(process.argv.slice(2));

if (flags.invalid) {
  console.error(`Argumento desconhecido: ${flags.invalid}\n`);
  console.error(USAGE);
  process.exitCode = 2;
} else if (flags.help) {
  console.log(USAGE);
  process.exitCode = 0;
} else {
  const env = process.env;
  const results = [
    await checkApiKey(env),
    checkNativeCli(env),
    checkAllowedRoots(env),
    checkStateDirs(env),
    checkNodeVersion(),
  ];

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(renderHuman(results));
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
