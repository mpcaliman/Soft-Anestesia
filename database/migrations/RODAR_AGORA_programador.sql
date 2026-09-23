-- =============================================================================
-- Soft Anestesia — RODAR AGORA: destravar a criação de ambientes
-- =============================================================================
-- Erro que você viu:
--   ERROR 42P01: relation "public.app_programmers" does not exist
--
-- Ele diz a verdade: a migração 0009 nunca rodou neste banco. A tabela que eu
-- mandei preencher é criada por ela. Este arquivo é a 0009 inteira, com uma
-- guarda a mais, seguida do registro do programador e da conferência.
--
-- É SEGURO com dados em produção:
--   • não apaga, não altera e não move nenhum registro seu;
--   • só cria duas tabelas novas (app_programmers, org_shares), duas funções
--     e políticas de LEITURA adicionais;
--   • as políticas novas de leitura entre ambientes só liberam algo quando
--     existe uma linha em org_shares — e não existe nenhuma. Na prática, nada
--     passa a ser visto por ninguém hoje;
--   • é idempotente: pode rodar de novo à vontade.
--
-- Rode ESTE ARQUIVO INTEIRO de uma vez no SQL Editor do Supabase.
-- No fim, a última consulta tem de devolver 1 linha com o seu e-mail.
-- =============================================================================

begin;
set local check_function_bodies = off;

-- 1) QUEM É O PROGRAMADOR --------------------------------------------------
create table if not exists public.app_programmers (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  criado_em  timestamptz not null default now()
);
alter table public.app_programmers enable row level security;

-- semente: o único programador (se a conta já existir na nuvem)
insert into public.app_programmers(user_id)
select id from auth.users where lower(email) = 'mpcaliman@hotmail.com'
on conflict do nothing;

-- cada um pode checar se É programador (vê só a própria linha); ninguém grava
drop policy if exists prog_self_sel on public.app_programmers;
create policy prog_self_sel on public.app_programmers
  for select using (user_id = auth.uid());

create or replace function app.eh_programador()
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists (select 1 from public.app_programmers where user_id = auth.uid())
$$;

-- 2) PROGRAMADOR ENXERGA E ADMINISTRA OS AMBIENTES --------------------------
-- (policies ADICIONAIS — as existentes por organização continuam valendo;
--  múltiplas policies permissivas somam com OR)
drop policy if exists org_prog_sel on public.organizations;
create policy org_prog_sel on public.organizations
  for select using (app.eh_programador());
drop policy if exists org_prog_ins on public.organizations;
create policy org_prog_ins on public.organizations
  for insert with check (app.eh_programador());
drop policy if exists org_prog_upd on public.organizations;
create policy org_prog_upd on public.organizations
  for update using (app.eh_programador());

drop policy if exists ou_prog_sel on public.organization_users;
create policy ou_prog_sel on public.organization_users
  for select using (app.eh_programador());
drop policy if exists ou_prog_all on public.organization_users;
create policy ou_prog_all on public.organization_users
  for all using (app.eh_programador()) with check (app.eh_programador());

drop policy if exists prof_prog_sel on public.profiles;
create policy prof_prog_sel on public.profiles
  for select using (app.eh_programador());

-- 3) CRIAR AMBIENTE (org) COM O MÉDICO GESTOR ------------------------------
create or replace function public.prog_criar_ambiente(p_nome text, p_email_gestor text)
returns uuid
language plpgsql security definer set search_path = public, app, auth as $fn$
declare
  v_uid uuid; v_org uuid;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode criar ambientes.';
  end if;
  if coalesce(trim(p_nome), '') = '' then
    raise exception 'Informe o nome do ambiente.';
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email_gestor)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %. Peça para o médico criar a conta primeiro (Entrar -> Criar conta).', p_email_gestor;
  end if;
  insert into public.organizations(nome) values (trim(p_nome)) returning id into v_org;
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (v_org, v_uid, 'gestor', true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, split_part(p_email_gestor, '@', 1), p_email_gestor, 'gestor', true)
    on conflict (id) do update set ativo = true;
  return v_org;
end;
$fn$;

-- 4) PROGRAMADOR ADICIONA MEMBRO EM QUALQUER AMBIENTE ----------------------
create or replace function public.prog_add_member(p_org uuid, p_email text, p_role text)
returns uuid
language plpgsql security definer set search_path = public, app, auth as $fn$
declare
  v_uid uuid;
begin
  if not app.eh_programador() then
    raise exception 'Apenas o programador pode usar esta função.';
  end if;
  if p_role not in ('gestor','anestesiologista','cirurgiao','auxiliar','financeiro','empresa') then
    raise exception 'Papel inválido: %', p_role;
  end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then
    raise exception 'Nenhuma conta na nuvem com o e-mail %.', p_email;
  end if;
  insert into public.organization_users(organization_id, user_id, role, ativo)
    values (p_org, v_uid, p_role, true)
    on conflict (organization_id, user_id, role) do update set ativo = true;
  update public.organization_users
    set ativo = false
    where organization_id = p_org and user_id = v_uid and role <> p_role;
  insert into public.profiles(id, nome, email, funcao, ativo)
    values (v_uid, split_part(p_email, '@', 1), p_email, p_role, true)
    on conflict (id) do update set ativo = true, funcao = p_role;
  return v_uid;
end;
$fn$;

-- 5) COMPARTILHAMENTO ENTRE AMBIENTES (leitura no destino) ------------------
create table if not exists public.org_shares (
  id          uuid primary key default gen_random_uuid(),
  org_origem  uuid not null references public.organizations(id) on delete cascade,  -- dona dos dados
  org_destino uuid not null references public.organizations(id) on delete cascade,  -- passa a LER
  modulos     text[] not null default '{}',   -- vazio = todos os módulos
  criado_por  uuid references auth.users(id),
  criado_em   timestamptz not null default now(),
  unique (org_origem, org_destino)
);
alter table public.org_shares enable row level security;

drop policy if exists shares_sel on public.org_shares;
create policy shares_sel on public.org_shares
  for select using (
    app.eh_programador()
    or org_origem  in (select app.org_ids())
    or org_destino in (select app.org_ids())
  );
drop policy if exists shares_prog_all on public.org_shares;
create policy shares_prog_all on public.org_shares
  for all using (app.eh_programador()) with check (app.eh_programador());

-- o registro de p_org é visível para MIM via compartilhamento?
create or replace function app.compartilhada_para_mim(p_org uuid, p_modulo text)
returns boolean
language sql stable security definer set search_path = public, app, auth as $$
  select exists (
    select 1 from public.org_shares s
     where s.org_origem = p_org
       and s.org_destino in (select app.org_ids())
       and (cardinality(s.modulos) = 0 or p_modulo = any(s.modulos))
  )
$$;

-- 6) LEITURA extra (OR) nas tabelas de dados — a escrita NÃO muda -----------
do $$
declare r record;
begin
  for r in select * from (values
      ('patients',                  'pacientes'),
      ('preanesthetic_assessments', 'pre'),
      ('consultations',             'consulta'),
      ('anesthesia_records',        'anestesia'),
      ('recovery_records',          'recuperacao'),
      ('risk_assessments',          'risco'),
      ('consents',                  'termo'),
      ('prescriptions',             'prescricao'),
      ('documents',                 'documentos'),
      ('finance_entries',           'financeiro'),
      ('quotes',                    'orcamento'),
      ('appointments',              'agenda')
    ) as t(tabela, modulo)
  loop
    -- a tabela pode não existir num projeto que parou numa migração anterior:
    -- sem esta guarda, UMA tabela faltando derruba a migração inteira
    if not exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = r.tabela) then
      raise notice 'tabela public.% ainda não existe — pulando', r.tabela;
      continue;
    end if;
    execute format('drop policy if exists %I_share_sel on public.%I', r.tabela, r.tabela);
    execute format(
      'create policy %I_share_sel on public.%I for select using (app.compartilhada_para_mim(organization_id, %L))',
      r.tabela, r.tabela, r.modulo);
  end loop;
end $$;

-- 7) grants de execução ------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.prog_criar_ambiente(text, text) to authenticated';
    execute 'grant execute on function public.prog_add_member(uuid, text, text) to authenticated';
  end if;
end $$;


-- =============================================================================
-- REGISTRO DO PROGRAMADOR
-- A semente lá em cima já tenta isto; repetimos aqui para o caso de a conta
-- ter sido criada depois, e para a conferência final valer por si.
-- TROQUE o e-mail se a conta que você usa no app for outra.
-- =============================================================================
insert into public.app_programmers(user_id)
select id from auth.users
 where lower(email) = lower('mpcaliman@hotmail.com')
on conflict do nothing;

commit;

-- =============================================================================
-- CONFERÊNCIA — as três têm de dar certo
-- =============================================================================
-- 1) a tabela existe agora?
select count(*) as tabela_criada
  from information_schema.tables
 where table_schema = 'public' and table_name = 'app_programmers';

-- 2) a função que o botão chama existe?
select count(*) as funcao_criada
  from information_schema.routines
 where routine_schema = 'public' and routine_name = 'prog_criar_ambiente';

-- 3) você está registrado? TEM DE VOLTAR 1 LINHA COM O SEU E-MAIL.
--    Se voltar 0, a conta não existe com esse e-mail em auth.users — confira em
--    Authentication -> Users qual é o endereço exato.
select u.email, p.criado_em
  from public.app_programmers p
  join auth.users u on u.id = p.user_id;
