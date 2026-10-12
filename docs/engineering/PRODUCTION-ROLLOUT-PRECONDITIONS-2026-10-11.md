# Precondições da transição de produção com dados existentes

Revisão local de 11/10/2026 das fontes `0018`–`0032`, hardening de assinaturas
e catálogo capturado de produção. Nenhuma consulta remota, leitura de prontuário
ou alteração de produção foi realizada para este documento. A fonte `0033`
está sendo preparada separadamente e exige sua própria revisão e evidência.

A homologação hospedada com 60 verificações aprovadas comprova os contratos
exercitados em fixtures criadas depois das migrações. O replay do catálogo sem
registros comprova outra coisa: a transição estrutural. Nenhum dos dois, sozinho,
prova a atualização de linhas históricas que já existiam antes das migrações.

Uma leitura agregada posterior, realizada pelo agente principal somente com
metadados de workflow, encontrou **zero** registros status-only signed/finalized
sem carimbo canônico nas oito tabelas clínicas. Encontrou **455** registros que
receberiam o backfill `_finalizado=true` e `finalized_at NULL`: 92 pré-anestésicos,
167 anestesias, 143 recuperações e 53 consentimentos; as quatro outras tabelas
retornaram zero. Esses agregados não incluem conteúdo clínico ou identidades e
não são prova de execução da migração. O risco status-only não está presente
nessa fotografia; o backfill de 455 linhas é uma mudança concreta a ensaiar.

## Legado preservado e atendimento relacional disponível

O inventário agregado capturado encontrou **1.156** documentos pessoais:
751 candidatos com chave/criador coincidentes, 113 candidatos com criador
diferente e 292 sem correspondência. Os 113 pertencem aos 864 candidatos únicos;
não devem ser somados novamente. Entre os 292, há 243 registros de pacientes
e 49 cadastros/preferências/rascunhos. O total definitivo só existe depois do
congelamento verificado: essas contagens são uma fotografia, não um manifesto
imutável. Fontes: [inventário agregado](LEGACY-METADATA-CANDIDATES-2026-10-11.json)
e [procedimento B2](B2-LEGACY-MIGRATION.md).

A proposta é preservar integralmente `public.documentos` e manter cada item
pendente em `legacy_document_registry`, sem atribuir clínica automaticamente.
O atendimento continua consultando e gravando as tabelas relacionais pela
organização autenticada. Pendência de classificação não deve bloquear login,
agenda, gravação ou abertura de um registro relacional já autorizado; deve
bloquear somente a adoção/cópia daquele item de procedência não demonstrada.
Uma linha relacional existente nunca é ocultada por ausência de classificação
de uma cópia pessoal. Não adicionar joins obrigatórios ao registry nas policies
clínicas, nem uma condição global de “legado totalmente resolvido” no login.

O programador revisa lotes separados de 751, 113 e 292. Mesmo chave e criador
coincidentes exigem proveniência; não comprovam equivalência do conteúdo.
Classificação explícita não autoriza sobrescrever destino divergente. Copiar
em lotes pequenos, pacientes antes dos dependentes, validar hashes/vínculos e
registrar conflitos. A fonte permanece íntegra e as pendências permanecem
visíveis na área do programador, com códigos e contagens sem conteúdo clínico.
Nenhum lote exige apagar o original ou recriar pacientes por nome.

Acervo existente apenas em um aparelho é uma exceção separada: não consta nas
1.156 linhas da nuvem. Não limpar armazenamento, restaurar perfil do navegador
ou apagar fila/rascunho sem recibo verificável e associação de dono/clínica.
Quarentena local preservada não autoriza disponibilizá-la a outro usuário.

## Riscos concretos dos DDLs em linhas históricas

|Fontes|Precondição e efeito a verificar antes do corte|
|---|---|
|0018 / 0024|Encerram acesso direto dos clientes ao canal pessoal; não copiam nem classificam linhas por instalação. Os REVOKEs não retiram os direitos existentes de `service_role`. Provar ausência de escritores de backend e direitos efetivos compatíveis com fonte congelada.|
|0019|As três novas colunas `version` recebem default 1 quando realmente ausentes. Coluna já existente não é normalizada por `IF NOT EXISTS`; contar nulos/não positivos e confirmar constraints/definições. Os novos triggers tornam organização imutável.|
|0020|Há UPDATE real de adendos e de originais com marcador histórico de finalização. Triggers existentes de versão/auditoria continuam ativos. Medir mudanças de versão, carimbos e logs; não apresentar como alteração apenas estrutural.|
|0020 / 0032|Histórico com `status` signed/finalized e `finalized_at NULL`, sem `_finalizado=true`, não recebe o backfill da 0020. A0032 congela UPDATE/DELETE, mas o stamp de adendo exige `finalized_at` não nulo. Se existir, pode ficar sem caminho de correção: é bloqueador até solução revisada e ensaiada, sem inventar autoria/data nem alterar original silenciosamente.|
|0020 / 0031|O backfill recorta espaços de `legacy_id` de adendos e substitui vazio/NULL pelo UUID. Chaves distintas podem convergir no índice único já existente. Pais órfãos, tabela pai inválida ou organização divergente ficam armazenados, mas podem perder visibilidade pela nova policy. Adendo antigo não recebe revisão CAS; JSON antigo não deve virar cabeça aceita.|
|0021|Preserva binários; novos uploads/upserts exigem caminho do próprio autor. INSERT de metadado exige objeto existente, hash válido quando fornecido e vínculos na organização correta. Ensaiar anexos antigos e tentativas de atualizar arquivo de outro autor. Preservar os dois buckets privados e os 280 objetos agregados capturados, sem listar caminhos ou conteúdo.|
|0022 / 0023|Identidade de usuário/dispositivo e chave de envelope devem continuar recuperando pendências. Novas colunas de recibo vazias são compatíveis; drift prévio exige contar pares incompletos e UUID repetido por organização. Resposta perdida deve continuar idempotente. Não testar recuperação exportando chaves de usuários reais.|
|0024|A validação exige destino equivalente e finalizado quando aplicável. O INSERT de um legado finalizado fornece uma data, mas `stamp_finalization` da0020 a substitui por `now()` e carimba o ator autenticado. Ensaiar e explicitar a distinção entre proveniência histórica preservada em `data` e carimbo da importação; a validação atual exige carimbo não nulo, não igualdade de data/autoria histórica. Não declarar proveniência canônica equivalente sem resolver esse contrato.|
|0025|A nova RLS passa a usar papéis/permissões efetivos; registros com autor nulo/equipe/encounter ausente precisam de cenários por papel. A tabela CBHPM ausente no baseline exige a reconciliação específica já documentada, sem reexecutar indiscriminadamente0001–0017. Funções, grants, extensions e materialized view precisam manter dependências e consumidores.|
|0026|Não é transacional: índices CONCURRENTLY podem deixar índice inválido se interrompidos; `IF NOT EXISTS` não o conserta. Medir locks/duração e conferir `indisvalid/indisready` antes e depois. Nunca colocar essa fonte em BEGIN nem reescrevê-la para caber no SQL Editor.|
|0027 / 0029 / 0030|Confirmar schema completo das tabelas, CHECKs de drafts/conflitos existentes, publicação Realtime e identidade de réplica. Novas tabelas vazias não migram automaticamente fechamentos/rascunhos existentes apenas no aparelho.|
|0028|Compartilhamentos antigos passam inativos por default quando a coluna é nova. Não inferir autorização para preservar acesso anterior. Revisar exceções necessárias antes do corte e recriá-las por programador com módulos/motivo/prazo, mantendo histórico. Colunas existentes com drift não são corrigidas por `ADD IF NOT EXISTS`; CHECK NOT VALID preserva histórico, mas afeta qualquer nova atualização.|
|0032 e ACLs|Guards ALWAYS cobrem UPDATE/DELETE, inclusive cascatas, mas não TRUNCATE. O catálogo atual tem direitos amplos de serviço. Exigir inventário efetivo e política de menor privilégio de produção; o hardening de backend do runner é exclusivo de staging e não deve ser copiado como matriz de produção.|
|Hardening de assinaturas|No catálogo capturado, `organization_id/signed_by` ainda não existem. As colunas novas NULL e CHECKs NOT VALID preservam assinaturas antigas, mas a revogação de acesso direto muda a API imediatamente. Validar a Edge Function real e a validação pública de assinatura histórica sintética antes do corte. Não atribuir organizações/assinantes presumidos a registros imutáveis. Se as colunas já existirem, contar colisões de slots da corrente antes do índice único.|

## Agregados mínimos que faltam para decidir

O proprietário do banco executa somente SELECTs que retornem contadores,
sem nomes, IDs, caminhos, tokens, hashes individuais ou `data/dados`. Marcadores
`_finalizado` são metadados de workflow; a consulta abaixo lê apenas esse
marcador, sem campos clínicos. Se isso exceder o escopo da leitura autorizada,
a contagem deve ser fornecida por um operador autorizado, sem exportar payloads.

Repetir este SELECT para as oito tabelas de originais clínicos, mantendo somente
o nome estático da tabela e o contador no relatório:

```sql
select count(*) as status_only_finalized_without_canonical_timestamp
from public.preanesthetic_assessments
where finalized_at is null
  and lower(coalesce(status,'')) in ('signed','finalized')
  and lower(coalesce(data->>'_finalizado','false')) <> 'true';
```

As outras tabelas são `consultations`, `anesthesia_records`, `recovery_records`,
`risk_assessments`, `consents`, `prescriptions` e `documents`.
Também contar, por tabela, linhas que receberiam o backfill `_finalizado=true`
e `finalized_at NULL`, inclusive autoria ausente. Nenhuma contagem altera dados.

```sql
select count(*) as projected_collision_groups,
       coalesce(sum(n),0) as projected_collision_rows
from (
  select count(*) as n
  from public.addenda
  group by organization_id,
           coalesce(nullif(btrim(legacy_id),''),id::text)
  having count(*) > 1
) collisions;
```

Completar com contagens de: pais de adendos ausentes/fora do allowlist ou de
outra organização; versões inválidas e recibos parciais em colunas existentes;
shares ativas sem nova proveniência; colisões de assinatura se já houver escopo;
índices inválidos; objetos de anexos sem metadado correspondente e vínculos
cruzados. Os joins ficam dentro do banco e devolvem apenas totais. Consultar
também catálogo de direitos efetivos TRUNCATE/CRUD e os writers de serviço;
não testar o privilégio executando TRUNCATE ou escrevendo em produção.

## Ensaio fiel sem copiar prontuários

Criar outro projeto/container isolado com o **catálogo capturado antes das
correções**, contas e dados inteiramente sintéticos. Inserir fixtures antes das
migrações: finalizado canônico; `_finalizado` legado com/sem data válida e autor;
status-only signed/finalized; adendos com espaço/NULL e colisão projetada, pai
órfão e organização divergente; assinatura histórica sem escopo; share antiga;
anexo com autor diferente; fila com recibo perdido e migração interrompida.
Testar os papéis reais, além de gestor, e duas sessões concorrentes.

Capturar contagens e comparações internas antes/depois: bytes clínicos e FKs
permanecem preservados, alterações de metadados estão enumeradas, nenhum DELETE
clínico/auditoria/assinatura é cometido e toda correção possui caminho disponível.
Fixtures que deveriam abortar devem fazê-lo transacionalmente, com SQLSTATE
esperado e sem commit parcial. Relatórios contêm somente booleans/contagens.
O ensaio não recebe snapshot de prontuários, segredos ou arquivos de produção.

## Sequência concreta do corte

1. Encerrar as divergências do replay, revisar0033 e concluir o ensaio com dados
   sintéticos pré-existentes; validar navegador real e assinatura/Storage APIs.
2. Atualizar o inventário de catálogo e agregados, registrar autorização dos
   bytes/head exatos, backup operacional e ponto de retorno verificável.
   O baseline sem dados não substitui esse backup.
3. Definir janela coordenada de atualização e tratamento de clientes antigos;
   conservar suas pendências e proibir limpeza sem recibo. Aplicar somente as
   fontes e reconciliações aprovadas com histórico novo rastreável. Medir cada
   etapa; qualquer falha encerra o avanço.
4. Confirmar guards/ACLs/RLS/Realtime, ausência de escritor do legado e API de
   assinatura; publicar o cliente compatível. Verificar operação relacional
   por organização, conflitos e fila automaticamente reenviada. Não liberar
   corte se algum histórico autorizado ficar invisível ou sem adendo possível.
5. Inventariar a fonte congelada e reconciliar seu total definitivo. Classificar
   e migrar somente lotes demonstrados. Pendências292/113 ficam protegidas;
   atendimento relacional continua operando sem esperar a conclusão desses lotes.
6. Manter origem, auditoria e evidências; observar o piloto. Reversão de schema
   e recuperação operacional precisam de plano próprio: originais finalizados e
   assinaturas não devem ser alterados para desfazer uma publicação.

Esta proposta não autoriza SQL novo por si só e não afirma prontidão comercial.
Os bloqueadores devem ser comprovadamente resolvidos antes da aplicação em
produção; classificação pendente de item legado não se confunde com bloqueio
de todo o sistema relacional.
