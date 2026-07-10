// =====================================================================
//  config.example.js
//
//  COPIE este arquivo para "config.js" e preencha com os dados do seu
//  projeto Supabase. O arquivo config.js NÃO deve ser versionado
//  (adicione-o ao .gitignore).
//
//  IMPORTANTE — SEGURANÇA:
//   * Aqui só pode existir a CHAVE ANÔNIMA (anon/public) do Supabase.
//   * NUNCA coloque a chave service_role, tokens de WhatsApp ou qualquer
//     outro segredo neste arquivo — ele é público (roda no navegador).
//   * Segredos ficam apenas nas Edge Functions (variáveis de ambiente).
// =====================================================================

export const CONFIG = {
  // URL do projeto Supabase, ex.: https://xxxxxxxx.supabase.co
  SUPABASE_URL: 'https://SEU-PROJETO.supabase.co',

  // Chave pública "anon" do Supabase (Settings → API → Project API keys).
  SUPABASE_ANON_KEY: 'SUA_CHAVE_ANON_PUBLICA',

  // Nome do bucket privado de arquivos (deve existir no Storage).
  STORAGE_BUCKET: 'appointment-files',

  // Nome exibido do centro cirúrgico na tela de login.
  APP_NAME: 'Centro Cirúrgico',

  // Fuso horário de referência da aplicação.
  TIME_ZONE: 'America/Bahia',

  // Limite de tamanho por arquivo enviado (em bytes). Padrão: 10 MB.
  MAX_FILE_SIZE: 10 * 1024 * 1024,

  // Tipos MIME aceitos para upload.
  ALLOWED_FILE_TYPES: ['image/jpeg', 'image/png', 'application/pdf'],

  // Proteção contra tentativas excessivas de login (lado cliente).
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_LOCK_SECONDS: 60,
};
