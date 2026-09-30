import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const skipOnWindows = { skip: process.platform === 'win32' };

// fake curl padrão: responde 200 com JSON válido ecoando a última mensagem
const FAKE_CURL_OK = `#!/usr/bin/env node
const index = process.argv.indexOf('-d');
const body = JSON.parse(process.argv[index + 1]);
process.stdout.write(JSON.stringify({ choices: [{ message: { content: body.messages.at(-1).content } }] }));
`;

// fake curl que simula --fail-with-body: escreve corpo de erro na stdout e sai 22
const FAKE_CURL_FAIL_WITH_BODY = `#!/usr/bin/env node
const index = process.argv.indexOf('-d');
JSON.parse(process.argv[index + 1]);
process.stdout.write(JSON.stringify({ error: { message: 'api quebragalho: chave inválida', type: 'invalid_request_error', code: 401 } }));
process.exit(22);
`;

// fake curl que exige receber --max-time 5 (valida o repasse de --timeout)
const FAKE_CURL_MAX_TIME = `#!/usr/bin/env node
const i = process.argv.indexOf('--max-time');
if (i === -1 || process.argv[i + 1] !== '5') {
  process.stderr.write('esperava --max-time 5, argv: ' + process.argv.join(' '));
  process.exit(2);
}
const d = process.argv.indexOf('-d');
const body = JSON.parse(process.argv[d + 1]);
process.stdout.write(JSON.stringify({ choices: [{ message: { content: body.messages.at(-1).content } }] }));
`;

async function writeFakeCurl(fakeBin, source) {
  const fakeCurl = path.join(fakeBin, 'curl');
  await writeFile(fakeCurl, source);
  await chmod(fakeCurl, 0o755);
  return fakeBin;
}

function runQg(args, { fakeBin = '', stdin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve('bin/qg'), args, {
      env: {
        ...process.env,
        PATH: fakeBin
          ? `${fakeBin}${path.delimiter}${process.env.PATH}`
          : process.env.PATH,
        QUEBRAGALHO_API_KEY: 'test-key',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('qg combina prompt posicional com stdin sem chamada de rede', skipOnWindows, async () => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-qg-'));
  await writeFakeCurl(fakeBin, FAKE_CURL_OK);

  const result = await runQg(['Revise este código'], { fakeBin, stdin: 'const answer = 42;' });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Revise este código/);
  assert.match(result.stdout, /const answer = 42;/);
});

test('qg propaga erro do gateway (--fail-with-body) com corpo no stderr', skipOnWindows, async () => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-qg-'));
  await writeFakeCurl(fakeBin, FAKE_CURL_FAIL_WITH_BODY);

  const result = await runQg(['oi'], { fakeBin });

  assert.equal(result.code, 22, result.stderr);
  assert.match(result.stderr, /chave inválida/);
  assert.equal(result.stdout, '');
});

test('qg --version imprime a versão do package.json', skipOnWindows, async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  const result = await runQg(['--version']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('qg -q/--quiet suprime o box decorativo mantendo o stdout', skipOnWindows, async () => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-qg-'));
  await writeFakeCurl(fakeBin, FAKE_CURL_OK);

  for (const flag of ['-q', '--quiet']) {
    const result = await runQg([flag, 'Revise este código'], { fakeBin });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Revise este código/);
    assert.ok(!result.stderr.includes('┌'), `esperava stderr sem "┌" (${flag}): ${result.stderr}`);
    assert.ok(!result.stderr.includes('└'), `esperava stderr sem "└" (${flag}): ${result.stderr}`);
  }
});

test('qg --timeout inválido falha com erro de uso (exit 64)', skipOnWindows, async () => {
  const naoNumerico = await runQg(['--timeout', 'abc', 'oi']);
  assert.equal(naoNumerico.code, 64);
  assert.match(naoNumerico.stderr, /--timeout/);

  const zero = await runQg(['--timeout', '0', 'oi']);
  assert.equal(zero.code, 64);
  assert.match(zero.stderr, /--timeout/);

  const semValor = await runQg(['--timeout']);
  assert.equal(semValor.code, 64);
  assert.match(semValor.stderr, /--timeout/);
});

test('qg --timeout repassa --max-time ao curl', skipOnWindows, async () => {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-qg-'));
  await writeFakeCurl(fakeBin, FAKE_CURL_MAX_TIME);

  const result = await runQg(['--timeout', '5', 'oi'], { fakeBin });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /oi/);
});
