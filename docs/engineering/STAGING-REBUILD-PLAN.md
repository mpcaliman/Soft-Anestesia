# Reconstrução e integração de homologação — 10 de outubro de 2026

Alvo exclusivo: `yqqrfgbvoexricjdxpis`, branch Supabase
`audit-remediation-v2`, parent `zbpbrnalamjrcfbscjkt`. A identidade, o estado
`ACTIVE_HEALTHY` e `with_data: false` foram confirmados por `list_branches`.
`list_tables` confirmou somente `public.assinaturas`, com zero linhas; a
consulta de metadados feita pelo agente principal confirmou ausência do
schema `app` antes da tentativa de aplicação. Não foram consultados conteúdos
clínicos, nomes ou credenciais da produção.

## Estado da execução

A reconexão do Supabase permitiu aplicar e confirmar `0021`–`0024`.
O histórico independente contém agora 26 entradas: a pré-existente
`0001_assinaturas`, as 24 migrações `0001`–`0024` e a reconstrução vazia do
legado `staging_rebuild_legacy_empty_baseline_20261010`, versão
`20261010230832`. Nenhum SQL foi aplicado à produção.

As 19 categorias de metadados das duas tabelas legadas foram capturadas.
Um complemento registrou o helper de timestamp e os limites de sequência
como texto, preservando o bigint sem arredondamento. O SQL derivado foi
aplicado integralmente na homologação, com zero linhas copiadas, FORCE RLS,
revogação de privilégios e veto restritivo a clientes na mesma transação.
O relatório `LEGACY-BASELINE-RECONSTRUCTION-2026-10-10.json` registra os
hashes e a verificação independente: `documentos` tem seis colunas e
`pacientes` tem quinze; ambas têm três índices, cinco policies e zero linhas.
Essa captura cobre somente duas tabelas e não reconcilia toda a produção.

A primeira transferência da fonte `0025` foi truncada pelo limite de saída
da ferramenta, embora o JSON permanecesse parsável. O Supabase rejeitou
esse SQL com `42601`. A fonte histórica não foi alterada. A transferência
foi corrigida com chunks e verificação SHA-256 antes do envio: 44.293 bytes,
44.146 caracteres, 1.048 quebras LF e hash
`4847547686c59b50d066801d93a9229b617c8363d7287e401c76066d41a3c4c5`.
As duas aplicações isoladas subsequentes retornaram **“Invalid or expired
requestState”**. O histórico consultado após cada falha confirma ausência de
`0025`; `0026`–`0032` e o endurecimento das assinaturas também permanecem
pendentes. A falha atual é de execução do conector; a autorização continua
válida. Não se presume aplicação por sucesso de leitura ou reconexão.

Uma consulta agregada após as falhas confirmou zero usuários Auth,
organizações, pacientes, atendimentos e linhas nas duas tabelas legadas.
Nenhuma fixture foi criada e o runner não foi implantado ou executado.
O Advisor de segurança foi capturado antes de `0025` em
`STAGING-SECURITY-ADVISORS-2026-10-10.json`; seus achados pendentes não são
uma aprovação de homologação. A baseline completa, os testes hospedados e
as condições de governança continuam bloqueando publicação.

O inventário de fontes, hashes, versões e estados está em
`STAGING-MIGRATION-EVIDENCE.json`. Antes de retomar, confirmar o alvo e o
histórico atual, conferir o hash da string efetivamente enviada e aplicar
`0025` inteira em uma única transação. Não repetir uma mutação após erro
incerto sem consultar seu resultado no histórico.

## Plano reproduzível

`node scripts/prepare-staging-plan.mjs /tmp/soft-staging-plan.json` gera um
plano fechado ao alvo de homologação, sem executar SQL. O programa valida os
hashes de cada fonte contra `database/migration-baseline.json` e registra o
hash de cada SQL que seria aplicado.

A ordem consiste nas migrações numeradas de `database/migrations`, seguidas
de `supabase/migrations/0002_assinaturas_hardening.sql`. A contagem e os hashes
exatos são produzidos pelo gerador; uma nova proteção de exclusão sucede `0031`.
O histórico existente `0001_assinaturas` permanece intacto. Os nomes das novas
migrações começam por `staging_rebuild_`, para não confundir os dois arquivos
históricos chamados `0001`. A ferramenta de aplicação gera as versões
formais; não se inventa nem reescreve uma versão já aplicada.

A migração `0026` contém `CREATE INDEX CONCURRENTLY`, incompatível com a
transação da aplicação de migrações. Exclusivamente nesta homologação vazia,
o gerador remove `CONCURRENTLY` dos comandos de criação de índice e registra
separadamente `sourceSha256`, `appliedSha256` e o motivo da derivação. O arquivo
histórico permanece intacto. Essa derivação não é uma instrução de produção.

Os scripts `RODAR_AGORA_*`, o SQL consolidado, os seeds e quaisquer dados de
produção ficam fora do plano. Substituir policies e funções antigas faz parte
do DDL de endurecimento; nenhuma rotina deste plano classifica, transfere ou
apaga conteúdo clínico existente. A publicação continua bloqueada pelas
condições de governança e pela validação de homologação.

Após cada operação, registrar a fonte, os dois hashes, a versão retornada e o
resultado. Ao final, capturar metadados de tabelas, RLS, policies, funções,
grants, publicações e Storage, executar Advisors e comparar com o Git. Uma
baseline de produção assinada continua sendo uma entrega separada: reconstruir
esta homologação não reconcilia automaticamente a deriva da produção.

## Integração real preparada

`scripts/staging-integration-runner.ts` é um runner de Edge Function efêmera.
Ele rejeita qualquer `SUPABASE_URL` diferente do alvo exato e exige a gateway
JWT habilitada e uma capacidade aleatória adicional, verificada por SHA-256.
Antes do deploy, substituir fora do Git o hash da capacidade, UUID da
execução e horários UTC, com janela máxima de quinze minutos. O POST deve
conter apenas esse UUID. A função reivindica primeiro uma chave única no
banco, impedindo nova execução em outro isolate ou após resposta perdida.
`scripts/staging-only/runner-invocation-claims.sql` define a infraestrutura
exclusiva desta homologação, fora das migrações e dos assets de produção.
A tabela deve ter FORCE RLS, zero policies, nenhum acesso anon/authenticated
e somente SELECT/INSERT para service_role; não há UPDATE/DELETE para o
runner. Nenhuma dessas condições foi aplicada ou verificada remotamente
nesta retomada. Nenhum token ou senha pode aparecer em logs, código
versionado ou resultado.

O runner cria quatro contas Auth sintéticas com senhas aleatórias, faz login
real por senha e cria duas organizações. Os testes usam esses JWTs em
PostgREST, Storage e WebSocket:

- leitura anônima e leitura, criação, alteração e exclusão entre clínicas;
- alteração atômica da mesma revisão por duas sessões, com um vencedor e um
  conflito sem sobrescrita;
- imutabilidade de organização e recibo da operação confirmada;
- compartilhamento autorizado somente pelo programador, leitura limitada ao
  módulo e bloqueio imediato após revogação;
- upload próprio e negação de upload/leitura de Storage entre organizações;
- corrida de duas propostas de retificação `0031`, idempotência, autoria,
  auditoria, preservação do original e bloqueio de exclusão direta/cascade;
- três tópicos Realtime (`patients`, `encounters`, `addenda`), heartbeat,
  atualização recebida, inscrição maliciosa entre clínicas e renovação do
  token em todos os tópicos assinados.

Tabela legada ausente recebe resultado pendente, nunca aprovação automática.
Quando ela existe, o teste primeiro verifica o contrato correto (`dados`) e
exige negação por autorização, evitando confundir coluna errada ou recurso
ausente com RLS funcionando.

O retorno contém nomes dos testes, estado, códigos de diagnóstico, contagens
e UUIDs de evidência sintética. `failed` e `pending` precisam ser zero: HTTP
200 sozinho não demonstra aprovação. A limpeza de objetos de Storage fica
em `finally`. Organizações, Auth e registros sintéticos permanecem como
evidência; acesso é bloqueado desativando vínculos/perfis/organizações,
removendo privilégios da fixture, revogando sessões/compartilhamentos,
banindo as contas e substituindo suas senhas por valores aleatórios.
Depois de capturar a evidência, substituir o runner remoto por uma função
fechada, sem privilégio administrativo, ou removê-lo pelo painel.

Esses testes reais ainda **não foram executados**. O runner não acelera o
vencimento natural do JWT e não substitui a integração de duas abas e queda
abrupta do navegador. A suíte de navegador da CI e uma sessão atravessando o
vencimento do JWT devem produzir evidências próprias antes de declarar essas
garantias verificadas.

## Retificação estruturada de documentos finalizados

A proposta local `0031_append_only_retification_cas.sql` preserva o registro
original e cria uma cadeia de retificações por INSERT em `addenda`. O servidor
serializa o CAS por organização/tabela/UUID, carimba a revisão aceita e mantém
a proposta concorrente como adendo `conflict`. Rótulos clínicos corrigidos
podem ser projetados na tela e no PDF; FKs, autoria e assinatura permanecem
inalteradas. A migração não foi aplicada e não libera publicação.

`tests/sql/retification-cas-security.sql` contém uma fixture PostgreSQL com
rollback para autorização, isolamento, idempotência, cadeia aceita, conflito
preservado e imutabilidade integral do pai. O teste Node verifica o contrato
das fontes. A fixture SQL foi executada na CI PostgreSQL local do commit
`fff59e2`, com rollback e corrida real de duas conexões. Isso não comprova
Auth, RLS, Realtime ou Storage no Supabase hospedado. A corrida de duas
sessões autenticadas e a assinatura Realtime desta cadeia estão pendentes.

Essa corrida deve usar homologação exclusiva, com contas e registros sintéticos.
Os adendos são append-only mesmo em DELETE por cascade administrativo; não se
deve enfraquecer esse guard para limpeza. O runner atualizado cria adendos e
mantém essa evidência bloqueada, sem excluir as organizações ou contas Auth.
A proteção adicional de exclusão de pais finalizados deve estar aplicada
antes dessa execução; a revisão encontrou que o guard histórico só cobria
UPDATE. Os testes locais do runner verificam falhas induzidas e não substituem
a execução no PostgreSQL/Supabase real.
