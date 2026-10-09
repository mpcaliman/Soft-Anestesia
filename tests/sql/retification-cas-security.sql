-- Integração PostgreSQL em baseline isolada reconciliada até 0032 e hardening local.
-- psql -v ON_ERROR_STOP=1 -f tests/sql/retification-cas-security.sql
-- Dados inteiramente sintéticos; rollback desfaz também os adendos append-only.
-- Este arquivo prova CAS sequencial/RLS/invariantes. A corrida entre sessões
-- é um caso separado do runner preparado, não é simulada como se fosse real.
begin isolation level read committed;
set local statement_timeout = '30s';
insert into auth.users(id,email) values
 ('fb110000-0000-4000-8000-000000000001','retification-a@example.invalid'),
 ('fb110000-0000-4000-8000-000000000002','retification-a2@example.invalid'),
 ('fb110000-0000-4000-8000-000000000003','retification-b@example.invalid');
insert into public.organizations(id,nome) values
 ('fb220000-0000-4000-8000-000000000001','Synthetic retification A'),
 ('fb220000-0000-4000-8000-000000000002','Synthetic retification B');
insert into public.organization_users(organization_id,user_id,role,ativo) values
 ('fb220000-0000-4000-8000-000000000001','fb110000-0000-4000-8000-000000000001','gestor',true),
 ('fb220000-0000-4000-8000-000000000001','fb110000-0000-4000-8000-000000000002','gestor',true),
 ('fb220000-0000-4000-8000-000000000002','fb110000-0000-4000-8000-000000000003','gestor',true);
select set_config('request.jwt.claim.sub','fb110000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"fb110000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
insert into public.preanesthetic_assessments(id,organization_id,legacy_id,status,data)
values ('fb330000-0000-4000-8000-000000000001','fb220000-0000-4000-8000-000000000001',
 'fixture-finalized-original','finalized','{"nome":"Synthetic original label","alergias":"None","_patientRef":"immutable-patient-reference","_caseId":"immutable-case-reference","_finalizado":true}');
create temporary table retification_original_snapshot as
 select to_jsonb(p) original from public.preanesthetic_assessments p
 where p.id = 'fb330000-0000-4000-8000-000000000001';

do $test$
declare a public.addenda%rowtype; attempted jsonb; n integer;
begin
  if (select count(*) from retification_original_snapshot) is distinct from 1 then
    raise exception 'signed parent snapshot was absent';
  end if;
  if app.valid_retification_fields('{"nome":"Corrected synthetic label","paciente":{"nome":"Synthetic nested name"},"_labExtras":[{"nome":"Synthetic Hb","valor":"13.2"}],"_medsLista":[{"nome":"Synthetic medication"}]}') is distinct from true then
    raise exception 'clinical labels or permitted clinical arrays were blocked';
  end if;
  foreach attempted in array array[
    '{"nome":"Label","nested":{"_patientRef":"foreign"}}'::jsonb,
    '{"nested":[{"patient_id":"foreign"}]}'::jsonb,
    '{"nested":{"constructor":{"prototype":{"polluted":true}}}}'::jsonb,
    '{"_relOrg":"foreign"}'::jsonb,
    '{"nested":{"_labExtras":[]}}'::jsonb,
    '{"assinatura_dataurl":"forged"}'::jsonb,
    '{"data_assinatura2":"1900-01-01"}'::jsonb,
    '{"nested":{"access_token":"forged"}}'::jsonb
  ] loop
    if app.valid_retification_fields(attempted) is distinct from false then raise exception 'internal field was authorized'; end if;
    begin
      insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
      values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
       'fb330000-0000-4000-8000-000000000001','fixture-invalid-'||md5(attempted::text),
       'Synthetic invalid patch','correcao',jsonb_build_object('retificacao',
         jsonb_build_object('schema',1,'baseAdendoId','','campos',attempted)));
      raise exception 'invalid patch was inserted';
    exception when check_violation then null;
    end;
  end loop;

  -- Plain adenda cannot create a CAS revision, even by supplying the column.
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,retification_revision)
  values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
   'fb330000-0000-4000-8000-000000000001','fixture-plain','Synthetic plain addendum',999)
  returning * into a;
  if a.id is null or a.retification_revision is not null then raise exception 'client forged revision or plain addendum was absent'; end if;
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data,author_id,created_at)
  values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
   'fb330000-0000-4000-8000-000000000001','fixture-retification-a','Synthetic proposed A','correcao',
   '{"autor_exibicao":"Forged outsider label","retificacao":{"schema":1,"baseAdendoId":"","campos":{"nome":"Synthetic accepted A","alergias":"Synthetic allergy A"}}}',
   'fb110000-0000-4000-8000-000000000003','1900-01-01') returning * into a;
  if a.data#>>'{retificacao,status}' is distinct from 'accepted' or a.retification_revision is distinct from 1
     or a.author_id is distinct from auth.uid() or a.created_at is distinct from transaction_timestamp()
     or a.data->>'autor_exibicao' is distinct from auth.uid()::text
     or a.parent_legacy_id is distinct from 'fixture-finalized-original' then
    raise exception 'accepted proposal lacked server authority';
  end if;
  -- Same identity and same proposal replay is a no-op; another proposal is refused.
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
  values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
   'fb330000-0000-4000-8000-000000000001','fixture-retification-a','Synthetic proposed A','correcao',
   '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"nome":"Synthetic accepted A","alergias":"Synthetic allergy A"}}}')
  on conflict (organization_id,legacy_id) do nothing;
  select count(*) into n from public.addenda where legacy_id = 'fixture-retification-a';
  if n is distinct from 1 then raise exception 'idempotent replay duplicated proposal'; end if;
  begin
    insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
    values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
     'fb330000-0000-4000-8000-000000000001','fixture-retification-a','Synthetic proposed A','correcao',
     '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"alergias":"Different proposal"}}}')
    on conflict (organization_id,legacy_id) do nothing;
    raise exception 'same ID acknowledged different proposal';
  exception when check_violation then null;
  end;
end
$test$;

select set_config('request.jwt.claim.sub','fb110000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"fb110000-0000-4000-8000-000000000002","role":"authenticated"}',true);
do $test$
declare a public.addenda%rowtype;
begin
  begin
    insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
    values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
     'fb330000-0000-4000-8000-000000000001','fixture-retification-a','Synthetic proposed A','correcao',
     '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"nome":"Synthetic accepted A","alergias":"Synthetic allergy A"}}}')
    on conflict (organization_id,legacy_id) do nothing;
    raise exception 'another author reused operation identity';
  exception when check_violation then null;
  end;
  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
  values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
   'fb330000-0000-4000-8000-000000000001','fixture-retification-b','Synthetic stale proposal B','correcao',
   '{"retificacao":{"schema":1,"baseAdendoId":"","campos":{"alergias":"Synthetic conflict B"}}}') returning * into a;
  if a.data#>>'{retificacao,status}' is distinct from 'conflict' or a.retification_revision is not null
     or a.data#>>'{retificacao,baseAtualId}' is distinct from 'fixture-retification-a'
     or a.data#>>'{retificacao,campos,alergias}' is distinct from 'Synthetic conflict B'
     or a.author_id is distinct from auth.uid() then raise exception 'conflicting proposal was not retained'; end if;

  insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
  values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
   'fb330000-0000-4000-8000-000000000001','fixture-retification-c','Synthetic rebased C','correcao',
   '{"retificacao":{"schema":1,"baseAdendoId":"fixture-retification-a","campos":{"alergias":"Synthetic accepted C"}}}') returning * into a;
  if a.data#>>'{retificacao,status}' is distinct from 'accepted' or a.retification_revision is distinct from 2 then
    raise exception 'conflict incorrectly advanced accepted head';
  end if;
  if (select to_jsonb(p) from public.preanesthetic_assessments p
       where id = 'fb330000-0000-4000-8000-000000000001')
     is distinct from (select original from retification_original_snapshot) then
    raise exception 'signed parent, metadata, FK or revision changed';
  end if;
  begin
    update public.addenda set texto = 'tampered' where legacy_id = 'fixture-retification-b';
    raise exception 'conflict evidence was mutable';
  exception when insufficient_privilege or check_violation then null;
  end;
  begin
    delete from public.addenda where legacy_id = 'fixture-retification-b';
    raise exception 'conflict evidence could be deleted';
  exception when insufficient_privilege or check_violation then null;
  end;
end
$test$;

select set_config('request.jwt.claim.sub','fb110000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"fb110000-0000-4000-8000-000000000003","role":"authenticated"}',true);
do $test$
begin
  if exists (select 1 from public.addenda where organization_id = 'fb220000-0000-4000-8000-000000000001') then
    raise exception 'foreign organization read proposal';
  end if;
  begin
    insert into public.addenda(organization_id,parent_table,parent_id,legacy_id,texto,reason,data)
    values ('fb220000-0000-4000-8000-000000000001','preanesthetic_assessments',
     'fb330000-0000-4000-8000-000000000001','fixture-forbidden','Synthetic forbidden','correcao',
     '{"retificacao":{"schema":1,"baseAdendoId":"fixture-retification-c","campos":{"alergias":"Forbidden"}}}');
    raise exception 'foreign organization wrote proposal';
  exception when insufficient_privilege or foreign_key_violation or check_violation then null;
  end;
end
$test$;
reset role;
rollback;
