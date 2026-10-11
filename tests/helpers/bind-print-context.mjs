/** Post-boot synthetic sessions for browser/VM printing tests. No production API is contacted. */
export function bindSyntheticPrintContext() {
  const uid = 'csp-user', organizationId = 'csp-org';
  const jwtPart = value => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const cloudSession = {
    access_token: jwtPart({alg:'HS256',typ:'JWT'}) + '.' +
      jwtPart({sub:uid,exp:Math.floor(Date.now() / 1000) + 3600}) + '.c3ludGhldGljLWZpeHR1cmU',
    refresh_token: 'synthetic-csp-refresh', expires_at: Date.now() + 3600000,
    user: {id:uid,email:'csp-user@teste.local'}
  };
  const authSession = {id:uid,uid,usuario:'csp-user@teste.local',nome:'Teste CSP',
    perfil:'admin',role:'anestesiologista',modulos:auth.PERFIS.admin.modulos.slice(),
    soImpressao:[],organization_id:organizationId,entrouEm:Date.now()};
  sessionStorage.setItem(cloud.SESSION_KEY, JSON.stringify(cloudSession));
  sessionStorage.setItem(auth.SESSION_KEY, JSON.stringify(authSession));
  contextoAba.prepararUsuario(uid, {forcar:true});
  if (!contextoAba.vincular({uid,organization_id:organizationId,role:authSession.role,orgs:1}, 'Clínica CSP sintética') ||
      !contextoAba.operational() || !contextoAba.compativelComSessoes(cloud.session(), auth.usuarioAtual()))
    throw new Error('Synthetic print sessions/context did not bind');
  return contextoAba.capturar();
}
