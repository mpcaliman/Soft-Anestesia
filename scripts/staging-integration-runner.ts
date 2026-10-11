// Executar somente como Edge Function efêmera de homologação. Não é asset público.
// Antes do deploy, substituir os marcadores pela capacidade SHA-256, UUID da
// execução e janela UTC de no máximo 15 minutos. A capacidade aleatória fica
// fora do Git; apenas seu hash é publicado. A gateway JWT permanece habilitada.
const TARGET = 'yqqrfgbvoexricjdxpis';
const CAPABILITY_HASH = '__RUN_CAPABILITY_SHA256__';
const DEPLOYMENT_RUN_ID = '__RUN_UUID__';
const RUN_ISSUED_AT = '__RUN_ISSUED_AT__';
const RUN_EXPIRES_AT = '__RUN_EXPIRES_AT__';
const MAX_RUN_WINDOW_MS = 15 * 60 * 1000;
// Evidência sintética é permanente: não apagar organizações, Auth, prontuários
// ou auditoria. Ao encerrar, revogar sessões e desativar todo acesso da fixture.
const RETENTION_POLICY = 'retain-blocked-synthetic-evidence';
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
  const issuedAt = Date.parse(RUN_ISSUED_AT), expiresAt = Date.parse(RUN_EXPIRES_AT);
  if (!/^[a-f0-9]{64}$/.test(CAPABILITY_HASH)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(DEPLOYMENT_RUN_ID)
      || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_RUN_WINDOW_MS
      || Date.now() < issuedAt || Date.now() >= expiresAt)
    return new Response('audit_run_window_denied', { status: 403 });
  let body: any;
  try {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
      return new Response('audit_run_binding_denied', { status: 400 });
    const raw = await request.text();
    if (raw.length > 128) return new Response('audit_run_binding_denied', { status: 400 });
    body = JSON.parse(raw);
  } catch { return new Response('audit_run_binding_denied', { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || body.runId !== DEPLOYMENT_RUN_ID)
    return new Response('audit_run_binding_denied', { status: 400 });
  consumed = true;
  const runId = DEPLOYMENT_RUN_ID;
  const checks: { name: string; passed: boolean | null; diagnostic?: string }[] = [];
  const users: { id: string; email: string; password: string; access_token: string; refresh_token: string }[] = [];
  const orgs: string[] = [];
  const memberships: { organization_id: string; user_id: string; role: string }[] = [];
  const retainedRecords: { table: string; id: string }[] = [];
  const capturedAuditIds = new Set<string>();
  let clinicalEvidenceRetained: boolean | null = null;
  let auditEvidenceRetained: boolean | null = null;
  let authEvidenceRetained: boolean | null = null;
  const sockets: WebSocket[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const storagePaths = new Set<string>();
  let storagePath: string | null = null;
  let programmerId: string | null = null;
  let shareId: string | null = null;
  let shareActive = false;
  let phase = 'durable_invocation_claim';
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
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(20000)
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
  const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const denied = (result: Awaited<ReturnType<typeof call>>) =>
    ((result.status === 401 || result.status === 403) && result.data?.code === '42501')
      || (result.ok && Array.isArray(result.data) && result.data.length === 0);
  const authDenied = (result: Awaited<ReturnType<typeof call>>, allowed: string[]) =>
    [400, 401, 403, 422].includes(result.status) && allowed.includes(result.data?.error_code || result.data?.code);
  const storageDenied = async (response: Response, provedExisting = false) => {
    let body: any; try { body = await response.json(); } catch { return false; }
    const code = String(body.code || body.error || '').toLowerCase();
    const effectiveStatus = Number(body.statusCode || body.httpStatusCode || response.status);
    if (response.status >= 500 || response.status === 429) return false;
    return ([400, 403].includes(response.status) && effectiveStatus === 403
      && ['accessdenied','unauthorized','42501'].includes(code))
      || (provedExisting && [400, 404].includes(response.status) && effectiveStatus === 404 && ['nosuchkey','not_found'].includes(code));
  };
  const remember = (table: string, row: any) => { expect(row && typeof row.id === 'string'); retainedRecords.push({ table, id: row.id }); return row; };
  try {
    // O PK no banco protege contra outro isolate ou outro deploy com a mesma
    // capacidade. Esta tabela é infraestrutura exclusiva de homologação;
    // não existe policy nem privilégio para anon/authenticated. Uma resposta
    // perdida nunca autoriza retry: o claim e o UUID conhecido permitem
    // reconciliar esta execução sem criar um segundo conjunto de fixtures.
    const claim = await call('/rest/v1/staging_audit_run_claims', adminKey, 'POST', {
      capability_sha256: CAPABILITY_HASH, run_id: runId,
      issued_at: RUN_ISSUED_AT, expires_at: RUN_EXPIRES_AT
    });
    if (claim.status === 409 && claim.data?.code === '23505')
      return new Response('audit_invocation_already_claimed', { status: 409 });
    if (!claim.ok) throw new Error(`http_${claim.status}`);
    expect(Array.isArray(claim.data) && claim.data.length === 1
      && claim.data[0].capability_sha256 === CAPABILITY_HASH && claim.data[0].run_id === runId
      && Date.parse(claim.data[0].issued_at) === issuedAt && Date.parse(claim.data[0].expires_at) === expiresAt
      && Date.parse(claim.data[0].claimed_at) >= issuedAt && Date.parse(claim.data[0].claimed_at) < expiresAt);
    checks.push({ name: 'durable_invocation_claim', passed: true });
    // Não criar contas numa homologação parcialmente migrada. Coluna ausente,
    // erro de schema ou payload errado devem ser falhas, nunca prova de RLS.
    phase = 'required_retification_schema';
    await accepted('/rest/v1/addenda?select=id,retification_revision,parent_legacy_id,reason,author_id&limit=0', adminKey);
    checks.push({ name: 'required_retification_schema', passed: true });
    phase = 'fixture_auth_create';
    for (let index = 0; index < 4; index++) {
      const email = `audit-${runId}-${index}@example.invalid`;
      const password = 'Aa1!' + crypto.randomUUID() + crypto.randomUUID();
      const created = await accepted('/auth/v1/admin/users', adminKey, 'POST',
        { email, password, email_confirm: true, app_metadata: { synthetic_audit: runId } });
      // Registrar a identidade imediatamente: um login falho também precisa
      // ter a conta bloqueada, sem deixar privilégio ou senha reutilizável.
      const user = { id: created.id, email, password, access_token: '', refresh_token: '' };
      users.push(user);
      phase = 'fixture_auth_password_login';
      const session = await accepted('/auth/v1/token?grant_type=password', anonKey, 'POST', { email, password });
      Object.assign(user, session);
      phase = 'fixture_auth_create';
    }
    phase = 'fixture_organizations';
    for (let index = 0; index < 2; index++) {
      const org = crypto.randomUUID();
      orgs.push(org);
      const created = await accepted('/rest/v1/organizations', adminKey, 'POST', { id: org, nome: `synthetic-${runId}-${index}` });
      expect(created[0].id === org);
    }
    phase = 'fixture_profiles_and_memberships';
    for (let index = 0; index < users.length; index++) {
      await accepted('/rest/v1/profiles?on_conflict=id', adminKey, 'POST',
        { id: users[index].id, nome: `Synthetic ${index}`, email: users[index].email, ativo: true },
        { Prefer: 'resolution=merge-duplicates,return=representation' });
      const membership = { organization_id: orgs[index < 2 ? 0 : 1], user_id: users[index].id, role: 'gestor' };
      memberships.push(membership);
      await accepted('/rest/v1/organization_users', adminKey, 'POST', { ...membership, ativo: true });
    }
    phase = 'fixture_programmer_and_patients';
    const a = users[0], a2 = users[1], b = users[2], programmer = users[3];
    programmerId = programmer.id;
    await accepted('/rest/v1/app_programmers', adminKey, 'POST', { user_id: programmer.id });
    const patient = remember('patients', (await accepted('/rest/v1/patients', a.access_token, 'POST',
      { organization_id: orgs[0], nome: 'Synthetic Patient', legacy_id: `audit-${runId}` }))[0]);
    const betaPatient = remember('patients', (await accepted('/rest/v1/patients', b.access_token, 'POST',
      { organization_id: orgs[1], nome: 'Synthetic Beta Patient', legacy_id: `audit-beta-${runId}` }))[0]);
    const encounter = remember('encounters', (await accepted('/rest/v1/encounters', a.access_token, 'POST',
      { organization_id: orgs[0], patient_id: patient.id, procedimento: 'Synthetic procedure', legacy_id: `audit-case-${runId}` }))[0]);
    const started = Date.now();
    const parent = remember('preanesthetic_assessments', (await accepted('/rest/v1/preanesthetic_assessments', a.access_token, 'POST',
      { organization_id: orgs[0], patient_id: patient.id, encounter_id: encounter.id,
        legacy_id: `audit-finalized-${runId}`, status: 'finalized', finalized_at: '1900-01-01',
        finalized_by: b.id, data: { nome: 'Synthetic Patient', alergias: 'Synthetic original', _finalizado: true,
          _caseId: encounter.id, assinatura: 'synthetic-signature-evidence' } }))[0]);
    const originalParent = canonical(parent);
    await test('finalization_server_author_time_and_original_snapshot', async () => {
      expect(parent.finalized_by === a.id && Date.parse(parent.finalized_at) >= started - 2000);
      expect(parent.patient_id === patient.id && parent.encounter_id === encounter.id);
    });

    await test('auth_four_distinct_real_sessions', async () => {
      expect(new Set(users.map(user => user.id)).size === 4);
      for (const user of users) expect((await accepted('/auth/v1/user', user.access_token)).id === user.id);
    });
    await test('anonymous_clinical_read_denied', async () => {
      const result = await call('/rest/v1/patients?select=id', anonKey);
      expect(denied(result));
    });
    await test('cross_org_read_denied', async () => {
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 0);
    });
    await test('cross_org_create_denied', async () => {
      const result = await call('/rest/v1/patients', b.access_token, 'POST',
        { organization_id: orgs[0], nome: 'Synthetic Forbidden' });
      expect(denied(result));
    });
    await test('cross_org_update_denied', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Forbidden' });
      expect(denied(result));
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=nome`, a.access_token))[0].nome === 'Synthetic Patient');
    });
    await test('cross_org_delete_denied', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'DELETE');
      expect(denied(result));
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, a.access_token)).length === 1);
    });
    await test('organization_scope_immutable', async () => {
      const result = await call(`/rest/v1/patients?id=eq.${patient.id}`, a.access_token, 'PATCH', { organization_id: orgs[1] });
      expect(result.status === 400 && result.data?.code === '23514');
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
        expect(denied(result));
      });
    }
    await test('ordinary_user_cannot_authorize_share', async () => {
      const result = await call('/rest/v1/rpc/prog_authorize_org_share', a.access_token, 'POST',
        { p_org_origem: orgs[0], p_org_destino: orgs[1], p_modulos: ['pacientes'],
          p_motivo: 'Synthetic isolation audit', p_expira_em: new Date(Date.now() + 3600000).toISOString() });
      expect(denied(result));
    });
    await test('programmer_share_explicit_read_only_scope', async () => {
      shareId = await accepted('/rest/v1/rpc/prog_authorize_org_share', programmer.access_token, 'POST',
        { p_org_origem: orgs[0], p_org_destino: orgs[1], p_modulos: ['pacientes'],
          p_motivo: 'Synthetic isolation audit', p_expira_em: new Date(Date.now() + 3600000).toISOString() });
      shareActive = true;
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 1);
      const write = await call(`/rest/v1/patients?id=eq.${patient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Forbidden' });
      expect(denied(write));
    });
    await test('revoked_share_immediately_denies_read', async () => {
      expect(shareId);
      await accepted('/rest/v1/rpc/prog_revoke_org_share', programmer.access_token, 'POST',
        { p_share_id: shareId, p_motivo: 'Synthetic isolation audit complete' });
      shareActive = false;
      expect((await accepted(`/rest/v1/patients?id=eq.${patient.id}&select=id`, b.access_token)).length === 0);
    });
    storagePath = `${orgs[0]}/${a.id}/anexos/${runId}_synthetic.txt`;
    storagePaths.add(storagePath);
    await test('storage_owned_upload', async () => {
      const response = await fetch(`${url}/storage/v1/object/clinical-attachments/${storagePath}`,
        { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${a.access_token}`,
          'Content-Type': 'text/plain' }, body: 'synthetic audit fixture', signal: AbortSignal.timeout(20000) });
      expect(response.ok);
      const own = await fetch(`${url}/storage/v1/object/authenticated/clinical-attachments/${storagePath}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${a.access_token}` }, signal: AbortSignal.timeout(20000) });
      expect(own.ok && await own.text() === 'synthetic audit fixture');
    });
    await test('storage_cross_org_read_denied', async () => {
      const response = await fetch(`${url}/storage/v1/object/authenticated/clinical-attachments/${storagePath}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${b.access_token}` }, signal: AbortSignal.timeout(20000) });
      expect(await storageDenied(response, true));
    });
    await test('storage_cross_org_upload_denied', async () => {
      const forbiddenPath = `${orgs[0]}/${b.id}/anexos/${runId}_denied.txt`;
      storagePaths.add(forbiddenPath);
      const response = await fetch(`${url}/storage/v1/object/clinical-attachments/${forbiddenPath}`,
        { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${b.access_token}`,
          'Content-Type': 'text/plain' }, body: 'synthetic forbidden', signal: AbortSignal.timeout(20000) });
      expect(await storageDenied(response));
    });
    await test('storage_cross_org_update_denied', async () => {
      const response = await fetch(`${url}/storage/v1/object/clinical-attachments/${storagePath}`,
        { method: 'PUT', headers: { apikey: anonKey, Authorization: `Bearer ${b.access_token}`,
          'Content-Type': 'text/plain' }, body: 'synthetic forbidden update', signal: AbortSignal.timeout(20000) });
      expect(await storageDenied(response, true));
      const own = await fetch(`${url}/storage/v1/object/authenticated/clinical-attachments/${storagePath}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${a.access_token}` }, signal: AbortSignal.timeout(20000) });
      expect(own.ok && await own.text() === 'synthetic audit fixture');
    });
    await test('storage_cross_org_delete_denied', async () => {
      // Storage pode devolver 200 [] para objetos invisíveis ao usuário.
      await call('/storage/v1/object/clinical-attachments', b.access_token, 'DELETE', { prefixes: [storagePath] });
      const own = await fetch(`${url}/storage/v1/object/authenticated/clinical-attachments/${storagePath}`,
        { headers: { apikey: anonKey, Authorization: `Bearer ${a.access_token}` }, signal: AbortSignal.timeout(20000) });
      expect(own.ok && await own.text() === 'synthetic audit fixture');
    });
    const events: any[] = [];
    const joined = new Set<string>();
    const joinRefs = new Map<string, string>();
    const ownTables = ['patients', 'encounters', 'addenda'];
    const topics = [...ownTables.map(table => ({ table, org: orgs[0], suffix: table })),
      { table: 'patients', org: orgs[1], suffix: 'forbidden-patients' }];
    const eventRecord = (event: any) => event.payload?.data?.record;
    const waitFor = async (predicate: () => boolean) => {
      for (let step = 0; step < 100 && !predicate(); step++) await sleep(100);
      expect(predicate());
    };
    let socket: WebSocket | null = null;
    await test('realtime_authenticated_operational_and_addenda_topics', async () => {
      socket = new WebSocket(`wss://${TARGET}.supabase.co/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`);
      sockets.push(socket);
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.event === 'phx_reply' && message.payload.status === 'ok'
            && topics.some(topic => message.topic === `realtime:audit-${runId}-${topic.suffix}`)) joined.add(message.topic);
        if (message.event === 'postgres_changes') events.push(message);
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket_timeout')), 15000);
        socket!.onopen = () => { clearTimeout(timer); resolve(); };
        socket!.onerror = () => { clearTimeout(timer); reject(new Error('websocket_error')); };
      });
      heartbeat = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat',
          payload: {}, ref: crypto.randomUUID(), join_ref: null }));
      }, 20000);
      for (const [index, topic] of topics.entries()) {
        const channel = `realtime:audit-${runId}-${topic.suffix}`;
        const ref = String(index + 1);
        joinRefs.set(channel, ref);
        socket.send(JSON.stringify({ topic: channel, event: 'phx_join', ref, join_ref: ref,
          payload: { access_token: a.access_token, config: { broadcast: { self: false }, presence: { enabled: false },
            postgres_changes: [{ event: '*', schema: 'public', table: topic.table, filter: `organization_id=eq.${topic.org}` }] } } }));
      }
      await waitFor(() => joined.size === topics.length);
    });
    await test('realtime_own_update_and_cross_org_filter', async () => {
      expect(socket && joined.size === topics.length);
      await accepted(`/rest/v1/patients?id=eq.${betaPatient.id}`, b.access_token, 'PATCH', { nome: 'Synthetic Beta Update' });
      await accepted(`/rest/v1/patients?id=eq.${patient.id}`, a2.access_token, 'PATCH', { nome: 'Synthetic Realtime Update' });
      await accepted(`/rest/v1/encounters?id=eq.${encounter.id}`, a2.access_token, 'PATCH', { procedimento: 'Synthetic Realtime Case Update' });
      await waitFor(() => [patient.id, encounter.id].every(id => events.some(event => eventRecord(event)?.id === id)));
      await sleep(500);
      // Inclui inscrição deliberada na clínica estrangeira: RLS deve negar
      // mesmo quando o cliente pede esse organization_id explicitamente.
      expect(!events.some(event => eventRecord(event)?.organization_id === orgs[1]));
    });
    const proposals = [a, a2].map((user, index) => ({ user, body: {
      organization_id: orgs[0], parent_table: 'preanesthetic_assessments', parent_id: parent.id,
      legacy_id: `audit-retification-${runId}-${index}`, texto: `Synthetic clinical correction ${index}`, reason: 'correcao',
      author_id: b.id, created_at: '1900-01-01',
      data: { autor_exibicao: 'Forged synthetic author', retificacao: { schema: 1, baseAdendoId: '',
        campos: { alergias: `Synthetic concurrent proposal ${index}` } } }
    } }));
    let acceptedCorrection: any = null;
    let conflictCorrection: any = null;
    await test('retification_atomic_race_two_real_sessions_preserves_both_proposals', async () => {
      const results = await Promise.all(proposals.map(proposal => call('/rest/v1/addenda', proposal.user.access_token, 'POST', proposal.body)));
      // Rastrear também a proposta confirmada quando a outra chamada falha.
      const rows = results.filter(result => result.ok && Array.isArray(result.data) && result.data.length === 1)
        .map(result => remember('addenda', result.data[0]));
      expect(results.every(result => result.ok && Array.isArray(result.data) && result.data.length === 1));
      expect(rows.filter(row => row.data.retificacao.status === 'accepted').length === 1);
      expect(rows.filter(row => row.data.retificacao.status === 'conflict').length === 1);
      acceptedCorrection = rows.find(row => row.data.retificacao.status === 'accepted');
      conflictCorrection = rows.find(row => row.data.retificacao.status === 'conflict');
      expect(acceptedCorrection.retification_revision === 1 && acceptedCorrection.data.retificacao.baseAtualId === '');
      expect(conflictCorrection.retification_revision === null && conflictCorrection.data.retificacao.baseAtualId === acceptedCorrection.legacy_id);
      for (const [index, row] of rows.entries()) {
        expect(row.author_id === proposals[index].user.id && row.created_by === proposals[index].user.id);
        expect(Date.parse(row.created_at) >= started - 2000 && row.parent_legacy_id === parent.legacy_id);
        expect(row.patient_id === patient.id && row.encounter_id === encounter.id);
        expect(row.data.autor_exibicao !== 'Forged synthetic author');
        expect(canonical(row.data.retificacao.campos) === canonical(proposals[index].body.data.retificacao.campos));
      }
      const persisted = await accepted(`/rest/v1/addenda?parent_id=eq.${parent.id}&order=created_at.asc`, a.access_token);
      expect(persisted.length === 2 && rows.every(row => persisted.some((item: any) => canonical(item) === canonical(row))));
      expect(canonical((await accepted(`/rest/v1/preanesthetic_assessments?id=eq.${parent.id}`, a.access_token))[0]) === originalParent);
    });
    await test('retification_realtime_preserves_accepted_and_conflict', async () => {
      expect(acceptedCorrection && conflictCorrection);
      await waitFor(() => [acceptedCorrection.id, conflictCorrection.id].every(id => events.some(event => eventRecord(event)?.id === id)));
    });
    await test('retification_exact_replay_idempotent_and_other_proposal_denied', async () => {
      expect(acceptedCorrection);
      const proposal = proposals.find(item => item.body.legacy_id === acceptedCorrection.legacy_id)!;
      await accepted('/rest/v1/addenda?on_conflict=organization_id,legacy_id', proposal.user.access_token, 'POST', proposal.body,
        { Prefer: 'resolution=ignore-duplicates,return=representation' });
      const forged = await call('/rest/v1/addenda?on_conflict=organization_id,legacy_id', proposal.user.access_token, 'POST',
        { ...proposal.body, data: { retificacao: { schema: 1, baseAdendoId: '', campos: { alergias: 'Synthetic substituted proposal' } } } },
        { Prefer: 'resolution=ignore-duplicates,return=representation' });
      expect(forged.status === 400 && forged.data?.code === '23514');
      const otherAuthor = proposal.user.id === a.id ? a2 : a;
      const impersonation = await call('/rest/v1/addenda?on_conflict=organization_id,legacy_id', otherAuthor.access_token, 'POST', proposal.body,
        { Prefer: 'resolution=ignore-duplicates,return=representation' });
      expect(impersonation.status === 400 && impersonation.data?.code === '23514');
      const persisted = await accepted(`/rest/v1/addenda?parent_id=eq.${parent.id}`, a.access_token);
      expect(persisted.length === 2 && canonical(persisted.find((row: any) => row.id === acceptedCorrection.id)) === canonical(acceptedCorrection));
    });
    await test('retification_foreign_org_cannot_read_or_create', async () => {
      expect((await accepted(`/rest/v1/addenda?parent_id=eq.${parent.id}&select=id`, b.access_token)).length === 0);
      const result = await call('/rest/v1/addenda', b.access_token, 'POST', { ...proposals[0].body, legacy_id: `audit-forbidden-${runId}` });
      // O trigger de pai usa o SELECT com RLS: pai invisível pode retornar FK
      // 23503. Ausência da tabela/coluna ou schema inválido nunca conta.
      expect(denied(result) || (result.status === 409 && result.data?.code === '23503'));
      expect((await accepted(`/rest/v1/addenda?parent_id=eq.${parent.id}&select=id`, a.access_token)).length === 2);
    });
    await test('retification_each_proposal_has_server_audit', async () => {
      expect(acceptedCorrection && conflictCorrection);
      const audit = await accepted(`/rest/v1/audit_logs?organization_id=eq.${orgs[0]}&select=id,record_id,action,user_id`, adminKey);
      for (const row of audit) capturedAuditIds.add(row.id);
      expect([acceptedCorrection, conflictCorrection].every(row => audit.some((event: any) =>
        event.record_id === row.id && event.action === 'insert' && event.user_id === row.author_id)));
    });
    await test('retification_parent_update_delete_and_org_cascade_denied', async () => {
      const update = await call(`/rest/v1/preanesthetic_assessments?id=eq.${parent.id}`, a.access_token, 'PATCH', { data: { nome: 'Synthetic forbidden original update' } });
      expect(update.status === 400 && update.data?.code === '23514');
      const remove = await call(`/rest/v1/preanesthetic_assessments?id=eq.${parent.id}`, a.access_token, 'DELETE');
      expect(remove.status === 400 && remove.data?.code === '23514');
      const cascade = await call(`/rest/v1/organizations?id=eq.${orgs[0]}`, adminKey, 'DELETE');
      expect(cascade.status === 400 && cascade.data?.code === '23514');
      expect(canonical((await accepted(`/rest/v1/preanesthetic_assessments?id=eq.${parent.id}`, a.access_token))[0]) === originalParent);
      expect((await accepted(`/rest/v1/addenda?parent_id=eq.${parent.id}&select=id`, a.access_token)).length === 2);
    });
    await test('retification_accepted_and_conflict_append_only', async () => {
      expect(acceptedCorrection && conflictCorrection);
      for (const row of [acceptedCorrection, conflictCorrection]) {
        const update = await call(`/rest/v1/addenda?id=eq.${row.id}`, a.access_token, 'PATCH', { texto: 'Synthetic forbidden evidence update' });
        const remove = await call(`/rest/v1/addenda?id=eq.${row.id}`, a.access_token, 'DELETE');
        expect(denied(update) && denied(remove));
        expect(canonical((await accepted(`/rest/v1/addenda?id=eq.${row.id}`, a.access_token))[0]) === canonical(row));
      }
    });
    await test('realtime_refresh_every_joined_topic', async () => {
      expect(socket && joined.size === topics.length && acceptedCorrection);
      const renewed = await accepted('/auth/v1/token?grant_type=refresh_token', anonKey, 'POST', { refresh_token: a.refresh_token });
      a.access_token = renewed.access_token;
      a.refresh_token = renewed.refresh_token;
      for (const topic of joined) socket!.send(JSON.stringify({ topic, event: 'access_token', payload: { access_token: renewed.access_token },
        ref: crypto.randomUUID(), join_ref: joinRefs.get(topic) }));
      events.length = 0;
      await sleep(300);
      await accepted(`/rest/v1/patients?id=eq.${patient.id}`, a2.access_token, 'PATCH', { nome: 'Synthetic Realtime Renewed' });
      await accepted(`/rest/v1/encounters?id=eq.${encounter.id}`, a2.access_token, 'PATCH', { procedimento: 'Synthetic Realtime Case Renewed' });
      const next = remember('addenda', (await accepted('/rest/v1/addenda', a2.access_token, 'POST', {
        ...proposals[1].body, legacy_id: `audit-rebased-${runId}`, texto: 'Synthetic reviewed rebased correction',
        data: { retificacao: { schema: 1, baseAdendoId: acceptedCorrection.legacy_id, campos: { alergias: 'Synthetic reviewed current value' } } }
      }))[0]);
      expect(next.data.retificacao.status === 'accepted' && next.retification_revision === 2);
      await waitFor(() => [patient.id, encounter.id, next.id].every(id => events.some(event => eventRecord(event)?.id === id)));
      expect(!events.some(event => eventRecord(event)?.organization_id === orgs[1]));
      expect(canonical((await accepted(`/rest/v1/preanesthetic_assessments?id=eq.${parent.id}`, a.access_token))[0]) === originalParent);
    });
  } catch (error) {
    checks.push({ name: phase, passed: false, diagnostic: diagnostic(error) });
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    for (const socket of sockets) try { socket.close(); } catch { /* no token logs */ }
    if (storagePaths.size) await test('storage_fixture_cleanup', async () => {
      await accepted('/storage/v1/object/clinical-attachments', adminKey, 'DELETE', { prefixes: [...storagePaths] });
    });
    if (orgs.length === 2 && programmerId) await test('synthetic_share_revocation', async () => {
      const programmer = users.find(user => user.id === programmerId)!;
      const selector = `org_origem=eq.${orgs[0]}&org_destino=eq.${orgs[1]}`;
      // O RPC pode confirmar antes de perder sua resposta. Procurar só este
      // par sintético recupera o ID sem listar exceções de organizações reais.
      for (const share of await accepted(`/rest/v1/org_shares?${selector}&select=id,ativo`, adminKey)) if (share.ativo)
        await accepted('/rest/v1/rpc/prog_revoke_org_share', programmer.access_token, 'POST',
          { p_share_id: share.id, p_motivo: 'Synthetic fixture access shutdown' });
      shareActive = false;
      expect((await accepted(`/rest/v1/org_shares?${selector}&select=id,ativo`, adminKey)).every((share: any) => !share.ativo));
    });
    // Somente UUIDs criados nesta execução; não listar usuários ou registros.
    // Retenção da evidência é compatível com autoria/FKs e guards append-only.
    if (programmerId) await test('synthetic_programmer_privilege_removed', async () => {
      await accepted(`/rest/v1/app_programmers?user_id=eq.${programmerId}`, adminKey, 'DELETE');
      expect((await accepted(`/rest/v1/app_programmers?user_id=eq.${programmerId}&select=user_id`, adminKey)).length === 0);
    });
    for (const membership of memberships) await test('synthetic_membership_disabled', async () => {
      const selector = `organization_id=eq.${membership.organization_id}&user_id=eq.${membership.user_id}&role=eq.${membership.role}`;
      const disabled = await accepted(`/rest/v1/organization_users?${selector}`, adminKey, 'PATCH', { ativo: false });
      expect(disabled.every((row: any) => row.ativo === false));
      expect((await accepted(`/rest/v1/organization_users?${selector}`, adminKey)).every((row: any) => row.ativo === false));
    });
    for (const user of users) {
      if (user.access_token) await test('synthetic_all_sessions_revoked', async () => {
        await accepted('/auth/v1/logout?scope=global', user.access_token, 'POST');
      });
      await test('synthetic_auth_banned_password_rotated', async () => {
        const blocked = await accepted(`/auth/v1/admin/users/${user.id}`, adminKey, 'PUT',
          { password: 'Aa1!' + crypto.randomUUID() + crypto.randomUUID(), ban_duration: '876000h' });
        expect(blocked.id === user.id && Date.parse(blocked.banned_until) > Date.now());
        const oldLogin = await call('/auth/v1/token?grant_type=password', anonKey, 'POST', { email: user.email, password: user.password });
        expect(authDenied(oldLogin, ['user_banned','invalid_credentials']));
        if (user.refresh_token) expect(authDenied(await call('/auth/v1/token?grant_type=refresh_token', anonKey, 'POST',
          { refresh_token: user.refresh_token }), ['user_banned','refresh_token_not_found','refresh_token_already_used','session_not_found']));
      });
      await test('synthetic_profile_disabled', async () => {
        const rows = await accepted(`/rest/v1/profiles?id=eq.${user.id}`, adminKey, 'PATCH', { ativo: false });
        expect(rows.every((row: any) => row.ativo === false));
      });
      if (user.access_token) await test('synthetic_expiring_jwt_cannot_access_retained_evidence', async () => {
        // Signout não revoga access JWT já emitido; membership desativada deve
        // negar imediatamente, sem depender de ele vencer ou de ban Auth.
        for (const org of orgs) {
          const result = await call(`/rest/v1/patients?organization_id=eq.${org}&select=id`, user.access_token);
          expect(denied(result));
        }
      });
    }
    for (const org of orgs) await test('synthetic_organization_disabled_evidence_retained', async () => {
      const rows = await accepted(`/rest/v1/organizations?id=eq.${org}`, adminKey, 'PATCH', { ativo: false });
      expect(rows.every((row: any) => row.ativo === false));
      expect((await accepted(`/rest/v1/organizations?id=eq.${org}&select=id,ativo`, adminKey)).every((row: any) => row.ativo === false));
    });
    if (retainedRecords.length) await test('synthetic_confirmed_clinical_evidence_retained', async () => {
      let retained = true;
      for (const record of retainedRecords) {
        const rows = await accepted(`/rest/v1/${record.table}?id=eq.${record.id}&select=id`, adminKey);
        if (rows.length !== 1 || rows[0].id !== record.id) { retained = false; clinicalEvidenceRetained = false; }
      }
      clinicalEvidenceRetained = retained;
      expect(clinicalEvidenceRetained);
    });
    if (capturedAuditIds.size) await test('synthetic_captured_audit_evidence_retained', async () => {
      const currentIds = new Set<string>();
      for (const org of orgs) for (const event of await accepted(`/rest/v1/audit_logs?organization_id=eq.${org}&select=id`, adminKey)) currentIds.add(event.id);
      auditEvidenceRetained = [...capturedAuditIds].every(id => currentIds.has(id));
      expect(auditEvidenceRetained);
    });
    if (users.length) await test('synthetic_auth_identity_retained_for_audit_fk', async () => {
      for (const user of users) {
        const identity = await accepted(`/auth/v1/admin/users/${user.id}`, adminKey);
        if (identity.id !== user.id) { authEvidenceRetained = false; throw new Error('assertion_failed'); }
      }
      authEvidenceRetained = true;
      expect(authEvidenceRetained);
    });
  }
  const result = { target: TARGET, runId, checks, passed: checks.filter(c => c.passed === true).length,
    failed: checks.filter(c => c.passed === false).length, pending: checks.filter(c => c.passed === null).length,
    retention: { policy: RETENTION_POLICY, organizationIds: orgs, authUserIds: users.map(user => user.id), records: retainedRecords,
      capturedAuditRows: capturedAuditIds.size, clinicalRowsDeleted: clinicalEvidenceRetained === null ? null : !clinicalEvidenceRetained,
      auditRowsDeleted: auditEvidenceRetained === null ? null : !auditEvidenceRetained,
      authUsersDeleted: authEvidenceRetained === null ? null : !authEvidenceRetained },
    limitations: ['JWT lifetime expiry not accelerated', 'browser two tabs/crash belongs to browser integration suite',
      'RLS CRUD covers patients/addenda/Storage; Realtime payloads cover patients/encounters/addenda, not every role/table',
      'Unacknowledged Auth creation must be reconciled only by exact runId app_metadata synthetic_audit'] };
  return Response.json(result);
});
