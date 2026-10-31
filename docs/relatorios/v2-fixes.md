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
