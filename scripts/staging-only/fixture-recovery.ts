// Recovery independente do runner, exclusivamente em homologação. Repetições
// idempotentes são permitidas; esta função nunca cria identidades/fixtures.
const TARGET = 'yqqrfgbvoexricjdxpis';
const RUN_ID = '__RECOVERY_RUN_UUID__';
const CAPABILITY_HASH = '__RECOVERY_CAPABILITY_SHA256__';
const ISSUED_AT = '__RECOVERY_ISSUED_AT__';
const EXPIRES_AT = '__RECOVERY_EXPIRES_AT__';
const MIN_CLAIM_AGE_MS = 180000;
const url = Deno.env.get('SUPABASE_URL') || '';
const projectKey = (dictionary: string, fallback: string) => {
  try {
    const configured = JSON.parse(Deno.env.get(dictionary) || '{}');
    if (typeof configured?.default === 'string' && configured.default) return configured.default;
  } catch { /* legacy project */ }
  return Deno.env.get(fallback) || '';
};
const adminKey = projectKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const anonKey = projectKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const adminHeaders = (): Record<string, string> => ({ apikey: adminKey,
  ...(adminKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${adminKey}` }) });
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

Deno.serve(async request => {
  if (url !== `https://${TARGET}.supabase.co` || !adminKey || !anonKey)
    return new Response('staging_target_mismatch', { status: 403 });
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('x-audit-capability') || '')));
  const issued = Date.parse(ISSUED_AT), expires = Date.parse(EXPIRES_AT);
  if (request.method !== 'POST' || !/^[a-f0-9]{64}$/.test(CAPABILITY_HASH) || hash !== CAPABILITY_HASH
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(RUN_ID)
      || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued
      || expires - issued > 15 * 60 * 1000 || Date.now() < issued || Date.now() >= expires)
    return new Response('recovery_capability_denied', { status: 403 });
  try {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      return new Response('recovery_run_binding_denied', { status: 400 });
    const raw = await request.text();
    const body = raw.length <= 128 ? JSON.parse(raw) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || body.runId !== RUN_ID)
      return new Response('recovery_run_binding_denied', { status: 400 });
  } catch { return new Response('recovery_run_binding_denied', { status: 400 }); }
  const deadline = Date.now() + 120000;
  const checks: { name: string; passed: boolean; diagnostic?: string }[] = [];
  const expect = (condition: unknown) => { if (!condition) throw new Error('assertion_failed'); };
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('recovery_runtime_budget');
    const response = await fetch(url + path, {
      method, headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(10000, remaining)), cache: 'no-store'
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json();
  };
  const rpc = (name: string) => call(`/rest/v1/rpc/${name}`, { p_run_id: RUN_ID });
  const diagnostic = (error: unknown) => error instanceof Error && /^(http_[0-9]{3}|assertion_failed|recovery_runtime_budget)$/.test(error.message)
    ? error.message : 'unexpected_error';
  let inventory: any = null;
  let pending = 0;
  try {
    inventory = await rpc('staging_audit_recovery_inventory');
    expect(inventory.runId === RUN_ID && Array.isArray(inventory.authUserIds) && inventory.authUserIds.length <= 4
      && new Set(inventory.authUserIds).size === inventory.authUserIds.length
      && inventory.authUserIds.every((id: unknown) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
      && Array.isArray(inventory.organizationIds) && inventory.organizationIds.length <= 2);
    const knownUsers = JSON.stringify([...inventory.authUserIds].sort());
    const knownOrganizations = JSON.stringify([...inventory.organizationIds].sort());
    // Esperar o orçamento do runner mais chamadas em voo evita recuperar uma
    // fotografia enquanto ele ainda poderia criar outra identidade.
    expect(Number.isFinite(Date.parse(inventory.claimedAt)) && Date.now() - Date.parse(inventory.claimedAt) >= MIN_CLAIM_AGE_MS);
    checks.push({ name: 'claimed_exact_run_and_terminated_runner_window', passed: true });
    inventory = await rpc('staging_audit_block_fixture');
    expect(inventory.runId === RUN_ID && inventory.activeMemberships === 0 && inventory.activeProfiles === 0
      && inventory.activeOrganizations === 0 && inventory.programmerPrivileges === 0
      && JSON.stringify([...inventory.authUserIds].sort()) === knownUsers
      && JSON.stringify([...inventory.organizationIds].sort()) === knownOrganizations);
    checks.push({ name: 'independent_database_access_contained', passed: true });
    for (const id of inventory.authUserIds) {
      // Sem senha antiga, token de usuário, listagem global ou DELETE Auth.
      const password = 'Aa1!' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      const changed = await call(`/auth/v1/admin/users/${id}`, { password, ban_duration: '876000h' }, 'PUT');
      expect(changed.id === id && Date.parse(changed.banned_until) > Date.now());
      const verified = await call(`/auth/v1/admin/users/${id}`, undefined, 'GET');
      expect(verified.id === id && Date.parse(verified.banned_until) > Date.now());
      checks.push({ name: 'exact_synthetic_auth_identity_banned_password_rotated_retained', passed: true });
    }
    // Prazo de share pode vencer durante o bloqueio Auth. Segunda contenção
    // materializa essa expiração pelo guard original antes da verificação.
    await rpc('staging_audit_block_fixture');
    inventory = await rpc('staging_audit_verify_recovery');
    expect(inventory.runId === RUN_ID && inventory.activeMemberships === 0 && inventory.activeProfiles === 0
      && inventory.activeOrganizations === 0 && inventory.programmerPrivileges === 0
      && inventory.bannedAuthUsers === inventory.authUserIds.length
      && JSON.stringify([...inventory.authUserIds].sort()) === knownUsers
      && JSON.stringify([...inventory.organizationIds].sort()) === knownOrganizations);
    pending = Number(inventory.activeSharesPendingClosure);
    expect(Number.isInteger(pending) && pending >= 0);
    checks.push({ name: 'durable_recovery_verified', passed: true });
  } catch (error) { checks.push({ name: 'independent_recovery', passed: false, diagnostic: diagnostic(error) }); }
  return Response.json({ target: TARGET, runId: RUN_ID, checks, passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length, pending, inventory,
    retention: { policy: 'retain-blocked-synthetic-evidence', clinicalRowsDeleted: false, auditRowsDeleted: false, authUsersDeleted: false },
    limitations: ['Existing access JWT is contained by disabled scope; no assertion of JWT revocation',
      'Active share metadata requires legitimate programmer closure; pending is never approval',
      'Repeat only this recovery capability/UUID; never retry the original fixture-creation runner'] });
});
