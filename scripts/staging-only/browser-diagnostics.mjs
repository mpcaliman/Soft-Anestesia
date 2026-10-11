/** Redacted diagnostics: fixed enums, HTTP statuses and booleans only.
 * Never record URLs/headers/frame payloads, names, passwords, JWTs or bodies.
 */
const routes = new Map([
  ['/auth/v1/token', 'auth_token'], ['/auth/v1/logout', 'auth_logout'],
  ['/rest/v1/profiles', 'profiles'], ['/rest/v1/organization_users', 'memberships'],
  ['/rest/v1/organizations', 'organizations'], ['/rest/v1/rpc/ensure_offline_keyring', 'offline_keyring'],
  ['/rest/v1/patients', 'patients']
]);
const networkErrors = new Set(['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID',
  'net::ERR_PROXY_CONNECTION_FAILED', 'net::ERR_TUNNEL_CONNECTION_FAILED', 'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_TIMED_OUT', 'net::ERR_FAILED', 'net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT']);
export const networkErrorEnum = text => networkErrors.has(text) ? text : 'other_transport_error';
export const routeEnum = (url, target) => {
  try { const parsed = new URL(url); return parsed.hostname === `${target}.supabase.co`
    ? routes.get(parsed.pathname) || 'other_stage_route' : 'non_stage_route'; }
  catch { return 'invalid_url'; }
};
export const scriptErrorEnum = error => {
  const text = String(error?.message || '');
  const kind = /ReferenceError/.test(text) || error?.name === 'ReferenceError' ? 'ReferenceError'
    : /TypeError/.test(text) || error?.name === 'TypeError' ? 'TypeError' : 'other_script_error';
  const symbol = ['auth', 'cloud', 'contextoAba', 'ambiente', 'filaCifrada', 'persistenciaCloudFirst', 'store', 'realtime']
    .find(name => new RegExp(`\\b${name}\\b`).test(text)) || 'unknown_symbol';
  return { kind, symbol };
};
export const observeRedacted = (page, target, state) => {
  state.network = []; state.scriptErrors = [];
  page.on('response', response => {
    const route = routeEnum(response.url(), target);
    if (route !== 'non_stage_route') state.network.push({ route, status: response.status() });
  });
  page.on('requestfailed', request => {
    const route = routeEnum(request.url(), target);
    if (route !== 'non_stage_route') state.network.push({ route, error: networkErrorEnum(request.failure()?.errorText) });
  });
  page.on('pageerror', error => state.scriptErrors.push(scriptErrorEnum(error)));
};
export const authStateRedacted = async (page, expected) => {
  try { return await page.evaluate(({ target, uid, org }) => {
    const configured = typeof cloud !== 'undefined' ? cloud.config() : null;
    const session = typeof cloud !== 'undefined' ? cloud.session() : null;
    const context = typeof contextoAba !== 'undefined' ? contextoAba.atual() : null;
    const failure = typeof cloud !== 'undefined' ? cloud._ultimaFalha?.tipo : null;
    const raw = document.getElementById('auth-error')?.textContent || '';
    const ui = !raw ? 'none' : raw.includes('Verificando') ? 'checking'
      : raw.includes('confirmar sua clínica') ? 'organization_confirmation_failed'
      : raw.includes('inativa') ? 'inactive_account' : raw.includes('não corresponde') ? 'identity_mismatch'
      : raw.includes('E-mail ou senha') || raw.includes('inválidos') ? 'credentials_rejected'
      : raw.includes('servidor') || raw.includes('conexão') ? 'server_or_network_error'
      : raw.includes('Muitas tentativas') ? 'auth_throttled' : 'other_auth_message';
    return { online: navigator.onLine, appAuthPresent: typeof auth !== 'undefined',
      cloudPresent: typeof cloud !== 'undefined', configuredStageOnly: configured?.url === `https://${target}.supabase.co`,
      publicKeyKind: configured?.anonKey?.startsWith('sb_publishable_') ? 'publishable'
        : configured?.anonKey?.startsWith('sb_secret_') ? 'secret_rejected' : 'other',
      cloudSessionPresent: !!session, cloudUserMatches: session?.user?.id === uid,
      appAuthenticated: typeof auth !== 'undefined' && auth.estaLogado(),
      contextVerified: !!context?.verified, contextOperational: typeof contextoAba !== 'undefined' && contextoAba.operational(),
      contextUserMatches: context?.userId === uid, contextOrganizationMatches: context?.organizationId === org,
      cloudFailureKind: ['fora', 'credencial', 'nao_confirmado', 'excesso', 'protocolo'].includes(failure) ? failure : failure ? 'other' : 'none',
      authUI: ui, overlayVisible: document.getElementById('auth-overlay')?.style.display !== 'none' };
  }, expected); } catch { return { diagnosticUnavailable: true }; }
};
