# E0 — baseline de migrações

> **Atualização de estado — 9 de outubro de 2026.** O corpo abaixo é um
> retrato histórico e não representa o estado atual da execução. A branch de
> teste foi publicada no PR [225](https://github.com/mpcaliman/Soft-Anestesia/pull/225).
> A homologação registra 16 novas migrações (`0001`–`0013` e `0015`–`0017`),
> além da pré-existente `0001_assinaturas`; `0014` foi recusada e `0018`–`0030`
> permanecem ausentes. O runner de integração real não foi implantado nem
> executado. A proteção remota de `main` permanece inativa; os controles
> propostos no branch ainda não demonstram sua imposição em produção. Consulte
> [o estado atual da homologação](STAGING-REBUILD-PLAN.md) e
> [a evidência das migrações](STAGING-MIGRATION-EVIDENCE.json). Nenhum SQL desta
> execução foi enviado à produção. A reconstrução está parcial e interrompida.

## Retrato histórico preservado

O repositório contém hoje dois históricos distintos:

- `database/migrations/0001–0027` e scripts auxiliares antigos;
- `supabase/migrations/0001_assinaturas.sql` e
  `0002_assinaturas_hardening.sql`.

A E0 registra o inventário e os hashes em `database/migration-baseline.json`. Nenhum SQL foi movido, renomeado, editado ou executado. O validador falha se um arquivo for alterado ou aparecer sem revisão explícita.

## Bloqueio vigente

`remoteApplyAllowed` permanece `false`, e `supabase/config.toml` mantém migrações e seeds desativados. Os arquivos não devem ser enviados com `supabase db push`, colados no SQL Editor nem executados na produção. A ordem canônica só poderá ser definida depois de:

1. capturar o estado remoto de forma somente leitura;
2. reconstruir um banco vazio de homologação;
3. comparar schema, RLS, publicações Realtime, funções, storage e seeds;
4. documentar diferenças e plano de reversão;
5. registrar a referência exata do projeto e a evidência do portão G3 já
   autorizado antes de liberar qualquer aplicação.

Scripts chamados `RODAR_AGORA_*` são tratados apenas como legado inventariado; o nome não constitui autorização de execução.

## Migração local autorizada

- `0018_stop_legacy_writes.sql` congela o canal pessoal sem organização e cria
  destinos organizacionais para rascunhos e preferências.
- `0019_optimistic_concurrency.sql` acrescenta versão às tabelas que faltavam,
  impede troca de organização e prepara compare-and-swap atômico em todas as
  gravações clínicas.
- `0020_conflict_preservation_and_immutability.sql` mantém os dois lados de
  conflitos no aparelho e na nuvem, versiona rascunhos, torna adendos
  append-only e impede qualquer alteração posterior à finalização canônica.
- `0021_safe_attachment_lifecycle.sql` vincula cada upload ao ambiente e ao
  usuário autenticado, torna os metadados insert-only e retira do navegador a
  exclusão física de arquivos que ainda podem estar referenciados.
- `0022_encrypted_offline_keyrings.sql` cria a chave de envelope estável por
  usuário e dispositivo, liberada apenas ao próprio `auth.uid()`, para que a
  fila clínica local permaneça cifrada e inacessível ao próximo usuário.
- `0023_idempotent_cloud_receipts.sql` carimba cada linha com o UUID e o
  checksum da última mutação confirmada, permitindo reconhecer uma resposta
  perdida sem duplicar a gravação nem criar conflito falso.
- `0024_legacy_quarantine_migration.sql` inventaria o acervo pessoal legado
  sem expor seu conteúdo, exige classificação manual por clínica e mantém a
  origem intacta durante cópia, validação e eventual reversão.
- `0025_supabase_hardening.sql` consolida RLS, privilégios, funções e escopos
  imutáveis, sem usar metadados editáveis do usuário como autorização.
- `0026_e1_performance_indexes.sql` prepara índices concorrentes para os
  caminhos críticos sem remover índices existentes.
- `0027_cloud_only_cash_closings.sql` cria o fechamento diário relacional com
  RLS, versão, recibo e auditoria, e completa a publicação Realtime das tabelas
  gerenciadas pelo aplicativo.

As dez migrações (`0018`–`0027`) foram acrescentadas ao inventário local sob
G1. G3 foi autorizado em 2026-10-08, mas o bloqueio técnico acima continua
valendo até o projeto de homologação ser identificado e reconciliado: nenhum
desses arquivos foi aplicado em homologação ou produção.
