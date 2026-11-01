# Pick&Pay — Regras de produto

Estas regras são **obrigatórias**. Nenhuma pode ser alterada sem pedido explícito do dono do projeto, Ricardo Costa.
- O servidor (Supabase) é sempre quem decide e quem garante cada regra. A app só mostra o resultado.
- Uma app modificada não consegue contornar nenhuma delas.

Estado a 01-11-2026: R1 a R9, com as decisões do D (o D.1 já aplicado) e a R2 alargada ao total impresso. Os relatórios com os pormenores estão em `docs/relatorios/`.

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
| **Itens sem dono:** o servidor não deixa finalizar se houver itens que ninguém escolheu. Mostra quais são. | Se um item fica sem dono, as partes não somam a fatura. |
| **Itens partilhados:** só paga uma parte de um item partilhado quem também o escolheu. Se alguém é indicado como "partilha" mas não escolheu o item, o servidor recusa e mostra quem é. | **Ninguém paga o que não escolheu.** |
| **Quem sai de um item partilhado:** a parte de quem saiu da sessão é dividida pelos que ficaram a partilhar esse item. | O item continua a ter de ser pago na totalidade, por quem o escolheu. |
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
| **Já faz parte da sessão:** anfitrião atual ou original; ou estado `pending`, `joined`, `selecting` ou `items_picked`; ou saiu depois de já ter pago esta sessão. Mostra o ecrã de rejoin e entra **com qualquer saldo**. | Já pagou ou ainda vai pagar ao finalizar. Não faz sentido bloquear quem volta. |
| **Entrada nova, ou saiu antes de pagar, com créditos:** ecrã de confirmação normal. | É uma entrada normal na divisão. |
| **Entrada nova, ou saiu antes de pagar, a 0 créditos:** "Não tens créditos para te juntar à sessão de <anfitrião>", com Comprar créditos e Cancelar. Depois de comprar, a app volta ao mesmo ecrã, sem ler o QR outra vez. Na web: "instala a app para comprar créditos". | Na web não se compram créditos. |
| **Sessão fechada:** "Esta sessão já terminou." **Sessão cheia:** "Sessão cheia." **QR inválido ou sessão inexistente:** cada caso tem a sua mensagem, sempre com contexto. | A pessoa tem de perceber o que se passa. |
| **Privacidade:** antes de entrar, o ecrã só mostra o nome do anfitrião e o número de pessoas. Nada da fatura nem de valores. | Quem não entrou não tem de ver a conta dos outros. |
| **O QR lido pela câmara do telemóvel** (fora da app), e qualquer link `…/session/<id>`, abre o mesmo ecrã de entrada. | Há um só caminho de entrada, com as mesmas regras. |
| **O aviso "voltar à sessão"** do ecrã inicial usa a mesma regra do "já faz parte". | É coerente com o QR. |

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
