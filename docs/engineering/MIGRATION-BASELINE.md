# E0 — baseline de migrações

O repositório contém hoje dois históricos distintos:

- `database/migrations/0001–0017` e scripts auxiliares antigos;
- `supabase/migrations/0001_assinaturas.sql`.

A E0 registra o inventário e os hashes em `database/migration-baseline.json`. Nenhum SQL foi movido, renomeado, editado ou executado. O validador falha se um arquivo for alterado ou aparecer sem revisão explícita.

## Bloqueio vigente

`remoteApplyAllowed` permanece `false`, e `supabase/config.toml` mantém migrações e seeds desativados. Os arquivos não devem ser enviados com `supabase db push`, colados no SQL Editor nem executados na produção. A ordem canônica só poderá ser definida depois de:

1. capturar o estado remoto de forma somente leitura;
2. reconstruir um banco vazio de homologação;
3. comparar schema, RLS, publicações Realtime, funções, storage e seeds;
4. documentar diferenças e plano de reversão;
5. obter autorização específica para a migração.

Scripts chamados `RODAR_AGORA_*` são tratados apenas como legado inventariado; o nome não constitui autorização de execução.
