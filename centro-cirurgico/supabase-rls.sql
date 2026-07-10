-- =====================================================================
--  Centro Cirúrgico — Row Level Security (RLS)
--
--  Executar DEPOIS de supabase-schema.sql.
--
--  Princípios:
--   * Todo acesso é restrito ao centro cirúrgico do usuário autenticado.
--   * Usuários inativos não têm acesso a dados (is_active_user()).
--   * O gestor enxerga tudo do seu centro.
--   * Demais usuários só veem os agendamentos aos quais estão associados.
--   * A ocupação neutra e anônima é obtida via função get_occupancy()
--     (SECURITY DEFINER), nunca lendo a tabela appointments diretamente.
--   * Arquivos do Storage também são protegidos por RLS.
-- =====================================================================

-- Habilita RLS em todas as tabelas sensíveis -------------------------
alter table public.surgical_centers          enable row level security;
alter table public.profiles                  enable row level security;
alter table public.user_roles                enable row level security;
alter table public.rooms                      enable row level security;
alter table public.equipment                  enable row level security;
alter table public.accommodation_types        enable row level security;
alter table public.appointment_statuses       enable row level security;
alter table public.permission_matrix          enable row level security;
alter table public.center_settings            enable row level security;
alter table public.appointments               enable row level security;
alter table public.appointment_professionals  enable row level security;
alter table public.appointment_equipment      enable row level security;
alter table public.appointment_files          enable row level security;
alter table public.room_blocks                enable row level security;
alter table public.availability_requests      enable row level security;
alter table public.availability_responses     enable row level security;
alter table public.unavailability             enable row level security;
alter table public.notifications              enable row level security;
alter table public.audit_log                  enable row level security;

-- =====================================================================
--  SURGICAL CENTERS
-- =====================================================================
drop policy if exists sc_select on public.surgical_centers;
create policy sc_select on public.surgical_centers
  for select using (id = public.current_center_id() and public.is_active_user());

drop policy if exists sc_manage on public.surgical_centers;
create policy sc_manage on public.surgical_centers
  for update using (id = public.current_center_id() and public.is_gestor())
  with check (id = public.current_center_id() and public.is_gestor());

-- =====================================================================
--  PROFILES
--  Cada usuário lê o próprio perfil; todos do centro leem dados básicos
--  (necessário para montar seletores de profissionais). O gestor gerencia.
-- =====================================================================
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
  );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and surgical_center_id = public.current_center_id());

drop policy if exists profiles_manage on public.profiles;
create policy profiles_manage on public.profiles
  for all using (public.is_gestor() and surgical_center_id = public.current_center_id())
  with check (public.is_gestor() and surgical_center_id = public.current_center_id());

-- =====================================================================
--  USER ROLES
-- =====================================================================
drop policy if exists roles_select on public.user_roles;
create policy roles_select on public.user_roles
  for select using (
    public.is_active_user() and exists (
      select 1 from public.profiles p
      where p.id = user_roles.user_id
        and p.surgical_center_id = public.current_center_id()
    )
  );

drop policy if exists roles_manage on public.user_roles;
create policy roles_manage on public.user_roles
  for all using (
    public.is_gestor() and exists (
      select 1 from public.profiles p
      where p.id = user_roles.user_id
        and p.surgical_center_id = public.current_center_id()
    )
  )
  with check (
    public.is_gestor() and exists (
      select 1 from public.profiles p
      where p.id = user_roles.user_id
        and p.surgical_center_id = public.current_center_id()
    )
  );

-- =====================================================================
--  TABELAS DE CADASTRO (leitura para todos do centro; gestor gerencia)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'rooms','equipment','accommodation_types','appointment_statuses'
  ] loop
    execute format('drop policy if exists %I_select on public.%I;', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (
         surgical_center_id = public.current_center_id() and public.is_active_user()
       );', t, t);

    execute format('drop policy if exists %I_manage on public.%I;', t, t);
    execute format(
      'create policy %I_manage on public.%I for all using (
         public.is_gestor() and surgical_center_id = public.current_center_id()
       ) with check (
         public.is_gestor() and surgical_center_id = public.current_center_id()
       );', t, t);
  end loop;
end$$;

-- =====================================================================
--  PERMISSION MATRIX (leitura para todos; gestor gerencia)
-- =====================================================================
drop policy if exists pm_select on public.permission_matrix;
create policy pm_select on public.permission_matrix
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
  );

drop policy if exists pm_manage on public.permission_matrix;
create policy pm_manage on public.permission_matrix
  for all using (public.is_gestor() and surgical_center_id = public.current_center_id())
  with check (public.is_gestor() and surgical_center_id = public.current_center_id());

-- =====================================================================
--  CENTER SETTINGS (leitura para todos; gestor gerencia)
-- =====================================================================
drop policy if exists cs_select on public.center_settings;
create policy cs_select on public.center_settings
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
  );

drop policy if exists cs_manage on public.center_settings;
create policy cs_manage on public.center_settings
  for all using (public.is_gestor() and surgical_center_id = public.current_center_id())
  with check (public.is_gestor() and surgical_center_id = public.current_center_id());

-- =====================================================================
--  APPOINTMENTS
--  SELECT: gestor OU usuário associado. (A ocupação neutra vem de
--  get_occupancy(), então usuários NÃO associados não leem estas linhas.)
--  INSERT: qualquer usuário ativo do centro pode criar.
--  UPDATE/DELETE: gestor, ou associado com permissão na matriz.
-- =====================================================================
drop policy if exists appt_select on public.appointments;
create policy appt_select on public.appointments
  for select using (
    surgical_center_id = public.current_center_id()
    and public.is_active_user()
    and (public.is_gestor() or public.is_associated(id))
  );

drop policy if exists appt_insert on public.appointments;
create policy appt_insert on public.appointments
  for insert with check (
    surgical_center_id = public.current_center_id()
    and public.is_active_user()
    and created_by = auth.uid()
  );

drop policy if exists appt_update on public.appointments;
create policy appt_update on public.appointments
  for update using (
    surgical_center_id = public.current_center_id()
    and public.is_active_user()
    and (
      public.is_gestor()
      or (
        public.is_associated(id)
        and exists (
          select 1 from public.permission_matrix pm
          join public.user_roles ur on ur.role = pm.role
          where ur.user_id = auth.uid()
            and pm.surgical_center_id = public.current_center_id()
            and pm.can_edit_appointment = true
        )
      )
    )
  )
  with check (surgical_center_id = public.current_center_id());

drop policy if exists appt_delete on public.appointments;
create policy appt_delete on public.appointments
  for delete using (
    surgical_center_id = public.current_center_id()
    and public.is_active_user()
    and (public.is_gestor() or created_by = auth.uid())
  );

-- =====================================================================
--  APPOINTMENT PROFESSIONALS
--  Visível para gestor, para o próprio profissional, ou para associados
--  ao mesmo agendamento.
-- =====================================================================
drop policy if exists ap_select on public.appointment_professionals;
create policy ap_select on public.appointment_professionals
  for select using (
    public.is_active_user() and (
      public.is_gestor()
      or user_id = auth.uid()
      or public.is_associated(appointment_id)
    )
  );

drop policy if exists ap_manage on public.appointment_professionals;
create policy ap_manage on public.appointment_professionals
  for all using (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  )
  with check (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  );

-- =====================================================================
--  APPOINTMENT EQUIPMENT (segue a associação do agendamento)
-- =====================================================================
drop policy if exists ae_select on public.appointment_equipment;
create policy ae_select on public.appointment_equipment
  for select using (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  );

drop policy if exists ae_manage on public.appointment_equipment;
create policy ae_manage on public.appointment_equipment
  for all using (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  )
  with check (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  );

-- =====================================================================
--  APPOINTMENT FILES (metadados)
--  Apenas gestor ou associados. Nunca acessível a não associados.
-- =====================================================================
drop policy if exists af_select on public.appointment_files;
create policy af_select on public.appointment_files
  for select using (
    public.is_active_user() and (
      public.is_gestor() or public.is_associated(appointment_id)
    )
  );

drop policy if exists af_insert on public.appointment_files;
create policy af_insert on public.appointment_files
  for insert with check (
    public.is_active_user()
    and uploaded_by = auth.uid()
    and (public.is_gestor() or public.is_associated(appointment_id))
  );

drop policy if exists af_delete on public.appointment_files;
create policy af_delete on public.appointment_files
  for delete using (
    public.is_active_user() and (
      public.is_gestor()
      or uploaded_by = auth.uid()
      or public.is_associated(appointment_id)
    )
  );

-- =====================================================================
--  ROOM BLOCKS
--  Leitura para todos do centro (a agenda exibe o bloqueio como neutro).
--  Somente o gestor cria/edita/remove bloqueios.
-- =====================================================================
drop policy if exists rb_select on public.room_blocks;
create policy rb_select on public.room_blocks
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
  );

drop policy if exists rb_manage on public.room_blocks;
create policy rb_manage on public.room_blocks
  for all using (public.is_gestor() and surgical_center_id = public.current_center_id())
  with check (public.is_gestor() and surgical_center_id = public.current_center_id());

-- =====================================================================
--  AVAILABILITY REQUESTS / RESPONSES (fluxo confidencial)
--  Solicitações: criadas pelo gestor; visíveis para o gestor e para os
--  profissionais da função-alvo.
--  Respostas: cada profissional lê/gerencia a própria; o gestor lê todas.
-- =====================================================================
drop policy if exists avreq_select on public.availability_requests;
create policy avreq_select on public.availability_requests
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
    and (
      public.is_gestor()
      or exists (
        select 1 from public.user_roles ur
        where ur.user_id = auth.uid() and ur.role = availability_requests.target_role
      )
    )
  );

drop policy if exists avreq_manage on public.availability_requests;
create policy avreq_manage on public.availability_requests
  for all using (public.is_gestor() and surgical_center_id = public.current_center_id())
  with check (public.is_gestor() and surgical_center_id = public.current_center_id());

drop policy if exists avresp_select on public.availability_responses;
create policy avresp_select on public.availability_responses
  for select using (
    public.is_active_user() and (
      responder_id = auth.uid() or public.is_gestor()
    )
  );

drop policy if exists avresp_upsert on public.availability_responses;
create policy avresp_upsert on public.availability_responses
  for all using (public.is_active_user() and responder_id = auth.uid())
  with check (public.is_active_user() and responder_id = auth.uid());

-- =====================================================================
--  UNAVAILABILITY (cada usuário gerencia a própria; gestor lê todas)
-- =====================================================================
drop policy if exists unavail_select on public.unavailability;
create policy unavail_select on public.unavailability
  for select using (
    surgical_center_id = public.current_center_id() and public.is_active_user()
    and (user_id = auth.uid() or public.is_gestor())
  );

drop policy if exists unavail_manage on public.unavailability;
create policy unavail_manage on public.unavailability
  for all using (public.is_active_user() and user_id = auth.uid())
  with check (
    public.is_active_user() and user_id = auth.uid()
    and surgical_center_id = public.current_center_id()
  );

-- =====================================================================
--  NOTIFICATIONS (cada usuário lê/atualiza as próprias)
-- =====================================================================
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications
  for select using (public.is_active_user() and user_id = auth.uid());

drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications
  for update using (public.is_active_user() and user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications
  for delete using (public.is_active_user() and user_id = auth.uid());

-- =====================================================================
--  AUDIT LOG (somente gestor lê; escrita ocorre via triggers definer)
-- =====================================================================
drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log
  for select using (
    public.is_gestor() and surgical_center_id = public.current_center_id()
  );

-- =====================================================================
--  STORAGE — bucket privado 'appointment-files'
--
--  Convenção de caminho: {appointment_id}/{arquivo}
--  O primeiro segmento do caminho é o UUID do agendamento, usado para
--  verificar associação. Como o bucket é privado, o acesso ocorre por
--  URLs assinadas geradas sob demanda pela aplicação.
--
--  Execute isto no SQL Editor (as tabelas storage.* já existem no Supabase).
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('appointment-files', 'appointment-files', false)
on conflict (id) do nothing;

drop policy if exists sf_select on storage.objects;
create policy sf_select on storage.objects
  for select using (
    bucket_id = 'appointment-files'
    and public.is_active_user()
    and (
      public.is_gestor()
      or public.is_associated( (split_part(name, '/', 1))::uuid )
    )
  );

drop policy if exists sf_insert on storage.objects;
create policy sf_insert on storage.objects
  for insert with check (
    bucket_id = 'appointment-files'
    and public.is_active_user()
    and (
      public.is_gestor()
      or public.is_associated( (split_part(name, '/', 1))::uuid )
    )
  );

drop policy if exists sf_delete on storage.objects;
create policy sf_delete on storage.objects
  for delete using (
    bucket_id = 'appointment-files'
    and public.is_active_user()
    and (
      public.is_gestor()
      or public.is_associated( (split_part(name, '/', 1))::uuid )
    )
  );

-- =====================================================================
--  FIM DAS POLÍTICAS
-- =====================================================================
