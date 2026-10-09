-- Teste real PostgreSQL/Supabase, somente baseline reconciliada isolada.
-- Executar psql -v ON_ERROR_STOP=1 -f tests/sql/live-draft-conflict-security.sql.
-- Nenhum usuário real ou conteúdo clínico é usado; a transação é revertida.
begin;
set local statement_timeout = '30s';

insert into auth.users(id,email) values
 ('fa110000-0000-4000-8000-000000000001','draft-author-a@example.invalid'),
 ('fa110000-0000-4000-8000-000000000002','draft-author-b@example.invalid');
insert into public.organizations(id,nome) values
 ('fa220000-0000-4000-8000-000000000001','Synthetic draft organization A'),
 ('fa220000-0000-4000-8000-000000000002','Synthetic draft organization B');
insert into public.organization_users(organization_id,user_id,role,ativo) values
 ('fa220000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000001','anestesiologista',true),
 ('fa220000-0000-4000-8000-000000000001','fa110000-0000-4000-8000-000000000002','anestesiologista',true);
select set_config('request.jwt.claim.sub','fa110000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"fa110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;

do $test$
declare m text; expected_module text; n integer;
begin
  foreach m in array array[
    'pre','consulta','anestesia','recuperacao','termo','prescricao','risco',
    'documentos','orcamento','financeiro','agenda',
    'live:termo','live:prescricao','live:risco','live:documentos',
    'live:orcamento','live:financeiro','live:agenda'
  ] loop
    expected_module := case when left(m,5) = 'live:' then substr(m,6) else m end;
    if app.sync_conflict_permission_module('drafts',m) is distinct from expected_module then
      raise exception 'module mapping failed: %',m;
    end if;
    insert into public.sync_conflicts(organization_id,client_conflict_id,module,table_name,
      record_legacy_id,operation,base_version,server_version,proposed_data,canonical_data,created_by)
    values ('fa220000-0000-4000-8000-000000000001','fixture-draft-conflict-'||m,m,'drafts',
      'live_'||expected_module,'draft_upsert',1,2,'{"value":"proposal"}','{"value":"canonical"}',auth.uid());
  end loop;
  select count(*) into n from public.sync_conflicts
   where client_conflict_id like 'fixture-draft-conflict-%'
     and proposed_data = '{"value":"proposal"}'::jsonb
     and canonical_data = '{"value":"canonical"}'::jsonb;
  if n <> 18 then raise exception 'both conflict versions were not retained'; end if;

  begin
    insert into public.sync_conflicts(organization_id,client_conflict_id,module,table_name,
      record_legacy_id,operation,proposed_data,canonical_data,created_by)
    values ('fa220000-0000-4000-8000-000000000001','fixture-unknown-module','live:ajustes','drafts',
      'unknown','draft_upsert','{}','{}',auth.uid());
    raise exception 'unknown draft module was authorized';
  exception when check_violation or insufficient_privilege then null;
  end;
  begin
    insert into public.sync_conflicts(organization_id,client_conflict_id,module,table_name,
      record_legacy_id,operation,proposed_data,canonical_data,created_by)
    values ('fa220000-0000-4000-8000-000000000002','fixture-foreign-organization','termo','drafts',
      'foreign','draft_upsert','{}','{}',auth.uid());
    raise exception 'foreign organization was authorized';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.sync_conflicts set proposed_data = '{"value":"tampered"}'
     where client_conflict_id = 'fixture-draft-conflict-termo';
    raise exception 'proposed evidence was mutable';
  exception when check_violation then null;
  end;
  begin
    update public.sync_conflicts set canonical_data = '{"value":"tampered"}'
     where client_conflict_id = 'fixture-draft-conflict-termo';
    raise exception 'canonical evidence was mutable';
  exception when check_violation then null;
  end;
  update public.sync_conflicts set status = 'resolved_remote',resolution = '{"decision":"keep_canonical"}'
   where client_conflict_id = 'fixture-draft-conflict-termo';
  if not exists (
    select 1 from public.sync_conflicts where client_conflict_id = 'fixture-draft-conflict-termo'
     and status = 'resolved_remote' and resolved_by = auth.uid()
     and proposed_data = '{"value":"proposal"}'::jsonb
     and canonical_data = '{"value":"canonical"}'::jsonb
  ) then raise exception 'audited resolution lost evidence'; end if;
end
$test$;

select set_config('request.jwt.claim.sub','fa110000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"fa110000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $test$
begin
  if exists (select 1 from public.sync_conflicts where client_conflict_id like 'fixture-draft-conflict-%') then
    raise exception 'another author could read private draft conflicts';
  end if;
end
$test$;
reset role;
rollback;
