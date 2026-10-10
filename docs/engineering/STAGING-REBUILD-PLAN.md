# Reconstrução e integração de homologação — 10 de outubro de 2026

Alvo exclusivo: `yqqrfgbvoexricjdxpis`, branch Supabase
`audit-remediation-v2`, parent `zbpbrnalamjrcfbscjkt`. A identidade, o estado
`ACTIVE_HEALTHY` e `with_data: false` foram confirmados por `list_branches`.
`list_tables` confirmou somente `public.assinaturas`, com zero linhas; a
consulta de metadados feita pelo agente principal confirmou ausência do
schema `app` antes da tentativa de aplicação. Não foram consultados conteúdos
clínicos, nomes ou credenciais da produção.

## Estado da execução

Após a autorização expressa **“Pode fazer tudo”**, o agente principal retomou
a homologação. Uma consulta agregada confirmou zero usuários Auth,
organizações e pacientes antes das fixtures. As extensões `unaccent` e
`pg_trgm` estavam ausentes; a `0014` criou a estrutura vazia de medicamentos.

O histórico consultado em 10/10 às 00:42:32 UTC confirma 19 novas migrações:
`0001`–`0019`, além da pré-existente `0001_assinaturas` (20 entradas).
`0014` foi confirmada na versão `20261009211312` e `0018` na versão
`20261009212903`. A recusa anterior da `0014` foi superada por essa aplicação.

A tentativa anterior de aplicar `0019` foi superada por aplicação confirmada
na versão `20261010002555`. A conferência independente encontrou três colunas
de versão, 13 guardas de organização, três guardas de versão e 13 tabelas com
RLS forçada. Quinze contagens agregadas estavam zeradas antes das fixtures.

A tentativa de aplicar `0020` retornou `INVALID_ARGUMENT`, com a mensagem
**“Invalid or expired requestState”**. Ela permanece ausente do histórico.
A reconstrução está parcial e as novas aplicações foram interrompidas após
a repetição do erro do conector. A autorização permanece válida; o bloqueio
é de execução, não uma necessidade de renovar consentimento. Nenhuma fixture
foi criada, o runner não foi implantado ou executado e nenhum SQL foi enviado
à produção. `0020` e todas as migrações posteriores continuam pendentes.

O inventário de fontes, hashes e estados está em
`STAGING-MIGRATION-EVIDENCE.json`. Ele descreve a execução parcial; não é uma
baseline reconciliada da produção nem uma prova de homologação completa.
Antes de retomar a execução, recuperar a conexão, comparar schema e histórico
atual e verificar as condições ainda pendentes. A autorização já inclui essa
continuidade; não se deve repetir solicitações rotineiras.

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
O marcador de capacidade deve ser substituído fora do Git antes do deploy;
nenhum token ou senha pode aparecer em logs, código versionado ou resultado.

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
das fontes; a fixture SQL ainda não foi executada em um banco reconciliado.
A corrida de duas sessões reais e a assinatura Realtime desta cadeia também
permanecem pendentes.

Essa corrida deve usar homologação exclusiva, com contas e registros sintéticos.
Os adendos são append-only mesmo em DELETE por cascade administrativo; não se
deve enfraquecer esse guard para limpeza. O runner atualizado cria adendos e
mantém essa evidência bloqueada, sem excluir as organizações ou contas Auth.
A proteção adicional de exclusão de pais finalizados deve estar aplicada
antes dessa execução; a revisão encontrou que o guard histórico só cobria
UPDATE. Os testes locais do runner verificam falhas induzidas e não substituem
a execução no PostgreSQL/Supabase real.
