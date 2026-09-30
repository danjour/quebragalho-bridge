// Diário de uso (tokens) por dia local, base do guard de orçamento (P1-3).
// CONTRATO DE CONTEÚDO: cada linha contém SOMENTE contadores e identificadores
// — timestamp, model, executor, in_tokens, out_tokens, requests. Nunca gravar
// prompt, cwd, env, texto de resposta ou qualquer derivado deles; não há o que
// redigir porque nada sensível entra aqui, e qualquer campo novo precisa
// preservar esse contrato.
import {
  appendFile,
  mkdir,
  open,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const appendQueues = new Map();

export function todayLocalDate(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

// Mesma resolução de memoryDirectory (memory-store.mjs), replicada e não
// importada: store de uso tem ciclo de vida e permissões próprias.
export function usageDirectory(env) {
  const configured = String(env.QUEBRAGALHO_USAGE_DIR ?? '').trim();
  if (configured) return path.resolve(configured);
  return path.join(env.HOME || os.homedir(), '.local', 'share', 'quebragalho-bridge', 'usage');
}

export function usageFileForDate(env, date) {
  return path.join(usageDirectory(env), `usage-${date}.jsonl`);
}

function enqueueAppend(file, operation) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  appendQueues.set(file, current);
  return current.finally(() => {
    if (appendQueues.get(file) === current) appendQueues.delete(file);
  });
}

// Append atômico de linha, serializado por arquivo como em memory-store.mjs.
// Tolerante a falha de disco: resolve false silenciosamente (a store não
// loga); quem chama decide o que fazer com o resultado.
export async function recordUsage(
  { model, executor = 'direct', inTokens = 0, outTokens = 0 },
  env,
  { now = Date.now() } = {},
) {
  const modelName = String(model ?? '').trim();
  if (!modelName) return false;
  const entry = {
    timestamp: new Date(now).toISOString(),
    model: modelName,
    executor: String(executor ?? 'direct'),
    in_tokens: Math.max(0, Math.trunc(Number(inTokens) || 0)),
    out_tokens: Math.max(0, Math.trunc(Number(outTokens) || 0)),
    requests: 1,
  };
  const date = todayLocalDate(now);
  const file = usageFileForDate(env, date);
  try {
    await enqueueAppend(file, async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
    return true;
  } catch {
    return false;
  }
}

// Uma linha interrompida ou corrompida não invalida o restante do diário.
// Campos ausentes ou não numéricos viram 0.
function parseUsageEntries(raw) {
  const entries = [];
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      entries.push({
        model: String(entry.model ?? ''),
        in_tokens: Number(entry.in_tokens) || 0,
        out_tokens: Number(entry.out_tokens) || 0,
        requests: Number(entry.requests) || 0,
      });
    } catch {
      continue;
    }
  }
  return entries;
}

function emptyTotals() {
  return { in_tokens: 0, out_tokens: 0, requests: 0 };
}

function addToTotals(totals, entry) {
  totals.in_tokens += entry.in_tokens;
  totals.out_tokens += entry.out_tokens;
  totals.requests += entry.requests;
}

function addToModels(models, entry) {
  const key = entry.model || 'desconhecido';
  const totals = models[key] ?? emptyTotals();
  addToTotals(totals, entry);
  models[key] = totals;
}

// Lê os agregados de UM dia; ENOENT (dia sem uso) devolve estruturas zeradas;
// qualquer outro erro de leitura PROPAGA — o guard de orçamento é fail-closed
// e uso desconhecido nunca libera além do teto. Caminho que não é arquivo
// regular (ex.: diretório plantado no lugar do JSONL) também é ilegível: no
// Windows open() em diretório até abre, e tratar isso como dia vazio furaria
// o fail-closed.
export async function readUsageForDate(env, date) {
  const models = {};
  const total = emptyTotals();
  try {
    const handle = await open(usageFileForDate(env, date), 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw Object.assign(
          new Error(`diário de uso não é um arquivo regular: ${date}`),
          { code: 'EUSAGE_LOG_INVALID' },
        );
      }
      const buffer = Buffer.alloc(info.size);
      await handle.read(buffer, 0, info.size, 0);
      for (const entry of parseUsageEntries(buffer.toString('utf8'))) {
        addToTotals(total, entry);
        addToModels(models, entry);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { models, total };
    throw error;
  }
  return { models, total };
}

// Agrega os últimos `days` dias locais terminando hoje (mais antigo primeiro).
// Dias sem arquivo entram com contadores zerados — o shape do resumo é estável.
export async function readUsageSummary(env, { days = 7, now = Date.now() } = {}) {
  const count = Math.max(1, Math.trunc(Number(days) || 7));
  const today = new Date(now);
  const dayMs = 24 * 60 * 60 * 1000;
  const resultDays = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = todayLocalDate(new Date(today.getTime() - offset * dayMs));
    const { models, total } = await readUsageForDate(env, date);
    resultDays.push({ date, models, total });
  }
  return { days: resultDays, today: todayLocalDate(today) };
}

// Gasto estimado do dia corrente em US$: soma in*price.in/M + out*price.out/M.
// Modelo sem preço no mapa (ex.: vindo de sincronização de catálogo) conta
// tokens no resumo mas contribui custo 0.
export async function spendTodayUsd(env, prices, { now = Date.now() } = {}) {
  const { models } = await readUsageForDate(env, todayLocalDate(now));
  let spend = 0;
  for (const [model, totals] of Object.entries(models)) {
    const price = prices?.[model];
    if (!price) continue;
    spend += (totals.in_tokens * Number(price.in) || 0) / 1_000_000;
    spend += (totals.out_tokens * Number(price.out) || 0) / 1_000_000;
  }
  return spend;
}

// QUEBRAGALHO_MAX_SPEND_USD: número >= 0; ausente, vazia, inválida ou
// negativa = SEM limite (guard inerte).
export function configuredMaxSpendUsd(env) {
  const raw = String(env.QUEBRAGALHO_MAX_SPEND_USD ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function budgetExceededError(spend, limit) {
  const error = new Error(
    `BUDGET_EXCEEDED: gasto de hoje (US$ ${spend.toFixed(4)}) atingiu o teto de `
    + `US$ ${limit.toFixed(2)} configurado em QUEBRAGALHO_MAX_SPEND_USD. `
    + 'Aumente QUEBRAGALHO_MAX_SPEND_USD ou aguarde virar o dia local.',
  );
  error.code = 'BUDGET_EXCEEDED';
  error.spend_today_usd = spend;
  error.limit_usd = limit;
  return error;
}

export function budgetUnavailableError(limit) {
  const error = new Error(
    `BUDGET_EXCEEDED: o diário de uso está indisponível para leitura; com o teto `
    + `de US$ ${limit.toFixed(2)} configurado em QUEBRAGALHO_MAX_SPEND_USD, uso `
    + 'desconhecido não pode autorizar a chamada. Aumente QUEBRAGALHO_MAX_SPEND_USD, '
    + 'restaure o diário ou aguarde virar o dia local.',
  );
  error.code = 'BUDGET_EXCEEDED';
  error.limit_usd = limit;
  return error;
}

// Aviso em 80%: só dentro da faixa [80%, 100%) do teto; estourado e sem teto
// não avisam (o primeiro é bloqueio, o segundo é guard inerte).
export function budgetWarning(spend, limit) {
  if (limit === null || spend < limit * 0.8 || spend >= limit) return null;
  return {
    code: 'BUDGET_WARNING',
    message: `Aviso de orçamento: US$ ${spend.toFixed(4)} de US$ ${limit.toFixed(2)} USD usados hoje.`,
  };
}

// Guard pré-voo compartilhado (fail-closed): sem teto é inerte; diário
// ilegível bloqueia; gasto >= teto bloqueia; dentro de [80%, 100%) devolve
// warning. Retorna { limited, spend, limit, warning } quando libera.
export async function evaluateBudget(env, prices) {
  const limit = configuredMaxSpendUsd(env);
  if (limit === null) {
    return { limited: false, spend: null, limit: null, warning: null };
  }
  let spend;
  try {
    spend = await spendTodayUsd(env, prices);
  } catch {
    throw budgetUnavailableError(limit);
  }
  if (spend >= limit) throw budgetExceededError(spend, limit);
  return { limited: true, spend, limit, warning: budgetWarning(spend, limit) };
}
