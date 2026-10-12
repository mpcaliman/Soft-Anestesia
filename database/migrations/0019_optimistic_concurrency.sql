-- =============================================================================
-- Soft Anestesia — Migração 0019: concorrência otimista atômica
-- =============================================================================
-- Impede o padrão "última gravação vence" entre aparelhos. Cada UPDATE passa
-- a ser condicionado pela coluna version; o cliente envia a versão que abriu
-- e o Postgres só altera a linha se ela continuar sendo aquela versão.
--
-- Esta migração é aditiva e não altera conteúdo clínico existente.
-- Rode DEPOIS da 0018.
-- =============================================================================

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local check_function_bodies = off;

-- 1) As tabelas que ainda não eram versionadas passam a ser -----------------
alter table public.patients add column if not exists version integer not null default 1;
alter table public.encounters add column if not exists version integer not null default 1;
alter table public.appointments add column if not exists version integer not null default 1;

do $block$
declare
  t text;
  c text;
begin
  foreach t in array array['patients','encounters','appointments'] loop
    c := t || '_version_positive';
    if not exists (
      select 1
        from pg_constraint
       where conname = c
         and conrelid = format('public.%I', t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (version > 0)',
        t, c
      );
    end if;
  end loop;
end
$block$;

-- 2) O banco, não o navegador, controla versão, autor e escopo --------------
create or replace function app.bump_version()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'O ambiente de um registro não pode ser alterado.'
      using errcode = 'check_violation';
  end if;

  -- Ignora qualquer version enviada pelo cliente. Só o banco incrementa.
  new.version := coalesce(old.version, 1) + 1;
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  new.updated_at := now();
  return new;
end
$fn$;

-- Protege o escopo também em tabelas já versionadas e torna a intenção
-- explícita, independentemente da função usada para carimbar a linha.
create or replace function app.guard_organization_scope()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app, auth
as $fn$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'O ambiente de um registro não pode ser alterado.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$fn$;

do $block$
declare
  t text;
  versionadas text[] := array[
    'patients','encounters','appointments',
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions',
    'documents','finance_entries','quotes'
  ];
begin
  foreach t in array versionadas loop
    execute format('drop trigger if exists trg_org_scope on public.%I', t);
    execute format(
      'create trigger trg_org_scope before update on public.%I '
      'for each row execute function app.guard_organization_scope()', t
    );
  end loop;

  foreach t in array array['patients','encounters','appointments'] loop
    execute format('drop trigger if exists trg_version on public.%I', t);
    execute format(
      'create trigger trg_version before update on public.%I '
      'for each row execute function app.bump_version()', t
    );
  end loop;
end
$block$;

-- 3) Defesa em profundidade para todas as linhas multi-tenant mutáveis -------
do $block$
declare
  t text;
begin
  foreach t in array array[
    'patients','encounters','appointments',
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions',
    'documents','finance_entries','quotes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$block$;

commit;
