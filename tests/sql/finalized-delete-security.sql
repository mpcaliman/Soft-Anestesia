-- PostgreSQL real, baseline isolada reconciliada até 0032.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/finalized-delete-security.sql
-- Conteúdo inteiramente sintético. Nenhuma fixture é confirmada: ROLLBACK.
begin isolation level read committed;
set local statement_timeout = '30s';
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
    if v_count <> 0 then raise exception 'authorized draft DELETE silently canceled in %',t; end if;
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
do $test$
declare r record; v_row jsonb;
begin
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
  for r in select * from finalized_delete_snapshots loop
    execute format('select to_jsonb(p) from public.%I p where id=$1',r.table_name) into v_row using r.id;
    if v_row is distinct from r.original then raise exception 'original changed or disappeared in %',r.table_name; end if;
  end loop;
  if not exists(select 1 from public.addenda where legacy_id='synthetic-retained-addendum') then
    raise exception 'cascade lost retained addendum';
  end if;
  if not exists(select 1 from public.organization_users where organization_id='fc220000-0000-4000-8000-000000000001') then
    raise exception 'failed cascade partially removed membership';
  end if;
end
$test$;
rollback;
