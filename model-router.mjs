// Catálogo do gateway Quebragalho (https://www.quebragalho.dev/). Tiers são
// classes de custo do gateway pré-pago, não planos de assinatura: `pro` para o
// dia a dia, `ultra` para os flagship e `max` para variantes caras que só
// entram no roteamento automático com QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS.
const TIE_BREAK_ORDER = [
  'deepseek-v4.1-flash',
  'glm-5.3',
  'mimo-v2.6-flash',
  'gpt-6-luna',
  'glm-5.3-flash',
  'muse-spark-1.3-contributor',
];

// Mutável DE PROPÓSITO: `mergeModelSync` atualiza o catálogo in place quando
// QUEBRAGALHO_MODEL_SYNC=1; consumidores (index.mjs, agent-runner.mjs) leem as
// propriedades em tempo de chamada, então a mutação in place não diverge
// referências e preserva os 8 modelos base e seus metadados.
// Mutável DE PROPÓSITO: `mergeModelSync` atualiza o catálogo in place quando
// QUEBRAGALHO_MODEL_SYNC=1; consumidores (index.mjs, agent-runner.mjs) leem as
// propriedades em tempo de chamada, então a mutação in place não diverge
// referências.
export const MODEL_CATALOG = {
  // Catálogo completo do gateway (17 modelos, dados do app em 2026-09-30).
  // `price` é US$/M de tokens (in/out) e alimenta o guard de orçamento;
  // `vision: true` marca modelos com entrada de imagens (só estes aceitam o
  // parâmetro `images` das tools diretas). Modelos adicionados por
  // sincronização NUNCA recebem price nem vision até o catálogo local os
  // conhecer. Tiers são classes de custo para o roteamento: `pro` dia a dia,
  // `ultra` flagship, `max` os caros (auto: false — só com opt-in em
  // QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS=1). Contexto "1M" do app =
  // 1_048_576; limite de saída não é divulgado pelo gateway (padrão 64K).
  'claude-opus-5.5': {
    name: 'Claude Opus 5.5',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    vision: true,
    price: { in: 1.6, out: 8.0 },
    note: 'Flagship Anthropic, o mais capaz do catálogo',
    capabilities: {
      coding: 10,
      reasoning: 10,
      review: 10,
      security: 10,
      ux: 10,
      analysis: 10,
      long_context: 9,
      speed: 5,
      light: 3,
    },
    bias: 0,
  },
  'deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.14, out: 0.56 },
    note: 'Melhor CxB para codificação',
    capabilities: {
      coding: 10,
      reasoning: 8,
      review: 9,
      security: 8,
      ux: 7,
      analysis: 8,
      long_context: 10,
      speed: 8,
      light: 6,
    },
    bias: 0.6,
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    price: { in: 0.32, out: 0.97 },
    note: 'Variante premium para codificação mais exigente',
    capabilities: {
      coding: 10,
      reasoning: 9,
      review: 9,
      security: 9,
      ux: 8,
      analysis: 9,
      long_context: 10,
      speed: 6,
      light: 4,
    },
    bias: 0,
  },
  'glm-5.3': {
    name: 'GLM 5.3',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'ultra',
    price: { in: 0.54, out: 1.7 },
    note: 'Raciocínio complexo e desenvolvimento web (sem visão)',
    capabilities: {
      coding: 9,
      reasoning: 10,
      review: 9,
      security: 10,
      ux: 10,
      analysis: 9,
      long_context: 8,
      speed: 6,
      light: 4,
    },
    bias: 0.1,
  },
  'glm-5.3-flash': {
    name: 'GLM 5.3 Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.05, out: 0.17 },
    note: 'Rápido para tarefas simples',
    capabilities: {
      coding: 6,
      reasoning: 6,
      review: 6,
      security: 5,
      ux: 7,
      analysis: 5,
      long_context: 4,
      speed: 10,
      light: 10,
    },
    bias: 0.2,
  },
  'gpt-5.6-luna': {
    name: 'GPT 5.6 Luna',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.055, out: 0.33 },
    note: 'OpenAI econômico da geração 5.6',
    capabilities: {
      coding: 7,
      reasoning: 7,
      review: 7,
      security: 6,
      ux: 8,
      analysis: 7,
      long_context: 6,
      speed: 8,
      light: 8,
    },
    bias: 0.1,
  },
  'gpt-5.6-sol': {
    name: 'GPT 5.6 Sol',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    vision: true,
    price: { in: 1.2, out: 7.2 },
    note: 'Flagship OpenAI 5.6',
    capabilities: {
      coding: 9,
      reasoning: 9,
      review: 9,
      security: 9,
      ux: 9,
      analysis: 9,
      long_context: 8,
      speed: 5,
      light: 3,
    },
    bias: 0,
  },
  'gpt-6-luna': {
    name: 'GPT 6 Luna',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.03, out: 0.15 },
    note: 'Generalista barato com boa qualidade',
    capabilities: {
      coding: 7,
      reasoning: 7,
      review: 7,
      security: 6,
      ux: 8,
      analysis: 7,
      long_context: 6,
      speed: 9,
      light: 8,
    },
    bias: 0.1,
  },
  'gpt-6-sol': {
    name: 'GPT 6 Sol',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'ultra',
    vision: true,
    price: { in: 0.4, out: 2.0 },
    note: 'Flagship OpenAI 6',
    capabilities: {
      coding: 9,
      reasoning: 10,
      review: 9,
      security: 9,
      ux: 9,
      analysis: 9,
      long_context: 8,
      speed: 6,
      light: 4,
    },
    bias: 0.1,
  },
  'grok-4.7': {
    name: 'Grok 4.7',
    ctx: 500_000,
    out: 65_536,
    tier: 'ultra',
    vision: true,
    price: { in: 0.8, out: 2.4 },
    note: 'xAI com contexto de 500K',
    capabilities: {
      coding: 8,
      reasoning: 9,
      review: 8,
      security: 8,
      ux: 7,
      analysis: 8,
      long_context: 6,
      speed: 7,
      light: 5,
    },
    bias: 0.1,
  },
  'hy4': {
    name: 'HY4',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'ultra',
    price: { in: 0.33, out: 1.0 },
    note: 'Tencent equilibrado (sem visão)',
    capabilities: {
      coding: 7,
      reasoning: 8,
      review: 7,
      security: 7,
      ux: 6,
      analysis: 8,
      long_context: 7,
      speed: 7,
      light: 5,
    },
    bias: 0.1,
  },
  'kimi-k3': {
    name: 'Kimi K3',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'max',
    auto: false,
    vision: true,
    price: { in: 1.19, out: 6.2 },
    note: 'Flagship Moonshot para tarefas gerais e visuais',
    capabilities: {
      coding: 8,
      reasoning: 9,
      review: 8,
      security: 8,
      ux: 8,
      analysis: 9,
      long_context: 7,
      speed: 6,
      light: 5,
    },
    bias: 0,
  },
  'mimo-v2.6-flash': {
    name: 'Mimo V2.6 Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.028, out: 0.056 },
    note: 'Visão e análise com contexto de 1M por centavos',
    capabilities: {
      coding: 7,
      reasoning: 8,
      review: 8,
      security: 7,
      ux: 6,
      analysis: 10,
      long_context: 10,
      speed: 7,
      light: 5,
    },
    bias: 0.2,
  },
  'muse-spark-1.3-contributor': {
    name: 'Muse Spark 1.3 Contributor',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.025, out: 0.05 },
    note: 'O mais barato do catálogo, com visão',
    capabilities: {
      coding: 6,
      reasoning: 5,
      review: 5,
      security: 4,
      ux: 5,
      analysis: 5,
      long_context: 4,
      speed: 9,
      light: 10,
    },
    bias: 0.1,
  },
  'qwen3.8-flash': {
    name: 'Qwen 3.8 Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.03, out: 0.094 },
    note: 'Qwen rápido e barato',
    capabilities: {
      coding: 7,
      reasoning: 6,
      review: 6,
      security: 6,
      ux: 7,
      analysis: 6,
      long_context: 8,
      speed: 9,
      light: 9,
    },
    bias: 0.2,
  },
  'qwen3.8-max': {
    name: 'Qwen 3.8 Max',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'ultra',
    vision: true,
    price: { in: 0.4, out: 1.2 },
    note: 'Flagship Qwen',
    capabilities: {
      coding: 9,
      reasoning: 9,
      review: 8,
      security: 8,
      ux: 8,
      analysis: 9,
      long_context: 8,
      speed: 6,
      light: 4,
    },
    bias: 0.1,
  },
  'qwen3.8-omni-flash': {
    name: 'Qwen 3.8 Omni Flash',
    ctx: 1_048_576,
    out: 65_536,
    tier: 'pro',
    vision: true,
    price: { in: 0.03, out: 0.094 },
    note: 'Qwen multimodal rápido',
    capabilities: {
      coding: 6,
      reasoning: 6,
      review: 5,
      security: 5,
      ux: 8,
      analysis: 6,
      long_context: 7,
      speed: 9,
      light: 9,
    },
    bias: 0,
  },
};

// `let` DE PROPÓSITO: reconstruído quando o merge de sincronização adiciona
// modelos; TIE_BREAK_ORDER continua mandando na precedência e modelos fora
// dela entram por ordem de inserção no catálogo.
function buildModelOrder() {
  return [
    ...TIE_BREAK_ORDER.filter((model) => model in MODEL_CATALOG),
    ...Object.keys(MODEL_CATALOG).filter(
      (model) => !TIE_BREAK_ORDER.includes(model),
    ),
  ];
}

let MODEL_ORDER = buildModelOrder();

// Ordem canônica declarada para as classes conhecidas; classes novas detectadas
// no catálogo (ex.: trazidas por sincronização) são anexadas ao final em ordem
// de primeira aparição — catalogTiers() nunca precisa de edição manual.
const TIER_CANONICAL_ORDER = ['pro', 'ultra', 'max'];

export function catalogTiers() {
  const found = Object.values(MODEL_CATALOG).map((model) => model.tier);
  const known = TIER_CANONICAL_ORDER.filter((tier) => found.includes(tier));
  const extra = [...new Set(found.filter((tier) => !known.includes(tier)))];
  return [...known, ...extra];
}

// Mapa { [modelo]: { in, out } } derivado em tempo de chamada: mergeModelSync
// é mutável e pode trazer modelos sem `price`, que ficam fora do mapa (custo 0
// no cálculo de orçamento) sem precisar invalidar nada aqui.
export function modelPrices() {
  const prices = {};
  for (const [id, model] of Object.entries(MODEL_CATALOG)) {
    if (model.price && Number(model.price.in) >= 0 && Number(model.price.out) >= 0) {
      prices[id] = { in: Number(model.price.in), out: Number(model.price.out) };
    }
  }
  return prices;
}

const DIMENSION_LABELS = {
  coding: 'codificação',
  reasoning: 'raciocínio',
  review: 'revisão',
  security: 'segurança',
  ux: 'UX/web',
  analysis: 'análise',
  long_context: 'contexto longo',
  speed: 'velocidade',
  light: 'tarefa leve',
};

// ── Sincronização de catálogo (QUEBRAGALHO_MODEL_SYNC) ─────────────────
// Campos numéricos comuns anunciados por gateways OpenAI-compatible.
const SYNC_CONTEXT_FIELDS = ['context_length', 'context_window'];
const SYNC_OUTPUT_FIELDS = ['max_output_tokens', 'max_tokens'];

function remoteNumber(entry, fields) {
  for (const field of fields) {
    const value = Number(entry?.[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function neutralCapabilities() {
  return Object.fromEntries(
    Object.keys(DIMENSION_LABELS).map((dimension) => [dimension, 5]),
  );
}

// Muta MODEL_CATALOG in place com a lista remota de GET /v1/models:
// - id conhecido: mantém metadados locais (tier, capabilities, bias, note,
//   auto) e adota ctx/out quando o remoto traz números;
// - id desconhecido: entra com tier 'pro', SEM auto:false (roteamento
//   automático), capabilities neutras (5), bias 0, ctx 131072 e out 8192
//   quando o remoto não informa;
// - modelo local ausente do remoto: MANTIDO (a rede pode mentir, nunca
//   removemos silenciosamente).
// Retorna resumo { added, updated, kept, total }; kept são ids locais
// ausentes do remoto. refaz MODEL_ORDER via rebuildModelOrder quando adiciona.
export function mergeModelSync(remoteModels) {
  const list = Array.isArray(remoteModels) ? remoteModels : [];
  const added = [];
  const updated = [];
  const remoteIds = new Set();

  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || remoteIds.has(id)) continue;
    remoteIds.add(id);
    const ctx = remoteNumber(entry, SYNC_CONTEXT_FIELDS);
    const out = remoteNumber(entry, SYNC_OUTPUT_FIELDS);

    const local = MODEL_CATALOG[id];
    if (local) {
      if (ctx !== null) local.ctx = ctx;
      if (out !== null) local.out = out;
      updated.push(id);
      continue;
    }

    // Modelo desconhecido entra SEM `vision`: a sincronização nunca concede
    // visão (nem remove a de modelos locais conhecidos, cujos metadados são
    // preservados) — announced-by-remote não é prova de suporte multimodal.
    MODEL_CATALOG[id] = {
      name: typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : id,
      ctx: ctx ?? 131_072,
      out: out ?? 8_192,
      tier: 'pro',
      note: 'adicionado por sincronização',
      capabilities: neutralCapabilities(),
      bias: 0,
    };
    added.push(id);
  }

  if (added.length > 0) {
    MODEL_ORDER = buildModelOrder();
  }

  const kept = Object.keys(MODEL_CATALOG).filter((id) => !remoteIds.has(id));
  return { added, updated, kept, total: Object.keys(MODEL_CATALOG).length };
}

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(text, pattern) {
  return pattern.test(text);
}

export function classifyTask({ prompt, mode = 'read_only' }) {
  const text = normalizedText(prompt);
  const weights = Object.fromEntries(
    Object.keys(DIMENSION_LABELS).map((dimension) => [dimension, 0]),
  );
  const tags = new Set();

  const add = (tag, additions) => {
    tags.add(tag);
    for (const [dimension, weight] of Object.entries(additions)) {
      weights[dimension] += weight;
    }
  };

  if (mode === 'write') add('coding', { coding: 7, review: 1 });
  if (matches(text, /\b(implement|codific|refator|refactor|api|bugfix|fix|corrij|edit|crie|build|migrat|test|teste)\w*/)) {
    add('coding', { coding: 6, review: 1 });
  }
  if (matches(text, /\b(seguranc|security|vulnerab|auth|autoriz|tenant|csrf|xss|injection|permission|privileg|isolamento)\w*/)) {
    add('security', { security: 10, reasoning: 6, review: 4 });
  }
  if (matches(text, /\b(arquitet|architecture|complex|raciocin|trade.?off|decis|causa raiz|root cause|debug dificil)\w*/)) {
    add('reasoning', { reasoning: 9, analysis: 4 });
  }
  if (matches(text, /\b(ux|ui|frontend|front-end|web|design|acessib|responsive|responsiv|css|html|visual)\w*/)) {
    add('ux', { ux: 10, reasoning: 3, review: 2 });
  }
  if (matches(text, /\b(revis|review|audit|auditoria|code smell|performance|desempenho)\w*/)) {
    add('review', { review: 8, analysis: 3 });
  }
  if (matches(text, /\b(monorepo|contexto longo|long context|1m|milhao|muitos arquivos|large codebase|repositorio grande|volume)\w*/)) {
    add('long_context', { long_context: 10, analysis: 8 });
  }
  if (matches(text, /\b(analis|analy[sz]|investig|pesquis|research|compar|mapear)\w*/)) {
    add('analysis', { analysis: 7, reasoning: 2 });
  }
  if (matches(text, /\b(rapido|quick|simple|simples|typo|curto|light|leve|resposta curta)\w*/)) {
    add('speed', { speed: 10, light: 10 });
    if (text.length < 160) weights.coding = Math.min(weights.coding, 2);
  }

  if (tags.size === 0) {
    add('general', { coding: 4, reasoning: 3, analysis: 2 });
  }

  return {
    mode,
    tags: [...tags],
    weights,
  };
}

function runtimePenalty(state, now) {
  const penalties = [];
  let value = 0;
  const inFlight = Number(state?.inFlight ?? 0);
  if (inFlight > 0) {
    const penalty = inFlight * 1.25;
    value += penalty;
    penalties.push(`concorrência: -${penalty.toFixed(2)} (${inFlight} em execução)`);
  }
  const lastSelectedAt = Number(state?.lastSelectedAt ?? 0);
  if (lastSelectedAt > 0 && now - lastSelectedAt < 30_000) {
    value += 0.75;
    penalties.push('uso recente: -0.75');
  }
  const failures = Number(state?.failures ?? 0);
  if (failures > 0) {
    const penalty = Math.min(failures, 4) * 0.5;
    value += penalty;
    penalties.push(`falhas recentes: -${penalty.toFixed(2)}`);
  }
  const cooldownUntil = Number(state?.cooldownUntil ?? 0);
  if (cooldownUntil > now) {
    value += 50;
    penalties.push(`cooldown até ${new Date(cooldownUntil).toISOString()}: -50.00`);
  }
  return { value, penalties };
}

function affinityScore(profile, capabilities) {
  const weighted = Object.entries(profile.weights)
    .filter(([, weight]) => weight > 0);
  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight === 0) return 0;
  return weighted.reduce(
    (sum, [dimension, weight]) => sum + (capabilities[dimension] ?? 0) * weight,
    0,
  ) / totalWeight;
}

function reasonsFor(profile, model) {
  return Object.entries(profile.weights)
    .filter(([, weight]) => weight > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([dimension]) => (
      `${DIMENSION_LABELS[dimension]} ${model.capabilities[dimension]}/10`
    ));
}

export function rankModelsForTask({
  prompt,
  mode = 'read_only',
  profile: providedProfile,
  availableModels = Object.keys(MODEL_CATALOG),
  allowTiers = ['pro', 'ultra'],
  excludeModels = [],
  includePremiumModels = false,
  runtimeState = {},
  now = Date.now(),
}) {
  const profile = providedProfile ?? classifyTask({ prompt, mode });
  const available = new Set(availableModels);
  const tiers = new Set(allowTiers);
  const excluded = new Set(excludeModels);

  return MODEL_ORDER
    .filter((model) => (
      available.has(model)
      && !excluded.has(model)
      && tiers.has(MODEL_CATALOG[model].tier)
      && (includePremiumModels || MODEL_CATALOG[model].auto !== false)
    ))
    .map((model) => {
      const metadata = MODEL_CATALOG[model];
      const affinity = affinityScore(profile, metadata.capabilities);
      const { value: penalty, penalties } = runtimePenalty(
        runtimeState[model],
        now,
      );
      const score = affinity + metadata.bias - penalty;
      return {
        model,
        name: metadata.name,
        tier: metadata.tier,
        score: Number(score.toFixed(3)),
        affinity: Number(affinity.toFixed(3)),
        reasons: reasonsFor(profile, metadata),
        penalties,
      };
    })
    .sort((left, right) => (
      right.score - left.score
      || MODEL_ORDER.indexOf(left.model) - MODEL_ORDER.indexOf(right.model)
    ));
}

export function selectModelForTask(options) {
  const profile = classifyTask(options);
  const ranking = rankModelsForTask({ ...options, profile });
  if (ranking.length === 0) {
    const error = new Error('Nenhum modelo disponível após aplicar filtros e tiers.');
    error.code = 'MODEL_ROUTE_EMPTY';
    throw error;
  }
  const selected = ranking[0];
  return {
    model: selected.model,
    profile,
    ranking,
    reason: `Selecionado por afinidade com ${selected.reasons.join(', ')}.`,
  };
}
