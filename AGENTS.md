# Pick&Pay — Codex

**As regras de produto em `docs/regras-de-produto.md` (R1 a R9) são obrigatórias. Qualquer alteração a elas tem de ser pedida pelo dono do projeto, Ricardo Costa.**

## Diálogos
Nunca usar `Alert.alert`: no react-native-web não faz nada (o logout da web
falhava por isso). Usar sempre `showDialog` de `lib/dialog.ts`, com a mesma
assinatura. `npm run check:alerts` falha se aparecer algum fora de `lib/dialog.ts`.

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless absolutely necessary — prefer editing existing files
- NEVER create documentation files unless explicitly requested
- NEVER save working files or tests to root — use `/src`, `/tests`, `/docs`, `/config`, `/scripts`
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- Keep files under 500 lines
- Validate input at system boundaries
