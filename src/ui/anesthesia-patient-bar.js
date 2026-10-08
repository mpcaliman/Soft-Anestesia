'use strict';

(function(){
  var bar;
  function ensureBar(){
    if (bar) return bar;
    var mod = document.getElementById('module-anestesia');
    if (!mod) return null;
    bar = document.createElement('div');
    bar.className = 'ficha-topbar';
    bar.id = 'ficha-topbar';
    mod.insertBefore(bar, mod.firstChild);
    return bar;
  }
  function esc(s){ return String(s||'').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
  function atualizarBar(){
    var b = ensureBar(); if (!b) return;
    var f = document.getElementById('form-anestesia'); if (!f) return;
    var v = function(n){ var el = f.querySelector('[name="'+n+'"]'); return el ? el.value.trim() : ''; };
    var nome = v('paciente_nome');
    var mod = (location.hash||'').replace('#','').split('/')[0];
    if (!nome || mod !== 'anestesia') { b.classList.remove('on'); return; }
    var idade = v('paciente_idade'), peso = v('paciente_peso'), imc = v('paciente_imc');
    var asa = v('pre_asa') || v('asa'), alerg = v('pre_alergias');
    var nega = /^\s*(nega|não|nao|sem|nda|-|—)/i.test(alerg);
    var html = '<span class="ft-nome">'+esc(nome)+'</span>'
      + '<span class="ft-sub">'+[idade?idade+'a':null, peso?peso+' kg':null, imc?'IMC '+imc:null].filter(Boolean).join(' · ')+'</span>';
    if (asa) html += '<span class="ft-badge ft-asa">'+esc(asa)+'</span>';
    if (alerg) html += nega
      ? '<span class="ft-badge ft-alergia-nega">ALERGIAS: NEGA</span>'
      : '<span class="ft-badge ft-alergia">⚠ ALERGIA: '+esc(alerg.toUpperCase().slice(0,40))+'</span>';
    b.innerHTML = html;
    b.classList.add('on');
  }
  function syncMod(){
    var mod = (location.hash||'#dashboard').replace('#','').split('/')[0];
    document.body.setAttribute('data-mod', mod);
    atualizarBar();
  }
  window.addEventListener('hashchange', syncMod);
  document.addEventListener('input', function(e){
    if (e.target && e.target.form && e.target.form.id === 'form-anestesia') atualizarBar();
  });
  setInterval(atualizarBar, 3000);
  if (document.readyState !== 'loading') syncMod(); else document.addEventListener('DOMContentLoaded', syncMod);
})();

/* FIM DA BARRA VISUAL DO PACIENTE NA ANESTESIA */
