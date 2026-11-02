# Correções do guião v2

Um commit por ponto, pela ordem combinada:
A1 → A2 → A3 → A4 → B2 → A5 → B1 → C3 → C1 → C2 → A6.

Contas: A = vault.ai.hq@gmail.com, B = ricardo.costa.rjgc@gmail.com,
C = teste@pickandpay.com.

---

## A1 — fechar a app não é "saiu"

**Estado: aplicado em produção a 2026-10-31.** A migração é
`20261030100000_a1_left_only_on_purpose.sql`; a reversão está em
`supabase/rollback/20261030100000_a1_pre_state_and_rollback.sql`.

### Causa

Não ficou provada. A base de dados não guardava o histórico dos estados, e não
havia logs do teste. Por isso a correção fecha todos os caminhos e passa a
registar cada mudança.

### O que mudou

**No servidor:**
- **Registo de estados.** A tabela `session_participant_status_log` guarda
  cada mudança de `status`: de onde para onde, quem a fez e por que via. As
  apps não a podem ler.
- **Só se sai com um botão.** Só `leave_session` (o botão Sair do
  participante) e `leave_as_host` ("Sair e passar") podem gravar `left`.
  Quando um utilizador tenta escrever `left` diretamente, o servidor recusa com
  `LEAVE_VIA_RPC`. Os processos do servidor, como a expiração, continuam a
  poder gravá-lo.
- **`leave_session`** responde `left`, `already_left`, `closed` (numa sessão
  fechada não grava nada) ou `not_in_session`. O anfitrião não o pode usar.

**Na app:**
- Os três botões Sair (lobby, botão do lobby, seleção) chamam
  `lib/leaveSession.ts`.
- **Rejoin**, pelo QR e pelo aviso do ecrã inicial: quem está `joined`,
  `selecting` ou `items_picked` mantém o estado, incluindo os itens já
  escolhidos. Só `left` e `pending` voltam a `joined`.
- **Releitura do lobby:** a lista de quem saiu é substituída pela do servidor,
  em vez de lhe ser acrescentada. O lobby volta a ler quando a app regressa ao
  primeiro plano. Qualquer regresso à sessão tira a pessoa de "saiu".

### Verificado em produção

Tudo foi feito numa transação anulada no fim, com utilizadores de teste:
- escrever `left` diretamente → recusado;
- Sair → `left` (antes `items_picked`); repetir → `already_left`;
- `left` → `pending` continua a funcionar;
- "Sair e passar" passa a vez e fica registado;
- numa sessão fechada, Sair não grava nada;
- `anon` não chega a nada disto;
- nenhuma linha real foi tocada.

### Atenção

Uma app ou um site antigos que carreguem em Sair recebem a recusa
`LEAVE_VIA_RPC` no modal. É preciso recarregar a app e publicar a nova `dist`
no Netlify.

### Teste A1 (dois ou três aparelhos)

1. **A** cria a sessão e lê a fatura. **B** e **C** entram pelo código.
2. **B** escolhe itens e carrega em Concluir.
   - Log de B: `[join] ...`; depois, no lobby, `items_picked`.
3. **B** fecha a app (tira-a dos recentes).
   - Em A e C, B aparece "desligado", **não** "saiu".
4. **B** abre a app → aviso no ecrã inicial → Voltar.
   - Log de B: `[home] rejoin: status kept (items_picked)`.
   - Os itens de B continuam escolhidos.
   - Em A e C, B volta a estar ligado.
5. **C** põe a app em segundo plano 1 minuto e volta.
   - Log de C: `[session-lobby] reread: N people, 0 left`.
6. **C** carrega em Sair.
   - Log de C: `[leave-session] lobby: leave button: left (was joined)`.
   - Em A, C aparece "saiu".
7. **C** volta a entrar pelo código.
   - Log de C: `[join] ...pending → joined` ou `left → joined`.
   - Em A, C deixa de estar em "saiu" (a lista é relida).
8. **A** carrega em "Sair e passar".
   - A vez passa para B, e A fica `left`.

Se algum passo falhar, o registo de estados no servidor mostra exatamente quem
escreveu o quê. Eu leio-o.

---

## Pedidos juntados a pontos da fila

**C1 (2026-11-01).** Depois de um scan validado, o anfitrião pode voltar atrás
até ao ecrã de escolher foto, galeria ou manual (botão voltar, gesto do Android
ou qualquer outro caminho). Antes de lá chegar aparece "Vais fazer o scan de uma
nova fatura? O crédito usado no scan anterior não é devolvido.", com duas
opções:
- **Continuar com esta fatura**;
- **Fazer novo scan**, que só então volta ao ecrã de escolha.

**Lobby, "Done" (2026-11-02, para a fila).** Quem aceita uma partilha no lobby
sem ter feito Done não pode aparecer como "Done". Aceitar só muda os itens, e
não o estado. Hoje o lobby trata como confirmada qualquer pessoa `joined` com
itens.

---

## Scan que voltou ao menu sem aviso (2026-11-02, 00:44 UTC, conta A)

**O que aconteceu**
- A foto do Oligark foi escolhida na galeria e preparada: `[scan] photo taken
  1848x4000`, `resized 1478x3200, 278 KB`, `base64 370 KB`.
- O ecrã de pré-visualização abriu.
- Antes de se tocar em "Scan" não há `[scan] sending`. O Expo Go recarregou a
  app (`Android Bundled … (1 module)`, seguido do arranque normal), e a app
  abriu no ecrã inicial.

**No servidor**
- A sessão `f2ea8fc9` ficou sem fatura (`draft`).
- Não houve nenhum pedido de OCR, por isso não foi gasto crédito: a conta A
  continua com 2.
- Não há unidades nem escritas recusadas: a R12 não entrou nisto.
- A sessão foi depois terminada pelo anfitrião no lobby (`host_ended`).

**A causa do recarregamento** não está nos logs:
- não veio do código da app (não há nenhuma chamada de reload);
- não veio de ficheiros alterados (o último foi às 00:40);
- não veio do servidor.

É o Expo Go, ou o Android, a reiniciar a app no telemóvel. Numa build de
produção, o equivalente seria o sistema fechar a app.

**O que estava errado:** o aviso "O scan anterior não terminou" existe para
isto, mas o ecrã de pré-visualização apagava a marca logo ao abrir. Por isso a
app voltou ao início sem dizer nada.

**Correção**
- O ecrã de pré-visualização marca o passo `preview` e só o apaga quando se
  sai dele, ou quando o scan termina.
- Se a app reiniciar nesse ponto, o arranque seguinte mostra: "A app foi
  reiniciada antes de a foto ser enviada. Não foi gasto nenhum crédito. Faz o
  scan outra vez." (nas 5 línguas).
- Log: `[scan] the previous scan did not finish (stopped at: preview)`.

---

## O aviso de rejoin de uma sessão já terminada (2026-11-02)

**De onde vinha**
- O log mostra `[home] rejoin: status kept (selecting)` (linha 1601), e logo a
  seguir o heartbeat responde `status closed` e o Sair responde `closed`. O
  aviso ofereceu uma sessão que já estava fechada (`fa2ae2c9`, terminada pelo
  anfitrião às 01:41:31).
- O servidor está certo: `my_rejoinable_session` exclui as sessões `closed` e
  as expiradas.
- O problema estava no aparelho:
  - o ecrã inicial perguntava ao servidor uma só vez e guardava a resposta;
  - quando o anfitrião terminou a sessão depois disso, o aviso ficou;
  - tocar nele entrava numa sessão fechada.
- Não é a sessão guardada no disco: a sessão não fica gravada entre arranques.
  Fica em memória enquanto a app está em segundo plano.

**Correção** (`app/(app)/index.tsx`)
- O aviso pergunta ao servidor sempre que o ecrã inicial aparece, e quando a
  app volta ao primeiro plano.
- Se o aparelho ainda tiver em memória uma sessão que o servidor diz estar
  fechada, ela é apagada: `[home] session … is closed on the server —
  dropped from memory`.
- Os telemóveis que recebem o aviso de fecho já a apagavam
  (`useSessionMonitor`). Quem estava em segundo plano apaga-a ao voltar.
- **Ao tocar no aviso**, a app confirma primeiro com o servidor. Se a sessão
  já não estiver aberta, aparece "Sessão terminada — Esta sessão já
  terminou." e o aviso desaparece (`[home] rejoin: … is no longer open —
  banner removed`).
- **Sem rede**, a confirmação falha com a mensagem de erro, que fica até se
  fechar. Nunca há um ecrã partido.

**Teste**
1. A cria a sessão, e B entra.
2. B põe a app em segundo plano, sem a fechar.
3. A termina a sessão.
4. B volta à app.
   - O aviso de rejoin não aparece.
   - Se o B ainda vir o aviso e tocar, aparece "Esta sessão já terminou".

## D.7 para este caso: sessão terminada ou inexistente nunca deixa um ecrã sem saída (2026-11-02)

**O que falhou no teste 1**
- O B (conta C, `70abb821`) estava no lobby da sessão `511bea98` com a app em
  segundo plano. O A terminou-a às `[end-session] … closed (verified)`.
- Enquanto o B estava em segundo plano, o Android/Expo Go reiniciou a app
  (`[root] User: 70abb821…` com arranque do zero). A app voltou a abrir
  **no ecrã do lobby**, mas sem nada em memória.
- O lobby sem sessão mostrava só "Sessão não encontrada.", sem botões.
- O Voltar abria o diálogo de sair do participante ("A fatura já foi
  confirmada. Voltar atrás irá sair da sessão."), que parecia o do anfitrião.
- O "Sair" não fazia nada: a função de sair começava com `if (!session)
  return`.
- O `useSessionMonitor` só ouvia o evento de fecho pelo realtime, e um
  telemóvel em segundo plano perde esse evento.

**Servidor** (`20261102150000_d7_closed_reason.sql`, aplicado em produção)
- `session_closures` é só do servidor. A resposta `closed` do `join_preview`
  passa a trazer `closed_reason`:
  - `host` — o anfitrião terminou (`host_ended`);
  - `inactive` — expirou (qualquer regra, também a expiração vista na
    leitura antes do job a fechar) ou foi fechada pela limpeza (`cleanup`);
  - `ended` — outro fecho.
- O motivo só vai para quem tem linha na sessão, ou é o anfitrião ou o
  anfitrião original. Para os outros, a resposta fica igual (R3/R7).
- Nada mais muda no `join_preview`.
- **Ensaio** (com BEGIN e ROLLBACK, contra os dados reais): 7 casos.
  - Participante, anfitrião e estranho numa sessão terminada pelo anfitrião.
  - Uma sessão `cleanup` e uma `expired_no_receipt`.
  - Uma sessão aberta e uma inexistente.
  - Só muda o campo novo, e só para quem estava na sessão. A reversão repõe a
    definição exatamente.
- **Depois de aplicar**: os mesmos 7 casos em produção, 0 diferenças.
- **Reversão**: `supabase/rollback/20261102150000_d7_pre_state_and_rollback.sql`
  (a definição lida de produção antes da mudança).

**App**
- `lib/sessionGone.ts`:
  - pergunta ao servidor o estado da sessão (limite de 10 s);
  - quando a sessão acabou ou não existe, vai direto para o ecrã inicial e
    mostra um aviso só com OK:
    - "Esta sessão foi terminada pelo anfitrião.";
    - "Esta sessão terminou por inatividade.";
    - "Esta sessão já terminou." (outro fecho);
    - "Sessão não encontrada. Confirma com o anfitrião.";
  - um só aviso por sessão, mesmo que vários ecrãs o vejam ao mesmo tempo;
  - quem terminou a sessão neste telemóvel não recebe aviso.
- `hooks/useSessionMonitor.ts` (lobby e seleção) verifica:
  - quando o ecrã abre;
  - quando a app volta ao primeiro plano;
  - no evento de fecho do realtime.
  O aviso antigo em inglês ("Session Ended") sai.
- Lobby: a leitura de 2 em 2 s também apanha o `closed`.
- `components/session/SessionMissing.tsx` substitui o "Session not found" do
  lobby, da seleção e do dashboard:
  - pergunta ao servidor e vai para o início com o aviso certo;
  - se a sessão ainda estiver aberta, mas não carregada (a app foi
    reiniciada), vai para o início, onde o aviso de rejoin a oferece;
  - na seleção com a sessão carregada, volta ao lobby;
  - tem sempre o botão "Ir para o Início";
  - sem rede, mostra a mensagem de erro, que fica até se fechar, e o botão
    continua lá.
- O Voltar num lobby ou numa seleção sem sessão vai direto para o início, sem
  diálogo.
- Entrada (`join.tsx`):
  - QR de uma sessão que não existe → início, com "Sessão não encontrada.
    Confirma com o anfitrião.";
  - sessão terminada de que a pessoa fazia parte → início, com o motivo;
  - quem nunca esteve numa sessão fechada continua a ver o ecrã de entrada com
    o anfitrião (R7);
  - se a confirmação falhar porque a sessão acabou entretanto → início, com o
    motivo;
  - o botão Voltar vai para o início quando não há para onde voltar.
- O aviso de rejoin no início também diz o motivo.

**Aviso do crédito do scan (C1)**
- Só aparece ao anfitrião, quando ele sai de propósito de uma sessão com a
  fatura validada: "Esta fatura já foi lida e o crédito foi usado. Se saíres
  agora, a sessão termina e perdes esse crédito."
- O anfitrião sem fatura vê "A sessão termina para todos."
- O participante vê só "Vais sair desta sessão.".
- Igual no lobby e na seleção. A seleção tinha os textos escritos em português
  no código; agora usa as traduções.
- Por decidir: o diálogo do anfitrião com mais pessoas ("passar o papel de
  anfitrião" ou "terminar para todos") ficou igual. Terminar para todos aí
  também perde o crédito do scan, e o texto não o diz.

**Logs**
- `[session-gone] monitor (foreground): <id> is closed_host — going home`
- `[session-gone] lobby: <id> is open but not loaded here — home`
- `[session-gone] … could not ask the server — …` (sem rede; nada muda)
