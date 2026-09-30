import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_CATALOG,
  catalogTiers,
  classifyTask,
  mergeModelSync,
  modelPrices,
  rankModelsForTask,
  selectModelForTask,
} from '../model-router.mjs';

const ALL_MODELS = Object.keys(MODEL_CATALOG);

test('classifica e direciona implementação para DeepSeek', () => {
  const selection = selectModelForTask({
    prompt: 'Implemente esta API em Node, edite os arquivos e escreva testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'deepseek-v4.1-flash');
  assert.ok(selection.profile.tags.includes('coding'));
  assert.match(selection.reason, /codificação/i);
});

test('direciona auditoria de segurança complexa para GLM 5.3', () => {
  const selection = selectModelForTask({
    prompt: 'Faça uma auditoria de segurança multi-tenant e raciocine sobre a arquitetura.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'glm-5.3');
  assert.ok(selection.profile.tags.includes('security'));
  assert.ok(selection.profile.tags.includes('reasoning'));
});

test('direciona análise de contexto longo para Mimo', () => {
  const selection = selectModelForTask({
    prompt: 'Analise um monorepo enorme com muitos arquivos e contexto longo de 1 milhão.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'mimo-v2.6-flash');
  assert.ok(selection.profile.tags.includes('long_context'));
});

test('direciona tarefa simples e rápida para GLM Flash', () => {
  const selection = selectModelForTask({
    prompt: 'Resposta rápida: corrija um typo simples nesta mensagem.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
  });

  assert.equal(selection.model, 'glm-5.3-flash');
  assert.ok(selection.profile.tags.includes('speed'));
});

test('respeita tier permitido e exclusões com fallback determinístico', () => {
  const proOnly = rankModelsForTask({
    prompt: 'Audite a segurança e a arquitetura deste sistema complexo.',
    mode: 'read_only',
    availableModels: ALL_MODELS,
    allowTiers: ['pro'],
  });
  assert.ok(proOnly.every((item) => item.tier === 'pro'));
  assert.notEqual(proOnly[0].model, 'glm-5.3');

  const fallback = selectModelForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    excludeModels: ['deepseek-v4.1-flash'],
  });
  assert.equal(fallback.model, 'glm-5.3');
});

test('expõe modelos Max para seleção manual sem colocá-los no roteamento automático', () => {
  assert.equal(MODEL_CATALOG['deepseek-v4-pro'].tier, 'max');
  assert.equal(MODEL_CATALOG['kimi-k3'].tier, 'max');

  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    allowTiers: ['pro', 'max', 'ultra'],
  });
  assert.ok(!ranking.some((item) => item.model === 'deepseek-v4-pro'));
  assert.ok(!ranking.some((item) => item.model === 'kimi-k3'));
});

test('inclui variantes premium no ranking somente com opt-in explícito', () => {
  const input = {
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    allowTiers: ['pro', 'max', 'ultra'],
  };

  const defaultRanking = rankModelsForTask(input);
  assert.ok(!defaultRanking.some((item) => item.model === 'deepseek-v4-pro'));
  assert.ok(!defaultRanking.some((item) => item.model === 'kimi-k3'));

  const premiumRanking = rankModelsForTask({
    ...input,
    includePremiumModels: true,
  });
  assert.ok(premiumRanking.some((item) => item.model === 'deepseek-v4-pro'));
  assert.ok(premiumRanking.some((item) => item.model === 'kimi-k3'));
});

test('penaliza concorrência e uso recente sem fazer round-robin cego', () => {
  const now = 1_000_000;
  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    runtimeState: {
      'deepseek-v4.1-flash': {
        inFlight: 2,
        lastSelectedAt: now - 1_000,
        failures: 0,
        cooldownUntil: 0,
      },
    },
    now,
  });

  assert.equal(ranking[0].model, 'glm-5.3');
  const deepseek = ranking.find((item) => item.model === 'deepseek-v4.1-flash');
  assert.ok(deepseek.penalties.some((reason) => reason.includes('concorrência')));
  assert.ok(deepseek.penalties.some((reason) => reason.includes('uso recente')));
});

test('classificação é explicável e não depende de aleatoriedade', () => {
  const input = {
    prompt: 'Revise acessibilidade, UX responsiva e componentes web.',
    mode: 'read_only',
  };
  assert.deepEqual(classifyTask(input), classifyTask(input));

  const selection = selectModelForTask({
    ...input,
    availableModels: ALL_MODELS,
  });
  assert.equal(selection.model, 'glm-5.3');
  assert.ok(selection.ranking[0].reasons.length > 0);
});

test('lança MODEL_ROUTE_EMPTY quando os filtros removem todos os modelos', () => {
  assert.throws(
    () => selectModelForTask({
      prompt: 'Implemente algo.',
      availableModels: ALL_MODELS,
      excludeModels: ALL_MODELS,
    }),
    (error) => error.code === 'MODEL_ROUTE_EMPTY',
  );
});

test('cooldown ativo desprioriza o modelo', () => {
  const now = 1_000_000;
  const ranking = rankModelsForTask({
    prompt: 'Implemente uma refatoração grande com testes.',
    mode: 'write',
    availableModels: ALL_MODELS,
    runtimeState: {
      'deepseek-v4.1-flash': { cooldownUntil: now + 60_000 },
    },
    now,
  });

  assert.notEqual(ranking[0].model, 'deepseek-v4.1-flash');
  assert.equal(ranking.at(-1).model, 'deepseek-v4.1-flash');
});

// mergeModelSync muta o catálogo global in place: cada teste que muta tira um
// snapshot profundo e restaura no t.after (testes do arquivo rodam em série e
// node --test roda cada arquivo em processo próprio, então não há contaminação).
function snapshotCatalog() {
  return Object.fromEntries(
    Object.entries(MODEL_CATALOG).map(([id, meta]) => [id, {
      ...meta,
      capabilities: { ...meta.capabilities },
    }]),
  );
}

function restoreCatalog(snapshot) {
  for (const key of Object.keys(MODEL_CATALOG)) delete MODEL_CATALOG[key];
  Object.assign(MODEL_CATALOG, snapshot);
}

test('mergeModelSync atualiza ctx/out de modelo conhecido preservando metadados locais', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  const summary = mergeModelSync([
    { id: 'deepseek-v4.1-flash', context_length: 262_144 },
    { id: 'glm-5.3', context_window: 131_072, max_output_tokens: 32_768 },
  ]);

  const flash = MODEL_CATALOG['deepseek-v4.1-flash'];
  assert.equal(flash.ctx, 262_144);
  assert.equal(flash.tier, 'pro');
  assert.equal(flash.capabilities.coding, 10);
  assert.equal(flash.capabilities.long_context, 10);
  assert.equal(flash.bias, 0.6);
  assert.equal(flash.note, 'Melhor CxB para codificação');

  const glm = MODEL_CATALOG['glm-5.3'];
  assert.equal(glm.ctx, 131_072);
  assert.equal(glm.out, 32_768);
  assert.equal(glm.tier, 'ultra');
  assert.equal(glm.capabilities.reasoning, 10);

  assert.deepEqual(summary.added, []);
  assert.deepEqual(
    [...summary.updated].sort(),
    ['deepseek-v4.1-flash', 'glm-5.3'].sort(),
  );
  assert.deepEqual(
    [...summary.kept].sort(),
    ALL_MODELS.filter((id) => !['deepseek-v4.1-flash', 'glm-5.3'].includes(id)).sort(),
  );
  assert.equal(summary.total, ALL_MODELS.length);
});

test('mergeModelSync mantém ctx/out quando o remoto não traz números para modelo conhecido', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  const before = MODEL_CATALOG['mimo-v2.6-flash'].ctx;
  mergeModelSync([{ id: 'mimo-v2.6-flash' }]);
  assert.equal(MODEL_CATALOG['mimo-v2.6-flash'].ctx, before);
  assert.equal(MODEL_CATALOG['mimo-v2.6-flash'].out, 65_536);
});

test('mergeModelSync adiciona modelo desconhecido com metadados neutros', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  const summary = mergeModelSync([
    { id: 'modelo-novo-sync' },
    { id: 'modelo-novo-com-ctx', context_length: 500_000, max_tokens: 16_384 },
  ]);

  assert.deepEqual(
    [...summary.added].sort(),
    ['modelo-novo-com-ctx', 'modelo-novo-sync'].sort(),
  );

  const neutro = MODEL_CATALOG['modelo-novo-sync'];
  assert.equal(neutro.tier, 'pro');
  assert.ok(!('auto' in neutro), 'modelo sincronizado entra no roteamento automático');
  assert.equal(neutro.ctx, 131_072);
  assert.equal(neutro.out, 8_192);
  assert.equal(neutro.bias, 0);
  assert.equal(neutro.note, 'adicionado por sincronização');
  assert.ok(
    Object.values(neutro.capabilities).every((value) => value === 5),
    'capabilities neutras (5 em todas as dimensões)',
  );

  assert.equal(MODEL_CATALOG['modelo-novo-com-ctx'].ctx, 500_000);
  assert.equal(MODEL_CATALOG['modelo-novo-com-ctx'].out, 16_384);
  assert.equal(MODEL_CATALOG['modelo-novo-com-ctx'].tier, 'pro');
});

test('mergeModelSync mantém modelo local ausente do remoto', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  const summary = mergeModelSync([{ id: 'modelo-novo-sync' }]);

  for (const id of ALL_MODELS) {
    assert.ok(MODEL_CATALOG[id], `${id} nunca deve ser removido`);
    assert.ok(summary.kept.includes(id));
  }
  assert.equal(summary.total, ALL_MODELS.length + 1);
});

test('mergeModelSync inclui modelo novo em MODEL_ORDER e no ranking da rota', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  mergeModelSync([{ id: 'modelo-novo-sync' }]);

  // Se MODEL_ORDER não incluísse o modelo, o ranking viria vazio e lançaria
  // MODEL_ROUTE_EMPTY mesmo com availableModels contendo o modelo.
  const selection = selectModelForTask({
    prompt: 'Implemente uma API.',
    mode: 'write',
    availableModels: ['modelo-novo-sync'],
  });
  assert.equal(selection.model, 'modelo-novo-sync');

  const ranking = rankModelsForTask({
    prompt: 'Implemente uma API.',
    mode: 'write',
    availableModels: [...ALL_MODELS, 'modelo-novo-sync'],
    allowTiers: [...catalogTiers()],
  });
  assert.ok(ranking.some((item) => item.model === 'modelo-novo-sync'));
});

test('mergeModelSync ignora entradas sem id e aceita lista vazia', () => {
  const snapshot = snapshotCatalog();
  const summary = mergeModelSync([{ context_length: 1000 }, {}, null]);
  assert.deepEqual(summary, { added: [], updated: [], kept: [...ALL_MODELS], total: ALL_MODELS.length });
  assert.deepEqual(catalogTiers(), ['pro', 'ultra', 'max']);
  // sanity: catálogo não foi mutado por entradas inválidas
  assert.equal(Object.keys(MODEL_CATALOG).length, ALL_MODELS.length);
  restoreCatalog(snapshot);
});

test('catalogTiers deriva as classes do catálogo em ordem estável', (t) => {
  assert.deepEqual(catalogTiers(), ['pro', 'ultra', 'max']);

  // Adicionar uma nova classe ao catálogo muda o retorno automaticamente
  // (aceite do roadmap); snapshot restaura o estado global depois.
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));
  MODEL_CATALOG['modelo-tier-fake'] = {
    name: 'Modelo Tier Fake',
    ctx: 1_000,
    out: 1_000,
    tier: 'omega',
    note: 'fake',
    capabilities: {},
    bias: 0,
  };
  assert.deepEqual(catalogTiers(), ['pro', 'ultra', 'max', 'omega']);
});

test('catálogo declara price US$/M para os 8 modelos base', () => {
  const expected = {
    'deepseek-v4.1-flash': { in: 0.14, out: 0.56 },
    'deepseek-v4-pro': { in: 0.32, out: 0.97 },
    'glm-5.3': { in: 0.54, out: 1.70 },
    'glm-5.3-flash': { in: 0.05, out: 0.17 },
    'mimo-v2.6-flash': { in: 0.03, out: 0.06 },
    'kimi-k3': { in: 1.19, out: 6.20 },
    'gpt-6-luna': { in: 0.03, out: 0.15 },
    'muse-spark-1.3-contributor': { in: 0.03, out: 0.05 },
  };
  assert.equal(Object.keys(expected).length, ALL_MODELS.length);
  for (const [id, price] of Object.entries(expected)) {
    assert.deepEqual(MODEL_CATALOG[id].price, price, `price de ${id}`);
  }
  assert.deepEqual(modelPrices(), expected);
});

test('modelPrices exclui modelo vindo de sync (custo 0 no cálculo de orçamento)', (t) => {
  const snapshot = snapshotCatalog();
  t.after(() => restoreCatalog(snapshot));

  mergeModelSync([{ id: 'modelo-novo-sync' }]);
  const prices = modelPrices();
  assert.ok(!('modelo-novo-sync' in prices));
  assert.equal(prices['glm-5.3'].out, 1.70);
  assert.equal(MODEL_CATALOG['modelo-novo-sync'].price, undefined);
});
