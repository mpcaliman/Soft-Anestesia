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
  /* ---- BUSCA POR CONTEÚDO CLÍNICO ----
     A busca achava paciente, procedimento, cirurgião e convênio — a ficha de
     fora, o conteúdo de dentro não. "Quem tem alergia a dipirona", "quem já
     teve via aérea difícil", "quem usou noradrenalina" não tinham resposta
     possível, embora a resposta estivesse escrita em dezenas de fichas.

     Os campos abaixo são os que guardam texto clínico. A lista é explícita, e
     não "todos os campos", por duas razões: varrer tudo traria carimbos
     técnicos e identificadores como se fossem achado clínico; e o resultado
     precisa dizer EM QUE CAMPO achou — "dipirona" em alergias e "dipirona" em
     medicações em uso são coisas opostas, e uma busca que não distingue as
     duas é pior do que nenhuma. */
  var CLINICOS = {
    pre: [
      ['comorbidades','Comorbidades'], ['alergias','Alergias'], ['medicacoes','Medicações em uso'],
      ['descricao_clinica','Descrição clínica'], ['cirurgias_previas','Cirurgias prévias'],
      ['via_aerea','Via aérea'], ['ecg','ECG'], ['outros_exames','Outros exames'],
      ['pareceres','Pareceres'], ['conclusao','Conclusão'], ['orientacoes','Orientações'],
      ['asa','ASA'], ['jejum','Jejum'], ['acompanhantes','Acompanhantes']
    ],
    consulta: [
      ['queixa','Queixa'], ['hda','História da doença atual'], ['exame_fisico','Exame físico'],
      ['hipotese','Hipótese'], ['conduta','Conduta'], ['prescricao','Receituário'],
      ['comorbidades','Comorbidades'], ['alergias','Alergias'], ['medicacoes','Medicações']
    ],
    anestesia: [
      ['tecnica_descricao','Técnica'], ['via_aerea_detalhe','Via aérea'],
      ['intercorrencias','Intercorrências'], ['observacoes','Observações'],
      ['_medsLista','Medicações administradas']
    ],
    recuperacao: [['observacoes','Observações'], ['intercorrencias','Intercorrências']],
    risco: [['conclusao','Conclusão'], ['observacoes','Observações']]
  };
  /* Campo pode ser texto ou lista (as medicações da ficha são objetos). */
  function textoDoCampo(v){
    if (v == null) return '';
    if (Array.isArray(v)) {
      return v.map(function(x){
        if (!x) return '';
        if (typeof x === 'string') return x;
        return [x.nome, x.droga, x.medicamento, x.dose, x.via].filter(Boolean).join(' ');
      }).join(' · ');
    }
    if (typeof v === 'object') return '';
    return String(v);
  }
  /* O pedaço do texto em volta do achado, com o termo destacado. Mostrar a
     frase é o que permite decidir sem abrir a ficha. */
  function trecho(texto, termo){
    var i = texto.toLowerCase().indexOf(termo);
    if (i < 0) return '';
    var ini = Math.max(0, i - 45), fim = Math.min(texto.length, i + termo.length + 45);
    var s = (ini > 0 ? '…' : '') + texto.slice(ini, fim) + (fim < texto.length ? '…' : '');
    var e = esc(s);
    var alvo = esc(texto.substr(i, termo.length));
    var pos = e.toLowerCase().indexOf(alvo.toLowerCase());
    if (pos < 0) return e;
    return e.slice(0, pos) + '<mark>' + e.slice(pos, pos + alvo.length) + '</mark>' + e.slice(pos + alvo.length);
  }

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
        }

        /* ---- conteúdo clínico ---- */
        var clin = [];
        Object.keys(CLINICOS).forEach(function(m){
          var lista = [];
          try { lista = store.list(m) || []; } catch(e){}
          lista.forEach(function(it){
            if (!it || !it._id) return;
            var achados = [];
            CLINICOS[m].forEach(function(par){
              var txt = textoDoCampo(it[par[0]]);
              if (txt && txt.toLowerCase().indexOf(termo) >= 0) achados.push({ rot: par[1], txt: txt });
            });
            if (!achados.length) return;
            var nome = it.paciente_nome || it.nome || (it.paciente && it.paciente.nome) || '';
            var data = it.data_anestesia || it.data || (it._createdAt ? String(it._createdAt).slice(0,10) : '');
            clin.push({
              mod: m, id: it._id, nome: nome || '(sem nome)', data: data,
              campo: achados[0].rot, trecho: trecho(achados[0].txt, termo),
              outros: achados.length - 1
            });
          });
        });
        clin.sort(function(a,b){ return String(b.data||'').localeCompare(String(a.data||'')); });
        if (clin.length) {
          html += '<div class="gs-h">CONTEÚDO CLÍNICO · '+clin.length+'</div>' + clin.slice(0,40).map(function(c){
            var quando = '';
            try { quando = c.data ? utils.formatarData(c.data) : ''; } catch(e){ quando = c.data || ''; }
            return '<div class="gs-item" onclick="buscaGlobal.abrirReg('+utils.jsArg(c.mod)+','+utils.jsArg(c.id)+')">'
              + '<span class="gs-mod">'+esc(LABELS[c.mod]||c.mod)+'</span>'
              + '<span><div class="gs-nome">'+esc(c.nome)+(quando?' <span style="font-weight:400;opacity:.6">· '+esc(quando)+'</span>':'')+'</div>'
              + '<div class="gs-det"><b>'+esc(c.campo)+':</b> '+c.trecho
              + (c.outros ? ' <span style="opacity:.6">(+'+c.outros+' campo'+(c.outros>1?'s':'')+')</span>' : '')
              + '</div></span></div>';
          }).join('');
        }

        if (!res.length && !clin.length) {
          html += '<div class="gs-vazio">Nenhum registro para "'+esc(termo)+'".</div>';
        }
      } else if (!termo) {
        html += '<div class="gs-vazio">Digite 2+ letras. Busca pacientes, procedimentos, convênios e agenda — e também dentro das fichas: alergias, comorbidades, medicações, técnica, intercorrências, conduta.</div>';
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
