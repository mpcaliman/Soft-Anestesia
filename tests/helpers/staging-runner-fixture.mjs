// Exercita o runner com HTTP/WebSocket controlados. Não é evidência Supabase
// real: verifica que servidores incorretos fazem os checks falharem e que o
// encerramento retém a prova e bloqueia credenciais, inclusive após falhas.
import { webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

export async function exerciseRunner(source, capability, capabilityHash, defects = {}) {
  const accounts = [], memberships = [], subscriptions = [], records = new Map();
  const runId = webcrypto.randomUUID();
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let handle, auditOrClinicalDeletionCommitted = false, failedLogin = false;
  const rows = table => records.get(table) || [];
  const put = (table, row) => {
    if (!records.has(table)) records.set(table, []); records.get(table).push(row);
    if (['patients','encounters','preanesthetic_assessments','addenda'].includes(table)) {
      if (!records.has('audit_logs')) records.set('audit_logs', []);
      records.get('audit_logs').push({ id: webcrypto.randomUUID(), organization_id: row.organization_id,
        record_id: row.id, user_id: row.created_by, action: 'insert' });
    }
    return row;
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const response = (value, status = 200) => status === 204 ? new Response(null, { status }) : Response.json(value, { status });
  const error = (status, code = '42501') => response({ code, message: 'synthetic controlled server response' }, status);
  // Match the configured Auth policy at the API boundary, before any account
  // creation or password/ban mutation. Weak rotation must not partially ban.
  const validPassword = password => typeof password === 'string' && password.length >= 12
    && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password);
  const tokenUser = token => accounts.find(user => [user.token, user.previousToken].includes(token));
  const canRead = (user, org) => memberships.some(membership => membership.user_id === user?.id && membership.organization_id === org && membership.ativo);
  const emit = (table, row) => {
    for (const subscription of subscriptions) if (subscription.table === table && subscription.org === row.organization_id
        && canRead(tokenUser(subscription.token), row.organization_id)) {
      subscription.socket.onmessage?.({ data: JSON.stringify({ topic: subscription.topic, event: 'postgres_changes',
        payload: { data: { table, type: 'UPDATE', record: clone(row) } } }) });
    }
  };
  class FixtureWebSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.event === 'phx_join') {
        if (!message.join_ref || message.join_ref !== message.ref) throw new Error('invalid join reference');
        const change = message.payload.config.postgres_changes[0];
        subscriptions.push({ socket: this, topic: message.topic, table: change.table,
          org: change.filter.replace('organization_id=eq.', ''), token: message.payload.access_token, joinRef: message.join_ref });
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ topic: message.topic, event: 'phx_reply',
          payload: { status: 'ok' }, ref: message.ref }) }));
      } else if (message.event === 'access_token') {
        for (const subscription of subscriptions) if (subscription.socket === this && subscription.topic === message.topic)
          { if (message.join_ref !== subscription.joinRef) throw new Error('refresh lost join reference'); subscription.token = message.payload.access_token; }
      }
    }
    close() {}
  }
  const fetchFixture = async (target, options = {}) => {
    const url = new URL(target), path = url.pathname, method = options.method || 'GET';
    const headers = options.headers || {}, bearer = headers.Authorization?.replace('Bearer ', '');
    const admin = bearer === 'synthetic-private-admin-token';
    const user = tokenUser(bearer);
    const body = typeof options.body === 'string' && (headers['Content-Type'] || '').includes('application/json') ? JSON.parse(options.body) : options.body;
    if (path === '/rest/v1/staging_audit_run_claims' && method === 'POST') {
      if (!admin) return error(403);
      if (rows('staging_audit_run_claims').some(row => row.capability_sha256 === body.capability_sha256 || row.run_id === body.run_id))
        return error(409, '23505');
      const row = put('staging_audit_run_claims', { ...body, claimed_at: new Date().toISOString() });
      return response([clone(row)], 201);
    }
    if (path === '/auth/v1/admin/users' && method === 'POST') {
      if (!validPassword(body.password)) return error(422, 'weak_password');
      const account = { id: webcrypto.randomUUID(), email: body.email, password: body.password,
        token: `synthetic-access-${accounts.length}`, refresh: `synthetic-refresh-${accounts.length}`, blocked: false, sessionsRevoked: false };
      accounts.push(account);
      return response({ id: account.id });
    }
    if (path === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'password') {
        if (defects.failFirstLogin && !failedLogin) { failedLogin = true; return error(400, 'invalid_credentials'); }
        const account = accounts.find(item => item.email === body.email && item.password === body.password && !item.blocked);
        return account ? response({ access_token: account.token, refresh_token: account.refresh }) : error(400, 'invalid_credentials');
      }
      const account = accounts.find(item => item.refresh === body.refresh_token && !item.blocked && !item.sessionsRevoked);
      if (!account) return error(400, 'refresh_token_not_found');
      account.previousToken = account.token;
      account.token += '-renewed'; account.refresh += '-renewed';
      return response({ access_token: account.token, refresh_token: account.refresh });
    }
    if (path === '/auth/v1/user') return user ? response({ id: user.id }) : error(401);
    if (path === '/auth/v1/logout') { if (!user) return error(401); user.sessionsRevoked = true; return response(null, 204); }
    if (path.startsWith('/auth/v1/admin/users/')) {
      const account = accounts.find(item => item.id === path.split('/').at(-1));
      if (method === 'DELETE') { auditOrClinicalDeletionCommitted = true; return response(null, 204); }
      if (method === 'GET') return response({ id: account.id, banned_until: account.blocked ? '2126-01-01T00:00:00Z' : null });
      if (!validPassword(body.password)) return error(422, 'weak_password');
      account.blocked = true; account.password = body.password;
      return response({ id: account.id, banned_until: '2126-01-01T00:00:00Z' });
    }
    if (path.startsWith('/storage/')) {
      if (path === '/storage/v1/object/clinical-attachments' && method === 'DELETE') {
        for (const prefix of body.prefixes) if (admin) records.delete(`storage:${prefix}`);
        return response([]);
      }
      const prefix = path.replace(/^\/storage\/v1\/object\/(?:authenticated\/)?clinical-attachments\//, '');
      const org = prefix.split('/')[0];
      if (!admin && !canRead(user, org)) return error(403);
      if (method === 'POST' || method === 'PUT') { records.set(`storage:${prefix}`, body); return response({ Key: prefix }); }
      const object = records.get(`storage:${prefix}`);
      return object === undefined ? error(404) : new Response(object, { status: 200 });
    }
    if (path.startsWith('/rest/v1/rpc/')) {
      const programmer = rows('app_programmers').some(item => item.user_id === user?.id);
      if (!programmer) return error(defects.permissionInfrastructureError ? 503 : 403);
      if (path.endsWith('prog_authorize_org_share')) {
        const id = webcrypto.randomUUID(); put('org_shares', { id, ...body,
          org_origem: body.p_org_origem, org_destino: body.p_org_destino, ativo: true }); return response(id);
      }
      const share = rows('org_shares').find(item => item.id === body.p_share_id);
      if (share) share.ativo = false;
      return response(!!share);
    }
    const table = path.replace('/rest/v1/', '');
    if (table === 'documentos') return error(404, 'PGRST205');
    const matches = row => [...url.searchParams].every(([key, value]) => {
      if (!value.startsWith('eq.')) return true;
      return String(row[key]) === value.slice(3);
    });
    const shareRead = row => table === 'patients' && rows('org_shares').some(share => share.ativo
      && share.p_org_origem === row.organization_id && canRead(user, share.p_org_destino));
    if (method === 'GET') {
      const visible = rows(table).filter(row => matches(row) && (admin || canRead(user, row.organization_id) || shareRead(row)));
      return response(url.searchParams.get('limit') === '0' ? [] : clone(visible));
    }
    if (method === 'POST') {
      if (table === 'organizations' || table === 'profiles' || table === 'app_programmers') {
        const row = { id: webcrypto.randomUUID(), ...body }; put(table, row);
        if (table === 'app_programmers' && defects.loseProgrammerResponse) throw new Error('fetch_failed');
        return response([clone(row)]);
      }
      if (table === 'organization_users') {
        memberships.push({ ...body }); put(table, memberships.at(-1));
        if (defects.loseMembershipResponse) throw new Error('fetch_failed');
        return response([body]);
      }
      if (!admin && !canRead(user, body.organization_id)) return error(table === 'addenda' ? 409 : 403, table === 'addenda' ? '23503' : '42501');
      if (table === 'addenda') {
        const prior = rows(table).find(row => row.organization_id === body.organization_id && row.legacy_id === body.legacy_id);
        if (prior) {
          if (prior.author_id !== user.id || JSON.stringify(prior.data.retificacao.campos) !== JSON.stringify(body.data.retificacao.campos)) return error(400, '23514');
          return response([]);
        }
        const parent = rows(body.parent_table).find(row => row.id === body.parent_id);
        const chain = rows(table).filter(row => row.parent_id === parent.id && row.retification_revision !== null);
        const head = chain.at(-1), patch = body.data.retificacao;
        const accepted = defects.bothAccepted || patch.baseAdendoId === (head?.legacy_id || '');
        const row = { id: webcrypto.randomUUID(), ...clone(body), author_id: user.id, created_by: user.id,
          created_at: new Date().toISOString(), patient_id: parent.patient_id, encounter_id: parent.encounter_id,
          parent_legacy_id: parent.legacy_id, retification_revision: accepted ? (head?.retification_revision || 0) + 1 : null,
          data: { autor_exibicao: user.id, retificacao: { ...clone(patch), status: accepted ? 'accepted' : 'conflict',
            revisao: (head?.retification_revision || 0) + (accepted ? 1 : 0), baseAtualId: head?.legacy_id || '' } } };
        put(table, row);
        if (defects.mutateOriginal) parent.data.alergias = 'silently changed signed original';
        emit(table, row); return response([clone(row)]);
      }
      const row = { id: webcrypto.randomUUID(), version: 1, ...clone(body), created_by: user?.id, updated_by: user?.id };
      if (row.status === 'finalized') { row.finalized_at = new Date().toISOString(); row.finalized_by = user.id; }
      put(table, row); return response([clone(row)]);
    }
    let selected = rows(table).filter(matches);
    if (table === 'addenda') return error(403);
    if (table === 'preanesthetic_assessments' && selected.some(row => row.finalized_at)) {
      if (defects.allowParentDelete && method === 'DELETE') {
        records.set(table, rows(table).filter(row => !selected.includes(row)));
        auditOrClinicalDeletionCommitted = true;
        return response(clone(selected));
      }
      return error(400, '23514');
    }
    if (method === 'DELETE' && table === 'organizations') return error(400, '23514');
    if (!admin) selected = selected.filter(row => canRead(user, row.organization_id));
    if (method === 'DELETE') {
      if (table === 'app_programmers') records.set(table, rows(table).filter(row => !selected.includes(row)));
      else if (selected.length) auditOrClinicalDeletionCommitted = true;
      return response([]);
    }
    for (const row of selected) {
      if (body.organization_id && body.organization_id !== row.organization_id) return error(400, '23514');
      Object.assign(row, clone(body)); if (typeof row.version === 'number') row.version++;
      emit(table, row);
    }
    return response(clone(selected));
  };
  const context = vm.createContext({
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://yqqrfgbvoexricjdxpis.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-private-admin-token', SUPABASE_ANON_KEY: 'synthetic-public-key' })[key] },
      serve: callback => { handle = callback; } },
    crypto: webcrypto, TextEncoder, Uint8Array, Request, Response, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval, WebSocket: FixtureWebSocket, fetch: fetchFixture
  });
  const deployed = source.replace('__RUN_CAPABILITY_SHA256__', capabilityHash)
    .replace('__RUN_UUID__', runId).replace('__RUN_ISSUED_AT__', issuedAt).replace('__RUN_EXPIRES_AT__', expiresAt);
  new vm.Script(stripTypeScriptTypes(deployed)).runInContext(context);
  const result = await (await handle(new Request('https://operator.invalid/run', { method: 'POST',
    headers: { 'x-audit-capability': capability, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }))).json();
  return { result, accounts, memberships, auditOrClinicalDeletionCommitted, programmerPrivileges: rows('app_programmers') };
}
