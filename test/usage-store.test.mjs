import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  budgetExceededError,
  budgetUnavailableError,
  budgetWarning,
  configuredMaxSpendUsd,
  evaluateBudget,
  readUsageSummary,
  recordUsage,
  spendTodayUsd,
  todayLocalDate,
  usageDirectory,
  usageFileForDate,
} from '../usage-store.mjs';

// Datas fixas em horário local (meio-dia) para não sofrer shift de fuso.
const DIA_1 = new Date(2026, 8, 30, 12, 0, 0).getTime(); // 2026-09-30 local
const DIA_2 = new Date(2026, 9, 1, 12, 0, 0).getTime(); // 2026-10-01 local

async function usageFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-usage-'));
  const usageDir = path.join(base, 'usage');
  return {
    base,
    usageDir,
    env: { HOME: base, QUEBRAGALHO_USAGE_DIR: usageDir },
  };
}

async function lerLinhas(file) {
  const raw = await readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('todayLocalDate usa componentes locais, sem shift UTC', () => {
  // 2026-01-01 00:30 local: em fusos negativos o UTC ainda é 2025-12-31.
  const virada = new Date(2026, 0, 1, 0, 30, 0);
  assert.equal(todayLocalDate(virada), '2026-01-01');
  assert.equal(todayLocalDate(new Date(2026, 11, 31, 23, 59, 0)), '2026-12-31');
  assert.equal(todayLocalDate(DIA_1), '2026-09-30');
  assert.match(todayLocalDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('usageDirectory replica a resolução do memory dir e aceita override', async () => {
  const { base, usageDir, env } = await usageFixture();
  assert.equal(usageDirectory(env), usageDir);
  assert.equal(
    usageDirectory({ HOME: base }),
    path.join(base, '.local', 'share', 'quebragalho-bridge', 'usage'),
  );
  const comEspacos = { QUEBRAGALHO_USAGE_DIR: `  ${usageDir}  `, HOME: base };
  assert.equal(usageDirectory(comEspacos), usageDir);
});

test('recordUsage grava JSONL diário somente com contadores e identificadores', async () => {
  const { usageDir, env } = await usageFixture();
  const ok = await recordUsage(
    { model: 'deepseek-v4.1-flash', executor: 'direct', inTokens: 1000, outTokens: 250 },
    env,
    { now: DIA_1 },
  );
  assert.equal(ok, true);

  const linhas = await lerLinhas(usageFileForDate(env, '2026-09-30'));
  assert.equal(linhas.length, 1);
  assert.deepEqual(linhas[0], {
    timestamp: new Date(DIA_1).toISOString(),
    model: 'deepseek-v4.1-flash',
    executor: 'direct',
    in_tokens: 1000,
    out_tokens: 250,
    requests: 1,
  });
  // Contrato de conteúdo: nenhum campo além de contadores/identificadores.
  assert.deepEqual(
    Object.keys(linhas[0]).sort(),
    ['executor', 'in_tokens', 'model', 'out_tokens', 'requests', 'timestamp'],
  );
  await stat(usageDir); // diretório de uso foi criado pela store
});

test('recordUsage serializa gravações concorrentes sem perder linha', async () => {
  const { env } = await usageFixture();
  await Promise.all(Array.from({ length: 20 }, (_, index) => recordUsage(
    { model: `modelo-${index}`, inTokens: index, outTokens: index },
    env,
    { now: DIA_1 },
  )));
  const linhas = await lerLinhas(usageFileForDate(env, '2026-09-30'));
  assert.equal(linhas.length, 20);
  assert.equal(new Set(linhas.map((linha) => linha.model)).size, 20);
});

test('recordUsage rejeita modelo vazio e tolera falha de disco sem lançar', async () => {
  const { base, env } = await usageFixture();
  assert.equal(await recordUsage({ model: '  ' }, env), false);
  assert.equal(await recordUsage({ model: 'glm-5.3' }, {}), true); // HOME default

  // QUEBRAGALHO_USAGE_DIR apontando para um ARQUIVO: mkdir/append falham e a
  // store resolve false silenciosamente (não loga, não lança).
  const arquivo = path.join(base, 'bloqueio.txt');
  await writeFile(arquivo, 'x');
  assert.equal(
    await recordUsage({ model: 'glm-5.3' }, { QUEBRAGALHO_USAGE_DIR: arquivo }),
    false,
  );
});

test('recordUsage satura contadores negativos ou não numéricos em 0', async () => {
  const { env } = await usageFixture();
  await recordUsage(
    { model: 'glm-5.3', inTokens: -5, outTokens: Number.NaN },
    env,
    { now: DIA_1 },
  );
  const [linha] = await lerLinhas(usageFileForDate(env, '2026-09-30'));
  assert.equal(linha.in_tokens, 0);
  assert.equal(linha.out_tokens, 0);
});

test('readUsageSummary agrega por modelo e total nos últimos N dias', async () => {
  const { env } = await usageFixture();
  await recordUsage({ model: 'glm-5.3', inTokens: 100, outTokens: 50 }, env, { now: DIA_1 });
  await recordUsage({ model: 'glm-5.3', inTokens: 10, outTokens: 5 }, env, { now: DIA_1 });
  await recordUsage({ model: 'gpt-6-luna', inTokens: 7, outTokens: 3 }, env, { now: DIA_1 });

  const summary = await readUsageSummary(env, { days: 3, now: DIA_1 });
  assert.equal(summary.today, '2026-09-30');
  assert.equal(summary.days.length, 3);
  assert.deepEqual(
    summary.days.map((day) => day.date),
    ['2026-09-28', '2026-09-29', '2026-09-30'],
  );
  const hoje = summary.days.at(-1);
  assert.deepEqual(hoje.models['glm-5.3'], { in_tokens: 110, out_tokens: 55, requests: 2 });
  assert.deepEqual(hoje.models['gpt-6-luna'], { in_tokens: 7, out_tokens: 3, requests: 1 });
  assert.deepEqual(hoje.total, { in_tokens: 117, out_tokens: 58, requests: 3 });
  // Dias sem arquivo ficam zerados, mas presentes (shape estável).
  assert.deepEqual(summary.days[0].total, { in_tokens: 0, out_tokens: 0, requests: 0 });
});

test('separação por dia: datas injetadas geram arquivos e agregados separados', async () => {
  const { env } = await usageFixture();
  await recordUsage({ model: 'glm-5.3', inTokens: 100, outTokens: 0 }, env, { now: DIA_1 });
  await recordUsage({ model: 'glm-5.3', inTokens: 900, outTokens: 0 }, env, { now: DIA_2 });

  const files = [
    await lerLinhas(usageFileForDate(env, '2026-09-30')),
    await lerLinhas(usageFileForDate(env, '2026-10-01')),
  ];
  assert.equal(files[0][0].in_tokens, 100);
  assert.equal(files[1][0].in_tokens, 900);

  const summary = await readUsageSummary(env, { days: 2, now: DIA_2 });
  assert.equal(summary.today, '2026-10-01');
  assert.equal(summary.days[0].total.in_tokens, 100);
  assert.equal(summary.days[1].total.in_tokens, 900);
});

test('spendTodayUsd soma in*out com preços por milhão e modelo sem preço custa 0', async () => {
  const { env } = await usageFixture();
  await recordUsage(
    { model: 'deepseek-v4.1-flash', inTokens: 1_000_000, outTokens: 500_000 },
    env,
    { now: DIA_1 },
  );
  await recordUsage(
    { model: 'modelo-vindo-de-sync', inTokens: 10_000_000, outTokens: 10_000_000 },
    env,
    { now: DIA_1 },
  );
  const spend = await spendTodayUsd(env, {
    'deepseek-v4.1-flash': { in: 0.14, out: 0.56 },
  }, { now: DIA_1 });
  // 1*0.14 + 0.5*0.56 = 0.42; o modelo sem preço contribui 0.
  assert.ok(Math.abs(spend - 0.42) < 1e-9);
});

test('spendTodayUsd e readUsageSummary toleram dia inexistente (ENOENT = 0)', async () => {
  const { env } = await usageFixture();
  assert.equal(await spendTodayUsd(env, {}, { now: DIA_1 }), 0);
  const summary = await readUsageSummary(env, { days: 1, now: DIA_1 });
  assert.deepEqual(summary.days[0], {
    date: '2026-09-30',
    models: {},
    total: { in_tokens: 0, out_tokens: 0, requests: 0 },
  });
});

test('linha corrompida é ignorada e o restante do diário agrega', async () => {
  const { env } = await usageFixture();
  const file = usageFileForDate(env, '2026-09-30');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    JSON.stringify({ timestamp: 'x', model: 'glm-5.3', in_tokens: 10, out_tokens: 5, requests: 1 }),
    '{"model": "glm-5.3", "in_tokens": 7', // linha interrompida
    'isto não é json',
    JSON.stringify({ timestamp: 'y', model: 'glm-5.3', in_tokens: 30, out_tokens: 0, requests: 1 }),
    '',
  ].join('\n'));

  const { total } = await readUsageSummary(env, { days: 1, now: DIA_1 }).then((s) => s.days[0]);
  assert.deepEqual(total, { in_tokens: 40, out_tokens: 5, requests: 2 });
});

test('configuredMaxSpendUsd: ausente, vazia, inválida ou negativa = sem limite', () => {
  assert.equal(configuredMaxSpendUsd({}), null);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: '' }), null);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: '   ' }), null);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: 'abc' }), null);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: '-1' }), null);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: '0' }), 0);
  assert.equal(configuredMaxSpendUsd({ QUEBRAGALHO_MAX_SPEND_USD: '1.5' }), 1.5);
});

test('budgetWarning só existe na faixa [80%, 100%) do teto', () => {
  const warning = budgetWarning(0.9, 1);
  assert.equal(warning.code, 'BUDGET_WARNING');
  assert.match(warning.message, /Aviso de orçamento/);
  assert.match(warning.message, /US\$ 0\.9\d* de US\$ 1\.00 USD usados hoje/);
  assert.equal(budgetWarning(0.79, 1), null);
  assert.equal(budgetWarning(1, 1), null);
  assert.equal(budgetWarning(1.2, 1), null);
  assert.equal(budgetWarning(0.9, null), null);
});

test('evaluateBudget é inerte sem teto e fail-closed com teto', async () => {
  const { env } = await usageFixture();
  await recordUsage(
    { model: 'deepseek-v4.1-flash', inTokens: 100_000, outTokens: 0 },
    env,
    { now: DIA_1 },
  ); // gasto 0.014

  // Sem teto: inerte, sem warning.
  const inerte = await evaluateBudget(env, { 'deepseek-v4.1-flash': { in: 0.14, out: 0.56 } });
  assert.deepEqual(inerte, { limited: false, spend: null, limit: null, warning: null });

  // Dentro do teto, abaixo de 80%: libera sem warning.
  const livre = await evaluateBudget({ ...env, QUEBRAGALHO_MAX_SPEND_USD: '1' }, {
    'deepseek-v4.1-flash': { in: 0.14, out: 0.56 },
  });
  assert.equal(livre.limited, true);
  assert.equal(livre.warning, null);

  // Entre 80% e 100%: libera com warning.
  const proximo = await evaluateBudget({ ...env, QUEBRAGALHO_MAX_SPEND_USD: '0.015' }, {
    'deepseek-v4.1-flash': { in: 0.14, out: 0.56 },
  });
  assert.equal(proximo.warning?.code, 'BUDGET_WARNING');

  // Teto de 0 com qualquer gasto >= 0: bloqueia.
  await assert.rejects(
    evaluateBudget({ ...env, QUEBRAGALHO_MAX_SPEND_USD: '0' }, {}),
    (error) => error.code === 'BUDGET_EXCEEDED',
  );

  // Estourado: BUDGET_EXCEEDED com gasto, teto e recuperação.
  try {
    await evaluateBudget({ ...env, QUEBRAGALHO_MAX_SPEND_USD: '0.01' }, {
      'deepseek-v4.1-flash': { in: 0.14, out: 0.56 },
    });
    assert.fail('deveria bloquear');
  } catch (error) {
    assert.equal(error.code, 'BUDGET_EXCEEDED');
    assert.ok(error.spend_today_usd >= 0.01);
    assert.equal(error.limit_usd, 0.01);
    assert.match(error.message, /QUEBRAGALHO_MAX_SPEND_USD/);
    assert.match(error.message, /virar o dia local/);
  }

  // Diário ilegível: o arquivo do dia corrente é um DIRETÓRIO (open falha com
  // EISDIR — erro de leitura que não é ENOENT), então fail-closed bloqueia.
  const ilegivelDir = path.join(env.HOME, 'ilegivel');
  const ilegivelFile = path.join(ilegivelDir, `usage-${todayLocalDate()}.jsonl`);
  await mkdir(ilegivelFile, { recursive: true });
  await assert.rejects(
    evaluateBudget({ QUEBRAGALHO_MAX_SPEND_USD: '1', QUEBRAGALHO_USAGE_DIR: ilegivelDir }, {}),
    (error) => error.code === 'BUDGET_EXCEEDED' && /indisponível/.test(error.message),
  );
});

test('erros de orçamento carregam código e mensagem de recuperação', () => {
  const exceeded = budgetExceededError(0.5, 0.4);
  assert.equal(exceeded.code, 'BUDGET_EXCEEDED');
  assert.match(exceeded.message, /US\$ 0\.5000\) atingiu o teto de US\$ 0\.40/);
  assert.match(exceeded.message, /Aumente QUEBRAGALHO_MAX_SPEND_USD ou aguarde virar o dia local/);

  const unavailable = budgetUnavailableError(2);
  assert.equal(unavailable.code, 'BUDGET_EXCEEDED');
  assert.match(unavailable.message, /indisponível para leitura/);
});
