#!/usr/bin/env node

import { createRequire } from 'module';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AGENT_EXECUTORS,
  autoIncludePremiumModels,
  assertGlobalModelAllowed,
  configuredModelPolicy,
  executorAvailableModels,
  formatAgentFailure,
  globallyAllowedModels,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  normalizeAgentRequest,
  resolveAllowedCwd,
  resolveAgentExecutor,
  runQuebragalhoAgent,
  waitForAgentSlot,
} from './agent-runner.mjs';
import {
  MODEL_CATALOG,
  catalogTiers,
  mergeModelSync,
  modelPrices,
  selectModelForTask,
} from './model-router.mjs';
import {
  configuredMaxSpendUsd,
  evaluateBudget,
  readUsageSummary,
  recordUsage,
  spendTodayUsd,
} from './usage-store.mjs';
import {
  memoryStatus,
  readProjectMemory,
  rememberProjectNote,
} from './memory-store.mjs';
import { JobQueue } from './job-queue.mjs';
import { runQuebragalhoValidate } from './verify.mjs';
const require = createRequire(import.meta.url);
const { version: VERSION } = require('./package.json');
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ── Models ──────────────────────────────────────────────────────────────

const MODELS = MODEL_CATALOG;

// ── Config ──────────────────────────────────────────────────────────────

const API_KEY = process.env.QUEBRAGALHO_API_KEY;
const BASE_URL = process.env.QUEBRAGALHO_BASE_URL || 'https://api.quebragalho.dev/v1';
const LOG_LEVEL = (process.env.QUEBRAGALHO_LOG_LEVEL || 'info').toLowerCase();
const API_TIMEOUT_MS = resolveApiTimeoutMs(process.env.QUEBRAGALHO_API_TIMEOUT_MS);
const API_RETRIES = resolveApiRetries(process.env.QUEBRAGALHO_API_RETRIES);
const DEFAULT_AGENT_EXECUTOR = resolveAgentExecutor(undefined, process.env);

if (!API_KEY) {
  console.error(
    'AVISO: QUEBRAGALHO_API_KEY nao definida; tools de prompt direto e executor OpenCode podem ficar indisponiveis.',
  );
}

function log(level, ...args) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] >= (levels[LOG_LEVEL] ?? 1)) {
    console.error(`[quebragalho] ${level}:`, ...args);
  }
}

// Timeout do fetch da API em ms: default 300s, limitado a [1s, 30min];
// valor ausente, vazio ou não numérico cai no default.
function resolveApiTimeoutMs(raw) {
  const DEFAULT_MS = 300_000;
  const MIN_MS = 1_000;
  const MAX_MS = 1_800_000;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_MS;
  return Math.min(Math.max(value, MIN_MS), MAX_MS);
}

// Retries para 429/5xx: default 2, teto 5; valor ausente, vazio ou não
// inteiro cai no default; negativo vira 0 (sem retry).
function resolveApiRetries(raw) {
  const DEFAULT_RETRIES = 2;
  const MAX_RETRIES = 5;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_RETRIES;
  const value = Number(raw);
  if (!Number.isInteger(value)) return DEFAULT_RETRIES;
  return Math.min(Math.max(value, 0), MAX_RETRIES);
}

function pickContent(choice) {
  const m = choice?.message;
  const d = choice?.delta;
  return m?.content || m?.reasoning_content || d?.content || d?.reasoning_content || '';
}

function parseSSE(raw) {
  let full = ''; let usage = {}; let invalidLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    // Linha inválida é apenas contada: pode conter segredo, nunca logar nem incluir.
    let parsed;
    try {
      parsed = JSON.parse(line.slice(6));
    } catch {
      invalidLines += 1;
      continue;
    }
    full += pickContent(parsed.choices?.[0]);
    if (parsed.usage) usage = parsed.usage;
  }
  if (invalidLines > 0) {
    throw Object.assign(
      new Error(`API_BAD_STREAM: ${invalidLines} linha(s) de dados inválida(s) no stream SSE; resposta descartada por segurança.`),
      { code: 'API_BAD_STREAM' },
    );
  }
  return { full, usage };
}

// ── API Client ──────────────────────────────────────────────────────────

// Abort gerado por AbortSignal.timeout chega como TimeoutError/AbortError
// (às vezes embrulhado em err.cause pelo undici).
function isTimeoutAbort(err) {
  return [err, err?.cause].some((candidate) => (
    candidate?.name === 'TimeoutError' || candidate?.name === 'AbortError'
  ));
}

function apiTimeoutError(model) {
  return Object.assign(
    new Error(
      `API_TIMEOUT: Quebragalho não respondeu em ${API_TIMEOUT_MS}ms (modelo ${model}). `
      + 'Aumente QUEBRAGALHO_API_TIMEOUT_MS ou reduza o escopo da tarefa e tente novamente.',
    ),
    { code: 'API_TIMEOUT' },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

// Só 429 e 5xx são recuperáveis; qualquer 4xx falha na primeira tentativa.
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

// Rastreio de uso (P1-2) é fire-and-forget: falha de gravação NUNCA quebra a
// resposta (o guard de orçamento cobre o risco de subestimação na próxima
// checagem pré-voo). A store não loga; um resultado false é simplesmente ignorado.
function recordDirectUsage(result) {
  void recordUsage({
    model: result.model,
    executor: 'direct',
    inTokens: Number(result.usage?.prompt_tokens) || 0,
    outTokens: Number(result.usage?.completion_tokens) || 0,
  }, process.env).catch(() => {});
}

async function callQuebragalho(model, messages, opts = {}) {
  if (!API_KEY) {
    throw new Error(
      'QUEBRAGALHO_API_KEY não definida; use quebragalho_agent com executor nativo ou configure a chave.',
    );
  }
  const info = MODELS[model];
  if (!info) {
    const available = Object.keys(MODELS).join(', ');
    throw new Error(`Modelo desconhecido: "${model}". Disponiveis: ${available}`);
  }
  assertGlobalModelAllowed(model, process.env);

  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    // Default seguro (8192): sem valor explícito a chamada não pede o teto de
    // saída do modelo; valor explícito continua aceito, limitado a info.out.
    max_tokens: Math.min(opts.max_tokens ?? Math.min(info.out, 8192), info.out),
  };

  log('debug', `POST ${BASE_URL}/chat/completions model=${model} tokens=${body.max_tokens}`);

  const totalAttempts = API_RETRIES + 1;
  let raw;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Orçamento de timeout vale por tentativa: cada retry recomeça o relógio.
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (err) {
      if (isTimeoutAbort(err)) throw apiTimeoutError(model);
      throw err;
    }

    if (res.ok) {
      try {
        raw = await res.text();
      } catch (err) {
        if (isTimeoutAbort(err)) throw apiTimeoutError(model);
        throw err;
      }
      break;
    }

    const statusError = new Error(`API ${res.status}: ${await readErrorBody(res)}`);
    if (!isRetryableStatus(res.status) || attempt >= totalAttempts) {
      if (attempt > 1) {
        statusError.message = `${statusError.message} (falhou após ${attempt} tentativas)`;
      }
      throw statusError;
    }

    // Retry-After em segundos vence o backoff exponencial; teto de 30s.
    const retryAfterRaw = res.headers.get('retry-after');
    const retryAfterSeconds = retryAfterRaw === null ? Number.NaN : Number(retryAfterRaw);
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? Math.min(retryAfterSeconds * 1000, 30_000)
      : 500 * 2 ** (attempt - 1);
    log('warn', `API ${res.status} na tentativa ${attempt}/${totalAttempts}; repetindo em ${Math.round(delayMs)}ms`);
    await sleep(delayMs);
  }

  // SSE streaming format — router pode retornar data: lines mesmo com stream:false
  if (raw.startsWith('data:') || raw.includes('\ndata:')) {
    const { full, usage } = parseSSE(raw);
    if (!full) throw new Error('Resposta vazia da API');
    const result = { content: full, model, usage };
    recordDirectUsage(result);
    return result;
  }

  // JSON format
  const data = JSON.parse(raw);
  const content = pickContent(data.choices?.[0]);
  if (!content) throw new Error('Resposta vazia da API');
  const result = { content, model: data.model || model, usage: data.usage || {} };
  recordDirectUsage(result);
  return result;
}

// ── Imagens nas tools de prompt direto (P3-3) ──────────────────────────
// quebragalho_code e as tools por modelo legadas aceitam `images`: array de 1
// a 5 itens, cada um `{ path }` (arquivo local → data URL base64) ou `{ url }`
// (repassado ao gateway). Só modelos com `vision: true` no catálogo aceitam.

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const IMAGE_MAX_COUNT = 5;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

const IMAGES_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: IMAGE_MAX_COUNT,
  description: `Imagens anexadas ao prompt (1 a ${IMAGE_MAX_COUNT} itens; apenas modelos com visão). Cada item: { path } de arquivo local (extensões: ${IMAGE_EXTENSIONS.join(', ')}; até 5 MiB) ou { url } http(s)/data URL repassada ao gateway. String pura é aceita como { path }.`,
  items: {
    type: 'object',
    description: 'Imagem com path OU url (nunca ambos)',
    properties: {
      path: { type: 'string', description: `Caminho de arquivo local (${IMAGE_EXTENSIONS.join(', ')}; até 5 MiB)` },
      url: { type: 'string', description: 'URL http(s) ou data URL da imagem' },
    },
  },
};

function imagesInvalidError(message) {
  return Object.assign(new Error(`IMAGES_INVALID: ${message}`), { code: 'IMAGES_INVALID' });
}

// Ausente = sem visão: modelos vindos de sincronização nunca recebem a flag.
function modelHasVision(model) {
  return MODELS[model]?.vision === true;
}

function visionCapableModels() {
  return Object.keys(MODELS).filter((id) => modelHasVision(id));
}

// Converte um item { path } em parte image_url com data URL. Erros são
// específicos e NUNCA ecoam o conteúdo da imagem (só a posição no array).
async function readImageFilePart(imagePath, label) {
  const ext = extname(imagePath).replace(/^\./, '').toLowerCase();
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    throw imagesInvalidError(
      `${label}: extensão "${ext || 'ausente'}" não suportada; use: ${IMAGE_EXTENSIONS.join(', ')}.`,
    );
  }
  let stats;
  try {
    stats = await stat(imagePath);
  } catch {
    throw imagesInvalidError(`${label}: arquivo não encontrado no disco.`);
  }
  if (!stats.isFile()) {
    throw imagesInvalidError(`${label}: caminho não é um arquivo.`);
  }
  if (stats.size > IMAGE_MAX_BYTES) {
    throw imagesInvalidError(
      `${label}: arquivo com ${stats.size} bytes excede o limite de ${IMAGE_MAX_BYTES} bytes (5 MiB).`,
    );
  }
  let buffer;
  try {
    buffer = await readFile(imagePath);
  } catch {
    throw imagesInvalidError(`${label}: falha ao ler o arquivo.`);
  }
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw imagesInvalidError(
      `${label}: arquivo com ${buffer.length} bytes excede o limite de ${IMAGE_MAX_BYTES} bytes (5 MiB).`,
    );
  }
  return {
    type: 'image_url',
    image_url: { url: `data:image/${ext};base64,${buffer.toString('base64')}` },
  };
}

// Valida `args.images` contra o modelo resolvido e devolve as partes
// multimodais OpenAI (vazio = chamada sem imagens). MODEL_NO_VISION vence
// qualquer validação de forma: não adianta revisar o array se o modelo não
// suporta imagens. Sem images o retorno é [] e o payload fica intocado.
async function resolveImageParts(model, rawImages) {
  if (rawImages === undefined || rawImages === null) return [];
  if (!modelHasVision(model)) {
    const error = new Error(
      `MODEL_NO_VISION: modelo ${model} não suporta imagens; use um de: ${visionCapableModels().join(', ')}.`,
    );
    error.code = 'MODEL_NO_VISION';
    throw error;
  }
  if (!Array.isArray(rawImages)) {
    throw imagesInvalidError(
      `images deve ser um array de 1 a ${IMAGE_MAX_COUNT} itens, cada um com { path } ou { url }.`,
    );
  }
  if (rawImages.length < 1 || rawImages.length > IMAGE_MAX_COUNT) {
    throw imagesInvalidError(
      `images deve ter entre 1 e ${IMAGE_MAX_COUNT} itens (recebidos: ${rawImages.length}).`,
    );
  }
  const parts = [];
  for (const [index, raw] of rawImages.entries()) {
    const label = `images[${index}]`;
    const entry = typeof raw === 'string' ? { path: raw } : raw;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw imagesInvalidError(`${label}: item deve ser um objeto { path } ou { url }.`);
    }
    const hasPath = typeof entry.path === 'string' && entry.path.trim() !== '';
    const hasUrl = typeof entry.url === 'string' && entry.url.trim() !== '';
    if (hasPath && hasUrl) {
      throw imagesInvalidError(`${label}: informe apenas path ou url, não ambos.`);
    }
    if (hasUrl) {
      parts.push({ type: 'image_url', image_url: { url: entry.url } });
      continue;
    }
    if (!hasPath) {
      throw imagesInvalidError(`${label}: item deve ter path (string) ou url (string).`);
    }
    parts.push(await readImageFilePart(entry.path.trim(), label));
  }
  return parts;
}

// Sem images o payload permanece EXATAMENTE o de antes (content string); com
// images o papel user usa content array no formato multimodal OpenAI.
function userMessageWithImages(prompt, imageParts) {
  if (imageParts.length === 0) return { role: 'user', content: prompt };
  return {
    role: 'user',
    content: [{ type: 'text', text: prompt }, ...imageParts],
  };
}

// ── Model Sync (quebragalho://models dinâmico) ─────────────────────────
// OPT-IN via QUEBRAGALHO_MODEL_SYNC=1 (default OFF): depois de server.connect,
// um único GET {BASE_URL}/models mescla o catálogo remoto no local IN PLACE
// (mergeModelSync). Falha de rede/auth/corpo = fail-open: catálogo local segue
// valendo e o warn é logado. Estado exposto em quebragalho://status como
// model_sync: { enabled, ran_at, error } + resumo { added, updated, kept, total }
// quando bem-sucedido; ran_at null significa "nunca executou".
const MODEL_SYNC_ENABLED = process.env.QUEBRAGALHO_MODEL_SYNC === '1';
const syncedModelIds = new Set();
let modelSyncState = { enabled: MODEL_SYNC_ENABLED, ran_at: null, error: null };

function modelSyncErrorMessage(err) {
  if (isTimeoutAbort(err)) return 'timeout em GET /models';
  return String(err?.message ?? 'falha desconhecida').slice(0, 200);
}

// Uma tentativa, sem retry: o sync é best-effort e a disponibilidade do
// gateway já é exercitada pelas chamadas de chat com retry próprio.
async function runModelSync() {
  if (!MODEL_SYNC_ENABLED) return;
  if (!API_KEY) {
    modelSyncState = {
      enabled: true,
      ran_at: null,
      error: 'QUEBRAGALHO_API_KEY ausente',
    };
    log('warn', 'QUEBRAGALHO_MODEL_SYNC=1 sem QUEBRAGALHO_API_KEY; sincronização de modelos não executada.');
    return;
  }
  const ranAt = new Date().toISOString();
  try {
    log('debug', `GET ${BASE_URL}/models`);
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Nunca incluir o corpo: pode conter detalhes sensíveis.
      throw new Error(`API ${res.status} em GET /models`);
    }
    const body = await res.json();
    const remoteModels = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(remoteModels)) {
      throw new Error('corpo inesperado em GET /models');
    }
    const summary = mergeModelSync(remoteModels);
    syncedModelIds.clear();
    for (const id of [...summary.added, ...summary.updated]) {
      syncedModelIds.add(id);
    }
    modelSyncState = {
      enabled: true,
      ran_at: ranAt,
      error: null,
      added: summary.added,
      updated: summary.updated,
      kept: summary.kept,
      total: summary.total,
    };
    log('info', `Sync de modelos: +${summary.added.length} novo(s), ${summary.updated.length} atualizado(s), ${summary.kept.length} mantido(s), total ${summary.total}.`);
  } catch (err) {
    const message = modelSyncErrorMessage(err);
    modelSyncState = { enabled: true, ran_at: ranAt, error: message };
    log('warn', `Sync de modelos falhou (catálogo local mantido): ${message}`);
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────

// ── Async Job Queue ────────────────────────────────────────────────────

const MAX_CONCURRENCY_USER = Number(process.env.QUEBRAGALHO_AGENT_MAX_CONCURRENCY ?? 4);
const jobQueue = new JobQueue({
  concurrency: Number.isInteger(MAX_CONCURRENCY_USER) && MAX_CONCURRENCY_USER >= 1 && MAX_CONCURRENCY_USER <= 8
    ? MAX_CONCURRENCY_USER : 4,
});

if (process.platform === 'win32' && process.env.QUEBRAGALHO_JOB_PERSIST_RESULTS === '1') {
  log('warn', 'Persistência de resultados de jobs desabilitada no Windows.');
}

// Wire runner — runnerData contém agentArgs reais, nunca persistidos
// Usa waitForAgentSlot para que jobs assíncronos aguardem o slot global
// em vez de falhar com AGENT_BUSY quando chamadas síncronas ocuparem.
jobQueue.setRunner(async (job, signal, runnerData) => {
  const slotRelease = await waitForAgentSlot(process.env, signal);
  const options = {
    availableModels: Object.keys(MODELS),
    env: process.env,
    signal,
    slotRelease,
  };
  return runQuebragalhoAgent(runnerData, options);
});

// Initialise store from env (initStore agora é await antes de start)
let storeReady = true;
if (
  process.env.QUEBRAGALHO_JOB_PERSIST_RESULTS === '1'
  && process.platform !== 'win32'
  && !process.env.QUEBRAGALHO_JOB_STORE_DIR
) {
  log('error', 'QUEBRAGALHO_JOB_PERSIST_RESULTS=1 exige QUEBRAGALHO_JOB_STORE_DIR.');
  storeReady = false;
} else if (process.env.QUEBRAGALHO_JOB_STORE_DIR) {
  try {
    await jobQueue.initStore(process.env.QUEBRAGALHO_JOB_STORE_DIR);
    log('info', `Job store inicializado: ${process.env.QUEBRAGALHO_JOB_STORE_DIR}`);
  } catch (err) {
    log('error', `Falha ao inicializar job store: ${err.message}`);
    storeReady = false;
  }
}

const server = new Server(
  { name: 'quebragalho-bridge', version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
    instructions: 'Delegue à Quebragalho somente pelas ferramentas MCP; nunca execute a CLI no shell. Cada execução é um subagente externo. Use quebragalho_agent_start por padrão em App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta: mostre o job_id, continue trabalhando e consulte quebragalho_job status/result sem reenviar após timeout. Reserve quebragalho_agent síncrono para tarefa curta. Prefira executor=native, model=auto e read_only; write exige autorização e opt-in. Se o MCP faltar, reporte erro de configuração. O orquestrador revisa e roda testes, Git e deploy.',
  },
);

// ── Tools ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const codec = { type: 'object', properties: { prompt: { type: 'string' }, system: { type: 'string' }, temperature: { type: 'number', default: 0.3 }, max_tokens: { type: 'number', default: 8192 }, images: IMAGES_SCHEMA }, required: ['prompt'] };
  const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);

  const tools = [];

  if (allowedModels.length > 0) {
    const defaultDirectModel = allowedModels.includes('deepseek-v4.1-flash')
      ? 'deepseek-v4.1-flash'
      : allowedModels[0];

    // Uma tool por modelo custava ~900 tokens de contexto em cada sessao de
    // qualquer host, com schema identico entre elas: era o parametro `model` de
    // quebragalho_code repetido N vezes na vitrine. Removidas da listagem; o handler
    // continua resolvendo `quebragalho_<modelo>` por lookup em MODELS, entao quem ja
    // chama pelo nome antigo nao quebra. Defina QUEBRAGALHO_LIST_MODEL_TOOLS=1 para
    // voltar a publica-las.
    if (process.env.QUEBRAGALHO_LIST_MODEL_TOOLS === '1') {
      tools.push(
        ...Object.entries(MODELS)
          .filter(([id]) => allowedModels.includes(id))
          .map(([id, info]) => ({
            name: `quebragalho_${id.replace(/[.-]/g, '_')}`,
            description: `${info.name} - ${info.note}. ${(info.ctx / 1024).toFixed(0)}K ctx, ${info.out} max output. Plano: ${info.tier}.`,
            inputSchema: { ...codec, properties: { ...codec.properties, max_tokens: { type: 'number', description: `Max tokens (max ${info.out})`, default: Math.min(info.out, 8192) } } },
          })),
      );
    }

    tools.push(
      {
        name: 'quebragalho_code',
        description: `Executa tarefa com um modelo Quebragalho. Escolha em "model" (${allowedModels.length} disponiveis).`,
        inputSchema: { ...codec, properties: { ...codec.properties, model: { type: 'string', enum: allowedModels, default: defaultDirectModel } } },
      },
      {
        name: 'quebragalho_review',
        description: 'Revisa codigo buscando bugs, vulnerabilidades e problemas de performance',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Codigo a ser revisado' },
            context: { type: 'string', description: 'Contexto adicional (ex: linguagem, framework)' },
            model: { type: 'string', enum: allowedModels, default: defaultDirectModel },
            temperature: { type: 'number', default: 0.2 },
          },
          required: ['code'],
        },
      },
      {
        name: 'quebragalho_route',
        description: 'Classifica uma tarefa e explica o ranking dos modelos Quebragalho sem executar nenhum agente.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'Tarefa que será classificada',
            },
            mode: {
              type: 'string',
              enum: ['read_only', 'write'],
              default: 'read_only',
            },
            tiers: {
              type: 'array',
              items: { type: 'string', enum: catalogTiers() },
              default: catalogTiers(),
            },
            exclude_models: {
              type: 'array',
              items: { type: 'string', enum: allowedModels },
              default: [],
            },
            executor: {
              type: 'string',
              enum: AGENT_EXECUTORS,
              default: DEFAULT_AGENT_EXECUTOR,
              description: 'Aplica à prévia a mesma disponibilidade de modelos do executor que executará a tarefa',
            },
          },
          required: ['prompt'],
        },
      },
    );
  }

  tools.push(
    {
      name: 'quebragalho_agent',
      description: 'Executa um subagente Quebragalho repo-aware de forma síncrona e bloqueia até concluir; use apenas para tarefa curta. Para App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta, use quebragalho_agent_start. Nunca chame a CLI diretamente. model=auto classifica a tarefa e tenta fallback recuperável. read_only apenas inspeciona; write exige QUEBRAGALHO_AGENT_WRITE_ENABLED=1. O orquestrador executa testes e outros comandos.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Tarefa concreta e delimitada para o agente' },
          cwd: { type: 'string', description: 'Diretório do projeto, dentro de QUEBRAGALHO_AGENT_ALLOWED_ROOTS' },
          executor: {
            type: 'string',
            enum: AGENT_EXECUTORS,
            default: DEFAULT_AGENT_EXECUTOR,
            description: 'native usa o harness Quebragalho Code com OAuth; opencode usa o provider Quebragalho dentro do OpenCode',
          },
          mode: {
            type: 'string',
            enum: ['read_only', 'write'],
            default: 'read_only',
            description: 'read_only para análise; write somente para edição autorizada, sem shell',
          },
          model: {
            type: 'string',
            enum: ['auto', ...allowedModels],
            default: 'auto',
          },
          timeout_seconds: {
            type: 'integer',
            minimum: MIN_TIMEOUT_SECONDS,
            maximum: MAX_TIMEOUT_SECONDS,
            default: 600,
          },
        },
        required: ['prompt', 'cwd'],
      },
    },
    {
      name: 'quebragalho_agent_start',
      description: 'Inicia um subagente Quebragalho de forma assíncrona e retorna job_id imediatamente. É o padrão para App/IDE ou tarefa não trivial, longa, paralela ou de duração incerta. Mostre o job_id, continue trabalhando e consulte quebragalho_job status/result; não reenvie a mesma tarefa após timeout.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Tarefa concreta e delimitada para o agente' },
          cwd: { type: 'string', description: 'Diretorio do projeto, dentro de QUEBRAGALHO_AGENT_ALLOWED_ROOTS' },
          executor: { type: 'string', enum: AGENT_EXECUTORS, default: DEFAULT_AGENT_EXECUTOR },
          mode: { type: 'string', enum: ['read_only', 'write'], default: 'read_only' },
          model: { type: 'string', enum: ['auto', ...allowedModels], default: 'auto' },
          timeout_seconds: { type: 'integer', minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS, default: 600 },
        },
        required: ['prompt', 'cwd'],
      },
    },
    {
      name: 'quebragalho_job',
      description: 'Gerencia jobs assíncronos iniciados por quebragalho_agent_start. Use status sem bloquear enquanto trabalha e result após estado terminal; list lista jobs e cancel cancela. Nunca reenvie a tarefa apenas porque uma consulta expirou.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'result', 'list', 'cancel'], default: 'status' },
          job_id: { type: 'string', description: 'Obrigatorio para actions status, result e cancel' },
        },
        required: ['action'],
      },
    },
    {
      name: 'quebragalho_memory',
      description: 'Consulta ou registra memória técnica persistente de um projeto autorizado.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'read', 'remember'],
            default: 'status',
          },
          cwd: {
            type: 'string',
            description: 'Diretório do projeto, dentro de QUEBRAGALHO_AGENT_ALLOWED_ROOTS',
          },
          note: {
            type: 'string',
            description: 'Nota técnica curta, sem segredos ou dados pessoais',
            maxLength: 2000,
          },
        },
        required: ['action', 'cwd'],
      },
    },
    {
      name: 'quebragalho_validate',
      description:
        'Executa validação do repositório como sequência de argv estrito com shell:false, binário absoluto resolvido/validado na política, cwd realpath e HOME isolado, sem iniciar agente ou job. Dois perfis: ESTÁTICO (node --check <arquivo no cwd>; git diff --check, diff --cached --check, status --porcelain=v1, log --oneline limitado) sob QUEBRAGALHO_AGENT_VERIFY_ENABLED=1 (default falha fechado); PROJECT-CODE (npm test; npm run <script> só com QUEBRAGALHO_AGENT_VERIFY_NPM_SCRIPTS) — ação importante que executa código confiável do repositório com o mesmo usuário do bridge e pode escrever arquivos, ler qualquer caminho acessível ao usuário, ler configurações e acessar rede, exigindo ADICIONALMENTE QUEBRAGALHO_AGENT_VERIFY_PROJECT_CODE_ENABLED=1 e aprovação explícita do host. Não é read-only nem sandbox. Sem isolamento de filesystem ou rede. Nunca oferece comandos de commit, push, publish ou deploy.',
      annotations: {
        title: 'Validação segura do repositório',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Diretório do projeto, dentro de QUEBRAGALHO_AGENT_ALLOWED_ROOTS' },
          commands: {
            type: 'array',
            description: 'Sequência de comandos argv (sem shell). Ex.: {"cmd":"npm","args":["test"]}',
            items: {
              type: 'object',
              properties: {
                cmd: { type: 'string', enum: ['npm', 'node', 'git'] },
                args: { type: 'array', items: { type: 'string' }, default: [] },
              },
              required: ['cmd'],
            },
            minItems: 1,
            maxItems: 10,
          },
          stop_on_failure: { type: 'boolean', default: true },
          timeout_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: 600,
            default: 120,
            description: 'Timeout por comando, em segundos (há também teto total)',
          },
        },
        required: ['cwd', 'commands'],
      },
    },
  );

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const args = rawArgs ?? {};
  const match = name.match(/^quebragalho_(.+)$/);

  if (!match) {
    return { content: [{ type: 'text', text: `Tool desconhecida: ${name}` }], isError: true };
  }

  try {
    let model, messages;

    if (name === 'quebragalho_route') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt é obrigatório.');
      if (prompt.length > 100_000) {
        throw new Error('prompt excede o limite de 100000 caracteres.');
      }
      const executor = resolveAgentExecutor(args.executor, process.env);
      const executorModels = executorAvailableModels(
        executor,
        Object.keys(MODELS),
        process.env,
      );
      const policy = configuredModelPolicy(executorModels, process.env);
      const requestedTiers = args.tiers ?? policy.allowTiers;
      const includePremiumModels = autoIncludePremiumModels(process.env);
      const route = selectModelForTask({
        prompt,
        mode: args.mode ?? 'read_only',
        availableModels: policy.availableModels,
        allowTiers: requestedTiers.filter(
          (tier) => policy.allowTiers.includes(tier),
        ),
        excludeModels: args.exclude_models ?? [],
        includePremiumModels,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            executor,
            auto_include_premium_models: includePremiumModels,
            selected_model: route.model,
            reason: route.reason,
            task_profile: route.profile,
            ranking: route.ranking,
          }, null, 2),
        }],
      };
    } else if (name === 'quebragalho_agent') {
      const result = await runQuebragalhoAgent(args, {
        availableModels: Object.keys(MODELS),
        env: process.env,
      });
      // O guard de orçamento bloqueia antes do gasto; aqui só propagamos o
      // aviso de aproximação do teto para o log do servidor.
      for (const warning of result.warnings ?? []) {
        if (warning.code === 'BUDGET_WARNING') log('warn', warning.message);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } else if (name === 'quebragalho_agent_start') {
      let request;
      try {
        request = normalizeAgentRequest(args, Object.keys(MODELS));
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify(formatAgentFailure(err), null, 2) }], isError: true };
      }
      const cwd = await resolveAllowedCwd(
        request.cwd,
        process.env.QUEBRAGALHO_AGENT_ALLOWED_ROOTS,
      );
      const executor = resolveAgentExecutor(args.executor, process.env);
      const executorModels = executorAvailableModels(
        executor,
        Object.keys(MODELS),
        process.env,
      );
      if (request.model !== 'auto') {
        assertGlobalModelAllowed(request.model, process.env);
        if (!executorModels.includes(request.model)) {
          const error = new Error(
            `Modelo ${request.model} indisponível para o executor ${executor}.`,
          );
          error.code = 'MODEL_NOT_ALLOWED';
          error.executor = executor;
          throw error;
        }
      } else if (globallyAllowedModels(executorModels, process.env).length === 0) {
        const error = new Error(
          `Nenhum modelo disponível para o executor ${executor}.`,
        );
        error.code = 'MODEL_ROUTE_EMPTY';
        error.executor = executor;
        throw error;
      }
      const agentArgs = {
        prompt: request.prompt,
        cwd,
        mode: request.mode,
        model: request.model,
        executor,
        timeout_seconds: request.timeoutSeconds,
      };
      // Guard de orçamento antes de enfileirar (P1-3): fail-closed, o job não
      // entra na fila quando o teto diário já estourou.
      await evaluateBudget(process.env, modelPrices());
      const result = await jobQueue.enqueuePersisted({
        cwd,
        model: request.model,
        executor,
        runnerData: agentArgs,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: Boolean(result.error),
      };
    } else if (name === 'quebragalho_job') {
      const action = String(args.action ?? 'status');
      const jobId = String(args.job_id ?? '');
      switch (action) {
        case 'list':
          return { content: [{ type: 'text', text: JSON.stringify({ jobs: jobQueue.listJobs() }, null, 2) }] };
        case 'status':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = jobQueue.getJob(jobId) ?? { error: 'NOT_FOUND' };
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        case 'result':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = jobQueue.getJobResult(jobId) ?? { error: 'NOT_FOUND' };
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        case 'cancel':
          if (!jobId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_id obrigatorio' }) }], isError: true };
          {
            const payload = await jobQueue.cancel(jobId);
            return {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              isError: Boolean(payload.error),
            };
          }
        default:
          return { content: [{ type: 'text', text: JSON.stringify({ error: `Action desconhecida: ${action}` }) }], isError: true };
      }
    } else if (name === 'quebragalho_memory') {
      const action = String(args.action ?? 'status');
      if (!['status', 'read', 'remember'].includes(action)) {
        throw new Error(`Action desconhecida: ${action}`);
      }
      const cwd = await resolveAllowedCwd(
        String(args.cwd ?? ''),
        process.env.QUEBRAGALHO_AGENT_ALLOWED_ROOTS,
      );
      if (action === 'remember') {
        const note = String(args.note ?? '').trim();
        if (!note) throw new Error('note é obrigatória para action=remember.');
        const persisted = await rememberProjectNote(
          cwd,
          note,
          { executor: 'orchestrator', status: 'curated' },
          process.env,
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ...memoryStatus(process.env), persisted }, null, 2),
          }],
        };
      }
      const entries = action === 'read'
        ? await readProjectMemory(cwd, process.env)
        : [];
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...memoryStatus(process.env),
            entries,
          }, null, 2),
        }],
      };
    } else if (name === 'quebragalho_validate') {
      const payload = await runQuebragalhoValidate(args, { apiKey: API_KEY });
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError: payload.status !== 'ok',
      };
    } else if (name === 'quebragalho_code') {
      const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
      if (allowedModels.length === 0) {
        throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
      }
      model = args.model ?? (
        allowedModels.includes('deepseek-v4.1-flash')
          ? 'deepseek-v4.1-flash'
          : allowedModels[0]
      );
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      const imageParts = await resolveImageParts(model, args.images);
      messages.push(userMessageWithImages(args.prompt, imageParts));
    } else if (name === 'quebragalho_review') {
      const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
      if (allowedModels.length === 0) {
        throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
      }
      model = args.model ?? (
        allowedModels.includes('deepseek-v4.1-flash')
          ? 'deepseek-v4.1-flash'
          : allowedModels[0]
      );
        let contextPrefix = '';
        if (args.context) contextPrefix = `Contexto: ${args.context}\n\n`;
        messages = [
          { role: 'system', content: 'Voce e um revisor de codigo especialista. Analise o codigo abaixo e aponte: bugs, vulnerabilidades de seguranca, problemas de performance, code smells, e sugestoes de melhoria. Seja direto e especifico.' },
          { role: 'user', content: `${contextPrefix}\`\`\`\n${args.code}\n\`\`\`` },
        ];
    } else {
      model = Object.keys(MODELS).find(m => m.replace(/[.-]/g, '_') === match[1]);
      if (!model) {
        const known = Object.keys(MODELS).map(m => `quebragalho_${m.replace(/[.-]/g, '_')}`).join(', ');
        throw new Error(`Tool desconhecida: ${name}. Tools disponiveis: quebragalho_code, quebragalho_review, ${known}`);
      }
      messages = [];
      if (args.system) messages.push({ role: 'system', content: args.system });
      const legacyImageParts = await resolveImageParts(model, args.images);
      messages.push(userMessageWithImages(args.prompt, legacyImageParts));
    }

    // Guard de orçamento (P1-3): quebragalho_code, quebragalho_review e as
    // tools por modelo legadas são os únicos caminhos que chegam aqui. Checa
    // ANTES de montar/gastar; fail-closed (evaluateBudget lança BUDGET_EXCEEDED
    // com gasto, teto e recuperação quando estourado ou com diário ilegível).
    const budget = await evaluateBudget(process.env, modelPrices());
    const budgetFooter = budget.warning ? `\n\n${budget.warning.message}` : '';
    if (budget.warning) log('warn', budget.warning.message);

    const result = await callQuebragalho(model, messages, {
      temperature: args.temperature,
      max_tokens: args.max_tokens,
    });

    const info = MODELS[model];
    const header = `## ${info?.name || model}`;
    const footer = `\n---\n*Modelo: ${result.model} | Tokens: ${result.usage?.total_tokens ?? '?'} (${result.usage?.prompt_tokens ?? '?'} in + ${result.usage?.completion_tokens ?? '?'} out)*`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${result.content}${footer}${budgetFooter}` }],
    };
  } catch (err) {
    log('error', err.message);
    if (['quebragalho_agent', 'quebragalho_agent_start', 'quebragalho_job'].includes(name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify(formatAgentFailure(err), null, 2) }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Erro: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Prompts ─────────────────────────────────────────────────────────────

const PROMPTS = {
  'revisar-codigo': {
    name: 'Revisar codigo',
    description: 'Template para revisao de codigo usando modelo Quebragalho',
    arguments: [
      { name: 'codigo', description: 'Codigo fonte a ser revisado', required: true },
      { name: 'contexto', description: 'Contexto do projeto', required: false },
      { name: 'modelo', description: 'Modelo Quebragalho permitido pela política administrativa', required: false },
    ],
  },
  'refatorar': {
    name: 'Refatorar codigo',
    description: 'Template para refatoracao de codigo',
    arguments: [
      { name: 'codigo', description: 'Codigo a refatorar', required: true },
      { name: 'instrucoes', description: 'O que melhorar', required: false },
      { name: 'modelo', description: 'Modelo Quebragalho', required: false },
    ],
  },
  'explicar': {
    name: 'Explicar codigo',
    description: 'Explica um trecho de codigo em detalhe',
    arguments: [
      { name: 'codigo', description: 'Codigo a explicar', required: true },
      { name: 'modelo', description: 'Modelo Quebragalho', required: false },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([id, p]) => ({
    name: id,
    description: p.description,
    arguments: p.arguments,
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const prompt = PROMPTS[req.params.name];
  if (!prompt) throw new Error(`Prompt desconhecido: ${req.params.name}`);

  const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
  if (allowedModels.length === 0) {
    throw Object.assign(new Error('MODEL_POLICY_EMPTY: política de modelos vazia — nenhum modelo disponível.'), { code: 'MODEL_POLICY_EMPTY' });
  }
  const modelo = req.params.arguments?.modelo || (
    allowedModels.includes('deepseek-v4.1-flash')
      ? 'deepseek-v4.1-flash'
      : allowedModels[0]
  );
  assertGlobalModelAllowed(modelo, process.env);

  if (req.params.name === 'revisar-codigo') {
    const ctx = req.params.arguments?.contexto || '';
    return {
      messages: [
        { role: 'system', content: { type: 'text', text: `Voce é um revisor de codigo usando ${MODELS[modelo]?.name || modelo}. Seja critico e direto.` } },
        { role: 'user', content: { type: 'text', text: `${ctx}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'refatorar') {
    const inst = req.params.arguments?.instrucoes || 'Melhore a qualidade, legibilidade e performance';
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Refatore o codigo abaixo.\nInstrucoes: ${inst}\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  if (req.params.name === 'explicar') {
    return {
      messages: [
        { role: 'user', content: { type: 'text', text: `Explique este codigo em detalhe:\n\`\`\`\n${req.params.arguments?.codigo}\n\`\`\`` } },
      ],
    };
  }

  throw new Error(`Prompt nao implementado: ${req.params.name}`);
});

// ── Resources ───────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'quebragalho://models',
      name: 'Modelos disponiveis',
      description: 'Lista de modelos Quebragalho permitidos pela política administrativa',
      mimeType: 'application/json',
    },
    {
      uri: 'quebragalho://status',
      name: 'Status da bridge',
      description: 'Informacoes sobre a conexao e configuracao',
      mimeType: 'application/json',
    },
    {
      uri: 'quebragalho://usage',
      name: 'Uso de tokens e custo',
      description: 'Agregado diario de tokens por modelo, gasto estimado do dia corrente e teto de orcamento',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'quebragalho://models') {
    const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
    if (allowedModels.length === 0) {
      return {
        contents: [{
          uri: 'quebragalho://models',
          mimeType: 'application/json',
          text: JSON.stringify({ error: 'MODEL_POLICY_EMPTY', message: 'Política de modelos vazia — nenhum modelo disponível.' }, null, 2),
        }],
      };
    }
    return {
      contents: [{
        uri: 'quebragalho://models',
        mimeType: 'application/json',
        text: JSON.stringify(Object.entries(MODELS)
          .filter(([id]) => allowedModels.includes(id))
          .map(([id, m]) => ({
          id,
          name: m.name,
          context_window: m.ctx,
          max_output: m.out,
          tier: m.tier,
          note: m.note,
          source: syncedModelIds.has(id) ? 'synced' : 'local',
          })), null, 2),
      }],
    };
  }

  if (req.params.uri === 'quebragalho://status') {
    const queueStatus = jobQueue.status;
    const allowedModels = globallyAllowedModels(Object.keys(MODELS), process.env);
    return {
      contents: [{
        uri: 'quebragalho://status',
        mimeType: 'application/json',
        text: JSON.stringify({
          version: VERSION,
          base_url: BASE_URL,
          models_count: allowedModels.length,
          log_level: LOG_LEVEL,
          api_key_configured: Boolean(API_KEY),
          agent_allowed_roots_configured: Boolean(process.env.QUEBRAGALHO_AGENT_ALLOWED_ROOTS),
          agent_executor: DEFAULT_AGENT_EXECUTOR,
          agent_default_executor: DEFAULT_AGENT_EXECUTOR,
          agent_executors: AGENT_EXECUTORS,
          auto_include_premium_models: autoIncludePremiumModels(process.env),
          model_sync: modelSyncState,
          memory: memoryStatus(process.env),
          job_queue: {
            concurrency: jobQueue.capacity,
            queued: queueStatus.queued,
            running: queueStatus.running,
            total: queueStatus.total,
          },
        }, null, 2),
      }],
    };
  }

  if (req.params.uri === 'quebragalho://usage') {
    const limit = configuredMaxSpendUsd(process.env);
    const summary = await readUsageSummary(process.env);
    let spend;
    try {
      spend = await spendTodayUsd(process.env, modelPrices());
    } catch {
      spend = null; // diário ilegível: custo desconhecido, guard segue fail-closed
    }
    return {
      contents: [{
        uri: 'quebragalho://usage',
        mimeType: 'application/json',
        text: JSON.stringify({
          ...summary,
          spend_today_usd: spend,
          max_spend_usd: limit,
          budget_exceeded: limit !== null && (spend === null || spend >= limit),
        }, null, 2),
      }],
    };
  }

  throw new Error(`Resource desconhecido: ${req.params.uri}`);
});

// ── Start / Shutdown ───────────────────────────────────────────────────

let shutdownPromise = null;
let forcedExitTimer = null;
function scheduleForcedExit() {
  if (forcedExitTimer) return;
  forcedExitTimer = setTimeout(() => process.exit(1), 2_500);
  forcedExitTimer.unref?.();
}

function shutdown(reason) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = Promise.resolve().then(async () => {
    log('info', `Encerrando bridge (${reason}).`);
    let serverCloseTimer;
    const closeServer = Promise.race([
      Promise.resolve().then(() => server.close()),
      new Promise((_, reject) => {
        serverCloseTimer = setTimeout(() => reject(Object.assign(
          new Error('Fechamento do servidor excedeu o tempo limite.'),
          { code: 'SERVER_CLOSE_TIMEOUT' },
        )), 2_500);
      }),
    ]).finally(() => clearTimeout(serverCloseTimer));
    const results = await Promise.allSettled([
      jobQueue.shutdown(),
      closeServer,
    ]);
    let failure = null;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log('error', `Falha durante shutdown: ${result.reason?.message ?? result.reason}`);
        process.exitCode = 1;
        scheduleForcedExit();
        failure ??= result.reason instanceof Error
          ? result.reason
          : new Error('Falha durante shutdown.');
      }
      if (index === 0 && result.status === 'fulfilled' && result.value?.timed_out) {
        log('error', 'Shutdown da fila excedeu o tempo limite.');
        process.exitCode = 1;
        scheduleForcedExit();
        failure ??= Object.assign(
          new Error('Shutdown da fila excedeu o tempo limite.'),
          { code: 'SHUTDOWN_TIMEOUT' },
        );
      }
    });
    process.stdin.destroy();
    if (failure) throw failure;
  }).catch((err) => {
    process.exitCode = 1;
    process.stdin.destroy();
    throw err;
  });
  return shutdownPromise;
}

const onSignal = (signal) => { void shutdown(signal).catch(() => {}); };
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
process.stdin.once('end', () => { void shutdown('stdin_eof').catch(() => {}); });
server.onclose = () => { void shutdown('server_close').catch(() => {}); };

if (!storeReady) {
  console.error('FATAL: Job store configurado mas nao inicializou. Abortando.');
  process.exitCode = 1;
  await shutdown('store_init_failed').catch(() => {});
} else {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('info', `quebragalho-bridge ready | ${Object.keys(MODELS).length} models | ${BASE_URL}`);
    // Sync de catálogo é pós-connect e não-bloqueante: o servidor já responde;
    // falha é fail-open e registrada em modelSyncState (veja quebragalho://status).
    void runModelSync().catch((err) => {
      log('warn', `Sync de modelos falhou inesperadamente: ${err?.message ?? err}`);
    });
  } catch (err) {
    console.error('FATAL:', err.message);
    process.exitCode = 1;
    await shutdown('server_start_failed').catch(() => {});
  }
}
