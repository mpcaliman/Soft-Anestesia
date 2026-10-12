(function(){
  function build(select, cfg){
    if (!select || select.dataset.stepper) return;
    select.dataset.stepper = '1';
    var wrap = document.createElement('div');
    wrap.className = 'stepper-wrap';
    select.classList.add('stepper-select-hidden');
    select.parentNode.insertBefore(wrap, select.nextSibling);
    function setVal(v){
      select.value = v;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
      sync();
    }
    function sync(){
      var v = select.value;
      wrap.querySelectorAll('.stp').forEach(function(b){
        var bv = b.dataset.v;
        if (b.classList.contains('stp-e')) {
          b.classList.toggle('sel', /-E$/.test(v));
        } else {
          b.classList.toggle('sel', v === bv || v === bv + '-E');
        }
      });
    }
    cfg.chips.forEach(function(ch){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'stp' + (ch.cls ? ' ' + ch.cls : '');
      b.dataset.v = ch.v;
      b.innerHTML = ch.label;
      b.onclick = function(){
        var cur = select.value;
        if (ch.cls === 'stp-e') {
          /* alterna sufixo -E mantendo a classe atual */
          if (!cur) return;
          setVal(/-E$/.test(cur) ? cur.replace(/-E$/,'') : (cur === 'ASA VI' ? cur : cur + '-E'));
        } else {
          /* mantém -E se já estava marcado e o alvo permite */
          var manterE = /-E$/.test(cur) && ch.e !== false;
          setVal(manterE ? ch.v + '-E' : ch.v);
        }
      };
      wrap.appendChild(b);
    });
    select.addEventListener('change', sync);
    sync();
  }
  function init(){
    var asaChips = [
      { v:'ASA I', label:'I' }, { v:'ASA II', label:'II' }, { v:'ASA III', label:'III' },
      { v:'ASA IV', label:'IV' }, { v:'ASA V', label:'V' }, { v:'ASA VI', label:'VI', e:false },
      { v:'', label:'E', cls:'stp-e' }
    ];
    var maChips = [
      { v:'Mallampati I', label:'I' }, { v:'Mallampati II', label:'II' },
      { v:'Mallampati III', label:'III' }, { v:'Mallampati IV', label:'IV' },
      { v:'Via aérea difícil prevista', label:'<span class="stp-txt">VA difícil</span>' },
      { v:'Sem alterações', label:'<span class="stp-txt">Sem alt.</span>' }
    ];
    ['asa','pre_asa'].forEach(function(n){
      document.querySelectorAll('select[name="'+n+'"]').forEach(function(s){
        if (/ASA I/.test(s.innerHTML)) build(s, { chips: asaChips });
      });
    });
    ['via_aerea','pre_via_aerea'].forEach(function(n){
      document.querySelectorAll('select[name="'+n+'"]').forEach(function(s){
        if (/Mallampati I/.test(s.innerHTML)) build(s, { chips: maChips });
      });
    });
  }
  if (document.readyState !== 'loading') setTimeout(init, 400);
  else document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 400); });
})();

/* FIM DOS SELETORES RÁPIDOS DE FORMULÁRIO */
