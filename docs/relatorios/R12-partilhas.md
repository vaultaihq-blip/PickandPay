# R12 — Unidades no servidor, seleção ao vivo e partilhas com confirmação

Pedida a 02-11-2026. As regras estão em `docs/regras-de-produto.md` (R12, e a
R2 atualizada).

Por fases:
1. **Servidor:** **aplicado em produção a 02-11-2026** e verificado contra o
   ensaio (68 verificações, 0 diferenças).
2. **Seleção ao vivo** (app e web, o mesmo componente): por fazer.
3. **Partilhas** (pop-up, pedidos, lobby): por fazer.

---

## A causa (sessão `f71add73`, 01-11-2026, 22:45)

- A fatura tinha os dois Moskow Mule em duas linhas (`b1` e `b2`, quantidade 1
  cada). A seleção juntava-as numa linha "Moskow Mule ×2".
- Ao tocar, cada aparelho escolhia "a primeira livre", mas só sabia o que os
  outros já tinham **gravado**, e uma escolha só era gravada no Done. A e B
  escolheram ao mesmo tempo, e os dois ficaram com `b1`.
- A e B fizeram Done com 0,6 s de diferença (22:47:09). O finalizar recusou:
  `finalize refused: 1 item(s) without an owner` (`b2`).
- O B voltou a editar (22:47:44). Como o `b1` do A já estava gravado, ficou com
  `b2`. O finalizar passou às 22:51:12. Por isso os dados finais parecem
  certos.
- **Um segundo erro, da mesma origem:** numa linha com quantidade 2, o
  finalizar só verificava se **alguém** a tinha escolhido. Quem escolhia 1 de 2
  pagava as duas.

## Fase 1 — Servidor

Migração: `supabase/migrations/20261102090000_r12_units_and_shares.sql`.
Reversão: `supabase/rollback/20261102090000_r12_pre_state_and_rollback.sql`.

### O que muda

**Unidades**
- Cada linha da fatura tem `quantity` unidades: um número inteiro ≥ 1, senão 1.
- Linhas com a mesma categoria, o mesmo nome e o mesmo preço unitário são um
  só item. São as mesmas linhas que a seleção mostra juntas.
- Quem tem que unidade fica na tabela `session_unit_claims`. Só as funções do
  servidor lhe escrevem, sempre sob um bloqueio por sessão, por isso dois
  toques ao mesmo tempo são servidos um a seguir ao outro.

**`session_participants.selections`**
- Passa a ser **calculado pelo servidor** a partir das unidades, depois de
  cada mudança.
- Cada linha mantém o formato de antes (`itemId`, `quantity`, `isShared`,
  `sharedWith`) e ganha `unitSplits`: para cada unidade que a pessoa tem,
  quantas pessoas a partilham.
- A divisão passa a usar `unitSplits`. Isso está na fase 2.

**As funções novas**

| Função | O que faz | Respostas |
|---|---|---|
| `pick_units(sessão, item, N)` | "Quero N unidades deste item." Um item com uma unidade é partilhado por quem o escolhe. Um item com várias dá unidades livres, por ordem. | `ok` ou `full`, com `holders` (nomes de quem tem unidades), `free_units` e as seleções da pessoa |
| `share_unit(sessão, item, pessoa)` | "Partilhei o do <nome>." Junta-se à unidade dessa pessoa. | `shared`, `already`, `not_holder` |
| `request_share(sessão, item, [pessoas])` | O pedido de partilha. Quem pede tem de ter o item (a app escolhe-o primeiro). | por pessoa: `requested` (com `has_other_unit`), `already` (já está na mesma unidade: confirmado, sem pedido), `pending`, `limit`, `not_present` |
| `answer_share(sessão, [pedidos], aceitar)` | O convidado aceita ou rejeita. Funciona depois do Done. | `accepted`, `rejected`, `dropped` (quem pediu já largou a unidade), `not_pending` |
| `manage_share_request(pedido, ação)` | `cancel` (quem pediu ou o anfitrião atual), `remind` (o anfitrião), `dismiss` (quem pediu tira o X) | `done`, `not_allowed`, `not_pending` |

**Escritas diretas** (apps antigas, o web atual, o anfitrião a escolher por
alguém)
- Uma escrita direta em `selections` é transformada em unidades da mesma
  forma.
- Se pedir unidades que outra pessoa tem, é recusada com `UNITS_TAKEN`, e
  nada muda.
- A colisão de 01-11 deixa de ser possível: o segundo `b1` passa para `b2`.

**Sair**
- **Antes de finalizar**, sair (`left`, `cancelled`, `pending`, `removed`)
  larga as unidades da pessoa, e os pedidos de e para ela caem
  (`dropped/left`).
- **Depois de finalizar**, quem sai continua na divisão com a sua parte, e as
  suas unidades não ficam livres.

**`finalize_session`**

É a definição de produção, com três mudanças:
- se houver pedidos pendentes, responde `pending_shares`, com a lista
  (item — convidado);
- conta as unidades por item: `unowned_items` traz `units` e `free_units`
  ("1 de 2");
- a limpeza antiga de `sharedWith` é substituída pelo cálculo das seleções a
  partir das unidades.

**Preenchimento das sessões abertas**
- As sessões ainda não fechadas recebem unidades a partir das seleções já
  gravadas.
- A 02-11-2026 não há nenhuma sessão aberta com fatura, por isso nada muda nos
  dados reais.

### Ensaio (numa transação anulada no fim, com 4 utilizadores de teste)

| Teste | Resultado |
|---|---|
| Unidades da fatura de teste (`Moskow Mule` com espaço no fim junta-se ao outro) | `m1#1`, `m2#1` = moskow mule; `w1#1`, `w1#2` = wisky sour ✓ |
| **Colisão** escrita como a app antiga (A e B gravam `m1`) | A `m1`, B passa para `m2` ✓ |
| Uma terceira pessoa grava um Moskow Mule (app antiga) | `PP409 UNITS_TAKEN`, nada muda ✓ |
| A mesma coisa com `pick_units` | A `m1`, B `m2`, 0 livres ✓ |
| C pede um Moskow Mule sem nenhum livre | `full`, holders "Ana, Bruno" ✓ |
| C partilha o do Bruno | A `m1[1]`, B `m2[2]`, C `m2[2]`, ou seja A 1.100, B 550, C 550 ✓ |
| Arroz (1 unidade) escolhido por A, B e C | cada um `r1[3]`, um terço cada ✓ |
| A convida o B para o arroz, que o B já tem | `already`, sem pedido ✓ |
| Pedir sem ter o item | `PICK_FIRST` ✓ |
| A convida o B para o vinho; o C tenta responder | `not_pending` ✓ |
| O B aceita | `accepted`; o B fica no vinho `v1[2]` ✓ |
| Pedido pendente e o convidado escolhe o item sozinho | `accepted/pick` ✓ |
| Wisky Sour: o B tem a outra unidade e é convidado | `requested`, `has_other_unit = true` ✓ |
| Rejeitado duas vezes; terceira tentativa | `limit` ✓ |
| O X: visível 2 → tocar num → 1 → voltar a mexer no item → 0 | ✓ |
| O convidado sai | pedido `dropped/left`, unidades 0, seleções vazias; o vinho passa de `[3]` para `[2]` ✓ |
| Quem saiu tenta escolher | `NOT_IN_SESSION` ✓ |
| Finalizar com um pedido pendente | `pending_shares`, "Pão — Bruno" ✓ |
| Cancelar ou lembrar por alguém que não é o anfitrião nem quem pediu | `not_allowed` ✓ |
| O anfitrião lembra e cancela | `done` ✓ |
| Finalizar com 1 dos 2 Wisky Sour livre | `unowned_items`, "Wisky Sour 1/2" ✓ |
| Depois de escolhido o outro | `finalized`; quem saiu não entra na divisão ✓ |
| Escolher depois de finalizar | `SESSION_FINALIZED` ✓ |
| Sair depois de finalizar | `left`; as unidades ficam (3), as seleções de todos não mudam, e a pessoa continua na divisão ✓ |
| Linha com quantidade 2, só 1 escolhida, noutra sessão | "1 of 2" ✓ |
| Os clientes escrevem diretamente nas tabelas novas | recusado (42501) ✓ |
| Funções internas chamáveis por clientes / funções novas por `anon` | nenhuma ✓ |

O ensaio da **reversão** compara 5 marcas antes e depois:
- a `finalize_session` e quem a pode chamar;
- os objetos novos;
- a publicação realtime;
- os triggers;
- todas as linhas de `session_participants`.

**Diferenças: 0.** `db push --dry-run` só tinha esta migração por aplicar.

### Em produção (02-11-2026)

- `db push`: aplicada. O preenchimento encontrou 0 sessões abertas com
  fatura, por isso nenhuma seleção real foi reescrita.
- As mesmas verificações do ensaio, corridas em produção numa transação
  anulada: 68 chaves, **0 diferenças** em relação ao ensaio.

### Com a app atual, antes das fases 2 e 3

O servidor já protege a app atual:
- A colisão de 01-11 deixa de acontecer: a segunda pessoa que grava o mesmo
  Moskow Mule fica com o outro. No aparelho dela, a seleção só mostra a
  mudança quando volta a ler a sessão.
- O finalizar conta unidades, por isso deixa de aceitar "1 de 2".
- Se alguém gravar uma unidade que já não existe livre, o Done mostra o erro
  `UNITS_TAKEN` no modal.

### Decisões (propostas por mim, confirmadas pelo dono a 02-11-2026)

1. **Sair larga as unidades, só antes de finalizar.** Quem carrega em Sair
   deixa os itens livres para os outros. Se voltar, escolhe de novo. Fechar a
   app não é sair (A1), por isso não perde nada. Antes, os itens de quem saía
   ficavam presos e o finalizar recusava-os como sem dono. Depois de
   finalizar, nada é libertado (acrescento do dono).
2. **O limite de "convidar só mais uma vez"** conta por item e por convidado,
   seja quem for que pede. Assim o convidado não recebe o mesmo pedido de três
   pessoas diferentes.
3. **Quem larga uma unidade que partilhava** deixa o outro sozinho nessa
   unidade, e esse outro passa a pagá-la toda. Por exemplo: o B larga o seu
   Moskow Mule, que partilhava com o C, e o C fica a pagar 1.100. Não lhe é
   perguntado nada, mas recebe um aviso (acrescento do dono, fase 3): "<nome>
   deixou de partilhar o <item>. Agora pagas X em vez de Y."
4. **O mesmo item** é mesma categoria, mesmo nome (sem diferenças de
   maiúsculas e espaços) e mesmo preço unitário.
5. **Depois de finalizar**, `pick_units` recusa (`SESSION_FINALIZED`). As
   escritas diretas continuam como antes; o D.3 trata disso.

### Ainda não testado

O bloqueio entre dois toques **verdadeiramente** simultâneos não se consegue
mostrar dentro de uma única transação. Fica garantido pelo bloqueio da linha da
sessão (`FOR UPDATE`), o mesmo do finalizar. O teste 1 nos aparelhos confirma-o.

### Teste da fase 1 (com a app atual, três aparelhos)

Usa uma fatura com dois itens iguais (o Oligark tem 2 Moskow Mule e 2 Wisky
Sour).

1. **Colisão.** A cria a sessão e lê a fatura. B e C entram.
   - A e B escolhem cada um 1 Moskow Mule ao mesmo tempo e fazem Done.
   - No servidor, ficam com unidades diferentes. Eu leio as unidades
     (`session_unit_claims`): uma linha para A, outra para B, com unidades
     diferentes.
   - O C escolhe o resto e faz Done. O anfitrião finaliza.
   - Log do anfitrião: `[session-lobby] finalized: n=3 ...`, sem
     `finalize refused`.
2. **"1 de 2".** Numa sessão nova, só 1 dos 2 Wisky Sour é escolhido.
   - O finalizar recusa: `[session-lobby] finalize refused: 1 item(s) without
     an owner`. O diálogo mostra o Wisky Sour.
3. **Sair depois de finalizar.** Com a sessão finalizada, o C carrega em Sair.
   - A parte do C continua no dashboard do anfitrião.

## Fases 2 e 3 — App e web (um commit)

As duas fases mexem nos mesmos ecrãs (a linha do item tem os símbolos e o
botão Partilhar), por isso vão num só commit. A app e o web usam os mesmos
componentes.

### O que mudou

**Seleção ao vivo** (`app/(app)/selection/[sessionId].tsx`)
- Aplica-se a quem escolhe para si numa sessão online, vinda do lobby. Cada
  toque na linha, no + ou no − chama `pick_units`. A resposta do servidor
  substitui as escolhas do aparelho.
- O Done e o "voltar ao lobby" só gravam o estado; as escolhas já estão no
  servidor.
- O anfitrião a escolher por outra pessoa e as sessões offline continuam pelo
  caminho antigo. O servidor converte essas escritas em unidades.
- **As linhas** juntam-se pela regra do servidor (`lib/units.ts`, `groupItems`):
  o mesmo nome e o mesmo preço unitário.
- **Os símbolos** (`components/selection/PersonDot.tsx`):
  - um círculo com as iniciais na cor da pessoa; com duas cores (R4b), o meio
    círculo;
  - iniciais únicas na sessão (`sessionInitials`): "R"; se se repetem,
    "RI" / "RU";
  - "Tu" no próprio;
  - 3 círculos e "+N"; tocar mostra os nomes;
  - os estados: esbatido = pedido à espera; cor viva = confirmado; X =
    rejeitou.
- **"1 de 2 livre"** nos itens com mais de uma unidade.
- **Sem unidades livres**: "Os 2 Moskow Mule já foram escolhidos, por Ana e
  Bruno. Partilhaste algum? Com quem?", com um botão por nome e Cancelar.
- **O total a pagar** no fundo do ecrã usa as unidades (`selectionAmount`).

**A divisão** (`utils/splitter.ts`)
- Quando as escolhas trazem `unitSplits`, cada unidade é dividida por quem a
  tem, ao cêntimo.
- As unidades sem dono não são cobradas a ninguém; o finalizar recusa-as.
- Na parte de cada um: "Moskow Mule (partilhado com Bruno) 550,00", no
  dashboard, na lista de itens e no texto partilhado.

**Partilhas**
- **"Partilhar"** em cada linha: se ainda não tens o item, escolhe-o primeiro.
  Depois abre a lista das pessoas (`ShareWithModal`). Quem já está na tua
  unidade aparece marcado e não pode ser escolhido outra vez.
- **Pedidos ao vivo** (`hooks/useShareRequests.ts`, ligado no lobby):
  - um pedido novo, ou um "Lembrar" do anfitrião, abre a janela de pedidos;
  - "Tens N pedidos de partilha" no lobby, e um ícone no cartão de cada
    pessoa com pedidos;
  - "N partilhas à espera de resposta" para todos;
  - na seleção, "Pedido de partilha" na linha do item.
- **Responder** (`components/session/ShareRequestsPanel.tsx`): cada pedido
  mostra o valor, com Aceitar, Rejeitar e Aceitar todos. Também funciona
  depois do Done.
- **A lista do anfitrião**: Lembrar e Cancelar pedido. Quem pediu também pode
  cancelar o seu.
- **Rejeição**: quem pediu vê "O Bruno rejeitou partilhar o Arroz de Pato." e
  o X. O X desaparece ao tocar nos círculos ou ao mexer no item.
- **Deixar de partilhar**: quem fica recebe "Bruno deixou de partilhar o
  Moskow Mule. Agora pagas 1.100,00 em vez de 550,00."
- **O finalizar com pedidos pendentes** mostra a lista e "Ver pedidos".
- **Os itens sem dono** mostram "1 de 2 sem dono".

As 44 frases novas estão nas 5 línguas.

**Verificações**
- testes 95/95, com 9 novos (`units.test.ts`: unidades, linhas juntas,
  unidades livres, iniciais, e a divisão A 1.100 / B 550 / C 550, o arroz por
  três e "1 de 2");
- tipos sem erros;
- `check:alerts` limpo;
- o bundle Android e o web compilam.

### Testes (três aparelhos: A anfitrião, B, C)

Usa o Oligark (2 Moskow Mule em duas linhas, Wisky Sour, Çerez & Meyva). Se
quiseres um item de uma unidade para partilhar por três, serve o Çerez &
Meyva.

1. **Colisão.** A e B tocam cada um num Moskow Mule ao mesmo tempo, sem Done.
   - Logs: `[units] pick b1 → want 1: ok, have 1 of 2, 1 free` num, e
     `... 0 free` no outro.
   - A e B fazem Done. O anfitrião finaliza: `[session-lobby] finalized`, sem
     itens sem dono.
2. **Linha com quantidade 2.** Numa sessão nova, só 1 Wisky Sour escolhido.
   - O finalizar recusa, com "Wisky Sour — … — 1 de 2 sem dono".
   - Log: `[session-lobby] finalize refused: 1 item(s) without an owner`.
3. **Ao vivo.** Quando A toca num item, o círculo do A aparece na linha em B
   e C, e desaparece quando desmarca.
   - O próprio vê "Tu", e a linha fica destacada.
   - Os Moskow Mule mostram "1 de 2 livre" e depois "0 de 2 livre".
4. **Partilha automática.** A, B e C tocam no Çerez & Meyva. Os três círculos
   aparecem, e cada um paga um terço (200,00).
5. **Sem unidades livres.** Com os 2 Moskow Mule tomados (A e B), o C toca.
   - Aparece "Os 2 Moskow Mule já foram escolhidos, por A e B. Partilhaste
     algum? Com quem?". O C escolhe o B.
   - Log do C: `[units] share b1 with … : shared (b2#1)`.
   - No dashboard: A 1.100, B 550 (partilhado com C), C 550 (partilhado com
     B).
6. **Pedido aceite.** O A escolhe um item e carrega em Partilhar → B → Pedir
   partilha.
   - O B vê a janela "O A diz que partilhaste o … Se aceitares, pagas …",
     "Tens 1 pedido de partilha" no lobby, e o ícone no cartão.
   - O B aceita. O círculo do B passa de esbatido a cor viva.
   - Logs: no A, `[units] request …: … requested`; no B,
     `[share-requests] new request N for me` e
     `[units] answer accept: N accepted`.
7. **Pedido rejeitado.** O B rejeita.
   - O A vê "O B rejeitou partilhar o …" e o X no círculo do B.
   - O A volta a pedir: funciona. À terceira, aparece "Já não podes pedir
     ao B…".
8. **Resolvido sozinho.** O B já tem o item e o A pede-lhe. Fica confirmado,
   sem pedido nem janela no B.
   - Log do A: `… already`.
9. **Bloqueio.** Com um pedido pendente, o anfitrião finaliza.
   - Aparece "Há partilhas por responder", com a lista.
   - Log: `[session-lobby] finalize refused: 1 share request(s) pending`.
   - "Ver pedidos" → Cancelar pedido → finalizar passa.
10. **O convidado sai.** Com um pedido pendente para o C, o C carrega em Sair.
    O pedido desaparece da lista em todos.
11. **Deixar de partilhar** (acrescento). Depois do teste 5, o B desmarca o
    Moskow Mule.
    - O C recebe "B deixou de partilhar o Moskow Mule. Agora pagas 1.100,00 em
      vez de 550,00."

### O que fica de fora

- **O web publicado** (Netlify) ainda é o de antes. É preciso um novo
  `web:export`, quando pedires.
- **A3** ("selecionar por" do anfitrião) continua pelo caminho antigo.
- **C3** (+ e − com 44×44) fica para o seu ponto.
- **Quem aceita um pedido no lobby sem nunca ter aberto a seleção** aparece
  como "Done" no lobby, porque o lobby trata qualquer pessoa `joined` com
  itens como confirmada. Isto já era assim antes do R12. Está na fila
  (`docs/relatorios/v2-fixes.md`): aceitar só muda os itens, e não o estado.


---

## Correções depois dos testes de 02-11-2026

Resultados: sessão 1 com 1, 2, 3, 5, 6, 7, 9 e 10 OK; o 4 com problema; o 8 a
ajustar. Sessão 2: 11 OK.

### Ponto 1 — as escolhas desapareciam ao voltar à seleção

**Causa**
- No log: o A abre outra vez a seleção (linha 885). Logo a seguir, B e C
  recebem "VAULT deixou de partilhar o Çerez & Meyva / Art of Bosphorus"
  (891–893), e o A volta a escolher b8, b10 e b13 (894–896).
- O botão "Editar" do lobby ainda gravava `selections: []` antes de abrir a
  seleção. Vinha de antes da R12, quando o aparelho guardava as escolhas e as
  voltava a gravar no Done. Com a R12, o servidor lê uma lista vazia como
  "não quero nada" e liberta todas as unidades.
- "Cancelar" (rascunho) e "Cancelar pronto" faziam o mesmo.

**Correção** (decisão do dono: nenhum botão pode mandar `selections: []`)
- **Editar:** grava só `selecting`.
- **Cancelar:** grava só `joined`.
- **Cancelar pronto:** volta só a `selecting`.
- As unidades ficam sempre. Quem quiser tirar um item desmarca-o.
- **Os outros aparelhos**, ao receber `selection_uncomplete`, já não apagam as
  escolhas dessa pessoa no ecrã. As escolhas chegam do servidor pelo realtime.
- **Outros sítios que mandavam `selections`:**
  - os `joinSession` de `lib/supabase.ts` e `hooks/useSession.ts`: o upsert
    deixa de levar `selections` (nada os chama, mas um upsert sobre uma linha
    existente apagava as escolhas);
  - `updateParticipantSelections` (sem uso): apagada.
  - Os restantes `selections: []` no código são objetos locais, que não vão
    ao servidor.
- **A seleção abre sempre com o que está no servidor:** ao abrir, lê as
  escolhas de todos (`[selection] picks from the server: N people, M line(s)
  mine`). Vale ao voltar do lobby, no rejoin e depois de um cancelamento
  aceite.

**Teste**
1. A escolhe itens, partilhados com B e C, e faz Done.
2. A carrega em Editar.
   - As escolhas continuam marcadas, com os círculos e o "N de M livre"
     certos.
   - B e C não recebem nenhum "deixou de partilhar".
   - Log do A: `[selection] picks from the server: 3 people, N line(s) mine`.
3. A faz Done e depois "Cancelar pronto". As escolhas ficam.

### Ponto 2 — o pedido quando o convidado já tem o seu (opção B)

**O que o log mostrou**
- No teste 8 o servidor nunca respondeu `already`.
- O pedido 11 (Wisky Sour, 2 unidades) foi para o B, que já tinha a outra
  unidade. Pela R12 isso é um pedido a sério: aceitar põe o B na unidade de
  quem pediu, e o B passa a pagar mais.

**Decisão do dono:** opção B, com um texto mais claro.

**O que muda**
- O texto passa a ser "Já tens o teu Wisky Sour. O <nome> diz que também
  bebeste metade do dele. Se aceitares, pagas mais 550,00."
- O verbo segue a categoria do item:
  - bebidas: "bebeste";
  - entradas, pratos e sobremesas: "comeste";
  - "outros": "partilhaste".
- "Metade" quando a unidade passa a ser de dois; "parte" quando já são mais.
- Nas 5 línguas.
- Quando o pedido fica confirmado sozinho (o convidado já está nessa
  unidade, ou o item tem uma só unidade e ele já o escolheu), continua sem
  aviso nem janela para ninguém. O círculo fica com cor viva.
- A regra está atualizada na R12.

**Teste**
1. O B escolhe um Wisky Sour, e o A o outro.
2. O A carrega em Partilhar → B.
   - O B vê "Já tens o teu Wisky Sour. O A diz que também bebeste metade do
     dele. Se aceitares, pagas mais 550,00."
3. Num item de uma unidade que o B já escolheu, o A carrega em Partilhar → B.
   - Não aparece nada em nenhum aparelho, e o círculo do B fica vivo.
   - Log do A: `[units] request …: … already`.

### Ponto 4 — aceitar uma partilha não é Done

**Causa:** o lobby marcava como "Done" quem tinha itens e estava `joined`, ou
quem tinha itens no store do aparelho. Era um resto de antes, quando só o Done
gravava escolhas. Com a R12, quem aceita uma partilha no lobby passa a ter
itens sem ter feito Done.

**Correção** (`app/(app)/session-lobby/[id].tsx`): "Done" vem só do estado
`items_picked` no servidor, ou do aviso de Done do próprio aparelho.
- Corrigidos os cinco sítios que o decidiam: o estado inicial, a releitura ao
  abrir o lobby, a releitura ao voltar ao lobby, o realtime e a sincronização
  antes do finalizar.
- Quem tem itens sem Done fica como estava: "à espera", ou "a escolher" se
  estiver na seleção.

**Teste**
1. O B está no lobby sem ter aberto a seleção.
2. O A escolhe um item, carrega em Partilhar → B, e o B aceita no lobby.
   - Em todos os aparelhos, o B **não** aparece como Done.
   - O círculo do B aparece no item.
3. O B abre a seleção e faz Done. Agora aparece como Done.

### Ponto 3 — no lobby, o que falta escolher

**O que muda** (`components/session/LobbyReceiptItems.tsx`, na fatura
expandida do lobby)
- **No topo:** "Faltam N itens por escolher" a vermelho, ou "Todos os itens
  têm dono ✓" a verde. N conta as unidades sem dono, como o finalizar.
- **Primeiro, os itens com unidades sem dono**, com o destaque da revisão em
  espelho (fundo vermelho claro e "!"):
  - "1 de 2 Wisky Sour por escolher" nos itens de várias unidades;
  - "Arroz de Pato por escolher" nos de uma unidade.
- **Depois, os itens completos**, sem destaque, com os círculos de quem os
  escolheu. Tocar nos círculos mostra os nomes.
- **Os pedidos pendentes** aparecem junto do item: "à espera de Bruno", e o
  círculo do convidado esbatido.
- A contagem no cabeçalho da fatura ("N itens por escolher") passa a usar a
  mesma conta, e não as linhas.
- Na app e no web, nas 5 línguas.

**Teste**
1. Com o Oligark, antes de alguém escolher, o lobby mostra "Faltam N itens
   por escolher", com todos os itens a vermelho.
2. O A escolhe 1 Wisky Sour.
   - Aparece "1 de 2 Wisky Sour por escolher" no topo da lista, com o círculo
     do A.
3. O A pede ao B para partilhar um item. Junto desse item aparece "à espera
   de B", com o círculo do B esbatido.
4. Com tudo escolhido, aparece "Todos os itens têm dono ✓" a verde.

### Ponto 4b — "Cancelar pronto" deixava o utilizador preso

**O que ficou à espera:** um estado que nunca mudava. Não foi uma escrita
sem resposta, nem uma recusa do servidor.
- O log não tem nenhuma escrita falhada nem fora do tempo. A gravação de
  `selecting` correu bem (uma escrita bem-sucedida não deixa linha).
- O lobby lê `selecting` como "esta pessoa está no ecrã de seleção". Quando
  chegou o eco do servidor, a própria linha passou a "a escolher…", com a roda
  à direita e sem botões.
- A pessoa estava no lobby e não na seleção, por isso nada desfazia esse
  estado. Nos outros aparelhos, a roda também ficava a girar no círculo dela.

**Correção** (`app/(app)/session-lobby/[id].tsx`)
- **"Cancelar pronto"** grava só `selecting` e mantém as unidades.
  - No próprio aparelho, a linha mostra "Cancelar" e "Editar", sem roda.
  - O eco `selecting` que chega para si próprio, sem ter ido à seleção, já não
    liga a roda.
- **Nos outros aparelhos**, a roda só aparece em quem está mesmo no ecrã de
  seleção, pela presença ("selecting"). Quem voltou a "não pronto" no lobby
  aparece como "a escolher", sem roda. "Cancelar pronto" envia a presença
  `waiting`.
- **As escritas:** todas as escritas da sessão no lobby, na seleção e nas
  funções da R12 têm o limite de 10 s e uma mensagem quando falham. A única
  exceção é a escrita do utilizador de teste de programador (`fakeUserId`),
  que não corre com contas reais.

**Teste**
1. B escolhe itens e faz Done. No lobby do B aparecem "Cancelar" e "Editar".
2. B carrega em "Cancelar" (o "Cancelar pronto").
   - A linha do B mostra logo "Cancelar" e "Editar", sem roda.
   - Os itens continuam com o círculo do B.
3. Em A e C, o B deixa de estar Done e aparece "a escolher", sem roda.
4. B carrega em "Editar".
   - A seleção abre com as escolhas do B marcadas.
   - Em A e C aparece a roda ("a escolher…") enquanto o B está lá.
5. B faz Done. Fica Done em todos.

### Ponto 5 — a nova regra do "Cancelar" depois do Done (2026-11-02)

**Regra do dono**
- O "Cancelar" depois do Done deixa de manter as escolhas: deita-as fora,
  depois de uma confirmação.
- O "Editar" continua a mantê-las, para corrigir.
- A R12 nas regras de produto está atualizada.

**O que faz agora** (`app/(app)/session-lobby/[id].tsx`)
1. Pede confirmação: "Cancelar as escolhas? — Vais perder todas as tuas
   escolhas. Os itens ficam livres para os outros.", com **Cancelar
   escolhas** e **Voltar**.
2. Ao confirmar, liberta no servidor todas as unidades dessa pessoa, item a
   item, com `pick_units(…, 0)`. Cada chamada tem o limite de 10 s, e uma
   falha mostra a mensagem do servidor até se fechar. Nenhum botão manda
   `selections: []`.
3. Grava o estado `selecting`.
4. A pessoa fica no lobby com a linha a mostrar só **Editar**, sem roda.
5. Quem partilhava unidades com ela recebe "<nome> deixou de partilhar o
   <item>. Agora pagas X em vez de Y."

Se uma escrita falhar a meio, não muda mais nada no aparelho. O que o
servidor já libertou aparece pelo realtime, e a pessoa pode tentar outra vez.

Log: `[session-lobby] cancel ready: released N item(s)`.

**Teste**
1. B e C partilham o Çerez & Meyva. B tem também 1 Moskow Mule. B faz Done.
2. B carrega em "Cancelar".
   - Aparece a confirmação.
   - "Voltar" não muda nada.
3. B carrega outra vez em "Cancelar" → "Cancelar escolhas".
   - Os itens do B ficam livres: o Moskow Mule aparece em "por escolher" no
     lobby.
   - A linha do B mostra só "Editar", sem roda.
   - O C recebe "B deixou de partilhar o Çerez & Meyva. Agora pagas … em vez
     de …".
4. B carrega em "Editar". A seleção abre vazia para o B.
