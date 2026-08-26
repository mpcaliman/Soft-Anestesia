-- =============================================================================
-- Soft Anestesia — Migração 0015: publicar no Realtime os módulos que faltavam
-- =============================================================================
-- Rode DEPOIS da 0002. Aditiva e idempotente: pode rodar de novo à vontade.
--
-- POR QUE
--   A 0002 publicou pré-anestésica, ficha, SRPA, financeiro, pacientes e
--   encontros. Consulta, risco e termo ficaram de fora — e o app agora escuta
--   as sete. Sem esta migração, esses três continuam chegando só pelo ciclo de
--   sincronização: funcionam, mas com minutos de atraso em vez de segundos.
--
-- REPLICA IDENTITY FULL: manda também a linha ANTERIOR na mudança. Custa um
-- pouco mais de WAL e é o que permite comparar versões num conflito, em vez de
-- só saber que "algo mudou".
-- =============================================================================
do $$
declare
  t text;
  alvo text[] := array['consultations', 'risk_assessments', 'consents'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array alvo loop
    -- a tabela pode não existir num projeto que parou numa migração anterior
    if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = t) then
      raise notice 'tabela public.% ainda não existe — pulando', t;
      continue;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

-- Conferência: as sete tabelas dos módulos devem aparecer aqui.
select tablename
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public'
 order by tablename;
