-- =============================================================================
-- Soft Anestesia — Migração 0002: Storage (anexos) + Realtime
-- =============================================================================
-- Rode DEPOIS da 0001. Idempotente.
--
-- Storage: bucket PRIVADO para anexos clínicos. O binário NUNCA é público;
-- o app gera signed URLs sob demanda. O caminho segue o padrão:
--   {organization_id}/{patient_id}/{encounter_id}/{module}/{filename}
-- A 1ª pasta (organization_id) é usada nas policies para isolar por organização.
-- =============================================================================

-- 1) Bucket privado ----------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('clinical-attachments', 'clinical-attachments', false)
on conflict (id) do nothing;

-- 2) Policies de Storage (por organização) -----------------------------------
-- A pasta raiz do objeto = organization_id. Só membros da org acessam.

drop policy if exists clin_att_sel on storage.objects;
create policy clin_att_sel on storage.objects for select
  using (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
  );

drop policy if exists clin_att_ins on storage.objects;
create policy clin_att_ins on storage.objects for insert
  with check (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
    and app.has_role((storage.foldername(name))[1]::uuid,
                     array['gestor','anestesiologista','auxiliar'])
  );

drop policy if exists clin_att_upd on storage.objects;
create policy clin_att_upd on storage.objects for update
  using (
    bucket_id = 'clinical-attachments'
    and (storage.foldername(name))[1]::uuid in (select app.org_ids())
    and app.has_role((storage.foldername(name))[1]::uuid,
                     array['gestor','anestesiologista','auxiliar'])
  );

drop policy if exists clin_att_del on storage.objects;
create policy clin_att_del on storage.objects for delete
  using (
    bucket_id = 'clinical-attachments'
    and app.has_role((storage.foldername(name))[1]::uuid, array['gestor'])
  );

-- 3) Realtime ----------------------------------------------------------------
-- Publica as tabelas que precisam de edição ao vivo / "outro usuário editando".
-- (idempotente: só adiciona se ainda não estiver na publicação)
do $$
declare
  t text;
  alvo text[] := array[
    'encounters','preanesthetic_assessments','anesthesia_records',
    'anesthesia_timeline_events','recovery_records','finance_entries','patients'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array alvo loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    -- REPLICA IDENTITY FULL: envia a linha antiga também (útil p/ diffs/conflitos)
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;
