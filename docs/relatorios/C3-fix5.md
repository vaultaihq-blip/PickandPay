# C3-fix5: o sinal diz se a app está no ecrã, hooks do Ruflo retirados, links de sessão para o ecrã de entrada

São dois commits:
1. **db+app, o sinal "no ecrã".**
   - Migração `supabase/migrations/20261029150000_c3fix5_foreground_heartbeat.sql`, **aplicada** e verificada.
   - Reversão `supabase/rollback/20261029150000_c3fix5_pre_state_and_rollback.sql`, ensaiada.
   - O hook `hooks/useHostTransfer.ts` e este relatório.
2. **app, à parte: links de sessão para o ecrã de entrada da R7.**
   - `app/+native-intent.tsx` (novo), `lib/deeplink.ts` e `components/dev/DevPanel.tsx`.
   - O `app/(app)/session/[id].tsx` foi apagado.

Os hooks do Ruflo saíram do `.claude/settings.json`. Esse ficheiro está fora do git, por isso não aparece em nenhum commit.

## 1. O sinal diz se a app está no ecrã

### Regras

| Situação | Conta |
|---|---|
| Há algo à espera do anfitrião (pedido de cancelar, ou todos com Done) | 15 s **sem a app no ecrã**, a partir do mais recente entre a última vez que o anfitrião teve a app no ecrã e o início da espera |
| Nada à espera | 5 min **sem nenhum sinal**; os sinais enviados em segundo plano também contam |

- **Android, telemóvel no bolso:** a app continua a enviar sinal, mas sem estar no ecrã. Com algo à espera, troca 15 s depois; sem nada à espera, o anfitrião mantém o papel enquanto o sistema deixar a app correr.
- **iPhone, ecrã bloqueado:** a app é suspensa e deixa de haver sinal. É igual ao Android na regra dos 15 s, e na dos 5 min troca 5 min depois.
- **Quem pode receber o papel:** só alguém que teve a app **no ecrã** nos últimos 15 s, porque tem de ver o pop-up. Uma pessoa com a app em segundo plano não recebe o papel, mesmo que tenha chegado primeiro.

### Servidor (aplicado)

- **`session_presence.last_foreground_at`:** a hora do último sinal enviado com a app no ecrã. Foi preenchida com `last_seen_at` nas linhas que já existiam.
- **`session_heartbeat(sessão, p_foreground DEFAULT true)`:** substitui a versão de um só argumento.
  - Uma versão da app que não envie o valor conta como "no ecrã", como antes, por isso uma app antiga continua a funcionar.
  - Um sinal em segundo plano atualiza `last_seen_at` e não mexe em `last_foreground_at`.
- **`host_transfer_check`:** a regra dos 15 s usa `last_foreground_at` e a dos 5 min usa `last_seen_at`.
- **`host_snapshot`:** devolve também `host_off_screen_ms`.
- **`next_host_candidate`:** "recente" quer dizer "com a app no ecrã há menos de 15 s".
- **Sem alterações:** o `transfer_host` e o `leave_as_host`. Usam as duas funções acima e a chamada a `transfer_host` não conta como "no ecrã".

### App

- **`useHostTransfer`:**
  - envia `p_foreground: AppState.currentState === "active"`;
  - manda um sinal logo que a app volta ao ecrã;
  - o log diz `[host] heartbeat ok (…, on screen)` ou `(…, background)`, uma vez por mudança.
- **O pedido de troca no log passa a ser:** `[host] host <A> silent for N ms, off screen for M ms (host_needed, waiting: …) — asking the server for a new host`.

## 2. Hooks do Ruflo

- **Tirei o bloco `hooks` inteiro do `.claude/settings.json`:** 10 eventos, de `PreToolUse` a `Notification`. Ficou tudo o resto: `statusLine`, `permissions`, `env` e `claudeFlow`.
- **Cópia do ficheiro como estava:** `C:\Users\ricar\AppData\Local\Temp\claude\C--Users-ricar-Documents-VaultAI-PickandPay\3d2e08f2-d972-40d6-bee4-55d169123545\scratchpad\fix5\settings.json.before-c3fix5`.
- **Prova:** os 2 últimos ficheiros-lixo nasceram às 13:50:03, antes de tirar os hooks (às 13:51:34). Já os apaguei.
  - Depois disso escrevi ficheiros com `=>` e `->` (13:52:41 e 13:52:52) e não apareceu nenhum.
  - A partir da próxima sessão também deixa de aparecer o cabeçalho "Microsoft Windows [Version …]" na saída dos hooks.

### O que o `ruflo init` deixou mais no projeto (não mexi)

| O quê | Onde | No git? | Nota |
|---|---|---|---|
| Servidor MCP `ruflo` | `~/.claude.json`, entrada deste projeto (`npx ruflo@latest mcp start`) | não (é seu, global) | **É este que falha ao ligar em cada sessão** ("ruflo CONNECT_TIMEOUT"). Há outra igual para `VaultAI/splitmate`. |
| Servidores MCP `ruflo`, `ruv-swarm`, `flow-nexus` | `.mcp.json` | não (`.gitignore`) | Desligados em `.claude/settings.local.json` (`disabledMcpjsonServers`). Usam `cmd /c npx …`, a mesma forma dos hooks. |
| `statusLine` | `.claude/settings.json` | não | `node -e "…"` que carrega `.claude/helpers/statusline.cjs`. |
| `env`, `permissions.allow`, `claudeFlow` | `.claude/settings.json` | não | Variáveis `CLAUDE_FLOW_*` e `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; autorizações para `npx claude-flow*`, `node .claude/*` e `mcp__claude-flow__*`; o bloco de configuração do Ruflo (`"claudeFlow": { "version": "3.0.0" … }`). |
| Ajudantes | `.claude/helpers/` (41 ficheiros) | não | `hook-handler.cjs`, `statusline.cjs`, `auto-memory-hook.mjs` e scripts `.sh`. |
| Agentes e comandos | `.claude/agents/` (23 pastas), `.claude/commands/` | não | São os tipos de agente (`sparc-*`, `swarm-*`, `flow-nexus-*`…) e os comandos `/sparc:*`, `/hooks:*`, `/github:*`… que aparecem nas sessões. |
| Estado do Ruflo | `.claude-flow/` (config, dados, logs, métricas) | não (`.gitignore`) | 33 KB. |
| Configuração para o Codex | `AGENTS.md`, `.agents/skills/` (74 skills), `.codex/config.toml`, `.codex/hooks.json` | não (por seguir) | O `.codex/hooks.json` tem os mesmos hooks com `cmd /c`. |
| Configuração para o Cursor | `.cursor/rules/` (5 ficheiros `.mdc`) | não (por seguir) | |
| Texto no `CLAUDE.md` do projeto | `CLAUDE.md` | **sim** | Tudo menos as secções "Windows shell", "Tarefas em segundo plano" e "parse-receipt" é texto do Ruflo: swarm, agentes, memória e a ordem de correr `npx @claude-flow/cli` antes de cada tarefa. |
| Texto no `CLAUDE.md` global | `~/.claude/CLAUDE.md` | não | "Ruflo Integration (auto-generated by ruflo init)". |

Se quiser limpar mais, a ordem que proponho é esta:
1. Tirar o servidor `ruflo` do `~/.claude.json` neste projeto, que é o que dá o erro em cada sessão.
2. Apagar `.mcp.json` e `.codex/hooks.json`.
3. Tirar `statusLine`, `env`, `permissions` e `claudeFlow` do `.claude/settings.json`.
4. Decidir se quer manter os agentes e comandos do `.claude/`.
5. Limpar as secções do Ruflo nos dois `CLAUDE.md`.

Diga quais e eu faço.

## 3. Links de sessão para o ecrã de entrada da R7 (commit à parte)

- **`app/+native-intent.tsx` (novo):** todos os links que chegam de fora da app passam por aqui antes do router. Isto inclui o QR lido pela câmara, `pickandpay://session/<id>` e, na Fase 1, `https://…/session/<id>`.
  - Um caminho `session/<id>` é reescrito para `/session/join?sessionId=<id>`.
  - É o ecrã de entrada, que pergunta ao servidor (`join_preview`) o que mostrar.
  - O log é `[deeplink] session link → entry screen (<id>)`.
- **`lib/deeplink.ts`:**
  - `handleDeepLink` já não abre o ecrã de entrada para links de sessão, porque o router já o abriu e ficariam dois. Só trata o `ref=` de convite.
  - `parseDeepLink` ignora `session/join`.
- **DevPanel:** "sessão sem fatura" vai para o scan, como o "Start split" (antes ia para o ecrã antigo).
- **Apagado:** `app/(app)/session/[id].tsx` (2242 linhas). Nenhuma outra rota apontava para ele.
- **Testado:** o redirecionamento foi verificado contra 8 links: sessão por esquema, com `ref`, `https`, caminho, `join` já reescrito, convite, lobby e retorno do login. Os 8 dão o resultado certo. `tsc` sem erros.
- **Ficou sem uso** e não apaguei: `buildSessionShareText` em `lib/deeplink.ts`, que só era usado pelo ecrã apagado.

## Verificação

- **Ensaio antes de aplicar** (transações revertidas):
  - a bateria nova do C3-fix5, com 19 verificações, deu tudo como esperado:
    - `F1`: Android bloqueado (sinal há 1 s, fora do ecrã há 60 s) com todos em Done dá `host_needed`.
    - `F2`: com a app no ecrã há 10 s, não troca.
    - `F3`: troca, e o papel vai para o C (no ecrã) e não para o B (em segundo plano).
    - `F4`: no ecrã de pagamentos, com sinal em segundo plano e 10 min fora do ecrã, não troca.
    - `F5`: 5:01 sem sinal dá `host_idle`.
    - `F6`/`F7`: sem ninguém no ecrã dá `no_one_present`, mesmo depois de um sinal em segundo plano. `F8`: depois de um sinal no ecrã, troca.
    - `F9`: um sinal sem o valor conta como "no ecrã".
    - `G4`/`G5`: só existe a assinatura nova, chamável por `authenticated` e não por `anon`.
  - a bateria do C3-fix4 (95 verificações) deu o mesmo de antes, salvo os identificadores aleatórios dos utilizadores de teste. Não há regressões.
- **Reversão:** ensaiada com migração e reversão, comparadas em 3 pontos (6 funções com definição e permissões, colunas, linhas de presença). Resultado: **0 diferenças**.
- **Depois de aplicar:** as duas baterias em produção deram o mesmo que no ensaio.
- **Estado após aplicar:** migração registada, só a assinatura nova do `session_heartbeat`, 0 utilizadores de teste.
- **App:** `tsc` sem erros e testes do recibo 69/69.

## Notas

- **Regra do CLAUDE.md:** voltei a escrever `node -e ""` num comando, sem efeito, contra a regra. Os scripts deste trabalho estão em ficheiro.
- **Ordem de atualização:** a app nova precisa da migração (já aplicada). Uma app antiga continua a funcionar com o servidor novo e conta sempre como "no ecrã".

## Testes novos e alterados

**45 e 47, a repetir com o A em Android e sem modo avião** (é isto que o C3-fix5 muda):
- **45:** depois de finalizar, o A bloqueia o Android 2 minutos.
  - Não há troca.
  - O log do A mostra `heartbeat ok (…, background)` e, ao desbloquear, `(…, on screen)`.
  - SQL: `select user_id, now() - last_seen_at, now() - last_foreground_at from session_presence where session_id = '<id>'`. Para o A, a primeira coluna fica perto de 0 e a segunda sobe.
- **47:** antes de finalizar, o A bloqueia o Android; o B e o C fazem Done.
  - Cerca de 15 a 18 s depois do último Done, o B vê "… Todos escolheram os itens. Podes finalizar.".
  - Log no B ou no C: `off screen for 1xxxx ms (host_needed, waiting: all_picked)`.

**51 (links):** com uma sessão aberta no A:
1. No B, com a app instalada e com sessão iniciada, ler o QR da sessão com a **câmara** do telemóvel, fora da app, e abrir o link.
2. A app abre o ecrã de entrada da R7: confirmação, rejoin, sem créditos, terminada ou cheia, conforme o caso.
   - Logs: `[deeplink] session link → entry screen (<id>)` e `[join] join_preview: … `.
3. Repetir com a app fechada e com a app já aberta noutro ecrã. Nos dois casos aparece **um** só ecrã de entrada, e o Voltar leva ao ecrã anterior, não a um segundo ecrã de entrada.
4. No DevPanel, "sessão sem fatura" abre o scan.

## Onde recomeçar

1. O 48, o 44 e o 47 (agora sem modo avião, com o A em Android).
2. O 51, aproveitando a mesma sessão.
3. O 50 e depois o 45 (A em Android) e o 46.
4. O 49 está feito em SQL; o 43 só se houver 9 pessoas.
5. O resto da lista continua onde estava.


## 4. Limpeza do Ruflo (depois da aprovação do C3-fix5)

### Cópia de segurança

- **Onde está:** `C:\Users\ricar\Documents\VaultAI\_backup_ruflo_2026-10-29\` (fora do projeto), com 324 ficheiros.
- **`project\`:** `.claude\`, `.codex\`, `.cursor\`, `.agents\`, `.claude-flow\`, `.mcp.json`, `AGENTS.md` e `CLAUDE.md`.
- **`home\`:** o `CLAUDE.md` global e uma cópia do `~/.claude.json` de antes da remoção do servidor. Esta cópia tem as suas configurações e possíveis tokens: não a partilhe.

### O que foi feito, pela ordem pedida

1. **Servidor MCP `ruflo` deste projeto:** removido com `claude mcp remove ruflo -s local`. O comando respondeu "Removed MCP server ruflo from local config" e alterou o `~/.claude.json` só na entrada do PickandPay.
   - O `.mcp.json` (`ruflo`, `ruv-swarm`, `flow-nexus`) foi apagado.
2. **`.codex/hooks.json`:** apagado.
3. **`.claude/helpers/`, `.claude/agents/`, `.claude/commands/` e `.claude-flow/`:** apagados. Antes de apagar confirmei que eram só do Ruflo:
   - todos os ficheiros são de 19-05-2026, entre as 14:41 e as 14:43, que é a altura do `ruflo init`;
   - os 4 ficheiros sem palavras do Ruflo são dois READMEs que dizem "Commands for … in Claude Flow", `checkpoint-manager.sh` e `github-safe.js`, do mesmo conjunto e do mesmo minuto.
4. **`.claude/settings.json`.** Antes de mexer tinha:
   - `statusLine`: `node -e "…require('.claude/helpers/statusline.cjs')"`;
   - `permissions.allow`: `Bash(npx @claude-flow*)`, `Bash(npx claude-flow*)`, `Bash(node .claude/*)`, `mcp__claude-flow__:*`;
   - `permissions.deny`: `Read(./.env)`, `Read(./.env.*)`;
   - `env`: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, `CLAUDE_FLOW_V3_ENABLED=true`, `CLAUDE_FLOW_HOOKS_ENABLED=true`;
   - `claudeFlow`: o bloco de configuração do Ruflo (versão, preferências de modelo, equipas de agentes, swarm, memória, daemon, aprendizagem, ADR, DDD, segurança).
   
   Saíram o `statusLine`, as 4 autorizações do claude-flow, as duas variáveis `CLAUDE_FLOW_*` e o `claudeFlow`. Ficaram:
   - o bloqueio de leitura dos `.env`, que protege as chaves;
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Foi o Ruflo que o pôs, mas é uma opção do próprio Claude Code (equipas de agentes) e não do Ruflo; se não a usa, pode sair.
5. **Os `CLAUDE.md` e o `AGENTS.md`:**
   - **`CLAUDE.md` do projeto:** passou de 235 para 46 linhas. Ficaram as suas três secções ("Windows shell", "Tarefas em segundo plano", "parse-receipt: flags de funcionalidade") e a lista "Rules".
     - Saíram o título "Ruflo — Claude Code Configuration" (agora "Pick&Pay — Claude Code") e tudo a partir de "Agent Comms": comunicação entre agentes, swarm, memória, agentes, "Build & Test", referência do CLI e setup.
     - O "Build & Test" mandava correr `npm run build && npm test`, que não existem neste projeto. Os comandos reais são `npx tsc --noEmit` e `npm run test:receipt`.
   - **`AGENTS.md`:** passou de 201 para 12 linhas. Era todo o template do Ruflo para o Codex; ficou só a lista "Rules", com o título "Pick&Pay — Codex".
   - **`CLAUDE.md` global:** tinha só o bloco "Ruflo Integration (auto-generated by ruflo init)" e ficou vazio (0 bytes). Pode apagá-lo.
   - **A lista "Rules"** veio com o template do Ruflo (é igual no `AGENTS.md`), mas são regras gerais que não falam do Ruflo: não fazer commit de segredos, não gravar ficheiros na raiz, ficheiros com menos de 500 linhas, entre outras. Mantive-a. Se a quiser fora, é um corte de 11 linhas em cada ficheiro.
6. **`.agents/skills/`:** apagado. As 74 skills são cópias migradas dos comandos do Ruflo; cada uma diz "Migrated source command …". As únicas menções a Supabase são o modo genérico `supabase-admin` do Ruflo. A pasta `.agents/` ficou vazia e também a apaguei.
   - **`.cursor/rules/` não foi apagado, porque não é do Ruflo.** São 5 regras escritas para o Pick&Pay, de 17-09-2026, com o contexto do projeto, a organização dos ficheiros, os padrões Supabase, OCR e RevenueCat, e o git. Algumas estão desatualizadas: falam em NativeWind e Tailwind e em `npm run lint` antes de cada commit. Diga se as quer manter, atualizar ou apagar.
7. **`buildSessionShareText`:** apagado de `lib/deeplink.ts`.

### De onde vem a regra que proíbe `node -e`

- **Não é do Ruflo:** não está em nenhum ficheiro do Ruflo da cópia de segurança, e está em português, enquanto todo o texto do Ruflo é em inglês.
- **Já estava no `CLAUDE.md`** no único commit deste ficheiro (`c5cc4ee`, 24-09-2026, FIX 42), juntamente com as outras duas secções em português.
- **Não consigo dizer quem a escreveu:** os históricos de sessões do Claude Code deste projeto só começam a 06-10-2026.
- **A causa que a regra dá estava errada.** A regra diz que o `cmd.exe` reinterpreta os argumentos de `node -e` e cria ficheiros-lixo. Os ficheiros-lixo vinham dos hooks do Ruflo: o `cmd` interativo executava o JSON de cada ferramenta, e qualquer comando ou edição com `>` deixava lixo, fosse `node -e` ou não.
- **Sem os hooks, a causa desapareceu.** A regra continua no `CLAUDE.md`, porque não é do Ruflo, e continua a ser boa prática (scripts em ficheiro ficam registados). Se quiser, tiro a frase sobre a causa ou a regra toda.

### O que ficou nos ficheiros de configuração

- `.claude/settings.json`:
  ```json
  {
    "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] },
    "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }
  }
  ```
- **`.claude/settings.local.json`** (não mexi, porque não estava na lista):
  - as suas autorizações (`git status`, `npx tsc`, `npx eslint`, `npm outdated`, `git check-ignore`, e um `node -e` que conta dependências);
  - `disabledMcpjsonServers: ["ruflo", "ruv-swarm", "flow-nexus"]`, que deixou de ter efeito porque o `.mcp.json` já não existe. Pode sair.
- **`.claude/`:** ficou com `settings.json`, `settings.local.json`, `scheduled_tasks.lock` (do Claude Code) e uma pasta `skills/` vazia.
- **`.codex/config.toml`** (não mexi, porque não estava na lista): define `CLAUDE_FLOW_V3_ENABLED`, `CLAUDE_FLOW_HOOKS_ENABLED` e `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` para o Codex. É do Ruflo; se não usa o Codex, a pasta `.codex/` inteira pode ir.
- **`~/.claude.json`:** já não tem nenhum servidor MCP para este projeto. Ainda tem o `ruflo` no projeto `VaultAI/splitmate`, onde não mexi.
- **`CLAUDE.md` (46 linhas), `AGENTS.md` (12 linhas) e `~/.claude/CLAUDE.md` (vazio):** ver o ponto 5.

### Confirmação: sessão nova sem o erro do Ruflo

- **`claude mcp list` neste projeto:** só aparecem `claude.ai Claude Docs` e `claude.ai Google Drive`, ambos ✔ Connected. Não há `ruflo`.
- **Sessão nova a sério** (`claude -p "Responde apenas: ok" --debug`, 29-10 às 14:00): respondeu "ok".
  - O registo (`~/.claude/debug/ca8d3b0f-….txt`, 222 linhas) tem **0** menções a `ruflo`, `claude-flow`, `ruv-swarm` ou `flow-nexus`.
  - Só carregou os 2 conectores claude.ai, sem erros de MCP.
  - Não correu nenhum hook do `settings.json`; os únicos módulos de hooks são os internos do Claude Code.
- **Esta sessão ainda mostra o aviso**, porque arrancou com a configuração antiga. A próxima sessão já não o deve mostrar.
- **App:** `tsc` sem erros, testes do recibo 69/69 e 0 ficheiros-lixo na raiz.
