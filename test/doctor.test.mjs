// Testes do bin/quebragalho-doctor.mjs: spawna o binário com process.execPath
// e usa fixtures http locais (node:http) — nenhuma rede externa é acessada.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const doctorPath = fileURLToPath(
  new URL('../bin/quebragalho-doctor.mjs', import.meta.url),
);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function withTimeout(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Servidor http local que responde qualquer GET com status/corpo fixos e
// registra as requisições (URL e cabeçalho Authorization) para as asserções.
async function startModelsServer(status, body) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Remove qualquer QUEBRAGALHO_* herdado do shell para o resultado não depender
// do ambiente local; os overrides da cada teste entram por cima.
function doctorEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('QUEBRAGALHO_')) delete env[key];
  }
  return Object.assign(env, overrides);
}

function runDoctor(args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [doctorPath, ...args], {
      env: doctorEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

// Diretório com um binário `claude` falso para o check de CLI nativa resolver
// via PATH (arquivo vazio basta: o doctor só resolve, não executa).
async function makeFakeCliDir(temp) {
  const cliDir = path.join(temp, 'bin');
  await mkdir(cliDir, { recursive: true });
  const fake = path.join(cliDir, 'claude');
  await writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(fake, 0o755);
  return cliDir;
}

function goodOverrides(baseUrl, cliDir) {
  return {
    QUEBRAGALHO_API_KEY: 'qg-doctor-valid-key',
    QUEBRAGALHO_BASE_URL: baseUrl,
    QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repoRoot,
    PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

test('doctor: 401 do gateway → exit 1, ✖ e sugestão de chave, sem vazar a chave', async () => {
  const fixture = await startModelsServer(401, { error: 'invalid key' });
  try {
    const key = 'qg-segredo-401-nao-vazar';
    const { code, stdout, stderr } = await withTimeout(
      runDoctor([], {
        QUEBRAGALHO_API_KEY: key,
        QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${fixture.port}/v1`,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repoRoot,
      }),
      'doctor não encerrou em 15s',
    );

    assert.equal(code, 1, `exit code inesperado\nstdout: ${stdout}\nstderr: ${stderr}`);
    const output = stdout + stderr;
    assert.ok(output.includes('✖'), 'saída deveria conter ✖');
    assert.ok(
      output.includes('exporte QUEBRAGALHO_API_KEY'),
      'saída deveria conter a sugestão de chave',
    );
    assert.ok(
      !output.includes(key),
      'saída não deveria conter a chave completa',
    );
    assert.ok(
      !output.includes('invalid key'),
      'saída não deveria vazar o corpo da resposta',
    );
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, '/v1/models');
    assert.equal(fixture.requests[0].authorization, `Bearer ${key}`);
  } finally {
    await fixture.close();
  }
});

test('doctor: 200 com modelos e ambiente bom → exit 0 e ✔ de chave', async () => {
  const fixture = await startModelsServer(200, {
    data: [{ id: 'modelo-a' }, { id: 'modelo-b' }, { id: 'modelo-c' }],
  });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-doctor-ok-'));
  const cliDir = await makeFakeCliDir(temp);
  try {
    const { code, stdout, stderr } = await withTimeout(
      runDoctor([], goodOverrides(`http://127.0.0.1:${fixture.port}/v1`, cliDir)),
      'doctor não encerrou em 15s',
    );

    assert.equal(code, 0, `exit code inesperado\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(stdout.includes('✔'), 'saída deveria conter ✔');
    assert.ok(stdout.includes('chave válida'), 'saída deveria confirmar a chave');
    assert.ok(
      stdout.includes('3 modelos visíveis'),
      'saída deveria contar os modelos de data[]',
    );
    assert.equal(fixture.requests[0].url, '/v1/models');
  } finally {
    await fixture.close();
  }
});

test('doctor: --json imprime array de objetos com check/ok (e detail/fix)', async () => {
  const fixture = await startModelsServer(200, { data: [{ id: 'modelo-a' }] });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'quebragalho-doctor-json-'));
  const cliDir = await makeFakeCliDir(temp);
  try {
    const { code, stdout, stderr } = await withTimeout(
      runDoctor(
        ['--json'],
        goodOverrides(`http://127.0.0.1:${fixture.port}/v1`, cliDir),
      ),
      'doctor não encerrou em 15s',
    );

    assert.equal(code, 0, `exit code inesperado\nstdout: ${stdout}\nstderr: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), '--json deveria imprimir um array');
    assert.equal(parsed.length, 5);
    for (const item of parsed) {
      assert.equal(typeof item.check, 'string');
      assert.equal(typeof item.ok, 'boolean');
      assert.ok('detail' in item);
      assert.ok('fix' in item);
    }
    assert.ok(
      parsed.every((item) => item.ok === true),
      `com ambiente bom todos os checks deveriam passar: ${JSON.stringify(parsed)}`,
    );
    const keyCheck = parsed.find((item) => item.check === 'chave-gateway');
    assert.ok(keyCheck?.ok === true);
    assert.ok(!stdout.includes('qg-doctor-valid-key'));
  } finally {
    await fixture.close();
  }
});

test('doctor: ALLOWED_ROOTS apontando para diretório inexistente → exit 1 mencionando a raiz', async () => {
  const fixture = await startModelsServer(200, { data: [] });
  try {
    const badRoot = path.join(
      os.tmpdir(),
      'quebragalho-doctor-nao-existe',
      'raiz-ausente',
    );
    const { code, stdout, stderr } = await withTimeout(
      runDoctor([], {
        QUEBRAGALHO_API_KEY: 'qg-doctor-root-key',
        QUEBRAGALHO_BASE_URL: `http://127.0.0.1:${fixture.port}/v1`,
        QUEBRAGALHO_AGENT_ALLOWED_ROOTS: badRoot,
      }),
      'doctor não encerrou em 15s',
    );

    assert.equal(code, 1, `exit code inesperado\nstdout: ${stdout}\nstderr: ${stderr}`);
    const output = stdout + stderr;
    assert.ok(output.includes('✖'), 'saída deveria conter ✖');
    assert.ok(
      output.includes(badRoot),
      'saída deveria citar a raiz inexistente',
    );
  } finally {
    await fixture.close();
  }
});

test('doctor: sem QUEBRAGALHO_API_KEY → exit 1 com sugestão, sem consultar o gateway', async () => {
  const { code, stdout, stderr } = await withTimeout(
    runDoctor([], { QUEBRAGALHO_AGENT_ALLOWED_ROOTS: repoRoot }),
    'doctor não encerrou em 15s',
  );

  assert.equal(code, 1, `exit code inesperado\nstdout: ${stdout}\nstderr: ${stderr}`);
  const output = stdout + stderr;
  assert.ok(output.includes('✖'), 'saída deveria conter ✖');
  assert.ok(
    output.includes('exporte QUEBRAGALHO_API_KEY'),
    'saída deveria conter a sugestão de chave',
  );
});

test('doctor: --help mostra uso e sai com 0 sem executar verificações', async () => {
  const { code, stdout } = await withTimeout(
    runDoctor(['--help']),
    'doctor não encerrou em 15s',
  );

  assert.equal(code, 0);
  assert.ok(stdout.includes('--json'));
  assert.ok(stdout.includes('--help'));
  assert.ok(!stdout.includes('✔'), '--help não deveria rodar os checks');
});
