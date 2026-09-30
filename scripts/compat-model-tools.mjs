// nome antigo: o handler continua resolvendo quebragalho_<modelo> via MODELS.
// Sem chave configurada a chamada falha na rede, e isso ja basta: o que a
// regressao produziria e "Tool desconhecida", nao erro de credencial.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'index.mjs');
const LEGACY_TOOL = 'quebragalho_glm_5_3';

// Ambiente minimo e explicito. Herdar o shell inteiro levaria QUEBRAGALHO_API_KEY
// junto, e ai a chamada da tool legada faria uma requisicao real e paga em vez
// de parar no erro de credencial que esta checagem espera observar.
// Sem TMPDIR de proposito: esta checagem nao escreve em disco, e repassar o
// diretorio temporario so ampliaria a superficie do processo filho.
const BASE_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NO_COLOR: '1',
  QUEBRAGALHO_API_KEY: '',
};

const connect = async (env) => {
  const client = new Client({ name: 'compat-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: { ...BASE_ENV, ...env },
  }));
  return client;
};

let failures = 0;

// O detalhe vem da resposta do servidor, entao nao vai cru para o log:
// remove controle e pontuacao exotica, que e o vetor de log injection, e trunca.
const sanitize = (value) => String(value).replace(/[^\w\s.,:/=-]/g, '').slice(0, 160);

const check = (label, ok, detail = '') => {
  const status = ok ? 'PASS' : 'FALHA';
  const suffix = detail ? ` :: ${sanitize(detail)}` : '';
  console.log(`${status}  ${label}${suffix}`);
  if (!ok) failures += 1;
};

// 1. vitrine enxuta por padrao
const lean = await connect({});
const leanNames = (await lean.listTools()).tools.map((tool) => tool.name);
check('vitrine nao lista tools por modelo', !leanNames.includes(LEGACY_TOOL), leanNames.join(','));
check('quebragalho_code segue publicada', leanNames.includes('quebragalho_code'));

// 2. nome antigo continua resolvendo no handler.
// A resposta do servidor nao vai para o log nem sanitizada: so a classificacao
// dela, que e o unico dado de que o diagnostico precisa.
const call = await lean.callTool({ name: LEGACY_TOOL, arguments: { prompt: 'oi' } });
const text = call.content?.[0]?.text ?? '';
const resolved = !/Tool desconhecida/i.test(text);
check(
  'nome antigo nao vira "Tool desconhecida"',
  resolved,
  resolved ? 'chegou ao handler e parou na credencial' : 'handler nao reconheceu o nome',
);
await lean.close();

// 3. flag de compatibilidade republica as tools
const full = await connect({ QUEBRAGALHO_LIST_MODEL_TOOLS: '1' });
const fullNames = (await full.listTools()).tools.map((tool) => tool.name);
check('QUEBRAGALHO_LIST_MODEL_TOOLS=1 republica', fullNames.includes(LEGACY_TOOL), `${fullNames.length} tools`);
await full.close();

console.log(failures ? `\n${failures} verificacao(oes) falhou` : '\ntudo certo');
process.exit(failures ? 1 : 0);
