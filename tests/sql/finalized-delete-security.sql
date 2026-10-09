-- PostgreSQL real, baseline isolada reconciliada até 0032 e hardening local.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/finalized-delete-security.sql
-- Conteúdo inteiramente sintético. Nenhuma fixture é confirmada: ROLLBACK.
begin isolation level read committed;
set local statement_timeout = '30s';
-- O guard existente em 0032 precisa continuar BEFORE ROW UPDATE/DELETE e
-- ALWAYS. A prova em replica abaixo exige o proprietário isolado da conexão.
do $test$
declare t text;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'cash_closings'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_trigger g
      where g.tgrelid = to_regclass(format('public.%I',t))
        and g.tgname = 'trg_guard' and not g.tgisinternal
        and g.tgenabled = 'A' and g.tgtype = 27
        and g.tgfoid = 'app.guard_finalized()'::regprocedure
    ) then
      raise exception '0032 ALWAYS UPDATE/DELETE guard missing or weakened in %',t;
    end if;
  end loop;
end
$test$;
insert into auth.users(id,email)
 values ('fc110000-0000-4000-8000-000000000001','finalized-delete@example.invalid');
insert into public.organizations(id,nome)
 values ('fc220000-0000-4000-8000-000000000001','Synthetic finalized delete');
insert into public.organization_users(organization_id,user_id,role,ativo)
 values ('fc220000-0000-4000-8000-000000000001','fc110000-0000-4000-8000-000000000001','gestor',true);
select set_config('request.jwt.claim.sub','fc110000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"fc110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
create temporary table finalized_delete_snapshots(table_name text, id uuid, original jsonb);

do $test$
declare t text; v_id uuid; v_draft uuid; v_row jsonb; v_count integer;
begin
  foreach t in array array[
    'preanesthetic_assessments','consultations','anesthesia_records',
    'recovery_records','risk_assessments','consents','prescriptions','documents',
    'cash_closings'
  ] loop
    v_id := gen_random_uuid(); v_draft := gen_random_uuid();
    execute format('insert into public.%I(id,organization_id,legacy_id,status,data) '
      'values ($1,$2,$3,$4,$5) returning to_jsonb(%I.*)', t, t)
      into v_row using v_id, 'fc220000-0000-4000-8000-000000000001'::uuid,
      'synthetic-finalized-'||t, 'finalized', '{"nome":"Synthetic signed original"}'::jsonb;
    insert into finalized_delete_snapshots values(t,v_id,v_row);
    begin
      execute format('delete from public.%I where id=$1',t) using v_id;
      raise exception 'authenticated DELETE removed finalized original in %',t;
    exception when check_violation then null;
    end;
    begin
      execute format('update public.%I set deleted_at=clock_timestamp() where id=$1',t) using v_id;
      raise exception 'authenticated soft-delete modified finalized original in %',t;
    exception when check_violation then null;
    end;
    execute format('insert into public.%I(id,organization_id,legacy_id,status,data) values ($1,$2,$3,$4,$5)',t)
      using v_draft, 'fc220000-0000-4000-8000-000000000001'::uuid,
      'synthetic-draft-'||t, 'draft', '{"nome":"Synthetic removable draft"}'::jsonb;
    execute format('delete from public.%I where id=$1',t) using v_draft;
    execute format('select count(*) from public.%I where id=$1',t) into v_count using v_draft;
    if v_count is distinct from 0 then raise exception 'authorized draft DELETE silently canceled in %',t; end if;
  end loop;
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto)
    select 'fc220000-0000-4000-8000-000000000001','preanesthetic_assessments',id,
      'synthetic-retained-addendum','Synthetic retained evidence'
    from finalized_delete_snapshots where table_name='preanesthetic_assessments';
  -- Também conserva duas formas históricas sem finalized_at normalizado.
  foreach t in array array['signed','legacy-json'] loop
    v_id := gen_random_uuid();
    insert into public.preanesthetic_assessments(id,organization_id,legacy_id,status,data)
      values(v_id,'fc220000-0000-4000-8000-000000000001','synthetic-sealed-'||t,
        case when t='signed' then 'signed' else 'draft' end,
        case when t='legacy-json' then '{"_finalizado":true,"nome":"Synthetic legacy original"}'::jsonb
             else '{"nome":"Synthetic signed status original"}'::jsonb end)
      returning to_jsonb(preanesthetic_assessments.*) into v_row;
    insert into finalized_delete_snapshots values('preanesthetic_assessments',v_id,v_row);
    begin
      delete from public.preanesthetic_assessments where id=v_id;
      raise exception 'authenticated DELETE removed legacy sealed original';
    exception when check_violation then null;
    end;
  end loop;
end
$test$;

-- O proprietário da conexão também não pode apagar o original nem a clínica
-- em cascade. A exceção desfaz toda a instrução, não só a linha bloqueada.
reset role;
create temporary table finalized_delete_audit_snapshots as
  select a.id, to_jsonb(a) original from public.audit_logs a
  where a.organization_id = 'fc220000-0000-4000-8000-000000000001';
create temporary table finalized_delete_addendum_snapshot as
  select a.id, to_jsonb(a) original from public.addenda a
  where a.legacy_id = 'synthetic-retained-addendum';
do $test$
declare r record;
begin
  if (select count(*) from finalized_delete_snapshots) is distinct from 11
     or (select count(*) from finalized_delete_addendum_snapshot) is distinct from 1 then
    raise exception 'finalized originals or retained addendum were absent';
  end if;
  for r in select table_name,id from finalized_delete_snapshots
      union all select 'addenda',id from finalized_delete_addendum_snapshot loop
    if not exists (
      select 1 from public.audit_logs a
      where a.organization_id = 'fc220000-0000-4000-8000-000000000001'
        and a.module = r.table_name and a.record_id = r.id and a.action = 'insert'
        and a.user_id = 'fc110000-0000-4000-8000-000000000001'
    ) then
      raise exception 'original or addendum lacked server audit in %',r.table_name;
    end if;
  end loop;
  for r in select * from finalized_delete_snapshots loop
    begin
      execute format('delete from public.%I where id=$1',r.table_name) using r.id;
      raise exception 'administrative DELETE removed finalized original in %',r.table_name;
    exception when check_violation then null;
    end;
  end loop;
  begin
    delete from public.organizations where id='fc220000-0000-4000-8000-000000000001';
    raise exception 'organization cascade removed finalized original';
  exception when check_violation then null;
  end;
end
$test$;

-- replica desativa triggers comuns e FKs, mas não pode contornar o ALWAYS
-- de 0032. O cascade acima é testado em origin, onde as FKs estão ativas.
set local session_replication_role = 'replica';
do $test$
declare r record;
begin
  if current_setting('session_replication_role') is distinct from 'replica' then
    raise exception 'replica guard was not exercised';
  end if;
  for r in select * from finalized_delete_snapshots loop
    begin
      execute format('delete from public.%I where id=$1',r.table_name) using r.id;
      raise exception 'replica DELETE removed finalized original in %',r.table_name;
    exception when check_violation then null;
    end;
    begin
      execute format('update public.%I set deleted_at=clock_timestamp() where id=$1',r.table_name) using r.id;
      raise exception 'replica soft-delete modified finalized original in %',r.table_name;
    exception when check_violation then null;
    end;
  end loop;
end
$test$;
set local session_replication_role = 'origin';

do $test$
declare r record; v_row jsonb;
begin
  for r in select * from finalized_delete_snapshots loop
    execute format('select to_jsonb(p) from public.%I p where id=$1',r.table_name) into v_row using r.id;
    if v_row is distinct from r.original then raise exception 'original changed or disappeared in %',r.table_name; end if;
  end loop;
  if not exists(select 1 from public.addenda where legacy_id='synthetic-retained-addendum') then
    raise exception 'cascade lost retained addendum';
  end if;
  if (select to_jsonb(a) from public.addenda a where legacy_id='synthetic-retained-addendum')
     is distinct from (select original from finalized_delete_addendum_snapshot) then
    raise exception 'retained addendum changed or disappeared';
  end if;
  if exists (
    select 1 from finalized_delete_audit_snapshots s
    full join (
      select a.id, to_jsonb(a) original from public.audit_logs a
      where a.organization_id = 'fc220000-0000-4000-8000-000000000001'
    ) a using(id)
    where s.original is distinct from a.original
  ) then
    raise exception 'failed DELETE changed or removed audit evidence';
  end if;
  if not exists(select 1 from public.organization_users where organization_id='fc220000-0000-4000-8000-000000000001') then
    raise exception 'failed cascade partially removed membership';
  end if;
end
$test$;
rollback;
