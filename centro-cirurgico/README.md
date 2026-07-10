# Centro Cirúrgico — Sistema de Agendamento

Sistema web para organização e agendamento de procedimentos e cirurgias em
um centro cirúrgico. Front-end em **HTML5 + CSS3 + JavaScript puro** (ES
Modules), back-end no **Supabase** (Auth, PostgreSQL, Storage, Realtime e
Edge Functions), com **Row Level Security (RLS)** protegendo todos os dados
sensíveis.

- Idioma: **português do Brasil**
- Datas: **dd/mm/aaaa** · Horário: **24h** · Fuso: **America/Bahia**
- Sem componentes pagos. Calendário próprio, sem dependências de licença.

> Este módulo fica na pasta `centro-cirurgico/` e é independente do
> aplicativo de anestesia já existente na raiz do repositório.

---

## 1. Estrutura de arquivos

```
centro-cirurgico/
├── index.html                 # Shell da SPA (login + módulos)
├── styles.css                 # Estilos responsivos (desktop/tablet/celular)
├── config.example.js          # Modelo de configuração (copie para config.js)
├── supabase-client.js         # Cliente Supabase + utilitários
├── auth.js                    # Login, recuperação de senha, sessão
├── app.js                     # Bootstrap, menu, roteamento, permissões
├── calendar.js                # Agenda (grade/dia/semana/mês/lista)
├── appointments.js            # CRUD de agendamento, arquivos, profissionais
├── notifications.js           # Notificações internas + Realtime
├── settings.js                # Módulo Ajustes (somente gestor)
├── whatsapp.js                # Envio manual (wa.me) + Edge Function
├── supabase-schema.sql        # Tabelas, views, funções e triggers
├── supabase-rls.sql           # Políticas de RLS (tabelas + Storage)
├── README.md                  # Este arquivo
└── supabase/functions/
    ├── _shared/cors.ts
    ├── invite-user/index.ts   # Criação/convite de usuários (service_role)
    └── whatsapp-notify/index.ts  # Notificação por WhatsApp (token em secret)
```

---

## 2. Pré-requisitos

- Uma conta e um projeto no [Supabase](https://supabase.com).
- [Supabase CLI](https://supabase.com/docs/guides/cli) (para as Edge
  Functions).
- Um servidor de arquivos estáticos para publicar o front-end
  (Netlify, Vercel, GitHub Pages, Nginx, etc.).

---

## 3. Configuração do banco de dados

No painel do Supabase, abra **SQL Editor** e execute, **nesta ordem**:

1. `supabase-schema.sql` — cria tabelas, tipos, funções, triggers, a
   função de verificação de conflitos, a função de ocupação neutra e um
   centro cirúrgico inicial com dados-semente (salas, status e
   acomodações padrão).
2. `supabase-rls.sql` — habilita RLS em todas as tabelas sensíveis, cria
   as políticas de acesso e o **bucket privado** `appointment-files` com
   suas políticas de Storage.

### O que a RLS garante

- Todo acesso é restrito ao **centro cirúrgico** do usuário.
- **Usuários inativos** não acessam dados.
- O **gestor** enxerga tudo do seu centro.
- Os **demais usuários** só veem os agendamentos aos quais estão
  **associados** (criador, cirurgião principal/adicional/auxiliar,
  anestesiologista, pediatra, auxiliar ou empresa vinculada).
- A **ocupação neutra** (livre/ocupado/bloqueado) é obtida pela função
  `get_occupancy()`, que devolve apenas identificador anônimo, sala,
  data, horário e situação — **nunca** paciente, procedimento,
  profissionais, equipamentos, arquivos ou status detalhado.
- Os **arquivos** (Storage) só são acessíveis por usuários associados ou
  pelo gestor, sempre por **URL assinada** temporária (bucket privado).

---

## 4. Configuração da autenticação

Em **Authentication → URL Configuration**:

- **Site URL**: a URL onde o front-end será publicado
  (ex.: `https://seu-dominio.com/centro-cirurgico/`).
- **Redirect URLs**: adicione a mesma URL (necessária para o convite de
  usuários e a recuperação de senha).

Em **Authentication → Providers → Email**: mantenha o provedor de e-mail
habilitado.

### Criando o primeiro gestor

Como o convite de usuários exige um gestor autenticado, crie o primeiro
manualmente:

1. Em **Authentication → Users**, clique em **Add user** e crie o e-mail
   do gestor (defina uma senha).
2. Copie o `UUID` do usuário criado.
3. No **SQL Editor**, execute (substituindo o UUID e o e-mail):

   ```sql
   -- Vincula o usuário ao centro criado pelo schema:
   insert into public.profiles (id, surgical_center_id, full_name, email, status)
   select 'UUID_DO_USUARIO',
          (select id from public.surgical_centers order by created_at limit 1),
          'Nome do Gestor', 'gestor@exemplo.com', 'ativo';

   insert into public.user_roles (user_id, role)
   values ('UUID_DO_USUARIO', 'gestor');
   ```

A partir daí, o gestor faz login e cadastra os demais usuários pelo módulo
**Ajustes → Usuários** (que dispara a Edge Function `invite-user`).

---

## 5. Configuração do front-end

1. Copie o modelo de configuração:

   ```bash
   cp config.example.js config.js
   ```

2. Edite `config.js` e preencha:

   - `SUPABASE_URL` — URL do projeto (Settings → API).
   - `SUPABASE_ANON_KEY` — **apenas** a chave pública `anon`.
   - `APP_NAME` — nome exibido do centro cirúrgico.

   > **Segurança:** `config.js` só pode conter a chave anônima pública.
   > **Nunca** coloque a chave `service_role`, tokens do WhatsApp ou
   > outros segredos no front-end. Adicione `config.js` ao `.gitignore`.

3. Publique os arquivos estáticos da pasta `centro-cirurgico/` em qualquer
   hospedagem de sites estáticos. Como usa ES Modules, sirva via **HTTP(S)**
   (não abra por `file://`). Para testar localmente:

   ```bash
   cd centro-cirurgico
   python3 -m http.server 8080
   # abra http://localhost:8080
   ```

---

## 6. Edge Functions

As funções ficam em `supabase/functions/`. Configure os **segredos**
(nunca vão para o front-end):

```bash
supabase secrets set \
  SUPABASE_URL="https://SEU-PROJETO.supabase.co" \
  SUPABASE_ANON_KEY="CHAVE_ANON" \
  SUPABASE_SERVICE_ROLE_KEY="CHAVE_SERVICE_ROLE" \
  WHATSAPP_TOKEN="TOKEN_DO_PROVEDOR" \
  WHATSAPP_PHONE_ID="ID_DO_NUMERO"
```

Publique:

```bash
supabase functions deploy invite-user
supabase functions deploy whatsapp-notify
```

- **`invite-user`** — cria/convida usuários. Só executa se o solicitante
  for **gestor** (validado no servidor). Usa `service_role` para criar o
  usuário no Auth, enviar o convite e gravar o perfil com as funções.
- **`whatsapp-notify`** — envio automático de mensagem **neutra** por
  WhatsApp. O token permanece somente no ambiente da função. Por padrão
  usa a WhatsApp Cloud API (Meta); ajuste `sendViaProvider()` para outro
  provedor. Sem credenciais, retorna uma simulação para não quebrar o
  fluxo.

> A verificação de conflitos usa a **função PostgreSQL**
> `check_appointment_conflict()` (e a RPC `save_appointment()`), executada
> no servidor — não depende do navegador.

---

## 7. Perfis e permissões

Perfis: **gestor, cirurgião, cirurgião auxiliar, anestesiologista,
pediatra, auxiliar, empresa prestadora**. Um usuário pode ter **mais de
uma função**.

- **Gestor**: acesso total ao seu centro — agenda completa, todos os
  dados dos pacientes, criação/edição/reagendamento/cancelamento,
  bloqueio de salas, gestão de usuários/salas/equipamentos/acomodações/
  status, matriz de permissões, solicitações de disponibilidade,
  configurações e WhatsApp. Pode fazer alterações excepcionais informando
  **justificativa** (registrada na auditoria).
- **Demais usuários**: veem a **ocupação** das salas (livre/ocupado/
  bloqueado), criam agendamentos, e só veem/editam os procedimentos
  **associados** ao seu usuário, conforme a **matriz de permissões**
  definida pelo gestor. Também informam indisponibilidade e respondem a
  solicitações da sua função.

Para procedimentos **não associados**, o sistema mostra apenas um cartão
neutro com **"Ocupado"** (ou **"Bloqueado"**), sem qualquer dado do
paciente, procedimento, profissionais, equipamentos ou arquivos — proteção
aplicada no **banco** (RLS + função de ocupação), não apenas na interface.

---

## 8. Módulos do sistema

- **Agenda** — grade diária por sala, além de dia, semana, mês e lista.
  Filtros por sala, profissional, status e texto; localizar horários
  livres; clique em horário livre para agendar; clique no procedimento
  próprio para ver detalhes. Atualização em tempo real (Realtime).
- **Novo agendamento** — formulário completo (paciente, procedimento,
  profissionais, equipamentos, arquivos, prioridade, observações). Exige
  CPF **ou** carteirinha; senha de autorização obrigatória por padrão
  (com opção "Não se aplica" quando o gestor habilitar).
- **Meus procedimentos** — lista dos agendamentos associados ao usuário.
- **Notificações** — avisos internos, com contador em tempo real.
- **Minha disponibilidade** — períodos de indisponibilidade e respostas a
  solicitações confidenciais.
- **Ajustes** (somente gestor) — usuários, salas, equipamentos,
  acomodações, status, matriz de permissões, bloqueios de sala,
  solicitações de disponibilidade e configurações gerais (intervalo da
  grade: 10/15/20/30/60 min, horário de funcionamento, autorização,
  WhatsApp).
- **Sair** — encerra a sessão.

---

## 9. Arquivos anexados

- Envio de **foto (JPG/PNG)** ou **PDF**, múltiplos por agendamento.
- Tamanho máximo configurável (padrão **10 MB** por arquivo).
- Armazenados no **bucket privado** `appointment-files`, no caminho
  `{appointment_id}/{arquivo}`.
- Acesso somente para usuários **associados** ou **gestor**, via **URL
  assinada** temporária — nunca por URL pública.
- Registra nome, tipo, data de envio e **quem** fez o upload.

---

## 10. WhatsApp

Dois níveis, sempre com mensagem **neutra** (sem CPF, carteirinha, data de
nascimento, senha de autorização, dados clínicos ou arquivos):

- **Nível 1 (manual)** — botão *"Enviar pelo WhatsApp"* abre o
  WhatsApp/WhatsApp Web via `wa.me` com a mensagem preenchida; o usuário
  escolhe o destinatário entre os profissionais associados e confirma o
  envio.
- **Nível 2 (automático)** — quando habilitado nas configurações, dispara
  a Edge Function `whatsapp-notify`.

---

## 11. Segurança — resumo

- Segredos (**service_role**, **tokens do WhatsApp**) ficam **somente** nas
  Edge Functions (variáveis de ambiente). O front-end usa apenas a chave
  **anon** pública.
- **RLS** em todas as tabelas sensíveis; ocupação neutra por função
  `SECURITY DEFINER`; arquivos em bucket privado com políticas próprias.
- Proteção contra tentativas excessivas de login (bloqueio temporário).
- **Auditoria**: toda alteração em agendamentos e bloqueios é registrada
  em `audit_log`, incluindo a **justificativa** de alterações excepcionais.
- Escapamento de HTML ao renderizar dados do banco (prevenção de XSS).

---

## 12. Preparação para múltiplos centros

Todas as tabelas relevantes têm `surgical_center_id`. Hoje há um único
centro (criado pelo schema), mas o modelo e a RLS já isolam os dados por
centro. Para suportar vários centros no futuro, basta cadastrar novos
registros em `surgical_centers` e vincular perfis/salas/etc. ao centro
correspondente — as políticas de RLS continuam válidas sem alteração.
