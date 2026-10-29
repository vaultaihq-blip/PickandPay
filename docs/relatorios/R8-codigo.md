# R8: código de sessão e botão "Join with QR code / Session code"

- **Migração:** `supabase/migrations/20261029170000_r8_join_code.sql`, **aplicada** em produção e verificada.
- **Reversão:** `supabase/rollback/20261029170000_r8_pre_state_and_rollback.sql`, ensaiada.
- **App:**
  - `lib/joinCode.ts` (novo);
  - `components/session/QRScanner.tsx`, reescrito com as duas opções;
  - `app/(app)/session/join.tsx`;
  - o lobby;
  - as traduções.
- **Regras:** a R8 foi acrescentada a `docs/regras-de-produto.md`. A linha "obrigatórias" no `CLAUDE.md` e no `AGENTS.md` diz agora R1 a R8.
- **Créditos:** nada muda. Entrar pelo código é o mesmo que entrar pelo QR (R1, R3, R7).

## Servidor (aplicado)

### O código

- **Alfabeto:** `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, com 31 símbolos: os algarismos de 2 a 9 e as letras sem I, L e O. Não tem `0/O` nem `1/I/L`.
- **Combinações:** 31⁶ = **887 503 681**.
  - Com 1000 sessões por dia, ao fim de 10 anos estariam usados cerca de 0,4 % dos códigos.
  - Os códigos nunca se reutilizam, por isso só se esgotariam ao fim de milénios.
- **Formato:** 6 caracteres, guardados sem hífen (`ABC234`) e mostrados como `ABC-234`. Uma restrição na coluna garante o formato.
- **Geração:** quando a sessão é criada, um trigger antes da inserção chama `new_join_code`.
  - Tira bytes aleatórios do `pgcrypto` e descarta os que ficariam enviesados, para cada símbolo sair com a mesma probabilidade.
  - Regista o código em `session_join_codes`. Se o código já lá estiver, tenta outro.
  - É atómico: ou a sessão nasce com um código novo, ou não nasce.
- **Nunca reutilizado:** `session_join_codes` guarda todos os códigos já dados e nunca é esvaziada.
  - Não tem chave estrangeira para a sessão, por isso o código sobrevive mesmo que a sessão seja apagada (por exemplo, no futuro E).
  - Um código antigo nunca leva a outra sessão.
- **A app não o escreve:**
  - a app só pode inserir `host_id`, `receipt_data` e `status`, e só pode alterar `receipt_data` e `status` (não mudou);
  - o trigger também impede que o código mude depois de dado, mesmo do lado do servidor;
  - os participantes leem o código como o resto da sessão; o RLS decide quem vê a linha.
- **Sessão fechada:** mantém o código.
- **Backfill:** as 268 sessões não fechadas receberam código, sem tocar em `updated_at`. As 91 fechadas não receberam, como pedido.

### Entrar pelo código: `resolve_join_code(texto)`

- **Só com sessão iniciada.** Sem sessão iniciada dá 42501, e o perfil `anon` não pode chamar a função.
- **Normaliza a entrada:** passa a maiúsculas e tira espaços e hífenes. `abc 234`, `ABC-234` e ` abc234 ` dão o mesmo resultado.
- **Respostas:**
  - `found` com o `session_id`: só isso, nada da sessão. A app segue para o `join_preview` e para o ecrã de entrada da R7, tal como o QR.
  - `invalid` com `attempts_left`: o código não existe, ou era de uma sessão apagada.
  - `rate_limited` com `retry_after_s`.
- **Limite:** 10 códigos errados por pessoa em 10 minutos.
  - O 11.º pedido dá `rate_limited`, mesmo que o código esteja certo, para não deixar continuar a adivinhar.
  - O limite é por pessoa; outra pessoa continua a poder entrar.
  - As tentativas ficam em `join_code_attempts`, só no servidor, durante um dia.
  - Cada pessoa é verificada uma vez de cada vez, por isso pedidos em paralelo não passam o limite.
- **Privacidade:** a resposta só traz o resultado e o id. O ecrã de entrada mostra só o nome do anfitrião e o número de pessoas, como na R7.

### Nome do parâmetro

**Nenhum link nem rota leva o código.** O código só passa dentro da chamada ao servidor (`p_code`).
- Se um dia houver um link com o código (Fase 1), proponho o caminho `/j/ABC234`. Nunca o parâmetro `code`, porque o `isAuthCallbackUrl` trataria o link como retorno do login.
- Dentro da app, o código anda como `joinCode`.
- Isto está escrito no topo de `lib/joinCode.ts` e na R8.

## App

### Ecrã de entrada (`QRScanner` + `join.tsx`)

- **Duas opções no mesmo ecrã:** a câmara em cima e, sempre por baixo, o campo "Código da sessão" com o botão **Entrar**.
  - O campo formata enquanto se escreve (`ABC-234`), passa a maiúsculas e ignora espaços e hífenes.
  - Um código com a forma errada mostra logo "Código inválido" sem ir ao servidor, e por isso não conta para o limite.
- **Sem câmara**, o ecrã mostra o campo e uma linha a dizer porquê:
  - **permissão recusada:** "Sem acesso à câmara: insere o código da sessão.", com "Permitir câmara" se o sistema ainda deixar perguntar, ou "Abrir definições" se não deixar;
  - **aparelho sem câmara**, ou câmara que não arranca: "Este aparelho não tem câmara disponível: insere o código da sessão.";
  - **browser sem acesso à câmara:** "Este browser não deixa usar a câmara: insere o código da sessão."
- **Na app**, a permissão é pedida logo ao abrir o ecrã, enquanto o sistema deixar.
- **No web**, a câmara só é pedida quando a pessoa carrega em "Usar a câmara", porque um pedido de permissão logo ao abrir a página é intrusivo. O campo do código está sempre lá.
- **Mensagens:** "Código inválido. Confirma com o anfitrião." e "Demasiados códigos errados. Tenta outra vez daqui a N min." ficam no ecrã até à tentativa seguinte.
- **Depois de encontrar a sessão:** o resto é o caminho da R7, sem mudanças (rejoin, sem créditos, terminada, cheia).
- **Logs:**
  - `[join] resolve_join_code: found|invalid (N attempts left)|rate_limited`, seguido de `[join] join_preview: …`;
  - sem câmara: `[join] no camera (denied|device|browser) — showing the session code field`.

### Lobby

- **Cartão do convite, ao lado do QR:** "Código da sessão" e o código em letra grande, monoespaçada, com espaço entre letras (`ABC-234`), e o botão **Copiar**, que passa a "Copiado".
  - O cartão é o mesmo para o anfitrião e para os participantes, por isso todos o veem.
  - Fica dentro do cartão do convite, visível sem fazer scroll.
- **Ao tocar no QR para o ampliar:** o código aparece também por baixo, em letra ainda maior, para ditar.
- **Partilhar:** o texto inclui "Código da sessão: ABC-234".
- **Logs:** `[session-lobby] session code copied`, ou `[session-lobby] session code not available: …` se a leitura falhar.

### Botão do ecrã inicial

- **Texto:** "Join with QR code / Session code", com o descritivo "Scan a QR code or insert session code to join".
- **Em português:** "Entrar com código QR / código da sessão" e "Lê um código QR ou insere o código da sessão para entrar".
- **Também traduzido** em francês, espanhol e chinês, tal como os 16 textos novos do ecrã e do lobby.

## Verificação

- **Ensaio antes de aplicar:** 46 verificações numa transação revertida, todas como esperado.
  - **Backfill:** `B1` 268 sessões abertas com código e 0 sem; `B2` 0 fechadas com código; `B3` `updated_at` não tocado; `B4`/`B5` 268 códigos distintos, todos no registo.
  - **Gerador:** `G1` 3000 códigos, todos distintos; `G2`/`G3` nenhum com forma errada nem caracteres que se confundem; `G4` os 31 símbolos usados, entre 533 e 625 vezes cada (esperado cerca de 581).
  - **Criação e permissões:** `S1` a sessão criada pela app recebe código; `S2`/`S3` a app não consegue pôr nem mudar o código (42501); `S5` nem o servidor o muda depois de dado.
  - **Entrada:**
    - `E1`–`E3`: minúsculas com espaço, com hífen, e com espaços à volta dão `found`; a resposta só tem `result, session_id`.
    - `E4`: segue para o `join_preview`, que dá `join`. `E5`: a 0 créditos dá `no_credits`.
    - `E6`/`E7`: uma sessão fechada mantém o código e dá `closed`.
    - `E8`–`E10`: o código de uma sessão apagada fica no registo, não pode ser dado outra vez e dá `invalid`.
  - **Limite:** `R2` à 10.ª tentativa errada sobram 0; `R3` a 11.ª dá `rate_limited` com 600 s; `R4` até o código certo é recusado; `R5` outra pessoa não é afetada; `R7` passados 10 minutos volta a entrar.
  - **Quem pode chamar:** `P1`–`P4`: a app não lê o registo nem gera códigos; sem sessão iniciada e `anon` dão 42501.
- **Reversão:** ensaiada com migração e reversão, comparadas em 7 pontos (colunas, triggers, restrições, índices, permissões por coluna, objetos novos e `updated_at` e estado de todas as sessões). Resultado: **0 diferenças**.
- **Depois de aplicar:** a mesma bateria em produção deu o mesmo resultado, exceto as contagens por símbolo do gerador, que são aleatórias.
- **App:**
  - `tsc` sem erros e testes do recibo 69/69;
  - o bundle web (`expo export --platform web`) compila.
  - **Não testei num browser real nem num aparelho.** Em particular, não testei a leitura de QR pela câmara no web, que só aparece com "Usar a câmara"; é o teste 53.

## Notas

- **Reversão:** se se reverter, os códigos e o registo de códigos dados são apagados. Para manter a garantia de "nunca reutilizado" ao voltar a aplicar, copie antes a tabela `session_join_codes`. Está escrito no ficheiro de reversão.
- **Sessões antigas:** as sessões fechadas antes da R8 não têm código. Uma sessão antiga só se encontra pelo QR.
- **O ecrã web antigo** pedia o id inteiro da sessão (`session_…`). Foi substituído pelo campo do código.

## Testes novos

**52 (código no lobby):**
- O A cria uma sessão; o lobby mostra o código ao lado do QR, na app e no web.
- Copiar: o botão passa a "Copiado" e o código colado noutra app é `ABC-234`.
- O B e o C veem o mesmo código no lobby.
- Tocar no QR mostra-o ampliado, com o código por baixo.
- Partilhar inclui "Código da sessão: …".
- SQL: `select join_code from sessions where id = '<id>'`.

**53 (web sem câmara):**
- Num browser que bloqueia a câmara, carregar em "Entrar com código QR / código da sessão".
- Aparece o campo e, se o browser não tiver câmara, a linha "Este browser não deixa usar a câmara…".
- Escrever o código em minúsculas e com espaço (por exemplo `abc 234`) e carregar em Entrar: abre o ecrã de entrada da R7.
- Logs: `resolve_join_code: found` e `join_preview: join`.

**54 (app, permissão recusada):**
- Recusar a permissão da câmara: o ecrã mostra "Sem acesso à câmara: insere o código da sessão." e o campo.
- Entrar pelo código funciona.
- "Abrir definições" (ou "Permitir câmara") leva a dar a permissão.

**55 (respostas):**
- Um código bem formado que não existe (por exemplo `XXX-XXX`) dá "Código inválido. Confirma com o anfitrião."
- O código de uma sessão fechada dá "Esta sessão já terminou".
- A 0 créditos, o código de uma sessão nova dá "Não tens créditos para te juntar à sessão de …", tal como o QR.

**56 (limite):**
- 11 códigos errados seguidos, bem formados: use `XXX-XXX`. Um código com a forma errada não vai ao servidor e não conta.
- A partir do 11.º aparece "Demasiados códigos errados. Tenta outra vez daqui a 10 min."; até o código certo é recusado.
- Outra conta continua a entrar.
- SQL: `select count(*) from join_code_attempts where user_id = '<id>' and attempted_at > now() - interval '10 minutes'` dá 10.

**57 (línguas):**
- Mudar a língua da app para cada uma das 5. O botão e o descritivo do ecrã inicial, e o campo, os botões e as mensagens do ecrã de entrada, aparecem traduzidos.

## Onde recomeçar

1. O 52 e o 55, com dois aparelhos.
2. O 54 e o 56 num aparelho.
3. O 53 num browser.
4. O 57.
5. Depois, a lista que estava: 48, 44, 47, 51, 50, 45, 46.
