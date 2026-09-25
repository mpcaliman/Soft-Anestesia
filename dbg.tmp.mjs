import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage();
p.on('pageerror', e => console.log('ERR', e.message));
p.on('dialog', d => console.log('DIALOG', d.type(), JSON.stringify(d.message())));
await p.goto('file://' + process.cwd() + '/index.html');
await p.waitForTimeout(1300);
console.log(await p.evaluate(async () => {
  try { modal.close(); } catch(e) {}
  store.setList('financeiro', []);
  ui.navegar('financeiro');
  await new Promise(r=>setTimeout(r,400));
  financeiro.editar(null);
  await new Promise(r=>setTimeout(r,200));
  const f = document.getElementById('form-financeiro');
  f.querySelector('[name="convenio"]').value = 'Unimed';
  const tr = financeiro.codigos.add({ codigo: fin.CODIGO_CONSULTA, descricao: 'Consulta' });
  const unit = tr.querySelector('[name="fin_cod_unit[]"]');
  unit.value = '999'; unit.dispatchEvent(new Event('input', {bubbles:true}));
  const antes = unit.value;
  const confAntes = typeof window.confirm;
  const r = window.confirm('teste?');
  financeiro.codigos.sugerirTodos();
  await new Promise(r=>setTimeout(r,150));
  return { antes, depois: unit.value, confirmRetorna: r, confAntes };
}));
await b.close();
