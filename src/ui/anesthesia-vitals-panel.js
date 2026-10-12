'use strict';

(function(){
  var CAMPOS = [
    { k:'pas',  lbl:'PAS mmHg', def:120, passo:5,  min:30,  max:280 },
    { k:'pad',  lbl:'PAD mmHg', def:80,  passo:5,  min:15,  max:160 },
    { k:'fc',   lbl:'FC bpm',   def:70,  passo:5,  min:20,  max:220 },
    { k:'fr',   lbl:'FR irpm',  def:12,  passo:1,  min:4,   max:60 },
    { k:'spo2', lbl:'SpO₂ %',   def:98,  passo:1,  min:50,  max:100 }
  ];
  var RITMOS = ['Sinusal','Taquicardia sinusal','Bradicardia sinusal','FA','Ritmo de marca-passo'];
  var vals = {}, ritmo = 'Sinusal';
  function esc(s){ return String(s||'').replace(/[<>&"]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]; }); }
  function renderVals(){
    CAMPOS.forEach(function(c){
      var el = document.getElementById('vit-val-'+c.k);
      if (el) el.textContent = vals[c.k];
    });
  }
  window.vitaisRapidos = {
    abrir: function(){
      var ult = null;
      try { ult = anesthesiaQuickCommands.lerUltimosVitais(); } catch(e){}
      CAMPOS.forEach(function(c){
        var v = ult && parseFloat(ult[c.k]);
        vals[c.k] = (v && !isNaN(v)) ? v : c.def;
      });
      ritmo = (ult && ult.ritmo) || 'Sinusal';
      document.getElementById('vit-sub').textContent = ult
        ? 'Partindo do último registro — ajuste e registre'
        : 'Valores típicos — ajuste e registre';
      document.getElementById('vit-grid').innerHTML = CAMPOS.map(function(c){
        return '<div class="vit-item"><div class="vi-lbl">'+c.lbl+'</div><div class="vi-row">'
          + '<button type="button" class="vi-btn" onclick="vitaisRapidos.aj('+utils.jsArg(c.k)+',-1)">−</button>'
          + '<span class="vi-val" id="vit-val-'+c.k+'">'+vals[c.k]+'</span>'
          + '<button type="button" class="vi-btn" onclick="vitaisRapidos.aj('+utils.jsArg(c.k)+',1)">+</button>'
          + '</div></div>';
      }).join('');
      document.getElementById('vit-ritmo').innerHTML = RITMOS.map(function(r){
        return '<button type="button" class="ds-chip'+(r===ritmo?' sel':'')+'" onclick="vitaisRapidos.rit(this,'+utils.jsArg(r)+')">'+esc(r)+'</button>';
      }).join('');
      document.getElementById('vit-overlay').classList.add('on');
      document.getElementById('vit-sheet').classList.add('on');
    },
    aj: function(k, dir){
      var c = CAMPOS.find(function(x){ return x.k===k; });
      vals[k] = Math.min(c.max, Math.max(c.min, vals[k] + dir*c.passo));
      renderVals();
    },
    rit: function(btn, r){
      ritmo = r;
      document.querySelectorAll('#vit-ritmo .ds-chip').forEach(function(b){ b.classList.toggle('sel', b===btn); });
    },
    registrar: function(){
      try {
        anesthesiaQuickCommands.registrarVitais({
          pas: vals.pas,
          pad: vals.pad,
          fc: vals.fc,
          fr: vals.fr,
          spo2: vals.spo2,
          ritmo: ritmo
        });
      } catch(e) { alert('Abra uma ficha de anestesia primeiro.'); }
      vitaisRapidos.fechar();
    },
    fechar: function(){
      document.getElementById('vit-overlay').classList.remove('on');
      document.getElementById('vit-sheet').classList.remove('on');
    }
  };
})();

/* FIM DO PAINEL VISUAL DE SINAIS VITAIS */
