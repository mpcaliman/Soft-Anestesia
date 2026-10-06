# Registro de autorizações técnicas

Este registro aplica a Regra de Ouro 3: cada portão exige autorização expressa de Marcelo. Uma autorização não se transfere automaticamente ao portão seguinte.

| Data (UTC) | Cartão | Portão autorizado | Evidência/resultado | Ainda não autorizado |
|---|---|---|---|---|
| 2026-10-05 | Plano técnico | G0 — planejar sem alterar código | Plano e auditoria preservados | Implementação, push, ambiente remoto e produção |
| 2026-10-05 | A1 — contenção de XSS | G1 — implementação e commit local | Branch `codex/a1-xss-containment`, commit `8fac20d`; 254 testes aprovados | Push, PR, homologação, merge e deploy |
| 2026-10-05 | E0 — baseline de engenharia | G1 — implementação, validação e commit local | Branch `codex/e0-engineering-baseline`; `npm ci` e 253/253 testes aprovados no pacote público | Push, PR, criação/alteração de Supabase remoto, merge e deploy |
| 2026-10-06 | E0 — baseline de engenharia | G2 — publicar branch e abrir PR | Autorização explícita: “Autorizar g2 da e0”; branch `codex/e0-engineering-baseline` | Supabase remoto, merge e deploy |
| 2026-10-06 | Correções da auditoria | G1 — implementar e validar localmente todas as correções técnicas apontadas | Autorização explícita: “Autorizo fazer todas modificação apontadas pela auditoria. Todas necessárias.”; execução em cartões isolados, testáveis e rastreáveis | G2 de cada novo cartão, homologação/Supabase remoto, merge e deploy |

## Portões

- **G0:** planejar e auditar, sem modificar código.
- **G1:** implementar e testar localmente; pode gerar commit local quando autorizado.
- **G2:** publicar branch e abrir PR.
- **G3:** criar ou alterar homologação/Supabase remoto e executar migrações de teste.
- **G4:** aprovar merge.
- **G5:** publicar em produção.
- **G6:** confirmar produção e encerrar o cartão.

DDL manual em produção, dados reais em testes e reutilização implícita de autorização são proibidos.
