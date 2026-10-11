# Aprovação do proprietário e proteção de main

A autorização ampla registrada em [AUTHORIZATIONS.md](AUTHORIZATIONS.md)
permite continuar G3–G6, condicionados à evidência do portão anterior, sem nova
confirmação rotineira. Ela não cria um comentário, uma revisão ou uma identidade
GitHub em nome do proprietário.

## Autorização G4 do SHA final

O [workflow de autorização](../../.github/workflows/owner-approval.yml) carrega
o [verificador](../../scripts/verify-owner-authorization.mjs) da base confiável,
nunca do HEAD avaliado. Ele aceita um `workflow_dispatch` real em `main`, com
`mpcaliman` como ator e autor do disparo, número do PR, SHA completo do HEAD e
referência exata `G4-PR-N`. O PR deve estar aberto, pronto e apontar para `main`
no mesmo repositório. O workflow precisa estar integrado à base antes desse
despacho.

O próprio despacho verifica sua execução e seu job em andamento. Eventos
posteriores só reconhecem uma prova por status do bot oficial GitHub Actions
quando a API confirma execução e job concluídos com sucesso, evento e branch
corretos, identidade do proprietário, workflow ID/caminho e título vinculados
ao PR/SHA. O commit deve pertencer ao histórico de `main`, com os blobs do
workflow e do verificador iguais aos da implementação confiável atual.
Descrições de status e reruns não substituem essa prova.

Comentários genuínos do proprietário continuam sendo uma alternativa. A linha
deve conter somente a decisão exata:

```text
SOFT-AUTORIZACAO G4-PR-225 <SHA completo do HEAD avaliado> merge
```

Esse exemplo não registra um comentário publicado. Mudança de SHA exige prova
para o novo HEAD. Revogação posterior invalida a autorização; em empate de
datas, a revogação vence. A data do despacho original determina a decisão, de
modo que repetir um status antigo não a renova.

## Proteção proposta e estado remoto

O [ruleset](../../.github/rulesets/main.json) exige PR, resolução das discussões,
CI e autorização específica; bloqueia exclusão e force push, sem atores de
bypass. A proposta usa `required_approving_review_count: 0` e
`require_last_push_approval: false`: revisão independente não é exigida pela
Regra de Ouro 3. CODEOWNERS mantém a responsabilidade do proprietário, sem
inventar uma revisão de seu próprio PR.

O [CLI administrativo](../../scripts/configure-repository-governance.mjs)
mostra a proposta offline, permite inspeção e exige administração no alvo,
checks observados no HEAD e estabilidade de PR/`main` antes de aplicar. Depois
confere o detalhe completo do ruleset. `permissions.admin: true` informa o
papel no repositório; não identifica pessoalmente o proprietário nem
garante que a credencial possa usar todos os endpoints administrativos.

Na execução atual, o workflow Pages de ID `310367403` foi desativado e a
desativação foi confirmada. Pages continua com `build_type: legacy`, origem
`main` e caminho `/`. A tentativa de mudar essa origem por PUT retornou
`403 Resource not accessible by integration`. Desativar o workflow não contém
a publicação por branch; essa origem ainda precisa ser corrigida antes de um
merge que possa publicar.

O POST de instalação do ruleset bootstrap pelo CLI com `node --use-env-proxy`
também retornou `403`.
**O ruleset não foi aplicado.** A configuração local e os testes não comprovam
proteção ativa. Esses bloqueios são de capacidade da credencial nos endpoints,
não ausência de autorização geral para continuar o trabalho.

O [plano de execução](GOVERNANCE-EXECUTION-2026-10-10.md) detalha a sequência e
o limite do contexto de status: a origem Actions, sozinha, não distingue qual
workflow o publicou. Uma garantia contra outro escritor malicioso requer um
emissor restrito ou uma regra organizacional de workflow obrigatório.

O [Pages proposto](../../.github/workflows/pages.yml) exige disparo G5 real do
proprietário em `main`, SHA atual exato, CI aprovada e baseline com matriz de
homologação autenticada validada; publica exclusivamente `dist`. Esses
requisitos locais não significam que essa versão esteja instalada ou que uma
publicação tenha sido realizada.
