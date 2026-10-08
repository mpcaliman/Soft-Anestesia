-- =============================================================================
-- Soft Anestesia — assinatura digital: hardening da validação e do escopo
-- =============================================================================
-- Local/G1 somente. Não aplicar em Supabase remoto sem homologação e G3.
--
-- A validação pública continua existindo pela Edge Function `assinatura`, que
-- usa service_role e devolve somente os campos da view. A tabela e a view não
-- ficam mais acessíveis diretamente por anon/authenticated.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.assinaturas
  add column if not exists organization_id uuid,
  add column if not exists signed_by uuid;

-- Registros históricos podem não ter escopo. O CHECK NOT VALID preserva-os,
-- mas todo registro novo já precisa nascer ligado a uma organização.
do $block$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'assinaturas_organization_required'
       and conrelid = 'public.assinaturas'::regclass
  ) then
    alter table public.assinaturas
      add constraint assinaturas_organization_required
      check (organization_id is not null) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'assinaturas_signed_by_required'
       and conrelid = 'public.assinaturas'::regclass
  ) then
    alter table public.assinaturas
      add constraint assinaturas_signed_by_required
      check (signed_by is not null) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'assinaturas_codigo_format'
       and conrelid = 'public.assinaturas'::regclass
  ) then
    alter table public.assinaturas
      add constraint assinaturas_codigo_format
      check (codigo ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$') not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'assinaturas_modulo_allowed'
       and conrelid = 'public.assinaturas'::regclass
  ) then
    alter table public.assinaturas
      add constraint assinaturas_modulo_allowed
      check (modulo in (
        'pre','consulta','anestesia','recuperacao','risco','termo',
        'prescricao','documentos','financeiro','orcamento'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'assinaturas_hashes_format'
       and conrelid = 'public.assinaturas'::regclass
  ) then
    alter table public.assinaturas
      add constraint assinaturas_hashes_format
      check (
        hash_doc ~ '^[0-9a-f]{64}$'
        and self_hash ~ '^[0-9a-f]{64}$'
        and (prev_hash is null or prev_hash ~ '^[0-9a-f]{64}$')
      ) not valid;
  end if;

  if to_regclass('public.organizations') is not null
     and not exists (
       select 1 from pg_constraint
        where conname = 'assinaturas_organization_id_fkey'
          and conrelid = 'public.assinaturas'::regclass
     ) then
    alter table public.assinaturas
      add constraint assinaturas_organization_id_fkey
      foreign key (organization_id) references public.organizations(id)
      on delete restrict not valid;
  end if;

  if to_regclass('auth.users') is not null
     and not exists (
       select 1 from pg_constraint
        where conname = 'assinaturas_signed_by_fkey'
          and conrelid = 'public.assinaturas'::regclass
     ) then
    alter table public.assinaturas
      add constraint assinaturas_signed_by_fkey
      foreign key (signed_by) references auth.users(id)
      on delete restrict not valid;
  end if;
end
$block$;

create index if not exists assinaturas_org_created_idx
  on public.assinaturas(organization_id, criado_em desc);
create index if not exists assinaturas_signed_by_idx
  on public.assinaturas(signed_by);
-- Uma posição da corrente só pode receber um sucessor por organização. Em uma
-- disputa simultânea, uma inserção vence e a Edge Function relê/recalcula.
create unique index if not exists assinaturas_org_chain_slot_uidx
  on public.assinaturas(organization_id, coalesce(prev_hash, '<root>'));

alter function public.assinaturas_no_mutate()
  set search_path = pg_catalog;
revoke all on function public.assinaturas_no_mutate() from public, anon, authenticated;

alter view public.assinaturas_publicas
  set (security_invoker = true, security_barrier = true);

-- Não existe policy de cliente de propósito: somente service_role escreve e
-- lê. A Edge Function é a API pública mínima e auditável.
alter table public.assinaturas enable row level security;
revoke all on table public.assinaturas from public, anon, authenticated;
revoke all on table public.assinaturas_publicas from public, anon, authenticated;

do $block$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table public.assinaturas to service_role;
    grant select on table public.assinaturas_publicas to service_role;
  end if;
end
$block$;

comment on table public.assinaturas is
  'Registro append-only; acesso direto de cliente revogado, escrita somente pela Edge Function.';
comment on view public.assinaturas_publicas is
  'Campos mínimos devolvidos pela Edge Function de validação pública; sem grant direto para clientes.';

commit;
