# Pick&Pay — Regras de produto

Estas regras são **obrigatórias**. Nenhuma pode ser alterada sem pedido explícito do dono do projeto, Ricardo Costa.
- O servidor (Supabase) é sempre quem decide e quem garante cada regra. A app só mostra o resultado.
- Uma app modificada não consegue contornar nenhuma delas.

Estado a 02-11-2026: R1 a R12, com as decisões do D (o D.1 já aplicado). A R2 alargada ao total impresso já está na app. A R11 e a R12 estão feitas no servidor e na app. Os relatórios com os pormenores estão em `docs/relatorios/`.

---

## R1 — Créditos

| Regra | Porquê |
|---|---|
| Cada pessoa presente numa sessão gasta **1 crédito por sessão**: anfitrião e participantes, na app e na web. | A divisão é um serviço para todos os que dividem a conta, não só para quem a abriu. |
| **O anfitrião paga no scan.** Cada leitura bem-sucedida da fatura gasta 1 crédito. A sessão criada com essa leitura conta como paga para o anfitrião. Se não houve scan, o anfitrião paga ao finalizar. | O scan é o que custa dinheiro (OCR). Quem o faz paga-o logo, e nunca paga duas vezes a mesma sessão. |
| **Falhas do scan:** uma falha nossa é devolvida; uma fatura ilegível é cobrada; ler outra vez cobra outra vez. | Só devolvemos o que foi culpa nossa. A leitura de uma fatura ilegível também gasta recursos. |
| **Os participantes pagam ao finalizar.** Conta quem está presente (`joined`, `selecting` ou `items_picked`) no momento em que o anfitrião finaliza. O número de pessoas fica congelado nesse mesmo momento. | Paga quem fica até ao fim da divisão. Ninguém paga por ter só espreitado o QR, e o número de pessoas não muda depois de finalizar. |
| **Nunca há dupla cobrança:** finalizar outra vez não volta a cobrar a quem já pagou (`newly charged = 0`). | Cancelar o countdown e finalizar de novo é normal e não pode custar mais. |
| **Devoluções:** se, ao finalizar outra vez, alguém que já tinha pago já não estiver presente, recebe o crédito de volta. Cada cobrança e cada devolução ficam registadas. | Só paga quem fica na divisão final. O registo permite explicar qualquer saldo. |
| **Sem créditos ao finalizar:** o servidor recusa e mostra os nomes de quem não tem crédito. Essas pessoas veem no seu aparelho uma mensagem com o botão para comprar; depois o anfitrião tenta outra vez. | Ninguém entra numa divisão sem pagar, e quem resolve o problema é a própria pessoa. |
| **Cobrir alguém** (pagar a parte de outra pessoa) só é permitido se essa pessoa tiver créditos. | Cobrir é sobre o dinheiro da conta, não serve para contornar o crédito da sessão. |
| **Os utilizadores Pro não gastam créditos.** | É o que o Pro compra. |
| **Ao criar conta, cada pessoa recebe 3 créditos, uma única vez.** | Chega para experimentar, sem dar créditos repetidos a quem cria contas de novo. |
| **Registo para o futuro:** o histórico de créditos não é apagado com a sessão; fica anonimizado (plano do E). | O registo financeiro tem de sobreviver para auditoria. |
| **Aviso de devolução:** quem recebe um crédito de volta vai ser avisado (plano do F). | A pessoa deve saber porque é que o saldo mudou. |

## R2 — Cêntimos e soma exata

| Regra | Porquê |
|---|---|
| Os valores são arredondados a **2 casas decimais**, e as partes somam **exatamente** o total da fatura, ao cêntimo, em todos os ecrãs. | Ninguém aceita uma divisão que não bate certo com a fatura. |
| O cêntimo que sobra (ou falta) com o arredondamento é atribuído pelo anfitrião: ao anfitrião, a quem tem o valor mais alto, ou à roleta. A escolha fica gravada na sessão e todos veem o mesmo. | Um cêntimo tem de ficar com alguém, e todos têm de ver a mesma coisa. |
| **Itens sem dono:** o servidor não deixa finalizar enquanto houver **unidades** que ninguém escolheu, e mostra quantas faltam ("1 de 2 Moskow Mule sem dono"). Conta unidades por item, quer a fatura tenha uma linha com quantidade 2, quer duas linhas de 1 (R12). | Se uma unidade fica sem dono, as partes não somam a fatura. Antes, quem escolhia 1 de 2 pagava as duas. |
| **Itens partilhados:** só paga uma parte de um item partilhado quem também o escolheu ou aceitou a partilha (R12). | **Ninguém paga o que não escolheu.** |
| **Quem sai de um item partilhado:** a parte de quem saiu da sessão é dividida pelos que ficaram a partilhar essa unidade. | O item continua a ter de ser pago na totalidade, por quem o escolheu. |
| **A divisão soma sempre o total impresso na fatura**, não a soma dos itens. "Total do talão" é sempre o total impresso. Não há "Grand total" sem explicação. | O grupo paga a conta que o restaurante cobra. No Oligark (30-10-2026), a divisão usou a soma dos itens (6.100 ₺) em vez do total impresso (6.700 ₺), e o grupo pagou 600 ₺ a menos. |
| **Itens abaixo do total impresso, sem linha que explique a diferença:** a revisão mostra a diferença a vermelho com a pergunta **"É um encargo ou falta um item?"**. As respostas são "Adicionar item em falta" ou "É um encargo". Continuar fica desligado até o anfitrião responder. | Só pela aritmética, um encargo sem linha e um item que a leitura perdeu são iguais. Repartir um item perdido como encargo daria o total certo e as partes erradas. |
| **Sugestão pré-escolhida:** quando há pistas, a resposta mais provável vem já escolhida, mas o anfitrião confirma sempre. As pistas são: as categorias de IVA impressas somam o total impresso e não os itens (como no Oligark); ou aparecem palavras como serviço, servis, service ou couvert. | Poupa trabalho quando a fatura dá a resposta, sem decidir pelo anfitrião. |
| **Um encargo confirmado é repartido na proporção do que cada um escolheu**, e aparece na parte de cada um com o nome que o anfitrião lhe der (por omissão, "Encargo"). | Quem consumiu mais paga mais do encargo, e cada pessoa vê de onde vem o valor. |
| **Itens acima do total impresso:** a pergunta passa a ser **"É um desconto ou um item a mais?"**, com o Continuar desligado até o anfitrião responder. Um desconto confirmado é repartido da mesma forma. | Pode ser um desconto sem linha ou um erro de leitura. Só o anfitrião, com o papel na mão, sabe qual. |
| **O estado da fatura vem do parser.** Quando o parser diz que a fatura não bate certo, a app nunca mostra "os totais coincidem". Só o mostra depois de a diferença ter resposta do anfitrião. | A app dizia "os totais coincidem" porque comparava os itens com a soma deles próprios. |

## R3 + R7 — Sem créditos e entrada numa sessão

| Regra | Porquê |
|---|---|
| **"Start split" fica bloqueado a 0 créditos:** aparece um diálogo, e o OK abre o ecrã de créditos. | Começar uma divisão leva ao scan, que custa dinheiro. |
| **"Join with QR" abre sempre o leitor**, com qualquer saldo. | Só depois de ler o QR se sabe se a pessoa já faz parte da sessão. |
| Depois de ler o QR, **o servidor decide o ecrã de entrada** (`join_preview`). | A decisão é do servidor, e é a mesma na app e na web. |
| **Já fez parte da sessão** (R11): é o anfitrião atual ou original, ou entrou e confirmou alguma vez nesta sessão (passou por `joined`), mesmo que depois tenha carregado em Sair. Mostra o ecrã de rejoin e entra **com qualquer saldo**. A exceção é quem foi retirado da divisão (R11). | Já pagou ou ainda vai pagar ao finalizar. Não faz sentido bloquear quem volta. |
| **Entrada nova, com créditos:** ecrã de confirmação normal. Conta como entrada nova quem nunca confirmou, incluindo quem só leu o QR e cancelou na confirmação. | É uma entrada normal na divisão. |
| **Entrada nova, a 0 créditos:** "Não tens créditos para te juntar à sessão de <anfitrião>", com Comprar créditos e Cancelar. Depois de comprar, a app volta ao mesmo ecrã, sem ler o QR outra vez. Na web: "instala a app para comprar créditos". | Na web não se compram créditos. |
| **Sessão fechada:** "Esta sessão já terminou." **Sessão cheia:** "Sessão cheia." **QR inválido ou sessão inexistente:** cada caso tem a sua mensagem, sempre com contexto. | A pessoa tem de perceber o que se passa. |
| **Privacidade:** antes de entrar, o ecrã só mostra o nome do anfitrião e o número de pessoas. Nada da fatura nem de valores. | Quem não entrou não tem de ver a conta dos outros. |
| **O QR lido pela câmara do telemóvel** (fora da app), e qualquer link `…/session/<id>`, abre o mesmo ecrã de entrada. | Há um só caminho de entrada, com as mesmas regras. |
| **O aviso "voltar à sessão"** do ecrã inicial usa a mesma regra do "já fez parte". | É coerente com o QR. |

## R10 — Revisão da fatura em espelho

Pedida pelo dono a 03-11-2026.

| Regra | Porquê |
|---|---|
| **Cabeçalho:** "Confirmar a fatura · Passo 2 de 3 · Compara com o papel", com a barra de passos (Foto, Confirmar, Dividir) e a moeda com "Alterar". | O anfitrião sabe onde está e o que tem de fazer. |
| **Cartão com aspeto de papel**, com as linhas na ordem da fatura e os números no formato e na moeda da fatura. As linhas iguais (mesmo nome, sem contar maiúsculas e espaços, e o mesmo preço unitário) aparecem juntas, **só neste ecrã**. | Compara-se linha a linha com o papel. |
| **Estados das linhas:** vermelho claro com "!" (por confirmar), verde claro com "✓" (confirmada), sem destaque (sem dúvidas). Há uma legenda por baixo. Os avisos saem do painel do topo e passam para as linhas, em português claro. | O que falta ver está à vista, no sítio certo. |
| **Fim da fatura:** Soma dos itens, os encargos, a diferença respondida (por exemplo "+ Encargos sem linha 600,00") e "TOTAL IMPRESSO ✓". Por baixo, "Os 600,00 são repartidos na proporção do que cada um escolheu." | A conta lê-se como no papel. |
| **A pergunta da diferença (R2)**, "É um encargo ou falta um item?", é uma linha vermelha no fim da fatura. Abre o mesmo painel de resposta, com a sugestão pré-escolhida e o nome do encargo. | Está onde a diferença aparece. |
| **Painel de correção** (de baixo para cima) ao tocar numa linha: o recorte da foto dessa linha (com a posição que o parser envia), o nome, a quantidade com − / + de 48×48, o preço unitário e o total da linha, calculado sozinho. Tem Apagar e Guardar. Guardar põe a linha a verde. | Corrige-se a olhar para o papel. |
| **Continuar** só fica ativo sem linhas a vermelho ("Confirma N linhas para continuar"), com a diferença respondida, a moeda conhecida e o total impresso preenchido. | Nada segue para a divisão por confirmar. |
| Ficam **"Adicionar item em falta"** e **"Ver a foto inteira"**. A gratificação sugerida (R13) fica para depois. | — |

## R11 — Voltar a uma sessão onde já se esteve, e retirar da divisão

Pedida pelo dono a 01-11-2026. Substitui a parte da R7 sobre "quem saiu antes de pagar".

| Regra | Porquê |
|---|---|
| **Quem já fez parte volta sempre:** pelo QR, pelo código ou pelo aviso de rejoin, **com qualquer saldo**, mesmo depois de ter carregado em Sair. "Já fez parte" é ser o anfitrião atual ou original, ou ter entrado e confirmado alguma vez nesta sessão. O servidor guarda isto numa marca na linha da pessoa, que nunca volta a falso. | Quem esteve na divisão e saiu por engano tem de poder voltar. O registo é do servidor, por isso a app não o consegue forjar. |
| **Quem só cancelou na confirmação** (nunca confirmou) conta como **entrada nova**: a 0 créditos vê "Não tens créditos para te juntar…". | Nunca esteve na divisão. |
| **Sessões novas** continuam bloqueadas a 0 créditos (R3 e R7). | O scan custa dinheiro. |
| **Voltar a 0 créditos sem ter pago esta sessão:** ao entrar aparece o aviso "Tens 0 créditos. Podes voltar, mas precisas de 1 crédito antes de o anfitrião finalizar.", com **Comprar créditos** e **Continuar**. | A pessoa sabe logo que tem de resolver o crédito, antes de bloquear o grupo. |
| **O finalizar** continua a exigir 1 crédito a quem está presente e ainda não pagou (R1). | Voltar não é pagar. |
| **Retirar da divisão:** quando o finalizar é recusado por alguém presente estar a 0 créditos, o diálogo do anfitrião tem, para cada nome, o botão **"Retirar da divisão"**. Só o **anfitrião atual** o pode fazer. Passa por um RPC no servidor, com a escrita verificada. | Uma pessoa sem crédito não pode bloquear o grupo inteiro. |
| **Estado próprio:** a pessoa retirada fica `removed`, que é diferente de `left`. Fica no registo de estados, com quem a retirou. | Tem de se saber se a pessoa saiu ou foi retirada, e por quem. |
| **Itens de quem é retirado:** os itens que só ela escolheu ficam sem dono, e o anfitrião redistribui-os no diálogo dos itens sem dono. Nos itens partilhados, a parte dela é dividida pelos que ficaram. Funciona como quando alguém sai (R2). | As partes continuam a somar a fatura. |
| **Créditos de quem é retirado:** não lhe é cobrado nada. Se já tinha sido cobrada nesta sessão (num finalizar anterior), recebe a devolução (R1). | Só paga quem fica na divisão final. |
| **A pessoa retirada vê** "O anfitrião retirou-te desta divisão por falta de créditos." e volta ao ecrã inicial. | Tem de perceber o que aconteceu. |
| **Voltar depois de ser retirada:** só com pelo menos 1 crédito. A 0 créditos vê a mensagem de falta de créditos com o botão para comprar. | Para não bloquear o grupo outra vez. |
| **Retirar no lobby** (pedido pelo dono a 02-11-2026): o **anfitrião atual** vê "Retirar da divisão" junto de quem está **desligado há mais de 3 minutos** (o sinal da R6b, o último sinal de vida da app dessa pessoa). Nunca junto de quem está ligado, nem de quem nunca enviou sinal. O servidor confirma os 3 minutos antes de retirar. | Uma pessoa que desapareceu não pode bloquear o grupo. |
| **Confirmação antes de retirar no lobby:** "Os itens de <nome> ficam sem dono e vão ser divididos pelos outros. <nome> pode voltar à sessão." | O anfitrião sabe o que acontece aos itens. |
| **Quem é retirado por ausência:** o mesmo que no "Retirar da divisão" (não é cobrado, os itens ficam livres, recebe o aviso), mas o aviso é "O anfitrião retirou-te desta divisão porque estiveste ausente.". Pode voltar **com qualquer saldo se já tiver pago esta sessão**; senão, com pelo menos 1 crédito. | O motivo é a ausência, não a falta de créditos. |
| **Os 3 minutos** deste "Retirar" são independentes dos 5 minutos da troca de anfitrião (R6b). | São regras diferentes, com tempos diferentes. |
| **O anfitrião pode retirar qualquer pessoa** (pedido pelo dono a 04-11-2026): no lobby, só o **anfitrião atual** vê "Retirar da sessão" junto de cada participante presente (nunca de si próprio), **sem esperar** pelos 3 minutos. Antes de retirar, a confirmação "Os itens de <nome> ficam sem dono e vão ser divididos pelos outros.". A pessoa vê "O anfitrião retirou-te desta sessão." e vai para o início. Se a pessoa estiver desligada há mais de 3 minutos, o mesmo botão retira-a por ausência (com o aviso "porque estiveste ausente"). | O anfitrião decide quem fica na divisão. |
| **Depois de uma troca de anfitrião (R6b)**, o botão passa para o novo anfitrião e o antigo deixa de o ter. O servidor só aceita o pedido do anfitrião atual. Quem foi retirado assim volta com qualquer saldo se já pagou esta sessão; senão, com pelo menos 1 crédito (R11). | Só quem gere a sessão pode retirar alguém. |

## R12 — Unidades, seleção ao vivo e partilhas com confirmação

Pedida pelo dono a 02-11-2026, depois da colisão de 01-11-2026 (dois aparelhos ficaram com o mesmo Moskow Mule e o outro ficou sem dono). **Princípio: ninguém paga o que não escolheu. Partilhar é escolher o mesmo item.**

**Unidades**

| Regra | Porquê |
|---|---|
| **O servidor decide as unidades.** Cada toque em +/− ou na linha pede ao servidor "N unidades deste item". O servidor bloqueia a sessão e entrega as unidades livres por ordem. Nunca há duas pessoas na mesma unidade, a não ser numa partilha. | Cada aparelho escolhia "a primeira livre" sem saber do outro. |
| **Cada escolha é gravada logo**, e não só no Done. | Os outros veem-na ao vivo, e o servidor decide com o que está gravado. |
| **Sem unidades livres**, a resposta é "cheio", com os nomes de quem as tem. | A pessoa sabe com quem falar. |
| **O servidor recusa escritas diretas** que ponham duas pessoas na mesma unidade sem partilha. | Protege as apps antigas e o web. |
| **Sair antes de finalizar liberta os itens** de quem sai; se voltar, escolhe de novo. **Depois de finalizar**, quem sai continua na divisão com a sua parte, e os itens não ficam livres. Fechar a app não é sair (A1). | Antes de finalizar, os outros precisam desses itens; depois, a divisão já está fechada. |
| **O mesmo item** é a mesma categoria, o mesmo nome (sem contar maiúsculas e espaços) e o mesmo preço unitário. | São as linhas que a seleção mostra juntas. |
| **Nenhum botão manda `selections: []` ao servidor.** "Editar" mantém as escolhas, para corrigir. Para tirar um item, desmarca-se. | Cada toque já está gravado: não há rascunho para deitar fora. |
| **"Cancelar" depois do Done** pede primeiro confirmação: "Vais perder todas as tuas escolhas. Os itens ficam livres para os outros.", com **Cancelar escolhas** e **Voltar**. Ao confirmar, todas as unidades dessa pessoa são libertadas no servidor (cada escrita com o limite de 10 s e mensagem se falhar), o estado volta a `selecting`, e a pessoa fica no lobby com a linha a mostrar **Editar**, sem roda. Quem partilhava itens com ela recebe o aviso "deixou de partilhar". | Desistir das escolhas é uma decisão clara, e quem partilhava fica a saber o que passa a pagar. |

**Seleção ao vivo**

| Regra | Porquê |
|---|---|
| Quando alguém escolhe um item, mesmo antes do Done, o **símbolo dessa pessoa** aparece no extremo direito da linha, em todos os aparelhos, em tempo real. Desmarcar tira-o. | Todos veem quem escolheu o quê enquanto escolhem. |
| **O símbolo é um círculo com as iniciais na cor da pessoa** (R4; da 9.ª pessoa em diante, o meio círculo da R4b). Não se usam emojis. Iniciais repetidas na sessão passam a duas letras ("RI", "RU"). | Duas pessoas nunca se confundem. |
| **O próprio** vê "Tu" no seu símbolo, e as linhas que escolheu ficam destacadas. | Vê logo o que é seu. |
| **Mais de 3 pessoas no mesmo item:** 3 círculos e "+N". Tocar nessa zona abre a lista dos nomes. | A linha não transborda. |
| **Itens com quantidade maior do que 1** mostram quantas unidades estão livres ("1 de 2 livre"). | Sabe-se se ainda há uma para escolher. |
| **O lobby** tem a legenda: cada círculo com o nome ao lado. | Liga cada símbolo a uma pessoa. |
| **Em todas as perguntas, avisos e diálogos** aparecem os nomes, nunca só ícones. | Um ícone sozinho não diz quem é. |

**Partilha automática**

| Regra | Porquê |
|---|---|
| **Item com uma unidade:** se várias pessoas o escolhem, fica partilhado por elas, em partes iguais. Ninguém precisa de convidar ninguém. | Escolher o mesmo item é partilhá-lo. |
| **Item com várias unidades:** tocar dá uma unidade livre. Sem nenhuma livre, aparece "Os 2 Moskow Mule já foram escolhidos, por <nome> e <nome>. Partilhaste algum? Com quem?", com a lista de quem tem unidades. Escolher um nome é partilhar **a unidade dessa pessoa** (por exemplo, o C escolhe o B: A paga 1.100, B paga 550, C paga 550). | Só se divide a unidade que foi mesmo partilhada. |
| Na parte de cada um aparece "Moskow Mule (partilhado com <nome>) 550,00". | Cada um vê com quem dividiu. |
| **Deixar de partilhar:** quem larga uma unidade partilhada não precisa de perguntar, e quem fica paga a unidade toda. Essa pessoa recebe o aviso "<nome> deixou de partilhar o <item>. Agora pagas X em vez de Y." | Ninguém fica a pagar mais sem saber. |

**Pedido de partilha** (quando alguém se esqueceu de escolher)

| Regra | Porquê |
|---|---|
| **Botão "Partilhar"** em cada linha da seleção. Abre as pessoas do lobby (círculo e nome), sem o próprio, e dá para escolher várias. Quem já está no item aparece marcado: cor viva se confirmado, esbatido se pendente. | Quem se lembra da partilha pode lembrar o outro. |
| **Estado de cada pessoa na linha do item:** esbatido = pedido à espera; cor viva = confirmado (escolheu ou aceitou); com um X = rejeitou. | Vê-se de relance o que falta. |
| **Pedido resolvido sozinho**, verificado no servidor ao gravar o pedido: num item com uma unidade, se o convidado já o escolheu, fica logo confirmado, sem pedido nem aviso; se o pedido estiver pendente e o convidado escolher o item por conta própria, fica aceite. Num item com várias unidades, só fica aceite sozinho se o convidado já estiver **na mesma unidade**. Se tiver outra unidade do mesmo item, o pedido vai na mesma, com "Já tens o teu Wisky Sour. O <nome> diz que também bebeste metade do dele. Se aceitares, pagas mais 550,00." ("bebeste" nas bebidas, "comeste" na comida, "partilhaste" no resto; "parte" em vez de "metade" quando já são mais de dois). Quando o pedido fica confirmado sozinho, não há aviso nem janela para ninguém: o círculo do convidado fica com cor viva. Os avisos são só para pedidos que precisam de resposta, rejeições e "deixou de partilhar". | Não se pergunta o que já está respondido, e ninguém paga duas unidades sem confirmar. |
| **Quem recebe o pedido** vê no lobby um ícone no seu cartão e a faixa "Tens N pedidos de partilha"; na seleção, a linha do item também o mostra. Cada pedido mostra o valor: "O <nome> diz que partilhaste o Arroz de Pato (24,00 €). Se aceitares, pagas 8,00 €.", com **Aceitar**, **Rejeitar** e **Aceitar todos** quando há vários. Quem já fez Done responde no lobby, e o Done mantém-se. | A pessoa decide sabendo quanto paga. |
| **Rejeição:** quem pediu vê o símbolo do convidado com um X nessa linha e o aviso "O <nome> rejeitou partilhar o <item>.". O X desaparece quando quem pediu toca nele ou volta a mexer nesse item. Depois de uma rejeição, só se pode voltar a convidar a mesma pessoa para o mesmo item **uma vez**, seja quem for que pede. | Quem pediu fica a saber, e o convidado não é insistido. |
| **O finalizar fica bloqueado** enquanto houver pedidos por responder; o servidor recusa com a lista. No lobby todos veem o resumo ("2 partilhas à espera de resposta"). O anfitrião vê a lista ("Arroz de Pato — Bruno; Vinho — Carla"), com **Lembrar** e **Cancelar pedido**. Quem pediu também pode cancelar o seu. | Não se fecha a conta com uma partilha por decidir. |
| Se o convidado **sair da sessão ou for retirado** (R11), os seus pedidos caem sozinhos. Não há limite de tempo automático. | Quem já não está não pode responder. |
| **Créditos:** nada muda (R1). | Partilhar não é uma sessão nova. |

## C.2 — O anfitrião e o estado dos outros

| Regra | Porquê |
|---|---|
| O anfitrião só pode mudar o estado de outro participante pelas transições que a app usa (por exemplo, devolver alguém à seleção). Pagos e "coberto por" só mudam pelas funções do servidor, e só o anfitrião as pode usar. | Ninguém deve conseguir pôr outra pessoa num estado que a faça pagar ou não pagar sem saber. |
| **"Marcar todos como pagos"** é uma função do servidor que só o anfitrião pode usar. | Registar pagamentos é responsabilidade de quem está a receber o dinheiro. |

## R4 / R4b — Cores, ordem e limite de 26

| Regra | Porquê |
|---|---|
| **O servidor dá a cor**, uma vez por pessoa e por sessão. A cor nunca muda e nunca se repete na sessão, e a app não a consegue escrever. | A mesma pessoa tem a mesma cor em todos os aparelhos e do princípio ao fim. |
| **O verde é exclusivo do anfitrião original.** Fica com ele mesmo depois de uma troca de anfitrião. | O verde identifica quem abriu a sessão. |
| **Da 2.ª à 8.ª pessoa:** 7 cores sólidas. **Da 9.ª em diante:** meio círculo com duas cores (18 pares). Nenhum par usa verde, nenhum par se confunde com uma cor sólida, e os pares estão ordenados para daltónicos os distinguirem. | Distinguir pessoas sem cinzentos nem repetições, também para quem é daltónico. |
| **Limite de 26 pessoas por sessão** (1 verde, 7 sólidas e 18 pares). A 27.ª pessoa é recusada com "sessão cheia". Contam todas as linhas da sessão, também de quem saiu, porque as cores não se reutilizam. Quem já tem linha volta sempre. | Assim nunca há cinzento nem cores repetidas. |
| **Ordem nas listas:** primeiro o anfitrião atual, depois eu, depois os outros por ordem de entrada. É igual em todos os aparelhos. | Todos veem a mesma ordem, e cada um encontra-se logo. |

## R5 — Pedido para cancelar o countdown

| Regra | Porquê |
|---|---|
| **Qualquer participante** pode pedir para cancelar o countdown depois de o anfitrião finalizar. O countdown **pausa para todos**. | Quem se enganou na escolha pode parar antes de a divisão ficar fechada. |
| **O anfitrião vê Aceitar e Recusar.** | É ele quem conduz a divisão. |
| **Aceitar:** todos voltam à seleção, com as escolhas que tinham. Ninguém volta a pagar. | Corrigir uma escolha não pode custar créditos. |
| **Recusar:** o countdown continua de onde parou. | Não se perde o tempo que já tinha passado. |
| **Só um pedido de cada vez.** O pedido fica guardado no servidor e não expira: a pausa dura até o anfitrião, ou um novo anfitrião, decidir. | Evita pedidos em cadeia, e ninguém fica preso porque o anfitrião se desligou (ver R6b). |

## R6b — Troca de anfitrião e ecrã de pagamentos

| Regra | Porquê |
|---|---|
| **A troca vale desde que a sessão é criada até ser fechada.** | Um anfitrião que desaparece não pode bloquear a divisão em nenhuma fase. |
| **Há algo à espera do anfitrião** (um pedido de cancelar pendente, ou todos os presentes já fizeram Done e falta finalizar) e ele está há mais de **15 s sem a app no ecrã**: troca. Os 15 s contam a partir do mais recente de dois momentos: a última vez que ele teve a app no ecrã e o início da espera. | Há pessoas paradas à espera dele. Com o telemóvel no bolso, o anfitrião não pode decidir, mesmo que a app ainda envie sinal. |
| **Não há nada à espera** (lobby enquanto as pessoas escolhem, ecrã de pagamentos): o anfitrião pode bloquear o telemóvel ou mudar de app à vontade. Só troca depois de **5 minutos seguidos sem nenhum sinal**; os sinais em segundo plano contam. | É ele que está a receber o dinheiro: não pode perder o papel por pousar o telemóvel ou abrir o MB Way. |
| **O anfitrião sai de propósito** ("Sair e passar"): troca logo. Se não houver mais ninguém na sessão, a sessão termina. | A saída é intencional. |
| **Um anfitrião que nunca enviou sinal** (versão antiga da app) nunca é trocado. | Não se tira o papel a quem não se consegue medir. |
| **Quem recebe o papel:** o servidor escolhe a primeira pessoa presente, por ordem de entrada, que teve a app **no ecrã** nos últimos 15 s. Depois de finalizar, só pode ser alguém da divisão congelada. | Tem de ver o pop-up e conseguir agir. A ordem de entrada é justa e previsível. |
| **Há sempre uma só troca, e nunca dois anfitriões.** Só o servidor muda o anfitrião, e cada troca fica registada com o motivo. | Evita o problema de dois anfitriões de 6 de outubro, e qualquer troca pode ser explicada. |
| **O novo anfitrião pode fazer tudo:** finalizar, decidir pedidos de cancelar, marcar pagos (um a um ou todos), atribuir o cêntimo e fechar. | As permissões seguem o anfitrião atual, não quem criou a sessão. |
| **O novo anfitrião vê um pop-up:** "O anfitrião <nome> desligou-se. Agora és tu o anfitrião." Inclui o pedido de cancelar (Aceitar/Recusar) se houver; "Todos escolheram os itens. Podes finalizar." se todos fizeram Done; e "És tu que registas quem já pagou." no ecrã de pagamentos. **Os outros** veem "<nome> é agora o anfitrião." | Cada pessoa sabe o que mudou e o que tem de fazer. |
| **A troca não cobra nem devolve créditos.** **As cores não mudam:** o anfitrião original fica verde e com a etiqueta "Anfitrião original". **Se o anfitrião original voltar**, entra como participante. | A troca só muda quem conduz a divisão, nada mais. |
| **Ecrã de pagamentos:** não expira **enquanto está a ser usado**. Só fecha sozinho depois de **7 dias sem atividade** (ver "Ciclo de vida da sessão"), e mesmo assim os pagos continuam a poder ser registados pelo anfitrião atual. O pagamento faz-se **fora da app** (no restaurante, MB Way, Revolut ou como o grupo combinar). O anfitrião, ou quem o substituir, só **regista** quem pagou e, no fim, marca todos como pagos e fecha. O ecrã diz isto claramente. | A app não movimenta dinheiro, só ajuda a registar os pagamentos. |
| **O histórico** segue o anfitrião atual lido do servidor. | Os botões de anfitrião ficam com quem é anfitrião de facto. |

## R8 — Código de sessão

| Regra | Porquê |
|---|---|
| **Cada sessão tem um código curto**, alternativo ao QR. É gerado pelo servidor quando a sessão é criada, e a app não o pode escrever nem mudar. | Há browsers e aparelhos onde não se pode usar a câmara, e sem o código essas pessoas não conseguiam entrar. |
| **Formato:** 6 caracteres, sem caracteres que se confundem (sem `0/O` nem `1/I/L`), mostrados como `ABC-234`. Na entrada aceitam-se minúsculas, espaços e o hífen, ou a falta dele. São 31 símbolos, o que dá 887 503 681 códigos. | Tem de ser fácil de ditar e de escrever sem erros. |
| **Único e nunca reutilizado**, nem depois de a sessão fechar ou ser apagada. | Um código antigo nunca pode levar a outra sessão. |
| **Uma sessão fechada mantém o código.** Ao introduzi-lo aparece "Esta sessão já terminou." | É a mesma resposta do QR (R7). |
| **Entrar pelo código é exatamente o mesmo que entrar pelo QR:** o servidor devolve a sessão, e o ecrã de entrada da R7 decide (rejoin, créditos, sessão terminada, sessão cheia). Um código que não existe dá "Código inválido. Confirma com o anfitrião." | Há um só caminho de entrada, com as mesmas regras de créditos (R1, R3, R7). |
| **Contra tentativas às cegas:** só com sessão iniciada; no máximo 10 códigos errados por pessoa em 10 minutos. Depois disso aparece uma mensagem com o tempo de espera. Antes de entrar só se vê o nome do anfitrião e o número de pessoas. | Com códigos curtos é preciso travar quem tenta adivinhar, e a privacidade da R7 mantém-se. |
| **O código aparece no lobby, ao lado do QR**, em letra grande e com um botão Copiar, para o anfitrião e para os participantes. Também vai no texto de partilha. | Qualquer pessoa já presente o pode passar a quem chega depois. |
| **O botão de entrada chama-se "Entrar com código QR / código da sessão"** e abre um ecrã com as duas opções. Sem câmara (permissão recusada, aparelho sem câmara ou browser que não a suporta), o ecrã mostra logo o campo do código e uma linha a dizer porquê. | Ninguém fica sem forma de entrar. |
| **Nenhum link usa o parâmetro `code`.** | O `code=` é reservado ao retorno do login. |

## Ciclo de vida da sessão (decisões do D)

| Regra | Porquê |
|---|---|
| **Uma sessão sem atividade fecha sozinha.** Conta como atividade qualquer alteração à sessão ou a uma linha de participante, e qualquer sinal de presença de um aparelho. Os prazos: **sem fatura, 2 h**; **com fatura, antes de finalizar, 24 h**; **em pagamento, 7 dias**. | Sessões abandonadas não podem ficar abertas para sempre, a aparecer no aviso de rejoin e no ecrã de entrada. |
| **Uma sessão que já passou o prazo conta logo como terminada**, mesmo antes de o servidor a fechar: o ecrã de entrada diz "Esta sessão já terminou" e o aviso de rejoin não a mostra. O servidor fecha-a de 15 em 15 minutos. | Ninguém vê uma sessão abandonada à espera do próximo fecho. |
| **Cada fecho fica registado**, com quem ou o quê fechou, o motivo e a última atividade. | Um fecho pode sempre ser explicado. |
| **O anfitrião atual pode sempre terminar a sessão**, com ou sem fatura. | Uma sessão sem fatura não pode prender ninguém. |
| **O crédito de um scan bem-sucedido não é devolvido** quando a sessão acaba sem fatura. Os erros nossos continuam a ser devolvidos (R1). | Um scan com sucesso já custou o OCR. Devolvê-lo permitiria OCR grátis sem fim (fazer scan, ver o resultado, sair, receber o crédito). |
| **O resultado de um scan bem-sucedido fica gravado na sessão, no servidor.** Se a app cair depois do scan, o anfitrião volta à revisão com esse resultado, sem pagar outra vez. "Esta sessão ficou sem fatura" fica só para quando o scan nunca teve sucesso. (No D.4.) | Quem pagou o scan não perde o resultado. |
| **Uma sessão fechada não muda.** A exceção são os pagos (e "coberto por"), que **só o anfitrião atual** pode continuar a registar depois do fecho. (No D.3.) | O que foi fechado fica como estava; registar quem pagou pode acontecer dias depois. |
| **As partes de cada pessoa (`total_owed`) ficam gravadas no servidor.** A app do anfitrião envia-as, e o servidor só as aceita se somarem exatamente o total e nenhuma for negativa. (No D.6.) | O histórico e os outros aparelhos leem os mesmos valores, sem depender do telemóvel do anfitrião. |

## R9 — Uma só sessão de login por conta

| Regra | Porquê |
|---|---|
| **O último login ganha.** Quando uma conta entra num aparelho (app ou web, Google ou email), todas as outras sessões de login dessa conta terminam. Se dois logins acontecerem quase ao mesmo tempo, ganha o último que o servidor registar; nunca ficam os dois. | A mesma conta ligada em dois sítios confunde a presença, o anfitrião e as escritas. |
| **É imediato:** o aparelho antigo é avisado em tempo real; ao voltar ao primeiro plano, ao arrancar ou ao voltar a ter rede, verifica outra vez. O servidor recusa as escritas importantes (join, seleção, Done, finalizar, pagos, scan) de uma sessão de login que já não é a ativa, com o erro `SESSION_REPLACED`. | Terminar as sessões no Supabase não chega: um aparelho ligado continua com o acesso válido até ele expirar. |
| **O aparelho expulso** mostra "A tua conta entrou noutro dispositivo. Terminámos a sessão aqui." e vai para o ecrã de login. | A pessoa percebe o que aconteceu. |
| **Uma divisão a meio não se perde:** no aparelho novo, o aviso de rejoin leva a pessoa ao ponto onde estava, com as seleções e o Done. A presença e o sinal passam para o aparelho novo. **Um anfitrião que muda de aparelho continua anfitrião**: isto não provoca troca de anfitrião. | É a mesma pessoa. |
| **A mesma regra na app e na web**, com o mesmo RPC. | Um só caminho. |

---

## Decisões em aberto (não fazem parte das regras até serem decididas)

- **D:** em curso, pelos sub-blocos D.1 → D.5 → R9 → D.3 → D.4 → D.2 → D.6 → D.7.
- **E:** registo de créditos anonimizado quando uma sessão é apagada.
- **F:** aviso de devolução de crédito e traduções do ecrã de boas-vindas.
- **Fase 1:** domínio para os links universais. Espera pela decisão do domínio.
