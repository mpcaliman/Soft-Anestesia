// Ephemeral, JWT-gated bootstrap for a real Chromium staging verification.
// The response contains ONLY synthetic fixture credentials; save it mode 0600
// outside Git. Never print the response, capture traces, or retry a lost reply.
const TARGET = 'yqqrfgbvoexricjdxpis';
const CAPABILITY_HASH = '__BROWSER_CAPABILITY_SHA256__';
const RUN_ID = '__BROWSER_RUN_UUID__';
const ISSUED_AT = '__BROWSER_ISSUED_AT__';
const EXPIRES_AT = '__BROWSER_EXPIRES_AT__';
const projectKey = (dictionary, fallback) => {
  try {
    const configured = JSON.parse(Deno.env.get(dictionary) || '{}');
    if (typeof configured?.default === 'string' && configured.default) return configured.default;
  } catch { /* Legacy keys remain supported. */ }
  return Deno.env.get(fallback) || '';
};
const url = Deno.env.get('SUPABASE_URL') || '';
const adminKey = projectKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const publicKey = projectKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const safePublicKey = () => {
  if (!publicKey || publicKey === adminKey || publicKey.startsWith('sb_secret_')) return false;
  if (publicKey.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(atob(publicKey.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon'; }
  catch { return false; }
};
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
let consumed = false;
Deno.serve(async request => {
  if (url !== `https://${TARGET}.supabase.co` || !adminKey || !safePublicKey())
    return new Response('staging_target_mismatch', { status: 403 });
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('x-audit-capability') || '')));
  const issued = Date.parse(ISSUED_AT), expires = Date.parse(EXPIRES_AT);
  if (request.method !== 'POST' || consumed || !/^[a-f0-9]{64}$/.test(CAPABILITY_HASH) || hash !== CAPABILITY_HASH
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(RUN_ID)
      || !Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued
      || expires - issued > 900000 || Date.now() < issued || Date.now() >= expires)
    return new Response('browser_capability_denied', { status: 403 });
  try {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error();
    const raw = await request.text();
    const body = raw.length <= 128 ? JSON.parse(raw) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || body.runId !== RUN_ID) throw new Error();
  } catch { return new Response('browser_run_binding_denied', { status: 400 }); }
  consumed = true;
  const deadline = Math.min(Date.now() + 90000, expires);
  const call = async (path, token, method = 'GET', body, prefer) => {
    const admin = token === adminKey;
    const key = admin ? adminKey : publicKey;
    const bearer = !token.startsWith('sb_secret_') && !token.startsWith('sb_publishable_');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('bootstrap_runtime_budget');
    const response = await fetch(url + path, { method, cache: 'no-store',
      headers: { apikey: key, ...(bearer ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json', Prefer: prefer || 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(10000, remaining)) });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  try {
    // A durable unique claim also excludes another isolate/deployment after a
    // lost response. Independent fixture-recovery.sql/ts must already exist.
    const claim = await call('/rest/v1/staging_audit_run_claims', adminKey, 'POST',
      { capability_sha256: CAPABILITY_HASH, run_id: RUN_ID, issued_at: ISSUED_AT, expires_at: EXPIRES_AT });
    if (!Array.isArray(claim) || claim.length !== 1 || claim[0].run_id !== RUN_ID
        || claim[0].capability_sha256 !== CAPABILITY_HASH) throw new Error('claim_mismatch');
    const inventory = await call('/rest/v1/rpc/staging_audit_recovery_inventory', adminKey, 'POST', { p_run_id: RUN_ID });
    if (!inventory || inventory.runId !== RUN_ID || !Array.isArray(inventory.authUserIds) || inventory.authUserIds.length !== 0
        || !Array.isArray(inventory.organizationIds) || inventory.organizationIds.length !== 0
        || ['activeMemberships', 'activeProfiles', 'activeOrganizations', 'programmerPrivileges', 'bannedAuthUsers',
          'activeSharesPendingClosure'].some(name => inventory[name] !== 0)
        || !Number.isFinite(Date.parse(inventory.claimedAt)) || Date.parse(inventory.claimedAt) < issued
        || Date.parse(inventory.claimedAt) >= expires) throw new Error('fixture_recovery_preflight_mismatch');
    const users = [], orgs = [], patients = [];
    for (let index = 0; index < 4; index++) {
      const email = `audit-${RUN_ID}-${index}@example.invalid`;
      const password = 'Aa1!' + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
      const created = await call('/auth/v1/admin/users', adminKey, 'POST',
        { email, password, email_confirm: true, app_metadata: { synthetic_audit: RUN_ID } });
      if (!created?.id || created.email !== email) throw new Error('fixture_identity_mismatch');
      users.push({ id: created.id, email, password, organizationIndex: index < 2 ? 0 : 1 });
    }
    for (let index = 0; index < 2; index++) {
      const id = crypto.randomUUID();
      const rows = await call('/rest/v1/organizations', adminKey, 'POST', { id, nome: `synthetic-${RUN_ID}-${index}` });
      if (rows?.[0]?.id !== id) throw new Error('fixture_organization_mismatch');
      orgs.push(id);
    }
    for (const user of users) {
      await call('/rest/v1/profiles?on_conflict=id', adminKey, 'POST',
        { id: user.id, nome: 'Synthetic browser verifier', email: user.email, ativo: true },
        'resolution=merge-duplicates,return=representation');
      await call('/rest/v1/organization_users', adminKey, 'POST',
        { organization_id: orgs[user.organizationIndex], user_id: user.id, role: 'gestor', ativo: true });
    }
    for (let index = 0; index < 2; index++) {
      const user = users[index * 2];
      const session = await call('/auth/v1/token?grant_type=password', publicKey, 'POST', { email: user.email, password: user.password });
      if (session.user?.id !== user.id || !session.access_token) throw new Error('fixture_login_mismatch');
      // Clinical writes prove the real authenticated boundary, without a
      // server INSERT grant or any bypass of the production policy model.
      const rows = await call('/rest/v1/patients', session.access_token, 'POST',
        { organization_id: orgs[index], nome: `Synthetic Browser ${RUN_ID} ${index}`, legacy_id: `browser-${RUN_ID}-${index}`,
          data: { _id: `browser-${RUN_ID}-${index}`, nome: `Synthetic Browser ${RUN_ID} ${index}` } });
      if (!rows?.[0]?.id || rows[0].organization_id !== orgs[index]) throw new Error('fixture_patient_mismatch');
      patients.push({ id: rows[0].id, organization_id: orgs[index], legacy_id: rows[0].legacy_id, version: rows[0].version });
      // No access or refresh tokens cross the protected bootstrap response.
      await call('/auth/v1/logout?scope=global', session.access_token, 'POST');
    }
    return Response.json({ target: TARGET, runId: RUN_ID, publicKey, organizations: orgs, users, patients,
      retention: 'retain-blocked-synthetic-evidence', fixtureAccess: 'active-until-independent-recovery', independentRecoveryRequired: true },
      { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    // Tokens, passwords, emails and server response bodies never enter errors.
    const diagnostic = error instanceof Error && /^(http_[0-9]{3}|bootstrap_runtime_budget|claim_mismatch|fixture_[a-z_]+)$/.test(error.message)
      ? error.message : 'unexpected_error';
    return Response.json({ target: TARGET, runId: RUN_ID, failed: true, diagnostic, independentRecoveryRequired: true },
      { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
});
