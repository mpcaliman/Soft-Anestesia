-- =============================================================================
-- Soft Anestesia — 0030: Realtime do caso e linha do tempo intraoperatória
-- =============================================================================
-- Arquivo revisável. Não altera o schema gerenciado `realtime`, não aplica
-- remoto e não cria permissões novas: Realtime continua sujeito à RLS.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $block$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['encounters','anesthesia_timeline_events'] loop
    if to_regclass(format('public.%I',t)) is null then
      raise exception 'Tabela public.% ausente; reconcilie a baseline antes de publicar.',t;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I',t);
    end if;
    execute format('alter table public.%I replica identity full',t);
  end loop;
end
$block$;
commit;
