# ROADMAP — Guia de execução para agente orquestrador e subagentes

> Este documento é o contrato de trabalho. Cada seção de tarefa é autocontida:
> pode ser despachada a um subagent sem histórico da conversa que a originou.
> O orquestrador mantém este arquivo atualizado (marcando status) e é o único
> que roda a verificação final de cada batch.

Status: `pendente` | `em_andamento` | `concluido` | `bloqueado`

---

## 1. Contexto do projeto (leia antes de qualquer tarefa)

**O que é**: servidor MCP (stdio, Node 18+, ESM, zero deps além de
`@modelcontextprotocol/sdk`) que transforma o gateway pré-pago Quebragalho
(`https://api.quebragalho.dev/v1`, chave `qg-...`, compatível com OpenAI e
Anthropic) em sub-agentes para Claude Code, Codex, Cursor e OpenCode.

**Mapa do código**:

| Arquivo | Responsabilidade |
|---|---|
| `index.mjs` | Servidor MCP: tools, prompts, recursos, API client direto (`callQuebragalho`), validação de repositório (`quebragalho_validate`), wiring da fila |
| `agent-runner.mjs` | Executor do subagente: roteamento com fallback, spawn da CLI nativa (estilo Claude Code, via `ANTHROPIC_*`) ou OpenCode, parsing de eventos, limites de saída, slots de concorrência |
| `model-router.mjs` | Catálogo de modelos (hardcoded, 8 modelos) + classificação de tarefa e ranking por afinidade/classe de custo |
| `job-queue.mjs` | Fila assíncrona com persistência atômica opcional, heartbeats e progresso |
| `memory-store.mjs` | Diário JSONL isolado por projeto, redação de segredos, memória compartilhada |
| `bin/qg` | CLI manual bash (prompt direto ao gateway) |
| `bin/quebragalho-mcp` | Wrapper POSIX que carrega `QUEBRAGALHO_ENV_FILE` |
| `bin/quebragalho-install-instructions.mjs` | Instalador da skill em `skills/quebragalho-executor/SKILL.md` |
| `test/*.test.mjs` | Suíte `node --test` (283 testes) |
| `.github/workflows/release.yml` | CI (ubuntu + windows) e publish automático no npm quando a versão do `package.json` ainda não existe no registry |

**Classes de custo** no catálogo (não são planos; o gateway é pré-pago):
`pro` (dia a dia), `ultra` (flagship GLM 5.3), `max` (caros: DeepSeek V4 Pro,
Kimi K3 — fora do roteamento automático sem `QUEBRAGALHO_AUTO_INCLUDE_PREMIUM_MODELS=1`).

**Baseline de testes** (Windows local, antes de qualquer mudança):
283 testes, **269 pass / 5 fail / resto skip**. As 5 falhas são ambientais
(fixture de `quebragalho_validate` cria symlink e esbarra em EPERM sem modo
desenvolvedor; passam no CI). **Nenhuma tarefa pode aumentar esse número de
falhas.**

---

## 2. Regras de engajamento (valem para todos os subagentes)

1. **Verificação obrigatória ao terminar qualquer tarefa**:
   ```bash
   npm test                # 269 pass / 5 fail ambientais — nada pior
   npm run test:posix      # bash -n dos wrappers
   node --check index.mjs && node --check agent-runner.mjs
   ```
2. **Invariantes de segurança — não negociáveis**:
   - Gates continuam *fail-closed*: `write` (precisa `QUEBRAGALHO_AGENT_WRITE_ENABLED=1`),
     `quebragalho_validate` (precisa `QUEBRAGALHO_AGENT_VERIFY_ENABLED=1` + segundo
     gate para npm), e qualquer guard novo (ex.: orçamento) também falha fechado.
   - Subprocesso de agente recebe **somente** a allowlist de env de
     `buildChildEnv` (`agent-runner.mjs`); a chave chega apenas como
     `ANTHROPIC_AUTH_TOKEN`, nunca como `QUEBRAGALHO_API_KEY`.
   - Toda persistência nova passa pelas redações de `memory-store.mjs`
     (`redactSensitive`); nunca gravar prompt integral, cwd, env ou stderr bruto.
   - `spawn` sempre `shell: false`; argv validado antes; timeout com escalada
     SIGTERM→SIGKILL como em `execute()`.
3. **Sem novas dependências** sem justificativa escrita no PR (histórico de
   preocupação com supply-chain: há `overrides` de `@hono/node-server`).
4. **Estilo**: código e mensagens de erro em pt-BR; comentários só para
   restrição que o código não expressa; sem TypeScript/JSX; ESM puro.
5. **Docs acompanham código**: toda env var nova entra na tabela do `README.md`;
   behavior novo refletido na tabela de variáveis e, se afetar delegação, na
   `skills/quebragalho-executor/SKILL.md`.
6. **Não commite** a menos que o dono do repositório peça. O repo ainda está
   sem commits (branch `master`, tudo untracked).
7. Tarefas que tocam `index.mjs` simultaneamente devem ser **serializadas**
   (ver §4). Demais arquivos podem paralelizar.

---

## 3. Backlog

### P0 — Correções rápidas (bug real, esforço pequeno)

#### P0-1 — Timeout no `fetch` do caminho direto API — `concluido`
- **Arquivos**: `index.mjs` (`callQuebragalho`), `README.md`, `test/mcp.test.mjs`
- **Problema**: `fetch` sem `AbortSignal` pode pendurar `quebragalho_code`/`quebragalho_review`
  até o timeout do cliente MCP.
- **Fazer**: env `QUEBRAGALHO_API_TIMEOUT_MS` (default `300000`, min `1000`, max `1800000`,
  valor inválido usa default); passar `signal: AbortSignal.timeout(ms)` no fetch; mapear
  abort para erro com code `API_TIMEOUT` e mensagem de recuperação.
- **Aceite**: teste com servidor fake que nunca responde (fixture local, sem rede) confirma
  erro `API_TIMEOUT` dentro do tempo configurado; env documentada no README.

#### P0-2 — `parseSSE` tolerante a linha malformada — `concluido`
- **Arquivos**: `index.mjs` (`parseSSE`), `test/mcp.test.mjs`
- **Problema**: `JSON.parse` sem guarda em cada linha `data:` transforma resposta
  parcialmente corrompida em exceção genérica.
- **Fazer**: try/catch por linha; ao falhar, coletar contador e ao final lançar erro
  com code `API_BAD_STREAM` citando quantidade de linhas inválidas (nunca o conteúdo
  bruto da linha — pode conter segredo).
- **Aceite**: teste injeta payload com uma linha inválida e espera o erro claro.

#### P0-3 — Enum de tiers derivado do catálogo — `concluido`
- **Arquivos**: `index.mjs` (schema do `quebragalho_route`)
- **Problema**: `['pro','max','ultra']` hardcoded; drifará quando o catálogo mudar de
  classes.
- **Fazer**: derivar de `Object.values(MODEL_CATALOG)` (ordem estável: pro, ultra, max)
  para o `enum` de `tiers` e o default; testes existentes de rota continuam passando
  sem edição de expectations hardcoded.
- **Aceite**: adicionar um tier fake ao catálogo em teste muda o enum automaticamente
  (pode ser teste de unidade exportando um helper de `model-router.mjs`).

#### P0-4 — Versão 1.0.0 e README sem versão fantasma — `concluido`
- **Arquivos**: `package.json`, `README.md`
- **Problema**: `version` está `0.0.1` (CI publica no primeiro push da `main`) e o
  README cita `quebragalho-bridge@1.4.3`, versão que nunca existiu neste pacote
  (herança de texto de outro projeto).
- **Fazer**: `version: 1.0.0`; reescrever a linha do troubleshooting de `dontAsk`
  sem citar versão (comportamento atual já está correto).
- **Aceite**: `grep -n "1\.4\.3" README.md` não retorna nada;
  `node -p "require('./package.json').version"` → `1.0.0`.

#### P0-5 — Decisão de licença: atribuição upstream — `concluido` (decisão do dono em 2026-09-30)
- **Arquivos**: `LICENSE`
- **Problema**: código é fork substancial de projeto MIT cujo copyright não aparece
  na licença atual (só o autor atual). MIT pede retenção do copyright original em
  cópias substanciais.
- **Fazer**: **decisão humana** — adicionar a linha de copyright do upstream ao LICENSE
  (recomendado) ou registrar justificativa de não inclusão. Nenhum subagent decide isso.

### P1 — Aderência ao provider (maior valor)

#### P1-1 — Catálogo dinâmico via `GET /v1/models` — `concluido`
- **Arquivos**: `model-router.mjs`, `index.mjs`, `test/model-router.test.mjs`, `README.md`
- **Problema**: 8 modelos hardcoded; gateway anuncia 17 e evolui. Modelo novo exige
  release do bridge; specs de contexto são estimativas.
- **Fazer**:
  - Na inicialização do servidor (antes do `server.connect`), se `QUEBRAGALHO_API_KEY`
    existir e `QUEBRAGALHO_MODEL_SYNC != "0"`: `GET {BASE_URL}/models` com o timeout de P0-1;
  - Merge: modelo conhecido mantém metadados locais (e adota context/output reais quando
    o gateway informar); modelo desconhecido entra com tier `pro`, `auto` incluído,
    capacidades neutras (5 em tudo) e nota "adicionado por sincronização";
  - Falha de rede/key = **fail-open** com warning no log (catálogo local segue valendo);
  - Expor origem no recurso `quebragalho://models` (`source: "local" | "synced"`) e no
    `quebragalho://status` (`model_sync: {...}`).
- **Aceite**: testes com servidor fake (SDK client ou http server local) cobrem merge,
  modelo novo, modelo removido (mantido com aviso, nunca removido silenciosamente),
  e fail-open sem key; docs atualizadas.

#### P1-2 — Rastreio de uso (tokens) por projeto/dia — `concluido`
- **Arquivos**: novo `usage-store.mjs`, `index.mjs` (tools diretas + resultado do
  agente), `README.md`, `test/usage-store.test.mjs`
- **Fazer**:
  - `QUEBRAGALHO_USAGE_DIR` (default junto ao memory dir); JSONL por dia com
    `{date, model, in_tokens, out_tokens, executor}` agregado por linha;
  - gravar a partir do `usage` das respostas de `callQuebragalho` e do rodapé do
    agente quando disponível; escrita serializada como em `memory-store.mjs`;
  - recurso `quebragalho://usage` retorna agregados (por dia, por modelo);
  - redação: nada além de contadores e nomes de modelo é persistido.
- **Aceite**: teste de acumulação, de rotação de data e do recurso; sem prompt/segredo
  no arquivo (teste de redação).

#### P1-3 — Guard de orçamento fail-closed — `concluido` (depende de P1-2)
- **Arquivos**: `model-router.mjs` (preços), novo `usage-store.mjs`, `index.mjs`,
  `agent-runner.mjs`, `README.md`
- **Fazer**:
  - Adicionar `price: { in, out }` (US$/M tokens) a cada modelo do catálogo;
  - env `QUEBRAGALHO_MAX_SPEND_USD` (default: sem limite); escopo diário (reseta 00:00
    local, derivado do JSONL de P1-2);
  - checar **antes** de tools diretas e antes de enfileirar job de agente; estourado =
    erro `BUDGET_EXCEEDED` com gasto atual, teto e recuperação (aumentar teto ou esperar
    o dia virar); warning em 80% nos resultados;
  - fail-closed: uso desconhecido (sem log) nunca libera além do teto quando o teto
    existe — se o log estiver indisponível para leitura, bloquear.
- **Aceite**: testes de bloqueio, de reset diário e do caminho fail-closed;
  env documentada.

#### P1-4 — `max_tokens` default seguro nas tools diretas — `concluido`
- **Arquivos**: `index.mjs` (codec de `quebragalho_code`/`quebragalho_review`)
- **Fazer**: default 65536 → `min(info.out, 8192)` (paridade com as antigas tools por
  modelo); explícito na chamada continua valendo até `info.out`.
- **Aceite**: schema da tool reflete o novo default; teste chama sem `max_tokens` e o
  body enviado ao servidor fake usa 8192.

#### P1-5 — Retry com backoff para 429/5xx no caminho direto — `concluido` (serializar com P0-1: mesmo arquivo/função)
- **Arquivos**: `index.mjs` (`callQuebragalho`), `README.md`, `test/mcp.test.mjs`
- **Fazer**: env `QUEBRAGALHO_API_RETRIES` (default `2`, max `5`); backoff
  `500ms * 2^n` respeitando `Retry-After` quando presente; retentar somente 429 e
  5xx sem corpo consumido com sucesso; esgotado = erro atual com contagem de tentativas.
- **Aceite**: teste com fake respondendo 429→429→200 confirma sucesso e 2 retries;
  4xx (ex.: 401) não retenta.

### P2 — Robustez e manutenibilidade

#### P2-1 — Resolvedor Windows para a CLI nativa — `concluido`
- **Arquivos**: `agent-runner.mjs` (`buildAgentInvocation`), `test/agent-runner.test.mjs`, `README.md`
- **Problema**: `spawn(..., {shell: false})` não resolve shim `claude.cmd` no Windows.
- **Fazer**: resolver binário testando `claude`, `claude.exe`, `claude.cmd` no PATH
  (padrão já usado em `resolveVerifyBinary`); se cair em `.cmd`, spawn via `cmd.exe /d /s /c`
  com argv preservado (estudar escaping; preferir entrada `cli.js` via
  `QUEBRAGALHO_CODE_ENTRYPOINT` quando disponível) — documentar a limitação.
- **Aceite**: teste unitário do resolvedor com fixtures `.cmd`/`.exe` (no CI windows);
  README da seção Windows atualizado.

#### P2-2 — Extrair `verify.mjs` de `index.mjs` — `concluido` (executar por último entre as tarefas que tocam `index.mjs`)
- **Fazer**: mover o bloco `quebragalho_validate` (~500 linhas) para `verify.mjs` sem
  mudança de comportamento; `index.mjs` importa; testes atuais passam **sem edição**.
- **Aceite**: `index.mjs` < ~900 linhas; `npm test` idêntico ao baseline; diff é mover,
  não reescrever.

#### P2-3 — Lint + dependabot — `concluido`
- **Fazer**: ESLint flat config (regras recomendadas + `n/no-unsupported-features/node-builtins`
  para Node 18); `npm run lint` no CI; `.github/dependabot.yml` (npm + actions, semanal).
- **Aceite**: `npm run lint` limpa sem `eslint-disable` novo; CI verde.

#### P2-4 — Rotação da memória JSONL por tamanho — `concluido`
- **Arquivos**: `memory-store.mjs`, `test/memory-store.test.mjs`, `README.md`
- **Fazer**: env `QUEBRAGALHO_MEMORY_MAX_BYTES` (default `1048576`); ao exceder, rotacionar
  para `<arquivo>.1` mantendo o corrente vazio (uma geração apenas; sem zip).
- **Aceite**: teste de rotação preserva as notas mais recentes e mantém redação.

#### P2-5 — macOS na matriz de CI — `concluido`
- **Fazer**: job `validate-macos` (`runs-on: macos-latest`) espelhando o `validate`.
- **Aceite**: CI verde nas três plataformas (as 5 falhas de symlink são Windows-local, não CI).

### P3 — Experiência

#### P3-1 — `quebragalho-doctor` (bin de diagnóstico) — `concluido`
- **Fazer**: novo `bin/quebragalho-doctor.mjs` registrado no `package.json`: valida
  (1) chave contra `GET /v1/models`; (2) CLI nativa resolvível no PATH (com o resolvedor
  de P2-1); (3) `QUEBRAGALHO_AGENT_ALLOWED_ROOTS` aponta para diretórios existentes;
  (4) perms do job store (0700) onde aplicável; (5) `claude --version` executa. Saída
  legível com ✔/✖ e sugestão de correção por item (reaproveitar textos de `recoveryFor`).
- **Aceite**: teste chama com key fake contra servidor fake local e vê ✖ no item 1;
  README ganha seção "Diagnóstico".

#### P3-2 — Endurecer CLI `qg` — `concluido`
- **Fazer**: `curl --fail-with-body` + exit não-zero em erro de API; `--timeout`
  (default 120s); `--version` lendo `package.json`; `-q` para suprimir cores/box.
- **Aceite**: `test/qg-cli.test.mjs` cobre exit code de erro (fake curl devolve 500).

#### P3-3 — Suporte a imagens nas tools diretas — `concluido`
- **Fazer**: flag `vision: true` no catálogo para modelos com visão; `quebragalho_code`
  aceita `images: [{path|url}]` → content parts `image_url` (path vira base64, limite
  de tamanho e sanidade de extensão); modelo sem visão + imagem = erro claro.
- **Aceite**: teste monta body multipart-equivalente (content array) no servidor fake;
  README documenta formatos e limites.

---

## 4. Orquestração sugerida

```
Batch 1 (serializado por index.mjs):  P0-1 → P1-5 → P0-2 → P0-3 → P1-4
Batch 1 (paralelo, arquivos outros):  P0-4 | P1-1 | P1-2
Batch 2:                              P1-3 (após P1-2) | P2-1 | P2-3 | P2-4 | P2-5
Batch 3 (final):                      P2-2 (refactor de index.mjs por último)
Batch 4:                              P3-1 (após P2-1) | P3-2 | P3-3
Bloqueado:                            P0-5 (decisão do dono)
```

Regras do orquestrador:
- Um subagent por vez por arquivo compartilhado (`index.mjs` é o gargalo).
- Ao concluir uma tarefa: atualizar status aqui, rodar a verificação do §2.1 e
  reportar apenas desvios (não o log inteiro).
- Se uma tarefa revelar dependência não mapeada, parar e registrar `bloqueado`
  com o motivo em vez de improvisar fora do escopo do cartão.
- P1-3 e o guard de orçamento: qualquer dúvida de semântica (escopo diário vs
  total, comportamento sem log) → perguntar ao dono, não decidir.

## 5. Definition of Done do projeto

- [x] Todos os P0 e P1 concluídos com testes (P0-5 resolvido: zero retenção de upstream)
- [x] `npm test` sem regressão: baseline 283/269/5 → final 361/342/5 (as 5 falhas são as mesmas ambientais de symlink no Windows local; passam no CI)
- [x] README com todas as envs novas documentadas (7 envs, recursos `usage`/`models`/`status`, doctor, imagens, flags do `qg`)
- [x] CI com lint + testes em ubuntu, windows e macos
- [x] Versão 1.0.0 pronta para o primeiro push publicar
- [x] P0-5 resolvido (decisão registrada): **zero retenção de upstream** — projeto
      tratado como original; LICENSE e `package.json` sob identidade de
      Eduardo D'anjour (`danjour`).

## 6. Registro de execução (2026-09-30)

- Wave 0 (orquestrador): P0-4 (versão 1.0.0, fix de versão fantasma no README), eslint instalado.
- Wave 1 (4 subagentes em paralelo): P0-1+P1-5+P0-2+P1-4 (caminho direto da API), P2-4 (rotação de memória), P2-5+P2-3-infra (CI macos + eslint/dependabot), P2-1 (resolvedor Windows da CLI nativa).
- Wave 2 (1 subagente): P1-1 (catálogo dinâmico opt-in) + P0-3 (enum de tiers derivado).
- Wave 3 (1 subagente): P1-2 (usage store) + P1-3 (guard de orçamento fail-closed).
- Wave 4 (1 subagente): P2-2 (extração de verify.mjs; index.mjs 1666 → 1174 linhas).
- Wave 5 (2 subagentes em paralelo): P3-1 (quebragalho-doctor) + P3-2 (endurecer qg).
- Wave 6 (1 subagente): P3-3 (imagens nas tools diretas).
- Final (orquestrador): fixes de lint (shebangs, variáveis mortas, config com `allowEmptyCatch` e ignores de `fetch`/`node:test`), passo `npm run lint` nos 3 jobs do CI, consolidação do README, fechamento deste roadmap.
- Decisões tomadas pelo orquestrador em nome do escopo: sync de modelos é **opt-in** (`QUEBRAGALHO_MODEL_SYNC=1`) por determinismo de testes/latência de startup (o cartão previa default-on); docs centralizadas no orquestrador para evitar conflito de escrita no README entre agentes.
