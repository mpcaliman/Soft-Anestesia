# Baseline de produção e ensaio da transição

Captura de 11 de outubro de 2026, somente leitura, no projeto
`zbpbrnalamjrcfbscjkt`. Nenhum registro clínico, conta, email, nome, credencial,
token, objeto ou caminho do Storage foi exportado. Nenhum SQL foi enviado à
produção. A leitura das definições do catálogo não executa as funções capturadas.

## Evidência produzida

- `PRODUCTION-APPLICATION-CATALOG-2026-10-11.json`: catálogo completo dos objetos
  próprios em `public`/`app`, com 34 tabelas, uma view, uma materialized view, uma
  sequência, 500 colunas incluindo as views, 151 constraints, 120 índices,
  31 funções, 100 policies, 68 triggers e 1.481 grants efetivos. São 21 categorias
  verificáveis, incluindo defaults de privilégios, RLS/FORCE RLS, proprietários,
  atributos de coluna, identidade de réplica, publicação Realtime, extensões,
  políticas do Storage e configurações não secretas de buckets.
- `PRODUCTION-APPLICATION-BASELINE-2026-10-11.sql` e respectivo manifesto:
  reconstrução determinística somente da estrutura da aplicação, sem dados.
  Preserva o DDL atual, inclusive os riscos históricos, para testar a transição;
  o artefato não deve ser aplicado em produção nem sobre homologação existente.
- `STAGING-APPLICATION-CATALOG-2026-10-11.json` e
  `PRODUCTION-STAGING-CATALOG-DIFF-2026-10-11.json`: comparação integral de
  metadados. A homologação contém as correções e o controle de invocação de teste;
  as diferenças não são tratadas como aprovação automática da transição.
- `LEGACY-METADATA-CANDIDATES-2026-10-11.json`: contagens atualizadas e possíveis
  correspondências de chaves, sem atribuir registros a uma clínica.

Os limites bigint da sequência são capturados como texto. O máximo
`9223372036854775807` não passa por conversão para número JavaScript.
O catálogo não copia objetos membros de extensões ou DDL gerenciado de
Auth/Realtime/Storage. Esses componentes e suas versões/permissões são
dependências da plataforma e permanecem identificados separadamente.
Uma leitura complementar, registrada em `PRODUCTION-APPLICATION-COVERAGE-2026-10-11.json`,
confirmou zero collations, casts, configurações/dicionários/parsers/templates de
busca textual e event triggers próprios não cobertos pelo gerador; o executor
repete essas sete contagens no banco de referência e reprova divergências.
Dados de referência, sementes de medicamentos, contas e arquivos também não
estão no baseline: o ensaio comprova estrutura, não uma restauração dos dados.

## Execução isolada

Com Docker local disponível, CLI fixada no lockfile e sem variáveis de alvo ou
credenciais herdadas:

```sh
node tests/production-baseline-security.mjs
node scripts/run-production-baseline-replay.mjs
```

O executor cria uma nova identidade aleatória de projeto, valida container,
label, porta e socket Docker, exige PostgreSQL 17, aplicação vazia e zero linhas
de Auth/Storage, e nunca aceita URL ou argumento de alvo externo. Recria a
estrutura capturada e compara definições, RLS, triggers e grants efetivos antes
de aplicar as atualizações `0018`–`0034` e o hardening de assinaturas. A fonte `0026` é
executada intacta via `psql --file`, com cada comando top-level em autocommit;
`CREATE INDEX CONCURRENTLY` não é reescrito nesse ensaio. Nenhuma linha do
histórico formal de migrações é inserida ou reparada.

O replay real do commit `0350623` restaurou o catálogo e superou as comparações
da aplicação e de Storage, mas encontrou `42P01` na original `0025`.
`public.cbhpm_codigos` está ausente no catálogo de produção e não é criada por
`0018`–`0024`; a `0025`, linha 894, exige a tabela no GRANT incondicional.
A reconciliação agora executa **a original `0013_cbhpm_2022.sql`**, com hash
`0b996505d48930b2498548808277a0a7c69a664eae2b4c22cc5d88c4262ad8d8`, depois da
comparação exata do baseline e antes das 18 atualizações. Essa adição não é
apresentada como parte do esquema originalmente capturado. O executor verifica
23 colunas, duas constraints, cinco índices CBHPM, dois índices financeiros,
RLS, a policy SELECT e zero códigos carregados. Qualquer alteração em objeto
anterior ou adição não prevista reprova; nenhuma seed é executada.

A original `0013` herda defaults de privilégios amplos, incluindo TRUNCATE,
que não é restringido por RLS. Essa fase intermediária existe apenas no
container isolado e vazio. A evidência registra os grants intermediários e
finais; somente após `0025` exige que `anon`/PUBLIC não tenham grants e que
`authenticated` tenha apenas SELECT sem grant option. Direitos administrativos
e de serviço também são registrados, sem afirmar que são SELECT-only.
Essa reconciliação deve constar no plano específico de transição de produção;
não foi aplicada ao banco hospedado nem altera o histórico original.

O restore e a fixture gerenciada usam o administrador local apenas para
reconstruir e verificar a origem. As migrações são executadas em conexão
Docker-local fixa como `postgres`. Antes de ler cada fonte, no mesmo processo
psql, um comando separado exige `current_user = session_user = postgres`,
PostgreSQL 17 e banco `postgres`. O arquivo SQL de stdin permanece intacto;
não há transação envolvente ou mudança nos bytes de `0013`/`0026`.
Owners e defaults intermediários são verificados para esse papel. A `0033`
é uma adição ao histórico, não uma alteração das fontes anteriores. O relatório
mantém integralmente a comparação com o catálogo histórico de homologação,
identificando sua data de captura; diferenças não são filtradas para aprovar.
Antes das migrações, o ensaio registra owners e associação a papéis,
verifica a autoridade sobre policies de Storage e publicação Realtime e executa
um teste real da relocação exigida por `0025`. A associação ao papel proprietário
não basta para concluir a capacidade: hooks do Supabase podem autorizar
`ALTER EXTENSION` ao executor `postgres` sem essa associação.
O CI `2e85ba6` recusou `extension-owner` ao interpretar associação ausente como
recusa da operação. A prova nativa em homologação
[`MANAGED-EXTENSION-CAPABILITY-PROBE-2026-10-11.sql`](./MANAGED-EXTENSION-CAPABILITY-PROBE-2026-10-11.sql)
executou a relocação de `unaccent`, propriedade de `supabase_admin`, como
`postgres`, reverteu-a por uma exceção deliberada e comprovou owner e namespace
invariáveis. A prova e seus limites estão em
[`MANAGED-EXTENSION-CAPABILITY-2026-10-11.json`](./MANAGED-EXTENSION-CAPABILITY-2026-10-11.json);
nenhuma operação foi executada em produção.
O runner agora testa as três extensões fixas que precisam sair do schema
histórico. Cada `ALTER EXTENSION ... SET SCHEMA extensions` fica dentro de uma
subtransação revertida pela exceção `PZ001`; uma recusa real `42501` permanece
bloqueadora. O ensaio exige a execução observada, owner/namespace/versão/OID
invariáveis depois da reversão e a mesma necessidade de relocação registrada
nos metadados. Extensões já no schema alvo não são movidas e não recebem uma
afirmação de autoridade que não tenha sido testada. Outros erros continuam
falhando o ensaio. O `ROLLBACK` externo impede persistir qualquer ajuste da
sondagem. Criação histórica e baseline SQL congelado conservam seus executores
e bytes originais; o ensaio não troca owners nem concede papéis para passar.
Diagnósticos exportam somente nomes fixos de extensão, schema e proprietário
de papéis de plataforma reconhecidos e booleans; nomes inesperados são
substituídos por um marcador. A autoridade sobre defaults de `supabase_admin`
continua separada: uma tentativa real em homologação foi recusada com `42501`.
A migração fecha os defaults de `postgres` e preserva integralmente os defaults
do fornecedor. A condição do fornecedor permanece pendente; o ensaio não
afirma fechamento universal. Não concede associação a papéis privilegiados
nem muda owners para fazer a CI passar. Uma imagem local com autoridade
diferente da hospedada registra essa divergência explicitamente.
O catálogo imediatamente antes e depois de `0033` deve preservar todo CRUD
existente de `service_role` e não conceder DELETE adicional. O ensaio rejeita
TRUNCATE da aplicação, grants de cliente no legado e exposição da RPC de
autoprovisionamento. Uma fixture com ROLLBACK cria tabelas, sequências e funções
em `public`/`app`, verificando permissões efetivas e a combinação de defaults
globais e por schema. Para `postgres`, exige fechamento. Para `supabase_admin`,
registra os direitos residuais e prova a recusa `42501` quando a autoridade local
também é negada; não tenta corrigir os defaults internos do fornecedor.

Depois da comparação vazia e do pré-requisito `0013`, antes da original `0018`,
o ensaio carrega 455 registros históricos sintéticos (92 pré, 167 anestesias,
143 recuperações, 53 consentimentos). Também inclui vínculos, dois adendos e
uma assinatura históricos. A original `0020` deve converter a finalização
preservando payload, autoria, horário e vínculos, incrementando a revisão e
registrando exatamente 455 eventos de finalização. Os adendos antigos não
viram cabeças CAS, e a assinatura permanece sem atribuição presumida.
As fases SEED/VERIFY têm hashes separados, sem envolver as migrações originais
em outra transação. Esse conjunto é verificado depois de `0033` e do hardening
de assinaturas, antes da seed adicional de `0034`: registra 459 linhas clínicas
sintéticas, três usuários e uma assinatura; o baseline comparado inicialmente
continua sem registros. Somente o projeto efêmero é removido.

Imediatamente antes de `0034`, outra fixture acrescenta 12 documentos legados,
cinco contas sintéticas e oito registros canônicos de referência. A `0034`
exige uma coorte e clínica aprovadas explicitamente pelo programador, separa
autoria/data da importação das alegações históricas e preserva fonte, pacientes
e casos existentes. A verificação com ROLLBACK testa isolamento entre donos e
stamps, vínculos manuais, conflito sem sobrescrita, recibos imutáveis e repetição
idempotente. O preflight rejeita cópias antigas sem retrofit de proveniência
revisado. Contagens agregadas reais antes das fixtures seguintes devem mostrar
467 registros nas oito tabelas canônicas declaradas, oito contas, 12 documentos
legados e uma assinatura; os dados continuam inteiramente sintéticos.

Três pares autenticados exercitam concorrência de importação com o mesmo CPF,
cadastro comum com o mesmo CPF e declarações contraditórias sobre a clínica de
uma coorte. Cada primeiro escritor mantém a transação aberta até observar o
segundo aguardando seu advisory lock em `pg_locks`; só então faz COMMIT.
O teste exige um resultado vencedor e uma rejeição preservada em cada par.
Transações REPEATABLE READ são rejeitadas nos caminhos que exigem uma leitura
atualizada. Essa evidência não promete ausência geral de deadlocks ou deduplicação
por nomes; timeout e erro SQL reprovam o ensaio sem ocultar a falha.

Depois, roda os testes de imutabilidade/finalização e CAS de retificação com
duas sessões reais de PostgreSQL. Auth/Storage são fornecidos pela instalação
Supabase local, sem copiar seu DDL da produção. As fixtures sintéticas são
exclusivas do container efêmero. A limpeza só remove esse projeto.

O resultado fica em `artifacts/production-baseline-replay-evidence.json`, sem
credenciais. `restoreVerified` no manifesto permanece `false` porque gerar e
validar o artefato não equivale a executá-lo. Somente uma execução real e os
logs do mesmo commit podem comprovar o replay. O ensaio também não comprova
Auth API, Storage HTTP ou Realtime hospedados, nem a segurança operacional da
produção sob carga.

O comparador informa toda diferença sem publicar corpos no relatório. No modo
da aplicação, compara ACLs efetivos e mantém defaults de privilégios, ignorando
somente a representação equivalente `NULL`/ACL explícito. A única tabela de
controle excluída é `public.staging_audit_run_claims`; não há whitelist ampla
de dados, clínicas, funções, policies ou diferenças futuras. Versões e grants
gerenciados da plataforma ficam fora da equivalência da aplicação e exigem
verificação separada. O executor compara owners/grants dos schemas
Auth/Storage/extensions e privilégios efetivos, grantors, grant options e RLS das
oito tabelas Storage capturadas. Antes dessa comparação, a fixture local reproduz
os privilégios dessas oito dependências como `supabase_storage_admin`, sem copiar
DDL, mudar owners ou alterar o serviço hospedado. Isso evita depender dos defaults
de outra versão da imagem local. `NULL` e ACL explícito podem representar a mesma
autorização; a comparação dos privilégios efetivos permanece obrigatória.

A CLI 2.119 também cria `iceberg_namespaces` e `iceberg_tables`, ausentes no
catálogo de produção. Essas duas tabelas são registradas separadamente na
evidência. O executor exige RLS ativo, nenhuma policy, zero linhas, apenas SELECT
sem grant option para `anon`/`authenticated`, roles sem BYPASSRLS ou vínculo ao
papel proprietário, owner `supabase_storage_admin` e o inventário revisado de
18 grants por tabela. Consulta ambas com esses dois papéis e mantém
seu DDL e seus owners. Qualquer tabela extra diferente, policy ou privilégio
mais amplo reprova o ensaio. A equivalência declarada cobre as dependências
capturadas; não significa que as versões completas da plataforma são idênticas.

Divergência reprova o ensaio. Ele recusa defaults globais ainda não implementados
ou ACLs efetivos vazios em objetos próprios, evitando restaurar privilégios
implícitos sem querer. Os owners de `public`, `app` e `extensions` são restaurados
explicitamente. Essas comparações não incluem configurações de Auth API,
segredos ou ACLs alterados manualmente em objetos membros de extensões; estes
exigem o inventário operacional da plataforma antes de uma restauração integral.
Falhas registram a fase, SQLSTATE, código de assertion e contagens de diferenças;
não publicam logs brutos, valores substituídos, credenciais ou conteúdo clínico.

## Storage já existente deve ser preservado

Produção possui os buckets privados `clinical-attachments` e `documentos-pdf`.
O segundo não existia na homologação quando o catálogo foi capturado. O baseline
retém os dois buckets, suas restrições e as policies presentes no catálogo.
O ensaio não lista, lê, copia nem exclui arquivos. A publicação e a transição
devem preservar `documentos-pdf` e revisar suas policies; a ausência desse bucket
no ambiente de teste não autoriza removê-lo da produção.

A contagem agregada de objetos encontrou 280 em `clinical-attachments` e zero
em `documentos-pdf`. As quatro policies existentes `clin_att_sel`, `clin_att_ins`,
`clin_att_upd` e `clin_att_del` se aplicam somente a `clinical-attachments`, usando
o prefixo de organização e os papéis verificados por helpers do banco. Não há
policy permitindo ao cliente comum acesso a `documentos-pdf`. Isso é um estado
de acesso a preservar/revisar, não motivo para criar acesso genérico a PDFs.
O inventário correspondente está em `PRODUCTION-STORAGE-RETENTION-2026-10-11.json`.
Nenhum nome, caminho ou conteúdo de objeto foi retornado.

## Estado do legado e plano revisável

A contagem de 5 de outubro de 1.075 linhas e duas organizações está desatualizada.
A leitura agregada de 11 de outubro encontrou 1.156 linhas, cinco proprietários
distintos, três organizações e 100 linhas atualizadas depois de 5 de outubro.
Nenhuma chave de proprietário ou paciente aparece nos relatórios.

Comparação exata de `modulo`/`doc_id` com o `legacy_id` da tabela relacional
correspondente encontrou:

|Resultado|Linhas|
|---|---:|
|Uma linha relacional e uma organização candidata|864|
|Sem correspondência relacional|292|
|Mais de uma organização candidata|0|
|Candidato único com `created_by` igual ao dono legado|751|
|Candidato único com criador diferente do dono legado|113|

Entre as 292 sem correspondência, 243 são do módulo de pacientes e 49 são
cadastros, preferências ou rascunhos. O identificador do paciente não foi trocado
por uma busca por nome. Entre os 113 com criador diferente, há 99 pré-anestésicos,
nove financeiros, quatro anestesias e um orçamento. Os sufixos de módulo que
identificam usuários foram agregados antes de gravar o relatório.

Essas correspondências são candidatos para revisão. Não comprovam por si só
histórico, conteúdo equivalente ou uma autorização de compartilhamento. A
organização ainda não é imutável no banco atual de produção; ter hoje somente
um vínculo ativo com clínica também não prova a clínica de um registro antigo.
Nenhuma linha foi lida clinicamente, classificada, copiada ou movida.

Antes da aplicação na produção:

1. Executar e revisar o replay da estrutura atual com as 18 fontes novas.
   Resolver divergências, preservar buckets e validar todos os grants e policies.
2. Obter backup operacional verificável e ponto de retorno, distinto deste
   artefato sem dados; definir janela e métricas de locks/duração para índices.
3. Aplicar a transição com histórico novo rastreável, sem fingir que as fontes
   antigas `0001`–`0017` foram aplicadas formalmente. Confirmar o congelamento do
   canal pessoal antes de capturar o inventário definitivo do legado.
4. Inventariar a fonte congelada e registrar sua nova contagem/hashes. As 1.156
   linhas desta leitura não são uma contagem imutável enquanto produção aceita
   novas gravações legadas.
5. Revisar primeiro os 751 candidatos com chave e criador coincidentes; exigir
   comprovação de proveniência e comparar origem/destino antes de classificar.
   Os 113 com criador diferente e as 292 sem correspondência formam lotes
   separados de revisão. Não presumir clínica, usar nome como chave ou mesclar
   pacientes automaticamente.
6. Copiar e validar apenas lotes classificados pelo programador, sem sobrescrita,
   com hashes e auditoria. Manter a origem congelada íntegra, retenção e janela de
   reversão; pendências permanecem protegidas em quarentena.

O estado de CI, autorização, proteção de `main`, teste hospedado e aplicação
efetiva é registrado pelos outros portões. Este documento não afirma que esses
portões passaram ou que produção está pronta para receber as migrações.

Referências oficiais: [backup e restauração com a CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[migrações gerenciadas](https://supabase.com/docs/guides/deployment/database-migrations),
[segurança e RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
