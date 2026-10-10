# Execução da governança — 10 de outubro de 2026

> **Atualização remota às 23:40 UTC.** O bootstrap v2 foi publicado no
> PR [228](https://github.com/mpcaliman/Soft-Anestesia/pull/228), commit
> `c23e6313e883680c93f758ccfb2fa97d091ee123`, árvore
> `c2e00f10187ff6682bb9ab576912f0f66d12af8a`. A atualização da branch usou
> lease no HEAD anterior `2f2fa71c8d1c14c2fa3b8e88f77e415d6358b0cb`, sem
> force push. A preparação offline e seu manifesto abaixo permanecem
> preservados como snapshot anterior à publicação. O resultado remoto é
> registrado separadamente; nenhum status ou aprovação foi fabricado.
> A nova CI ainda precisa ser conferida. A leitura remota de `main` retornou
> `protected: false`, e a lista de rulesets estava vazia; sua proteção não
> está demonstrada. A configuração atual de Pages não pôde ser consultada,
> e a última evidência era `legacy main /`. Esses controles continuam
> necessários antes de integrar o bootstrap ou o PR de correções em `main`.

Esta revisão corrige os controles propostos para corresponder à Regra de Ouro 3:
Marcelo deve autorizar a mudança. A autorização ampla já registrada em
[AUTHORIZATIONS.md](AUTHORIZATIONS.md) abrange a continuidade de G3–G6, sujeita
à validação anterior. Não é necessário repetir essa autorização rotineiramente.
Preparar estes arquivos e passar testes locais não comprova administração,
proteção ativa, homologação real, merge ou publicação remota.

## Correção da proposta anterior

A exigência de outra pessoa realizar uma revisão GitHub foi acrescentada pela
implementação de governança, não pela formulação da Regra de Ouro 3. A conta
`mpcaliman` é autora dos PRs e GitHub não permite que o autor aprove sua própria
revisão. Essa exigência adicional foi removida explicitamente: o ruleset usa
`required_approving_review_count: 0` e `require_last_push_approval: false`.
Continuam obrigatórios PR, resolução de discussões, CI e autorização real do
proprietário para o SHA final. Exclusão e force push de `main` continuam
bloqueados; não há atores de bypass. Não foi produzida uma revisão fictícia.

As instruções anteriores em
`GOVERNANCE-ACTIVATION-2026-10-09.md`, `GOVERNANCE-BOOTSTRAP-2026-10-10.md` e
`RESOLUTION-STATUS-2026-10-10.md` descrevem a proposta e as observações anteriores.
Este documento substitui a exigência de revisor independente e a exigência de
comentário como único meio de autorização. O gerador antigo
`prepare-governance-bootstrap.mjs` continua congelado na fonte anterior e não
deve ser usado como se gerasse este workflow/verificador atualizado.

## Pacote offline do bootstrap v2

O novo `scripts/prepare-governance-bootstrap-v2.mjs` mantém o gerador v1
intacto. Ele prepara um diretório novo fora do repositório e fixa os blobs Git
e SHA-256 do workflow, do verificador e do ruleset revisados. As fontes são
explicitamente um snapshot da árvore de trabalho, não arquivos falsamente
atribuídos a um commit. O SHA de checkout é contexto; o manifesto registra os
blobs encontrados nesse commit e se ele contém as fontes revisadas.

O pacote preparado está em `/tmp/soft-governance-bootstrap-v2-20261010`, com
`bootstrap.patch`, `manifest.json`, os três arquivos e dois JSONs administrativos
que ficam fora do commit do bootstrap. A base fixada é
`634f9e2ccfe86ec0174b845526b0f9f70159db34`; a árvore esperada do resultado é
`c2e00f10187ff6682bb9ab576912f0f66d12af8a`. O SHA-256 do patch é
`ff624ab9558383da4ca2ada7abd4619700d853978ca974fa9de863625a34ee8e`.

O patch altera exatamente `.github/workflows/owner-approval.yml`,
`.github/workflows/pages.yml` e `scripts/verify-owner-authorization.mjs`.
O workflow de autorização usa Node `24.19.0` diretamente, sem depender da
`.nvmrc` ausente em `main`. Pages permanece um stub manual, sem permissões,
checkout ou publicação, que termina em falha. Os quatro hashes das árvores da
base e suas ligações são recalculados antes da preparação; todos os outros
arquivos e modos são preservados como metadados, sem abrir conteúdo clínico.

```bash
node scripts/prepare-governance-bootstrap-v2.mjs --output /tmp/novo-diretorio
node tests/governance-bootstrap-v2-security.mjs
```

O gerador recusa fontes modificadas, saída dentro do repositório inclusive via
symlink e sobrescrita de diretório existente. A verificação independente do
pacote confirmou blobs/patch/árvores e aplicou o patch em pasta descartável,
reproduzindo os bytes esperados. A checagem YAML, a sintaxe do verificador e os
92 casos API passaram nessa cópia. O teste do gerador confirmou rejeições antes
de escrita, integridade do v1, três caminhos, sidecars e reconstrução do patch.
O executor recusou `git apply` como subprocesso do Node com `EPERM`; essa
checagem padrão foi feita separadamente pela verificação independente.

Não há commit criado, index/ref alterado ou operação remota nesta preparação.
O manifesto mantém `newCommitSha: null`, `applied: false` e
`mainMergeAllowed: false`. Publicar a revisão do PR não autoriza mesclá-la:
Pages ainda tem origem `legacy main /`, sua alteração retornou `403` e a
aplicação do ruleset também retornou `403`. Esses bloqueios administrativos
precisam ser resolvidos antes de qualquer push/merge em `main`.

## Resultados remotos observados nesta execução

Os resultados abaixo foram reportados pelo executor principal em 10 de outubro
de 2026. Não decorrem dos mocks locais.

| Operação | Resultado observado | Consequência |
| --- | --- | --- |
| Desativar o workflow Pages, ID `310367403` | Desativação executada e confirmada por nova leitura | O workflow Actions antigo está desativado |
| Consultar a origem de Pages | `build_type: legacy`, branch `main`, caminho `/` | A publicação por branch permanece configurada |
| Alterar Pages para Actions com `PUT /repos/mpcaliman/Soft-Anestesia/pages` | HTTP `403`, `Resource not accessible by integration` | A origem de Pages não foi alterada |
| Aplicar o ruleset bootstrap com `node --use-env-proxy` | O CLI chegou ao `POST /repos/mpcaliman/Soft-Anestesia/rulesets`, que retornou HTTP `403` | O ruleset não foi aplicado |

O repositório informou `permissions.admin: true`, mas esse papel não comprova
os escopos da credencial para cada endpoint. As recusas `403` são o resultado
efetivo para as operações administrativas tentadas. A identidade pessoal do
token não foi inferida desse papel.

Desativar o workflow Actions não suspende a origem `legacy` de publicação por
branch. Enquanto essa origem persistir, um push em `main` pode publicar a raiz.
Portanto, a contenção de publicação continua incompleta e o merge não deve
prosseguir com base somente na desativação do workflow. A origem Pages e a
aplicação do ruleset ainda precisam ser resolvidas por uma capacidade
administrativa que o GitHub aceite. Não houve SQL, merge ou publicação
autorizada pelo novo workflow nesses resultados.

## Autorização G4 por evento real

O workflow confiável `owner-approval.yml` aceita `workflow_dispatch` em `main`,
somente se `github.actor` e `github.triggering_actor` forem `mpcaliman`. Os
inputs são o número canônico do PR, seu HEAD completo e a referência exata
`G4-PR-N`. O PR deve continuar aberto, pronto, do mesmo repositório e com base
`main`. O SHA de `main` identifica o código confiável que executa o workflow;
o SHA do HEAD do PR identifica o diff autorizado. Esses SHAs não são tratados
como equivalentes.

O nome determinístico da execução vincula a referência e o HEAD. O próprio
despacho valida o evento, a execução e o job em andamento antes de publicar
status no SHA autorizado. A concorrência é serializada por PR e não cancela
uma execução anterior. Comentários reais do proprietário continuam válidos;
o agente não precisa publicar comentários em seu nome.

Em eventos posteriores, um status de sucesso serve apenas para localizar uma
possível prova. O verificador exige todos estes fatos obtidos pela API GitHub:

- status no SHA/contexto exatos, criado pelo bot oficial GitHub Actions, com
  URL de uma execução deste repositório;
- execução concluída com sucesso, `workflow_dispatch`, branch `main`,
  proprietário como ator e autor do disparo, primeira tentativa, workflow ID
  e caminho `owner-approval.yml`, título com PR/referência/SHA exatos;
- exatamente um job de autorização, concluído com sucesso;
- commit da execução pertencente ao histórico de `main`, com os blobs do
  workflow e do verificador iguais aos da implementação confiável atual.

Descrições de status, revisões, objetos de prova fornecidos por um chamador,
workflows definidos em branch e reruns não constituem autorização. Alterar
esses dois arquivos confiáveis invalida provas de versões anteriores até haver
nova autorização real. Respostas incompletas, falhas de API e datas inválidas
não são tratadas como autorização.

A data da decisão é `run.created_at`, não a data de um status repetido ou de um
rerun. Assim um status novo não renova uma autorização antiga. Revogações reais
do proprietário entram na mesma ordem das decisões; uma revogação posterior
invalida a autorização e uma revogação empatada vence. Um novo despacho real
posterior pode autorizar novamente. Comentários e HEAD são lidos novamente
depois da inspeção das provas antes de produzir o resultado.
O histórico consultado é o de comentários existentes: apagar uma revogação
remove essa evidência. Não há arquivo imutável de comentários apagados nesta
implementação; essa garantia exigiria um registro durável adicional.

## CLI administrativo limitado ao repositório

`configure-repository-governance.mjs` usa o `GH_TOKEN` já injetado normalmente
na autenticação. Não consulta `/user`, não imprime o token e não afirma que
capacidade administrativa identifica pessoalmente o proprietário. Confirma o
repositório, seu proprietário, a branch padrão e `permissions.admin`. A
identidade exigida para G4/G5 é conferida no evento real do Actions.

Sem `--inspect` ou `--apply`, o CLI apenas mostra a proposta offline. Com
`--inspect`, consulta a configuração atual sem escrever. A aplicação exige
`--pr`, verifica que os checks existem no HEAD real, relê PR e `main` contra
mudança concorrente e só então realiza um POST ou PUT. Depois lê o detalhe do
ruleset e compara regras, condições e bypass; nome e enforcement ativo sozinhos
não comprovam a configuração.

```bash
node scripts/configure-repository-governance.mjs --mode bootstrap
node --use-env-proxy scripts/configure-repository-governance.mjs --mode bootstrap --inspect
node --use-env-proxy scripts/configure-repository-governance.mjs --mode bootstrap --apply --pr 228 --expected-main <SHA-atual-de-main>
node --use-env-proxy scripts/configure-repository-governance.mjs --mode full --apply --pr 225 --expected-main <SHA-atual-de-main>
```

O modo bootstrap requer o check existente `smoke`, de GitHub Actions. O modo
full requer `validate`, `sql-local` e `Autorização G4 do proprietário`, todos
associados a Actions (integration ID `15368`). Só é aplicado depois de observar
esses contextos no HEAD; a presença permite instalar os portões, não significa
que seus resultados já foram aprovados.

## Ordem operacional

1. Confirmar administração no alvo. Desativar o workflow Pages antigo, cancelar
   execuções ativas e confirmar origem Pages por Actions antes de qualquer
   merge. Se a origem for publicação por branch, mudar para Actions; preservar
   a versão pública existente. O workflow já foi desativado, mas a mudança de
   origem foi recusada; este pré-requisito ainda não está concluído.
2. Revalidar `main`, a árvore e o diff de três arquivos do novo bootstrap e sua
   CI. Instalar o ruleset bootstrap sem inventar o status G4 ainda ausente da
   base. A instalação inicial usa a autorização existente desta sessão,
   registrada como tal; não uma suposta revisão ou comentário GitHub.
   A tentativa de aplicar o ruleset foi recusada; arquivo local e pré-validação
   não substituem aplicação administrativa aceita e conferida.
3. Integrar somente o bootstrap, com o stub Pages sem publicação, e conferir os
   três arquivos e os hashes em `main`. A nova versão tem outro HEAD e exige
   evidência própria; os hashes históricos do PR228 não devem ser reutilizados.
4. Incorporar a base ao PR225, preservar as correções e reexecutar CI. Observar
   `validate`, `sql-local` e G4 no HEAD atual antes de ativar o ruleset full.
5. Concluir e registrar homologação real. Marcar o PR como pronto e despachar
   G4 pela identidade do proprietário em `main`, com o HEAD final e sua
   referência. Verificar execução concluída e checks aprovados antes do merge.
6. Após CI de push em `main`, baseline e matriz autenticada aprovadas, reabilitar
   Pages e despachar G5 pela identidade do proprietário, com o SHA atual de
   `main`. Conferir artefato `dist`, execução e versão pública.

## Validação e limite da arquitetura

Os testes locais de autorização usam respostas simuladas da API para provar
aceitação de despacho legítimo e rejeição de origem forjada, outro ator,
branch/workflow errado, SHA/PR diferente, jobs pulados, rerun, replay após
revogação, empate de datas, alteração do HEAD, alteração dos blobs confiáveis,
paginação e falhas de API. Os testes administrativos confirmam que falta de
administração, checks ou estabilidade do alvo não produz escrita e que uma
leitura divergente nunca é anunciada como proteção confirmada. Esses mocks
não substituem despacho, aplicação do ruleset ou homologação remotos.
Em 2026-10-10 12:41 UTC, passaram os testes de autorização (92 casos API além
dos casos puros), os testes administrativos, a análise sintática dos scripts,
a leitura YAML com extração/análise do JavaScript do workflow e
`git diff --check`. Nenhuma operação remota foi executada por esses testes.

`tests/configure-governance-security.mjs` faz parte das quatro cadeias de teste
em `package.json`: `test`, `test:security`, `test:dist` e `test:ci`, junto dos
testes de autorização do proprietário. A verificação do CLI usa somente API
simulada, sem credencial real, rede ou execução SQL.

Em 2026-10-10 13:36 UTC, a cadeia completa `npm run test:security` passou com
o teste administrativo incluído. Passaram também os validadores locais de
repositório e inventário/hash das migrações, executados diretamente por Node,
as verificações sintáticas dos scripts e do JavaScript extraído do workflow,
a leitura YAML e `git diff --check`. A conferência das quatro cadeias confirmou
uma inclusão do novo teste em cada uma. Não houve execução de SQL.
O Node disponível é `24.19.0`, mas o npm local é `11.9.0`, diferente do
`11.17.0` exigido pelo projeto. Por isso a cadeia completa `test:ci` não foi
executada; seu controle de versão não foi contornado. Os resultados de
segurança e dos validadores locais não são anunciados como CI completa.

O verificador impede que um status forjado seja reconhecido como prova de
autorização. Porém, o requisito de status com integration ID de Actions não
distingue, por si só, qual workflow publicou o status. Um escritor malicioso
com permissão para executar outro workflow com `statuses: write` poderia
publicar diretamente o contexto requerido sem passar pelo verificador. Uma
garantia contra esse modelo de ameaça exige um emissor dedicado com permissões
restritas ou uma regra organizacional de workflow obrigatório. Não se afirma
que remover a revisão independente elimina esse limite preexistente.
