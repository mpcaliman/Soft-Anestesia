-- ============================================================================
-- Soft Anestesia — registro imutável de assinaturas digitais (validação pública)
-- ============================================================================
-- Guarda APENAS o mínimo para provar autenticidade/integridade de um documento
-- assinado. NÃO guarda conteúdo clínico. A verificação pública lê só os campos
-- não sensíveis; a inserção é feita pela Edge Function (service_role).
-- ----------------------------------------------------------------------------

create table if not exists public.assinaturas (
  id             uuid primary key default gen_random_uuid(),
  codigo         text not null unique,          -- código de validação legível (ex.: ABCD-2345-EFGH)
  modulo         text not null,                 -- pre | anestesia | consulta | termo | prescricao | ...
  doc_id         text,                          -- id do registro de origem no app
  titulo         text not null,                 -- ex.: "Ficha de Anestesia"
  paciente_ini   text,                          -- iniciais do paciente (mínimo necessário, sem nome completo)
  profissional   text,                          -- nome do médico assinante
  crm            text,                          -- CRM/UF
  hash_doc       text not null,                 -- SHA-256 do PDF assinado (hex)
  algoritmo      text not null default 'SHA-256',
  provedor       text not null,                 -- govbr | safeid_cloud | certillion | ...
  cert_emissor   text,                          -- issuer DN do certificado (quando disponível via CSC)
  cert_serial    text,                          -- número de série do certificado
  cert_titular   text,                          -- subject DN / titular
  cadeia_icp     boolean,                       -- cadeia ICP-Brasil validada no momento da assinatura
  versao         int not null default 1,        -- versão do documento (versionamento imutável)
  prev_hash      text,                          -- encadeamento: self_hash do registro anterior
  self_hash      text not null,                 -- SHA-256 do próprio registro (à prova de adulteração)
  assinado_em    timestamptz not null default now(),
  criado_em      timestamptz not null default now()
);

create index if not exists assinaturas_codigo_idx  on public.assinaturas (codigo);
create index if not exists assinaturas_hash_idx    on public.assinaturas (hash_doc);
create index if not exists assinaturas_docid_idx   on public.assinaturas (modulo, doc_id);

-- Imutabilidade: proíbe UPDATE/DELETE mesmo para quem tiver acesso.
create or replace function public.assinaturas_no_mutate()
returns trigger language plpgsql as $$
begin
  raise exception 'Registro de assinatura é imutável (append-only).';
end;
$$;
drop trigger if exists assinaturas_immutable on public.assinaturas;
create trigger assinaturas_immutable
  before update or delete on public.assinaturas
  for each row execute function public.assinaturas_no_mutate();

-- RLS: leitura pública apenas dos campos de autenticidade (via a Edge Function
-- ou uma view). A inserção é exclusiva da Edge Function (service_role, que
-- ignora RLS). Aqui bloqueamos qualquer escrita anônima.
alter table public.assinaturas enable row level security;

-- View pública com o mínimo para validação (sem doc_id nem dados sensíveis).
create or replace view public.assinaturas_publicas as
  select codigo, titulo, paciente_ini, profissional, crm, hash_doc, algoritmo,
         provedor, cert_emissor, cert_serial, cert_titular, cadeia_icp, versao,
         assinado_em
  from public.assinaturas;

-- Permite SELECT anônimo somente na view pública.
grant select on public.assinaturas_publicas to anon, authenticated;
