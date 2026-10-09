// Executar somente como Edge Function efêmera de homologação. Não é asset público.
// Antes do deploy, substituir o marcador pelo SHA-256 de uma capacidade aleatória
// guardada fora do Git. A gateway JWT deve permanecer habilitada.
const TARGET = 'yqqrfgbvoexricjdxpis';
const CAPABILITY_HASH = '__RUN_CAPABILITY_SHA256__';
const url = Deno.env.get('SUPABASE_URL') || '';
const adminKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
let consumed = false;

Deno.serve(async request => {
  if (url !== `https://${TARGET}.supabase.co` || !adminKey || !anonKey)
    return new Response('staging_target_mismatch', { status: 403 });
  const capability = request.headers.get('x-audit-capability') || '';
  const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability)));
  if (request.method !== 'POST' || hash !== CAPABILITY_HASH || consumed)
    return new Response('audit_capability_denied', { status: 403 });
  consumed = true;
  const runId = crypto.randomUUID();
  const checks: { name: string; passed: boolean | null; diagnostic?: string }[] = [];
  const users: { id: string; email: string; password: string; access_token: string; refresh_token: string }[] = [];
  const orgs: string[] = [];
  const sockets: WebSocket[] = [];
  let storagePath: string | null = null;
  let phase = 'fixture_auth_create';
  const diagnostic = (error: unknown) => {
    const value = error instanceof Error ? error.message : 'unknown_error';
    return /^(http_[0-9]{3}|assertion_failed|websocket_timeout|websocket_error|fetch_failed)$/.test(value)
      ? value : 'unexpected_error';
  };
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, diagnostic: diagnostic(error) }); }
  };
  const expect = (condition: unknown) => { if (!condition) throw new Error('assertion_failed'); };
  const call = async (path: string, token: string, method = 'GET', body?: unknown,
    headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, {
      method, headers: { apikey: anonKey, Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000)
    });
    const text = await response.text();
    let data: any; try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, ok: response.ok, data };
  };
  const accepted = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    if (!result.ok) throw new Error(`http_${result.status}`);
    return result.data;
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let index = 0; index < 4; index++) {
      const email = `audit-${runId}-${index}@example.invalid`;
      const password = crypto.randomUUID() + crypto.randomUUID();
      const created = await accepted('/auth/v1/admin/users', adminKey, 'POST',
        { email, password, email_confirm: true, app_metadata: { synthetic_audit: runId } });
      phase = 'fixture_auth_password_login';
      const session = await accepted('/auth/v1/token?grant_type=password', anonKey, 'POST', { email, password });
      users.push({ id: created.id, email, password, ...session });
      phase = 'fixture_auth_create';
    }
    phase = 'fixture_organizations';
    for (let index = 0; index < 2; index++) {
      const created = await accepted('/rest/v1/organizations', adminKey, 'POST', { nome: `synthetic-${runId}-${index}` });
      orgs.push(created[0].id);
    }
    phase = 'fixture_profiles_and_memberships';
    for (let index = 0; index < users.length; index++) {
      await accepted('/rest/v1/profiles?on_conflict=id', adminKey, 'POST',
        { id: users[index].id, nome: `Synthetic ${index}`, email: users[index].email, ativo: true },
        { Prefer: 'resolution=merge-duplicates,return=representation' });
      await accepted('/rest/v1/organization_users', adminKey, 'POST',
        { organization_id: orgs[index < 2 ? 0 : 1], user_id: users[index].id, role: 'gestor', ativo: true });
    }
    phase = 'fixture_programmer_and_patients';
    const a = users[0], a2 = users[1], b = users[2], programmer = users[3];
    await accepted('/rest/v1/app_programmers', adminKey, 'POST', { user_id: programmer.id });
    const patient = (await accepted('/rest/v1/patients', a.access_token, 'POST',
      { organization_id: orgs[0], nome: 'Synthetic Patient', legacy_id: `audit-${runId}` }))[0];
    const betaPatient = (await accepted('/rest/v1/patients', b.access_token, 'POST',
      { organization_id: orgs[1], nome: 'Synthetic Beta Patient', legacy_id: `audit-beta-${runId}` }))[0];

    await test('auth_four_distinct_real_sessions', async () => {
      expect(new Set(users.map(user => user.id)).size === 4);
      for (const user of users) expect((await accepted('/auth/v1/user', user.access_token)).id === user.id);
    });
    await test('anonymous_clinical_read_denied', async () => {
      const result = await call('/rest/v1/patients?select=id', anonKey);
      expect(!result.ok || result.data.length === 0);
    });
    await test('cross_org_read_denied', async () => {
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 0);
    });
    await test('cross_org_create_denied', async () => {
      const result = await call('/rest/v1/patients', b.access_token, 'POST',
        { organization_id: orgs[0], nome: 'Synthetic Forbidden' });
      expect(result.status === 403);
    });
    await test('cross_org_update_denied', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Forbidden' });
      expect(!result.ok || result.data.length === 0);
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=nome`, a.access_token))[0].nome === 'Synthetic Patient');
    });
    await test('cross_org_delete_denied', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'DELETE');
      expect(!result.ok || result.data.length === 0);
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, a.access_token)).length === 1);
    });
    await test('organization_scope_immutable', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, a.access_token, 'PATCH', { organization_id: orgs[1] });
      expect(!result.ok);
    });
    await test('atomic_compare_and_swap_two_real_sessions', async () => {
      const endpoint = `/rest/v1/patients?id=eq.${patient.id}&organization_id=eq.${orgs[0]}&version=eq.${patient.version}`;
      const results = await Promise.all([a, a2].map((user, index) => call(endpoint, user.access_token, 'PATCH',
        { nome: `Synthetic Winner ${index}`, last_operation_id: crypto.randomUUID(), last_operation_checksum: 'a'.repeat(64) })));
      expect(results.every(result => result.ok));
      expect(results.filter(result => result.data.length === 1).length === 1);
      expect(results.filter(result => result.data.length === 0).length === 1);
      const final = (await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=version,last_operation_id,last_operation_checksum`, a.access_token))[0];
      expect(final.version === patient.version + 1 && final.last_operation_id && final.last_operation_checksum === 'a'.repeat(64));
    });
    // Uma tabela ausente ou payload inválido não prova uma autorização negada.
    const legacyPreflight = await call('/rest/v1/documentos?select=user_id,modulo,doc_id,dados&limit=0', adminKey);
    if (legacyPreflight.status === 404) {
      checks.push({ name: 'personal_legacy_channel_write_denied', passed: null,
        diagnostic: 'legacy_table_absent_in_empty_staging' });
    } else {
      await test('personal_legacy_channel_write_denied', async () => {
        expect(legacyPreflight.ok);
        const result = await call('/rest/v1/documentos', a.access_token, 'POST',
          { user_id: a.id, modulo: 'pre', doc_id: runId, dados: {} });
        expect(result.status === 403);
      });
    }
    await test('ordinary_user_cannot_authorize_share', async () => {
      const result = await call('/rest/v1/rpc/prog_authorize_org_share', a.access_token, 'POST',
        { p_org_origem: orgs[0], p_org_destino: orgs[1], p_modulos: ['pacientes'],
          p_motivo: 'Synthetic isolation audit', p_expira_em: new Date(Date.now() + 3600000).toISOString() });
      expect(!result.ok);
    });
    let shareId: string | null = null;
    await test('programmer_share_explicit_read_only_scope', async () => {
      shareId = await accepted('/rest/v1/rpc/prog_authorize_org_share', programmer.access_token, 'POST',
        { p_org_origem: orgs[0], p_org_destino: orgs[1], p_modulos: ['pacientes'],
          p_motivo: 'Synthetic isolation audit', p_expira_em: new Date(Date.now() + 3600000).toISOString() });
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 1);
      const write = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Forbidden' });
      expect(!write.ok || write.data.length === 0);
    });
    await test('revoked_share_immediately_denies_read', async () => {
      expect(shareId);
      await accepted('/rest/v1/rpc/prog_revoke_org_share', programmer.access_token, 'POST',
        { p_share_id: shareId, p_motivo: 'Synthetic isolation audit complete' });
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 0);
    });
    storagePath = `${orgs[0]}/${a.id}/anexos/${runId}_synthetic.txt`;
    await test('storage_owned_upload', async () => {
      const response = await fetch(`${url}/storage/v1/object/clinical-attachments/${storagePath}`,
        { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${a.access_token}`,
          'Content-Type': 'text/plain' }, body: 'synthetic audit fixture', signal: AbortSignal.timeout(20000) });
      expect(response.ok);
    });
    await test('storage_cross_org_read_denied', async () => {
      const response = await fetch(`${url}/storage/v1/object/authenticated/clinical-attachments/${storagePath}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${b.access_token}` }, signal: AbortSignal.timeout(20000) });
      expect(!response.ok);
    });
    await test('storage_cross_org_upload_denied', async () => {
      const response = await fetch(`${url}/storage/v1/object/clinical-attachments/${orgs[0]}/${b.id}/anexos/${runId}_denied.txt`,
        { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${b.access_token}`,
          'Content-Type': 'text/plain' }, body: 'synthetic forbidden', signal: AbortSignal.timeout(20000) });
      expect(!response.ok);
    });
    const events: any[] = [];
    const joined = new Set<string>();
    let socket: WebSocket | null = null;
    await test('realtime_authenticated_two_topics', async () => {
      socket = new WebSocket(`wss://${TARGET}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`);
      sockets.push(socket);
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.event === 'phx_reply' && message.payload.status === 'ok') joined.add(message.topic);
        if (message.event === 'postgres_changes') events.push(message);
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket_timeout')), 15000);
        socket!.onopen = () => { clearTimeout(timer); resolve(); };
        socket!.onerror = () => { clearTimeout(timer); reject(new Error('websocket_error')); };
      });
      for (const [index, table] of ['patients', 'encounters'].entries()) {
        socket.send(JSON.stringify({ topic: `realtime:audit-${runId}-${table}`, event: 'phx_join', ref: String(index + 1),
          payload: { access_token: a.access_token, config: { broadcast: { self: false }, presence: { enabled: false },
            postgres_changes: [{ event: '*', schema: 'public', table, filter: `organization_id=eq.${orgs[0]}` }] } } }));
      }
      for (let step = 0; step < 60 && joined.size < 2; step++) await sleep(100);
      expect(joined.size === 2);
    });
    await test('realtime_own_update_and_cross_org_filter', async () => {
      expect(socket && joined.size === 2);
      await accepted(`/rest/v1/patients?id=eq.${betaPatient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Beta Update' });
      await accepted(`/rest/v1/patients?id=eq.${patient.id}`, a2.access_token, 'PATCH', { nome: 'Synthetic Realtime Update' });
      for (let step = 0; step < 70 && !events.some(e => e.payload?.data?.record?.id === patient.id); step++) await sleep(100);
      expect(events.some(e => e.payload?.data?.record?.id === patient.id));
      expect(!events.some(e => e.payload?.data?.record?.organization_id === orgs[1]));
    });
    await test('realtime_refresh_every_joined_topic', async () => {
      expect(socket && joined.size === 2);
      const renewed = await accepted('/auth/v1/token?grant_type=refresh_token', anonKey, 'POST', { refresh_token: a.refresh_token });
      for (const topic of joined) socket!.send(JSON.stringify({ topic, event: 'access_token', payload: { access_token: renewed.access_token }, ref: crypto.randomUUID() }));
      events.length = 0;
      await sleep(300);
      await accepted(`/rest/v1/patients?id=eq.${patient.id}`, a2.access_token, 'PATCH', { nome: 'Synthetic Realtime Renewed' });
      for (let step = 0; step < 70 && events.length === 0; step++) await sleep(100);
      expect(events.some(e => e.payload?.data?.record?.id === patient.id));
    });
  } catch (error) {
    checks.push({ name: phase, passed: false, diagnostic: diagnostic(error) });
  } finally {
    for (const socket of sockets) try { socket.close(); } catch { /* no token logs */ }
    if (storagePath) await test('storage_fixture_cleanup', async () => {
      await accepted('/storage/v1/object/clinical-attachments', adminKey, 'DELETE', { prefixes: [storagePath] });
    });
    // Exclusão limitada a UUIDs gerados nesta execução; nunca lista usuários reais.
    for (const org of orgs) await test('synthetic_org_cleanup', async () => {
      await accepted(`/rest/v1/organizations?id=eq.${org}`, adminKey, 'DELETE');
    });
    for (const user of users) await test('synthetic_auth_cleanup', async () => {
      await accepted(`/auth/v1/admin/users/${user.id}`, adminKey, 'DELETE');
    });
  }
  const result = { target: TARGET, runId, checks, passed: checks.filter(c => c.passed === true).length,
    failed: checks.filter(c => c.passed === false).length, pending: checks.filter(c => c.passed === null).length,
    limitations: ['JWT lifetime expiry not accelerated', 'browser two tabs/crash belongs to browser integration suite'] };
  return Response.json(result);
});
