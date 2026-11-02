# Revisão em espelho (R10), total impresso (R2) e os dois bugs da fatura

Fatura de referência: Oligark Istanbul, 07/10/2026 (`corpus/oligark-istanbul.jpg`).
No papel: 6 itens que somam 6.100,00 e um total impresso de ₺ 6.700,00. O IVA
também soma 6.700 (659,02 + 6.040,98). Há um encargo de 600,00 sem linha
própria.

Ordem combinada: total impresso → moeda → avisos falsos → A2 … C1 → R10 → C2 → A6.

---

## 0. Que total dividiu a sessão? (investigado a 2026-11-01, só leitura)

**Dividiu 6.100. O grupo pagou menos 600 ₺ do que a conta.**

| Sessão | Criada | `printed_total` | Encargos | Ajuste | Itens divididos |
|---|---|---|---|---|---|
| `769a93a9` | 30/10 19:53 | 6700 | nenhum | nenhum | 6.100 (1.100 + 2.200 + 2.800) |
| `75cadfcb` | 30/10 20:08 | 6700 | nenhum | nenhum | 6.100 |

**Porquê:**
- `utils/splitter.ts` divide os itens, os encargos (`globalCosts`), a gorjeta e o
  ajuste de cêntimos. A diferença sem linha nunca é um encargo, por isso fica de fora.
- A revisão (`app/(app)/review-receipt.tsx:198`) compara os itens com
  `computedTotal`, que é a soma dos próprios itens. Por isso diz sempre "Os totais
  coincidem".
- "Total do talão" mostra essa mesma soma (6.100). O total impresso (6.700) só
  aparece como "Grand total" e nunca é verificado.
- O parser não errou aqui: respondeu `reconciles=false`, com 6100 contra 6700.

As duas sessões estão fechadas e não mudam.

## Regra nova (junta-se à R2)

A divisão soma sempre o total impresso:
- **Itens < total impresso, sem linha de encargo** (serviço, couvert, taxa) → a
  diferença é um encargo, repartido na proporção do que cada um escolheu, e
  aparece na revisão.
- **Itens > total impresso** → desconto ou erro de leitura. A revisão pede ao
  anfitrião que confirme.

**O corpus com esta regra:** nenhum total muda nas leituras que batem certo.

| Fatura | Itens | Encargos com linha | Total impresso | Diferença |
|---|---|---|---|---|
| Quebra Mar | 300,25 | 0 | 300,25 | 0 |
| Ramires | 76,20 | 0 | 76,20 | 0 |
| Sulbarreiro | 8,25 | 0 | 8,25 | 0 |
| Mad God | 363,55 | 0 | 363,55 | 0 |
| Augustiner, 1.ª leitura | 62,00 | 0 | 96,50 | **34,50** |
| Augustiner, 3200 | 96,50 | 0 | 96,50 | 0 |
| Oligark | 6.100,00 | 0 | 6.700,00 | **600,00** |

**Cuidado com a 1.ª leitura do Augustiner.** Os 34,50 não são um encargo: são o
item "3 × Currywurst", que a leitura perdeu. Só pela aritmética, um item em falta
e um encargo sem linha são iguais. Repartir os 34,50 dá o total certo, mas uma
divisão errada entre as pessoas.

**Decidido pelo dono a 2026-11-01 (R2 atualizada em `docs/regras-de-produto.md`):**
- **Itens abaixo do total:** a diferença fica a vermelho, com "É um encargo ou
  falta um item?". Os botões são "Adicionar item em falta" e "É um encargo". O
  Continuar fica desligado até o anfitrião responder.
- **Itens acima do total:** a pergunta é "É um desconto ou um item a mais?".
- **Sugestão pré-escolhida** quando há pistas:
  - as bases de IVA impressas somam o total impresso, e não os itens;
  - ou aparecem palavras como serviço, servis, service ou couvert.
- **Nome do encargo:** o anfitrião pode dar-lhe um nome, que aparece assim na
  parte de cada um.
- **Repartição:** um encargo confirmado é repartido na proporção do que cada um
  escolheu.
- **Estado da fatura:** vem do parser. Se o parser diz que não bate certo, a app
  nunca mostra "os totais coincidem".

**A pista do IVA tem de tolerar erros de leitura.** No Oligark, o OCR de
2026-11-01 leu a segunda base como `6.040.08` em vez de `6.040,98`. Somadas,
as duas bases dão 6.699,10 e não 6.700,00. Por isso a pista compara com uma
margem pequena e só serve para pré-escolher a resposta. Quem decide é sempre o
anfitrião.

**Garantia no servidor:** é o servidor que verifica que as partes somam o total
impresso, e isso entra com o D.6 (`total_owed` verificado). Até lá, a regra só
é cumprida na app.

---

## 1. Moeda

- **O parser acertou:** respondeu `TRY` (leitura de 2026-11-01).
- **A app trocou para EUR:** só conhece 12 moedas (`lib/receipt/money.ts:12`, sem
  TRY), e uma moeda desconhecida passa a EUR sem aviso
  (`lib/receipt/normalizer.ts:418`).
- **Outros sítios a corrigir:**
  - o parser também usa EUR quando o modelo não devolve moeda
    (`parse-receipt/index.ts:614`);
  - há `?? "EUR"` no dashboard, no histórico, na revisão e no texto de partilha;
  - a formatação só aceita EUR, USD, GBP e CAD.
- **O corpus:** as 5 faturas chegam em EUR, que é a moeda certa.

## 2. Avisos falsos — o "antes"

**De onde vêm:** a verificação é da app (`lib/receipt/evidence.ts:27`). Procura o
valor escrito como `1100.00` ou `1100,00` dentro da linha.

**Contagem:**
- a mesma leitura do parser, sem OCR novo para as 5 do corpus;
- a verificação da app, importada sem alterações;
- "depois" é uma pré-visualização num script, não na app.

| Fatura | Agora | Só formatos (`1.100,00`) | Formatos + unidade × qtd |
|---|---|---|---|
| Oligark | 5 | 0 | 0 |
| Quebra Mar | 10 | 10 | 0 |
| Ramires | 4 | 3 | 0 |
| Sulbarreiro | 0 | 0 | 0 |
| Mad God | 0 | 0 | 0 |
| Augustiner, 1.ª leitura | 1 | 1 | 0 |
| Augustiner, 3200 | 0 | 0 | 0 |

**Há um segundo tipo de aviso falso.** Exemplo: `3 Uni SAFATA DE PAO 5,25`. A app
procura o preço unitário (1,75), mas o papel só imprime o total da linha
(1,75 × 3 = 5,25). Também não há diferença de valor, por isso entra no ponto 2
(aprovado pelo dono a 2026-11-01).

**Na app, a Oligark mostrava 9 avisos.** Os 4 que faltam na tabela vêm do
diagnóstico de "não bate certo" (6.100 ≠ 6.700). Desaparecem quando a regra do
total impresso estiver feita.

**A correção:**
- ler os números da linha com `parseMoneyString`, o mesmo algoritmo que o
  `parseAmbiguousNumber` do ledger;
- um espaço só conta como separador de milhares antes de um grupo de 3
  algarismos: `1 100,00` é 1100, mas `1 1.100,00` fica quantidade 1 e 1100;
- aceitar o preço unitário ou unitário × quantidade;
- um teste garante que um erro de leitura verdadeiro continua a gerar aviso.

---

## Total impresso (R2): feito a 2026-11-01

Só mexe na app. Não há nada em produção nem no parser.

### O que mudou

**Revisão da fatura** (`review-receipt.tsx`, `GuidedClosingStep.tsx`):
- **Comparação:** os itens comparam com o total impresso menos os encargos que
  têm linha própria, e nunca com a soma deles próprios.
- **"Total do talão":** é sempre o total confirmado no passo 1, que por omissão
  é o impresso.
- **Saem do ecrã:** o "Grand total" e as caixas em inglês "Items don't add up" e
  "Small discrepancy".
- **Diferença por responder:** o cartão vermelho `PrintedTotalGapCard` pergunta
  "É um encargo ou falta um item?". Quando os itens passam o total, pergunta
  "É um desconto ou um item a mais?".
- **Sugestão:** fica pré-escolhida quando há pistas, que são as bases de IVA ou
  as palavras serviço, servis, service ou couvert. Mesmo assim, só o
  "Confirmar" responde à pergunta.
- **Nome do encargo:** o anfitrião escolhe-o. Por omissão é "Encargo".
- **Continuar:** fica desligado com "Responde à diferença para continuar". O
  "Aceitar mesmo assim" do FIX 44 deixa de existir, por decisão do dono.
- **"Os totais coincidem":** só aparece quando batem mesmo, contando a
  diferença respondida.
- **Itens mudados depois de responder:** a diferença muda e a pergunta volta.

**Fatura gravada:**
- a resposta passa a ser um encargo `unlined_gap`, com
  `split: "proportional"` e o nome dado pelo anfitrião;
- a validação compara itens + encargos com o total impresso.

**Divisão** (`utils/splitter.ts`):
- o encargo proporcional reparte-se pelo que cada um escolheu, ao cêntimo, pelo
  método do maior resto;
- os outros encargos continuam a dividir-se em partes iguais.

**Onde aparece o nome do encargo:**
- na parte de cada um (`BreakdownCard`, dashboard e texto de partilha);
- na estimativa da seleção.

**Traduções:** 20 textos novos, nas 5 línguas.

### Testes automáticos

`npm run test:receipt` passa 83/83, dos quais 14 são novos:
- diferenças para menos e para mais;
- sem total impresso;
- uma resposta só vale para a diferença em que foi dada;
- a pista do IVA no Oligark, mesmo com o erro de OCR;
- as palavras de serviço;
- o Augustiner sem sugestão;
- o encargo nomeado;
- a divisão do Oligark: 1.208,20 + 2.416,39 + 3.075,41 = 6.700,00;
- um desconto proporcional;
- os encargos normais continuam a dividir-se em partes iguais.

### Testes no telemóvel (passo R2)

**R2-1 — Oligark, o scan.** O anfitrião A lê a fatura em papel ou a foto
`corpus/oligark-istanbul.jpg` no ecrã.
1. No passo do total aparece 6.700,00.
2. No fecho aparece o cartão vermelho "Faltam 600,00 … para o total impresso.",
   com "É um encargo" já escolhido e a sugestão.
3. O botão diz "Responde à diferença para continuar" e não reage.
4. "Confirmar" deixa o cartão verde: "Encargo · +600,00" e "Os 600,00 são
   repartidos na proporção do que cada um escolheu."
5. "Aceitar" leva ao lobby.

Logs esperados:
- `[review-receipt] R2 gap answered: charge "Encargo" 600`
- `[review-receipt] R2: items 6100 + charges 0 + gap 600 = printed 6700 (ok)`

A moeda ainda aparece em €. Isso é o ponto seguinte.

**R2-2 — a divisão.** Escolhas como no dia 30/10:
- A: 1 Moskow Mule;
- B: Art of Bosphorus + 1 Moskow Mule;
- C: Çerez & Meyva + 2 Wisky Sour.

No dashboard, as partes são 1.208,20, 2.416,39 e 3.075,41, e somam 6.700,00.
Cada pessoa vê a linha "Encargo +108,20", "+216,39" ou "+275,41".

**R2-3 — mudar a resposta.** Na revisão: "Alterar", depois "Adicionar item em
falta" com um item de 600. A diferença passa a 0, aparece "Os totais
coincidem" e não fica nenhum encargo.

**R2-4 — uma fatura que bate certo** (Ramires ou Quebra Mar): não aparece
cartão vermelho, aparece "Os totais coincidem", e o Continuar está ativo.

### Resultado do teste (2026-11-01) e correções

R2-1, R2-3 e R2-4 passaram. No R2-2 as contas estavam certas (1.208,20 +
2.416,39 + 3.075,41 = 6.700,00), mas o dashboard tinha três erros:

1. **Na parte de cada pessoa aparecia "Discount +108,20".**
   - *Causa:* o cartão escolhia o nome por omissão uma só vez, quando aparecia
     no ecrã. Se aparecia antes de a diferença ser "a menos" (ou quando ainda não
     havia diferença), ficava com o nome do desconto e gravava-o no encargo.
   - *Correção:* o nome por omissão segue sempre a diferença atual, até o
     anfitrião escrever outro.
   - *Nota:* a sessão já gravada mantém "Discount". Para testar outra vez, é
     preciso um scan novo, ou "Alterar" na revisão.
2. **O resumo do topo dizia "Service 600,00".**
   - *Correção:* passa a mostrar cada encargo pelo nome que tem na fatura.
   - O texto de partilha e o histórico já usavam o nome do encargo, por isso
     ficam certos com o ponto 1.
3. **Com as duas unidades de Wisky Sour, a mesma pessoa via "2200,00 ÷2 of
   2200,00".**
   - *Causa:* o "÷N" contava unidades, não pessoas.
   - *Correção:* cada pessoa vê quantas unidades escolheu ("2 × 1.100,00"). O
     "÷N" só aparece quando as mesmas unidades são mesmo partilhadas, ou seja,
     quando foram escolhidas mais unidades do que as que o item tem.
   - Está corrigido no dashboard, no cartão de cada pessoa e no texto de
     partilha.

São 3 testes novos. O `test:receipt` passa 86/86.

**Fica para depois:** o ecrã de pagamentos está em inglês e mostra números como
`6700.00€`. O formato vai no ponto da moeda, e os textos no A6.

### Fica por fazer

- **No servidor:** a verificação de que as partes somam o total impresso. É o
  4.º ponto da lista (D.6).
- **Textos ainda fixos em português no fecho guiado:** "Confirmação", "As contas
  batem certo." e "Soma dos pratos". Vão no A6 e no C2.

## Estado

- O total impresso (R2) está feito na app e falta testar no telemóvel.
- Seguem-se a moeda e os avisos falsos.

---

## Moeda: feito a 2026-11-02

Só mexe na app. Não há nada em produção nem no parser.

### O que mudou
- **A fatura fica com a moeda dela.**
  - A app passa a conhecer 46 moedas ISO 4217 (`lib/receipt/money.ts`), em
    vez de 12, com TRY, INR, CHF, PLN e outras.
  - Lê também os símbolos ₺ e TL, ₹, ₩, ฿, ₪, zł, Kč e Ft.
  - A fatura da app deixou de trocar para EUR tudo o que não fosse EUR, USD,
    CAD ou GBP (`lib/receipt/adapter.ts`).
- **Quando há dúvida, pergunta ao anfitrião.** Se o parser não der moeda, ou
  der uma que a app não conhece, a fatura fica marcada (`currencyAssumed`).
  - A revisão mostra o cartão vermelho "Qual é a moeda desta fatura?".
  - O cartão tem as moedas mais comuns e o campo "Outra (ex.: CHF)".
  - "Confirmar total" e "Continuar" ficam desligados até haver resposta:
    "Escolhe a moeda para continuar".
- **O anfitrião pode sempre corrigir.**
  - Numa fatura com moeda conhecida, a revisão mostra "Moeda: TRY (₺) ·
    Alterar", no passo 1 e na lista completa.
  - A moeda escolhida é a que fica gravada na sessão.
  - Log: `[review-receipt] currency chosen by the host: …`.
- **Um só formato em todos os ecrãs** (`utils/formatter.ts`):
  - a moeda da fatura, com as casas decimais dela (o JPY não tem);
  - os separadores da língua da app: "6.700,00 ₺" em português, espanhol e
    francês, e "₺6,700.00" em inglês e chinês;
  - o ecrã de pagamentos mostrava "6700.00€";
  - um valor negativo fica "-5,00 €", e uma moeda sem símbolo fica
    "12,50 CHF".
- **Símbolos escolhidos à mão:**
  - a seleção escolhia entre €, £, C$ e $, e agora usa o símbolo da fatura;
  - na revisão antiga, "→ €0.00" passa a usar a moeda da fatura.

### Verificação no corpus
São as mesmas leituras do parser, sem OCR novo: as 11 do FIX 43 e a do Oligark.
Passaram pelo caminho da app, com o código de antes (commit `6cd3ed2`) e com o
de agora.

| Fatura | Parser | App antes → agora | Total mostrado antes → agora |
|---|---|---|---|
| Augustiner | EUR | EUR → EUR | 96.50€ → 96,50 € |
| Mad God | EUR | EUR → EUR | 363.55€ → 363,55 € |
| Quebra Mar | EUR | EUR → EUR | 300.25€ → 300,25 € |
| Ramires | EUR | EUR → EUR | 76.20€ → 76,20 € |
| Sulbarreiro | EUR | EUR → EUR | 8.25€ → 8,25 € |
| Buca di Beppo, Hollywood Cafe, Zoca | USD | USD → USD | $109.28 → 109,28 $ |
| Mademoiselle, Pai | CAD | CAD → CAD | C$376.97 → 376,97 C$ |
| VRO Bengaluru | INR | **EUR → INR** | 5226.00€ → 5.226,00 ₹ |
| Oligark | TRY | **EUR → TRY** | 6700.00€ → 6.700,00 ₺ |

**0 diferenças** em itens, somas, totais e estado, nas 12 faturas.

### Testes automáticos
`npm run test:receipt` passa 102/102. Os 7 testes novos estão em
`lib/receipt/__tests__/currency.test.ts`:
- TRY continua TRY;
- ₺ e TL são lidos como TRY;
- uma moeda desconhecida ou em falta fica marcada para o anfitrião;
- os valores não mudam com a moeda;
- os formatos em português e em inglês;
- o JPY sem cêntimos;
- o sinal negativo.

### Fora do âmbito, não corrigido (é o parser)
- `parse-receipt/index.ts:614`: quando o modelo não devolve moeda, o parser
  responde `EUR`. A app não consegue distinguir isso de um EUR verdadeiro.
- Por isso o "Alterar" está sempre visível na revisão.
- Para a app perguntar também nesse caso, o parser teria de mandar a moeda
  vazia. É uma mudança no parser, e só com a tua aprovação.

### Teste no telemóvel (moeda)
1. **M-1, Oligark:** o anfitrião A lê `corpus/oligark-istanbul.jpg`.
   - No passo 1 aparece "Moeda TRY (₺) · Alterar", e o total em ₺.
   - No lobby, na seleção e no dashboard os valores aparecem como
     "1.100,00 ₺". No ecrã de pagamentos, o total é "6.700,00 ₺".
2. **M-2, corrigir:** em "Alterar", o anfitrião escolhe EUR.
   - Todos os ecrãs da sessão passam a €.
   - Log: `[review-receipt] currency chosen by the host: EUR (was TRY)`.
3. **M-3, língua:** muda a língua da app para inglês. O mesmo total aparece
   como "₺6,700.00".
4. **M-4, Ramires ou Quebra Mar:** continua em €, com "76,20 €".
