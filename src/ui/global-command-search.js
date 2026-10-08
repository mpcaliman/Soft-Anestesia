(function(){
  function esc(s){ return String(s||'').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
  var MODS = ['anestesia','pre','consulta','recuperacao','termo','prescricao','risco','financeiro'];
  var LABELS = { anestesia:'Anestesia', pre:'Pré', consulta:'Consulta', recuperacao:'SRPA', termo:'Termo', prescricao:'Receituário', risco:'Risco', financeiro:'Financeiro', agenda:'Agenda' };
  var ACOES = [
    { t:'Nova ficha de anestesia', ic:'💉', go:function(){ location.hash='#anestesia'; setTimeout(function(){ try{ anestesia.novo(); }catch(e){} }, 200); } },
    { t:'Nova pré-anestésica', ic:'📋', go:function(){ location.hash='#pre'; } },
    { t:'Novo compromisso na agenda', ic:'📅', go:function(){ location.hash='#agenda'; setTimeout(function(){ try{ agenda.editar(null); }catch(e){} }, 200); } },
    { t:'Dashboard', ic:'📊', go:function(){ location.hash='#dashboard'; } },
    { t:'Financeiro', ic:'💰', go:function(){ location.hash='#financeiro'; } },
    { t:'Ajustes', ic:'⚙️', go:function(){ location.hash='#ajustes'; } }
  ];
  var acaoAtual = [];
  window.buscaGlobal = {
    abrir: function(){
      document.getElementById('gs-overlay').classList.add('on');
      var i = document.getElementById('gs-input');
      i.value = ''; buscaGlobal.buscar();
      setTimeout(function(){ i.focus(); }, 60);
    },
    fechar: function(){ document.getElementById('gs-overlay').classList.remove('on'); },
    acao: function(i){ buscaGlobal.fechar(); acaoAtual[i].go(); },
    abrirReg: function(mod, id){
      buscaGlobal.fechar();
      try { dashboard._abrirRegistro(mod, id); } catch(e){ location.hash = '#'+mod; }
    },
    buscar: function(){
      var termo = document.getElementById('gs-input').value.toLowerCase().trim();
      var out = document.getElementById('gs-results');
      var html = '';
      /* ações */
      acaoAtual = termo ? ACOES.filter(function(a){ return a.t.toLowerCase().includes(termo); }) : ACOES.slice(0,4);
      if (acaoAtual.length) {
        html += '<div class="gs-h">AÇÕES</div>' + acaoAtual.map(function(a,i){
          return '<div class="gs-item" onclick="buscaGlobal.acao('+i+')"><span class="gs-ic">'+a.ic+'</span><span class="gs-nome">'+esc(a.t)+'</span></div>';
        }).join('');
      }
      if (termo && termo.length >= 2) {
        var res = [];
        MODS.forEach(function(m){
          var lista = [];
          try { lista = store.list(m) || []; } catch(e){}
          lista.forEach(function(it){
            var nome = it.paciente_nome || it.nome || (it.paciente && it.paciente.nome) || it.paciente || '';
            var proc = (it.procedimento && it.procedimento.descricao) || it.descricao || '';
            var cir = (it.procedimento && it.procedimento.cirurgiao) || '';
            var conv = (it.paciente && it.paciente.convenio) || it.convenio || '';
            var blob = [nome, proc, cir, conv].join(' ').toLowerCase();
            if (blob.includes(termo)) res.push({ mod:m, id:it._id, nome:nome||'(sem nome)', det:[proc,cir,conv].filter(Boolean).join(' · '), data:it._updatedAt });
          });
        });
        try {
          (store.list('agenda')||[]).forEach(function(a){
            var blob = [a.paciente,a.procedimento,a.cirurgiao,a.convenio,a.local].join(' ').toLowerCase();
            if (blob.includes(termo)) res.push({ mod:'agenda', id:a._id, nome:a.paciente||a.tipo||'Compromisso', det:[a.data,a.hora,a.procedimento].filter(Boolean).join(' · '), data:a.data });
          });
        } catch(e){}
        res.sort(function(x,y){ return new Date(y.data||0) - new Date(x.data||0); });
        if (res.length) {
          html += '<div class="gs-h">REGISTROS · '+res.length+'</div>' + res.slice(0,30).map(function(r){
            return '<div class="gs-item" onclick="buscaGlobal.abrirReg('+utils.jsArg(r.mod)+','+utils.jsArg(r.id)+')">'
              + '<span class="gs-mod">'+esc(LABELS[r.mod]||r.mod)+'</span>'
              + '<span><div class="gs-nome">'+esc(r.nome)+'</div>'
              + (r.det?'<div class="gs-det">'+esc(r.det)+'</div>':'') + '</span></div>';
          }).join('');
        } else {
          html += '<div class="gs-vazio">Nenhum registro para "'+esc(termo)+'".</div>';
        }
      } else if (!termo) {
        html += '<div class="gs-vazio">Digite 2+ letras para buscar em todos os módulos — pacientes, procedimentos, convênios, agenda.</div>';
      }
      out.innerHTML = html;
    }
  };
  /* botão no header */
  function initBtn(){
    var hdr = document.querySelector('.app-header');
    if (!hdr || document.getElementById('gs-trigger')) return;
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'gs-trigger'; b.className = 'gs-trigger';
    b.innerHTML = '🔎 <span class="gs-txt">Buscar em tudo</span> <kbd>Ctrl K</kbd>';
    b.onclick = buscaGlobal.abrir;
    hdr.appendChild(b);
  }
  document.getElementById('gs-overlay').addEventListener('click', buscaGlobal.fechar);
  document.addEventListener('keydown', function(e){
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k') { e.preventDefault(); buscaGlobal.abrir(); }
    if (e.key==='Escape') buscaGlobal.fechar();
  });
  if (document.readyState !== 'loading') setTimeout(initBtn, 300);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(initBtn, 300); });
})();

/* FIM DA BUSCA GLOBAL DE COMANDOS */
