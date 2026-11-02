# R11 — Voltar a uma sessão, e retirar da divisão (feito a 2026-11-02)

As regras estão em `docs/regras-de-produto.md` (R11).

## Servidor (`20261102190000_r11_rejoin_and_remove.sql`, aplicado em produção)
- **`ever_joined`**, a marca de "já fez parte":
  - fica verdadeira quando a linha passa por `joined`, `selecting` ou
    `items_picked`, e nunca volta a falso;
  - quem a escreve é um trigger, por isso a app não a consegue forjar: o
    cliente não tem permissão sobre a coluna, e o trigger reescreve o valor;
  - **backfill:** o estado atual, o registo de estados (o estado novo ou o
    antigo) e os créditos já gastos. Ficou feito antes de o trigger existir,
    para o trigger não o apagar.
  - **Resultado:** 526 linhas marcadas e 29 não. Das 28 `left`, 5 ficaram
    marcadas. As outras 23 não têm rasto de terem entrado, porque são de antes
    do registo, e continuam como entrada nova.
- **Quem já fez parte volta com qualquer saldo**
  (`is_part_of_session`, `enforce_session_credit`). A exceção é quem foi
  retirado.
- O `join_preview` devolve `rejoin` com `needs_credit` quando a pessoa tem 0
  créditos e ainda não pagou esta sessão.
- **`remove_participant(sessão, pessoa)`:**
  - só o anfitrião atual o pode chamar, para alguém presente que não seja o
    anfitrião, e só antes do finalizar (R12);
  - o estado passa a `removed`, que fica no registo com quem retirou e
    `via = remove_participant`;
  - as unidades ficam livres e os pedidos de partilha caem, como no Sair
    (`units_release_on_leave`);
  - não é cobrado nada: o finalizar só cobra quem está presente. Se já tinha
    pago, é devolvido no finalizar seguinte, porque está ausente.
  - **Voltar exige 1 crédito.**
- O estado `removed` só se escreve pelo RPC (`REMOVE_VIA_RPC`).
- **Ensaio:** 19 casos, com BEGIN e ROLLBACK, contra a sessão `511bea98`.
  - A reversão repõe as 4 funções, apaga o RPC e o trigger, e tira a coluna.
  - **Depois de aplicar:** os mesmos 19 casos em produção, 0 diferenças.
- **Reversão:** `supabase/rollback/20261102190000_r11_pre_state_and_rollback.sql`.

## App
- **Entrada pelo QR, pelo código ou pelo aviso de rejoin, a 0 créditos e sem
  ter pago:** aparece "Tens 0 créditos. Podes voltar, mas precisas de 1
  crédito antes de o anfitrião finalizar.", com Comprar créditos e Continuar.
  Na web não há o Comprar.
- **Finalizar recusado por falta de créditos:**
  - o diálogo do anfitrião tem um "Retirar da divisão: <nome>" para cada
    pessoa;
  - antes de retirar, aparece a confirmação "Os itens de <nome> ficam sem dono
    e vão ser divididos pelos outros. <nome> pode voltar à sessão.";
  - depois aparece "<nome> já não está na divisão. Podes finalizar outra vez.";
  - o RPC tem o limite de 10 s, e uma falha mostra a mensagem até se fechar.
- **A pessoa retirada** vê "O anfitrião retirou-te desta divisão por falta de
  créditos." e vai para o início. Isto acontece pelo realtime, ou quando a app
  volta ao primeiro plano (o monitor do D.7).
- **Os outros** veem-na como quem saiu.
- **Quem foi retirado entra outra vez como entrada nova**, na mesma linha:
  - com 1 crédito vê o ecrã de confirmação normal;
  - a 0 créditos vê "Não tens créditos…".

## O que não fiz
- O resumo da conversa falava também de um "Retirar da divisão" no lobby, ao
  lado de quem está desligado há mais de 3 minutos.
- O texto da R11 em `docs/regras-de-produto.md` não tem essa regra, por isso
  não a fiz.
- Se a quiseres, diz e junto-a às regras.
