'use strict';

(function(){
  var MEDS = [
    { nome:'Fentanil',     unidade:'mcg', doses:[25,50,100,150] },
    { nome:'Propofol',     unidade:'mg',  doses:[20,50,100,150] },
    { nome:'Rocurônio',    unidade:'mg',  doses:[10,30,40,50] },
    { nome:'Midazolam',    unidade:'mg',  doses:[1,2,3,5] },
    { nome:'Efedrina',     unidade:'mg',  doses:[5,10,15] },
    { nome:'Metaraminol',  unidade:'mg',  doses:[0.5,1,2] },
    { nome:'Dipirona',     unidade:'g',   doses:[1,2] },
    { nome:'Ondansetrona', unidade:'mg',  doses:[4,8] },
    { nome:'Dexametasona', unidade:'mg',  doses:[4,8,10] },
    { nome:'Cefazolina',   unidade:'g',   doses:[1,2] }
  ];
  var sel = { med:null, dose:null };
  window.doseRapida = {
    abrir: function(){
      sel = { med:null, dose:null };
      var box = document.getElementById('ds-meds');
      box.innerHTML = MEDS.map(function(m,i){
        return '<button type="button" class="ds-chip" onclick="doseRapida.med('+i+')">'+m.nome+'</button>';
      }).join('');
      document.getElementById('ds-doses').style.display = 'none';
      document.getElementById('ds-titulo').textContent = 'Dose rápida';
      document.getElementById('ds-sub').textContent = 'Escolha o fármaco — registra com a hora atual';
      document.getElementById('ds-go').disabled = true;
      document.getElementById('ds-go').textContent = 'Registrar';
      document.getElementById('dose-overlay').classList.add('on');
      document.getElementById('dose-sheet').classList.add('on');
    },
    med: function(i){
      sel.med = MEDS[i]; sel.dose = null;
      var chips = document.querySelectorAll('#ds-meds .ds-chip');
      chips.forEach(function(c,j){ c.classList.toggle('sel', j===i); });
      var dd = document.getElementById('ds-doses');
      dd.style.display = 'flex';
      dd.innerHTML = sel.med.doses.map(function(d){
        return '<button type="button" class="ds-dose" onclick="doseRapida.dose('+d+')">'+d+'</button>';
      }).join('');
      document.getElementById('ds-sub').textContent = sel.med.nome+' · '+sel.med.unidade+' · EV · agora';
      document.getElementById('ds-go').disabled = true;
    },
    dose: function(d){
      sel.dose = d;
      document.querySelectorAll('#ds-doses .ds-dose').forEach(function(b){
        b.classList.toggle('sel', parseFloat(b.textContent)===d);
      });
      var go = document.getElementById('ds-go');
      go.disabled = false;
      go.textContent = 'Registrar '+sel.med.nome+' '+d+' '+sel.med.unidade+' ✓';
    },
    registrar: function(){
      if (!sel.med || sel.dose==null) return;
      try {
        anesthesiaQuickCommands.registrarDose({
          nome: sel.med.nome,
          dose: sel.dose,
          unidade: sel.med.unidade,
          via: 'EV'
        });
      } catch(e) { alert('Abra uma ficha de anestesia primeiro.'); }
      doseRapida.fechar();
    },
    fechar: function(){
      document.getElementById('dose-overlay').classList.remove('on');
      document.getElementById('dose-sheet').classList.remove('on');
    }
  };
})();

/* FIM DO PAINEL VISUAL DE DOSE RÁPIDA */
