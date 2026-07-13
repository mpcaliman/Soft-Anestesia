# Assinatura digital ICP‑Brasil em nuvem (Opção B) — backend

Backend leve para o **1‑clique real** com certificado em nuvem (SafeID/Certillion),
sem que o app estático precise guardar segredo. O app (`index.html`) chama a
Edge Function; o segredo do provedor fica só no servidor.

## Por que precisa de backend
Um app estático (GitHub Pages) **não pode guardar o `client_secret` OAuth** — qualquer
um leria no JavaScript. A Edge Function guarda o segredo e orquestra a assinatura
com a API do provedor. O **PIN/senha do certificado nunca passa pelo nosso lado**:
o usuário aprova a operação no app do provedor (push/OTP/biometria).

## Arquitetura
```
Navegador (index.html)                Supabase                     Provedor (SafeID/Certillion)
  adaptador safeid_cloud  ──HTTPS──►  Edge Function  ──OAuth2/CSC──►  API de assinatura em nuvem
      (sem segredo)                   (guarda segredo)                (chave no HSM do provedor)
                                          │
                                          └── tabela `assinaturas` (registro imutável)
                                              view `assinaturas_publicas` (validação pública)
```
Padrão de API: **CSC — Cloud Signature Consortium v1** (o que ITI/gov.br,
Certillion e provedores BR expõem).

## Deploy
1. Crie/pegue um projeto Supabase (o app já tem campo de URL nos Ajustes).
2. Rode a migração:
   ```bash
   supabase db push        # aplica supabase/migrations/0001_assinaturas.sql
   ```
3. Publique a função:
   ```bash
   supabase functions deploy assinatura --no-verify-jwt
   ```
4. Configure os segredos (nunca no app):
   ```bash
   supabase secrets set \
     SIGN_PROVIDER=safeid \
     CSC_BASE_URL="https://<host-do-provedor>/csc/v1" \
     CSC_CLIENT_ID="<client_id>" \
     CSC_CLIENT_SECRET="<client_secret>" \
     CSC_SCOPE="service"
   ```
5. No app: **Ajustes → nuvem** informe a URL do Supabase. O adaptador
   `safeid_cloud` passa a ficar "disponível" e o 1‑clique é liberado.

## O que a função expõe (`?op=`)
- `health` — checa se o provedor está configurado.
- `cert-list` / `cert-info` — lista/《detalha》 os certificados do usuário (CSC).
- `sign` — recebe o PDF (base64) + credencial + SAD, assina em **PAdES**, calcula
  o **SHA‑256**, grava o **registro imutável** e devolve o PDF assinado + código.
- `validar` — validação pública por `codigo` ou `hash` (lê só a view não sensível).

## ⚠️ O que EU preciso de você para finalizar e testar
A orquestração está pronta no **padrão CSC**, mas os pontos marcados
`>>> AJUSTAR CONFORME O PROVEDOR <<<` no `index.ts` dependem da **documentação de
API do SafeID/Certillion**. Me envie:

1. **Base URL** da API (ex.: `https://api.safeid.com.br/csc/v1`).
2. **Fluxo OAuth** aceito: `client_credentials` (app) ou `authorization_code`+PKCE
   (o usuário autoriza) — e as URLs de `token`/`authorize`.
3. **Credenciais**: `client_id` e `client_secret` (ficam só nos secrets).
4. **Endpoint de assinatura**: é **por documento** (envia PDF → recebe PDF assinado)
   ou **por hash** (`signatures/signHash` + embutir PAdES no nosso lado)?
   E o **formato exato** de request/response.
5. Como o usuário fornece o **SAD/OTP** (push no app, OTP, etc.).

Com isso eu ajusto o driver (2–3 funções pequenas e isoladas), fazemos um teste
com um certificado real e ligamos o 1‑clique. Até lá, o fluxo **gov.br / SafeID‑app
(guiado)** já entrega assinatura ICP‑Brasil real e verificável.

## Segurança / LGPD
- Segredo do provedor só na Edge Function (secrets).
- A tabela `assinaturas` é **append‑only** (trigger bloqueia UPDATE/DELETE).
- A validação pública lê a **view `assinaturas_publicas`** — sem dado clínico;
  paciente só por **iniciais**.
- PIN/chave nunca tocam o nosso backend.
