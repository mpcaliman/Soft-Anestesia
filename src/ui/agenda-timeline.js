(function(){
  function esc(s){ return String(s||'').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
  var card, diaAtual;
  function hojeISO(){
    try { return utils.hojeISO(); } catch(e){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  }
  function ensureCard(){
    if (card) return card;
    var contador = document.getElementById('ag-contador');
    if (!contador) return null;
    card = document.createElement('div');
    card.className = 'card no-collapse ag-timeline-card';
    card.innerHTML = '<div class="card-header no-collapse"><div class="ag-tl-head">'
      + '<div class="card-title-wrap"><h2>Linha do dia</h2></div>'
      + '<div class="ag-tl-nav">'
      + '<button type="button" class="btn btn-sm" onclick="agTimeline.mudarDia(-1)">‹</button>'
      + '<span class="ag-tl-dia" id="ag-tl-dia">—</span>'
      + '<button type="button" class="btn btn-sm" onclick="agTimeline.mudarDia(1)">›</button>'
      + '<button type="button" class="btn btn-sm" onclick="agTimeline.hoje()">Hoje</button>'
      + '</div></div></div>'
      + '<div class="card-body" id="ag-tl-body"></div>';
    contador.parentNode.insertBefore(card, contador.nextSibling);
    return card;
  }
  function render(){
    var c = ensureCard(); if (!c) return;
    if (!diaAtual) diaAtual = hojeISO();
    var lbl = document.getElementById('ag-tl-dia');
    var dParts = diaAtual.split('-');
    var dObj = new Date(+dParts[0], +dParts[1]-1, +dParts[2]);
    lbl.textContent = dObj.toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'short' });
    var itens = [];
    try {
      itens = (store.list('agenda')||[]).filter(function(a){ return a.data === diaAtual && a.hora; });
    } catch(e){}
    var body = document.getElementById('ag-tl-body');
    if (!itens.length) {
      body.innerHTML = '<div class="ag-tl-vazio">Sem compromissos com horário neste dia. Os compromissos sem hora aparecem no calendário abaixo.</div>';
      return;
    }
    var horas = itens.map(function(a){ return parseInt(a.hora.split(':')[0],10); });
    var hIni = Math.min(7, Math.min.apply(null, horas));
    var hFim = Math.max(19, Math.max.apply(null, horas)+2);
    var pxHora = 56;
    var altura = (hFim - hIni) * pxHora;
    var colHoras = '';
    for (var h = hIni; h < hFim; h++) colHoras += '<span>'+String(h).padStart(2,'0')+':00</span>';
    var gridlines = '';
    for (var g = 1; g < (hFim - hIni); g++) gridlines += '<div class="ag-tl-gridline" style="top:'+(g*pxHora)+'px"></div>';
    var blocos = itens.map(function(a){
      var p = a.hora.split(':');
      var top = ((+p[0] - hIni) + (+p[1]||0)/60) * pxHora;
      var st = String(a.status||'agendado').toLowerCase();
      var det = [a.procedimento, a.cirurgiao, a.local].filter(Boolean).join(' · ');
      return '<div class="ag-tl-bloco st-'+esc(st)+'" style="top:'+top.toFixed(1)+'px" '
        + 'onclick="agenda.editar('+utils.jsArg(a._id||'')+')" title="Editar compromisso">'
        + '<div class="tlb-pac">'+esc(a.hora)+' · '+esc(a.paciente||a.tipo||'Compromisso')+'</div>'
        + (det?'<div class="tlb-det">'+esc(det)+'</div>':'')
        + '<span class="tlb-tag">'+esc(st.toUpperCase())+'</span></div>';
    }).join('');
    var agora = '';
    if (diaAtual === hojeISO()) {
      var n = new Date();
      var topN = ((n.getHours() - hIni) + n.getMinutes()/60) * pxHora;
      if (topN >= 0 && topN <= altura) agora = '<div class="ag-tl-agora" style="top:'+topN.toFixed(1)+'px"></div>';
    }
    body.innerHTML = '<div class="ag-tl" style="height:'+altura+'px">'
      + '<div class="ag-tl-horas">'+colHoras+'</div>'
      + '<div class="ag-tl-track">'+gridlines+blocos+agora+'</div></div>';
  }
  window.agTimeline = {
    mudarDia: function(delta){
      var p = diaAtual.split('-');
      var d = new Date(+p[0], +p[1]-1, +p[2]+delta);
      diaAtual = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      render();
    },
    hoje: function(){ diaAtual = hojeISO(); render(); },
    render: render
  };
  window.addEventListener('hashchange', function(){
    var mod = (location.hash||'').replace('#','').split('/')[0];
    if (mod === 'agenda') setTimeout(render, 80);
  });
  if (document.readyState !== 'loading') setTimeout(render, 400);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(render, 400); });
  /* re-renderiza quando um compromisso é salvo (formulário da agenda) */
  document.addEventListener('submit', function(e){
    if (e.target && e.target.id === 'form-agenda') setTimeout(render, 300);
  }, true);
})();

/* FIM DA LINHA DO TEMPO DA AGENDA */
