# Pick&Pay — Claude Code

**As regras de produto em `docs/regras-de-produto.md` (R1 a R9) são obrigatórias. Qualquer alteração a elas tem de ser pedida pelo dono do projeto, Ricardo Costa.**

## Windows shell
Nunca passar código em linha a um shell (node -e, python -c, shell: true).
Escrever sempre o script para ficheiro e correr o ficheiro: fica registado,
pode ser revisto e corrido outra vez.
(Os ficheiros-lixo na raiz, com nomes de fragmentos de código, não vinham do
node -e: vinham dos hooks do Ruflo, que corriam `cmd /c` pelo Git Bash e
executavam como comandos o JSON de cada ferramenta. Foram retirados a
2026-10-29, no C3-fix5.)

## Tarefas em segundo plano
Nunca usar ScheduleWakeup para esperar por uma tarefa em segundo plano.
A tarefa já notifica quando termina. Usar ScheduleWakeup fora de /loop
faz os relatórios repetirem-se.

## parse-receipt: flags de funcionalidade

`supabase/functions/parse-receipt/index.ts`:

- **`GEOMETRIC_RECONSTRUCTION_ENABLED`** (FIX 42, default `true`). Controla
  qual método de reconstrução de linhas o OCR usa (`ocr.ts`,
  `reconstructLines`/`normalizeVisionResponse`). Ligada por decisão de
  produto (não por critério de medição — o critério do FIX 39 vetava; ver o
  commit do FIX 42 para os números do que se ganha/perde). Para reverter
  **sem alterar código nem fazer deploy**: definir a env var
  `GEOMETRIC_RECONSTRUCTION_ENABLED=false` nas definições do projeto
  Supabase. O valor efetivamente usado em cada corrida fica registado no
  log de diagnóstico (`geometricReconstructionEnabled`).
- **`DOUBLE_STRUCTURE_READ_ENABLED`** (FIX 41, default `false`). Corre a
  passagem de estruturação do GPT duas vezes e compara os resultados
  (`structureAgreement.ts`); desligada — ver o relatório do FIX 41 para o
  porquê (custo >2x, uma das faturas aprovadas desceu de taxa).

`scripts/debug-parse-receipt.ts` espelha o mesmo `GEOMETRIC_RECONSTRUCTION_ENABLED`
através do CLI: ligado por omissão, `--legacy-lines` força o caminho antigo
(reconstrução por ordem/quebras) para comparação lado a lado. `--doubleread`
liga o FIX 41 nesta ferramenta, tal como acima.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- Keep files under 500 lines
- Validate input at system boundaries
