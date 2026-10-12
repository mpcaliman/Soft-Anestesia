(function(){
  function esc(s){ return String(s||'').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
  var hero;
  function ensureHero(){
    if (hero) return hero;
    var kpi = document.getElementById('kpi-grid');
    if (!kpi) return null;
    hero = document.createElement('div');
    hero.className = 'hoje-hero';
    hero.id = 'hoje-hero';
    kpi.parentNode.insertBefore(hero, kpi);
    return hero;
  }
  function renderHero(){
    var h = ensureHero(); if (!h) return;
    var hojeISO;
    try { hojeISO = utils.hojeISO(); } catch(e){ var d=new Date(); hojeISO=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
    var itens = [];
    try {
      itens = (store.list('agenda')||[]).filter(function(a){ return a.data === hojeISO; })
        .sort(function(a,b){ return String(a.hora||'99').localeCompare(String(b.hora||'99')); });
    } catch(e){}
    var dataFmt = new Date().toLocaleDateString('pt-BR', { weekday:'long', day:'numeric', month:'long' });
    var html = '<div class="hh-top">'
      + '<div><div class="hh-title">Hoje</div><div class="hh-date">'+esc(dataFmt)+'</div></div>'
      + '<span class="hh-count">'+itens.length+' compromisso'+(itens.length===1?'':'s')+'</span></div>';
    if (itens.length) {
      html += '<div class="hh-list">' + itens.slice(0,6).map(function(a){
        var det = [a.procedimento, a.cirurgiao, a.local].filter(Boolean).join(' · ');
        return '<a class="hh-item" href="#agenda">'
          + '<span class="hh-hora">'+esc(a.hora||'—')+'</span>'
          + '<span><div class="hh-pac">'+esc(a.paciente||a.tipo||'Compromisso')+'</div>'
          + (det?'<div class="hh-det">'+esc(det)+'</div>':'') + '</span>'
          + (a.status?'<span class="hh-tag">'+esc(String(a.status).toUpperCase())+'</span>':'')
          + '</a>';
      }).join('') + '</div>';
    } else {
      html += '<div class="hh-vazio">Nenhum compromisso agendado para hoje.</div>';
    }
    html += '<div class="hh-actions">'
      + '<a class="hh-btn hh-btn-teal" href="#anestesia">💉 Nova ficha</a>'
      + '<a class="hh-btn hh-btn-line" href="#pre">📋 Nova pré-anestésica</a>'
      + '<a class="hh-btn hh-btn-line" href="#agenda">📅 Agenda completa</a>'
      + '<a class="hh-btn hh-btn-line" href="javascript:void(0)" onclick="var i=document.getElementById(\'dash-search-input\'); if(i){ i.focus(); }">🔎 Buscar</a>'
      + '</div>';
    h.innerHTML = html;
  }
  window.addEventListener('hashchange', function(){
    var mod = (location.hash||'#dashboard').replace('#','').split('/')[0];
    if (mod === 'dashboard') setTimeout(renderHero, 60);
  });
  if (document.readyState !== 'loading') setTimeout(renderHero, 300);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(renderHero, 300); });
})();

/* FIM DO RESUMO DE HOJE DO DASHBOARD */
