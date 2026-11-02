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

## Fases 2 e 3 — App e web

Por fazer. Começam depois de eu dizer "vou mexer na app" e de tu responderes.
