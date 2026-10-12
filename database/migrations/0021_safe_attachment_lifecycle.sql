-- =============================================================================
-- Soft Anestesia — 0021: ciclo seguro de anexos
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem autorização G3.
--
-- Contrato do caminho novo (o legado compatível também já usa os 3 primeiros):
--   {organization_id}/{uploaded_by}/anexos/{attachment_id}_{filename}
--
-- O cliente pode ler anexos da própria organização e criar/retentar somente
-- caminhos cujo segundo segmento é o seu próprio auth.uid(). A exclusão física
-- fica reservada a um coletor servidor futuro, com retenção e auditoria.
-- =============================================================================

begin;

create or replace function app.attachment_path_org(p_name text)
returns uuid
language plpgsql
stable
set search_path = pg_catalog, public, app, storage
as $$
declare
  v_root text;
begin
  v_root := split_part(coalesce(p_name, ''), '/', 1);
  if v_root = '' then return null; end if;
  return v_root::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

create or replace function app.attachment_path_owned(
  p_name text,
  p_org uuid,
  p_user uuid
)
returns boolean
language sql
stable
set search_path = pg_catalog, public, app
as $$
  select p_org is not null
     and p_user is not null
     and app.attachment_path_org(p_name) = p_org
     and split_part(coalesce(p_name, ''), '/', 2) = p_user::text
     and split_part(coalesce(p_name, ''), '/', 3) in ('anexos', 'backups-pdf')
     and position(chr(92) in coalesce(p_name, '')) = 0
     and coalesce(p_name, '') !~ '(^|/)\.\.?(/|$)'
$$;

revoke all on function app.attachment_path_org(text) from public;
revoke all on function app.attachment_path_owned(text, uuid, uuid) from public;
grant execute on function app.attachment_path_org(text) to authenticated;
grant execute on function app.attachment_path_owned(text, uuid, uuid) to authenticated;

-- Storage: leitura colaborativa dentro do ambiente; escrita apenas no caminho
-- imutável do próprio usuário. Upsert exige SELECT + INSERT + UPDATE.
drop policy if exists clin_att_sel on storage.objects;
create policy clin_att_sel on storage.objects
for select to authenticated
using (
  bucket_id = 'clinical-attachments'
  and app.attachment_path_org(name) in (select app.org_ids())
);

drop policy if exists clin_att_ins on storage.objects;
create policy clin_att_ins on storage.objects
for insert to authenticated
with check (
  bucket_id = 'clinical-attachments'
  and app.attachment_path_owned(
    name,
    app.attachment_path_org(name),
    (select auth.uid())
  )
  and app.has_role(
    app.attachment_path_org(name),
    array['gestor','anestesiologista','auxiliar','financeiro']
  )
);

drop policy if exists clin_att_upd on storage.objects;
create policy clin_att_upd on storage.objects
for update to authenticated
using (
  bucket_id = 'clinical-attachments'
  and app.attachment_path_owned(
    name,
    app.attachment_path_org(name),
    (select auth.uid())
  )
  and app.has_role(
    app.attachment_path_org(name),
    array['gestor','anestesiologista','auxiliar','financeiro']
  )
)
with check (
  bucket_id = 'clinical-attachments'
  and app.attachment_path_owned(
    name,
    app.attachment_path_org(name),
    (select auth.uid())
  )
  and app.has_role(
    app.attachment_path_org(name),
    array['gestor','anestesiologista','auxiliar','financeiro']
  )
);

drop policy if exists clin_att_del on storage.objects;

-- Metadado: valida ambiente/caminho e deriva autoria/hora no servidor. Também
-- impede forjar vínculo com paciente ou encounter de outra organização.
create or replace function app.stamp_attachment_metadata()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_path_org uuid := app.attachment_path_org(new.storage_path);
begin
  if v_uid is null then
    raise exception 'attachment requires authenticated user';
  end if;
  if v_path_org is null or v_path_org is distinct from new.organization_id then
    raise exception 'attachment path organization mismatch';
  end if;
  if not app.attachment_path_owned(new.storage_path, new.organization_id, v_uid) then
    raise exception 'attachment path owner mismatch';
  end if;
  if split_part(new.storage_path, '/', 3) <> 'anexos' then
    raise exception 'attachment metadata requires an anexos path';
  end if;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'clinical-attachments'
       and o.name = new.storage_path
  ) then
    raise exception 'attachment storage object not found';
  end if;
  if new.patient_id is not null and not exists (
    select 1 from public.patients p
     where p.id = new.patient_id and p.organization_id = new.organization_id
  ) then
    raise exception 'attachment patient organization mismatch';
  end if;
  if new.encounter_id is not null and not exists (
    select 1 from public.encounters e
     where e.id = new.encounter_id and e.organization_id = new.organization_id
  ) then
    raise exception 'attachment encounter organization mismatch';
  end if;
  if new.hash is not null and new.hash !~ '^[0-9a-f]{64}$' then
    raise exception 'attachment hash must be sha256 hex';
  end if;
  new.uploaded_by := v_uid;
  new.uploaded_at := now();
  return new;
end;
$$;

revoke all on function app.stamp_attachment_metadata() from public;

drop trigger if exists trg_attachment_metadata_stamp on public.attachments;
create trigger trg_attachment_metadata_stamp
before insert on public.attachments
for each row execute function app.stamp_attachment_metadata();

alter table public.attachments enable row level security;
alter table public.attachments force row level security;

drop policy if exists att_sel on public.attachments;
create policy att_sel on public.attachments
for select to authenticated
using (
  organization_id in (select app.org_ids())
  and app.has_role(
    organization_id,
    array['gestor','anestesiologista','financeiro','auxiliar']
  )
);

drop policy if exists att_wr on public.attachments;
drop policy if exists att_ins on public.attachments;
create policy att_ins on public.attachments
for insert to authenticated
with check (
  organization_id in (select app.org_ids())
  and app.attachment_path_owned(storage_path, organization_id, (select auth.uid()))
  and split_part(storage_path, '/', 3) = 'anexos'
  and app.has_role(
    organization_id,
    array['gestor','anestesiologista','auxiliar','financeiro']
  )
);

revoke all on table public.attachments from anon;
revoke update, delete, truncate, references, trigger on table public.attachments from authenticated;
grant select, insert on table public.attachments to authenticated;

comment on table public.attachments is
  'Metadados insert-only; binários privados no Storage e exclusão física somente por rotina servidor auditada.';

commit;
