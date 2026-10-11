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
de aplicar somente `0018`–`0032` e o hardening de assinaturas. A fonte `0026` é
executada intacta via `psql --file`, com cada comando top-level em autocommit;
`CREATE INDEX CONCURRENTLY` não é reescrito nesse ensaio. Nenhuma linha do
histórico formal de migrações é inserida ou reparada.

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

1. Executar e revisar o replay da estrutura atual com as 16 fontes novas.
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
