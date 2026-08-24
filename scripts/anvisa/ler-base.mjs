/* ============================================================================
   Leitura do arquivo da CMED — aceita CSV (;) e XLSX.
   Sem dependência externa: o XLSX é um zip de XML e nós lemos a aba pedida.
============================================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { COLUNAS } from './normalizar.mjs';

/* --- CSV com ; e campos entre aspas -------------------------------------- */
function partirCSV(texto, sep = ';') {
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

export function lerCSV(caminho) {
  let texto = fs.readFileSync(caminho, 'utf8');
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);   /* BOM */
  const linhas = partirCSV(texto).filter(l => l.length > 1);
  const cab = linhas.shift();
  return linhas.map(l => {
    const o = {};
    cab.forEach((c, i) => { o[c] = l[i] == null ? '' : l[i]; });
    return o;
  });
}

/* --- XLSX ---------------------------------------------------------------- */
function lerZip(caminho) {
  const buf = fs.readFileSync(caminho);
  /* varre os cabeçalhos locais; suficiente para os zips que o Excel gera */
  const arquivos = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i++; continue; }
    const metodo = buf.readUInt16LE(i + 8);
    let compTam = buf.readUInt32LE(i + 18);
    let bruTam = buf.readUInt32LE(i + 22);
    const nomeTam = buf.readUInt16LE(i + 26);
    const extraTam = buf.readUInt16LE(i + 28);
    const nome = buf.slice(i + 30, i + 30 + nomeTam).toString('utf8');
    const ini = i + 30 + nomeTam + extraTam;
    if (compTam === 0 && bruTam === 0) {
      /* tamanho no descritor pós-dado: cai fora, o Excel raramente usa */
      i = ini; continue;
    }
    const dados = buf.slice(ini, ini + compTam);
    try {
      arquivos[nome] = metodo === 8 ? zlib.inflateRawSync(dados) : dados;
    } catch (e) { /* entrada ilegível: ignora */ }
    i = ini + compTam;
  }
  return arquivos;
}

function textosCompartilhados(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    let s = '';
    const re2 = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let m2;
    while ((m2 = re2.exec(m[1]))) s += m2[1];
    out.push(desescapar(s));
  }
  return out;
}
function desescapar(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&amp;/g, '&');
}
function colunaParaIndice(ref) {
  const letras = String(ref).replace(/\d+/g, '');
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export function lerXLSX(caminho, nomeAba) {
  const z = lerZip(caminho);
  const wb = (z['xl/workbook.xml'] || Buffer.from('')).toString('utf8');
  const abas = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="rId(\d+)"/g)]
    .map(m => ({ nome: desescapar(m[1]), rid: m[2] }));
  const alvo = nomeAba ? abas.find(a => a.nome === nomeAba) : abas[0];
  if (!alvo) throw new Error('Aba não encontrada: ' + nomeAba + ' (existem: ' + abas.map(a => a.nome).join(', ') + ')');
  const rels = (z['xl/_rels/workbook.xml.rels'] || Buffer.from('')).toString('utf8');
  const rel = new RegExp('Id="rId' + alvo.rid + '"[^>]*Target="([^"]+)"').exec(rels);
  const caminhoAba = rel ? ('xl/' + rel[1].replace(/^\/?xl\//, '')) : 'xl/worksheets/sheet1.xml';
  const sst = textosCompartilhados((z['xl/sharedStrings.xml'] || Buffer.from('')).toString('utf8'));
  const xml = (z[caminhoAba] || Buffer.from('')).toString('utf8');

  const linhas = [];
  const reLinha = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let mr;
  while ((mr = reLinha.exec(xml))) {
    const celulas = [];
    const reCel = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let mc;
    while ((mc = reCel.exec(mr[1]))) {
      const attrs = mc[1] || mc[3] || '';
      const corpo = mc[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = ref ? colunaParaIndice(ref[1]) : celulas.length;
      const tipo = /t="([^"]+)"/.exec(attrs);
      const v = /<v>([\s\S]*?)<\/v>/.exec(corpo);
      const isT = /<is>[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/.exec(corpo);
      let valor = '';
      if (isT) valor = desescapar(isT[1]);
      else if (v) {
        valor = desescapar(v[1]);
        if (tipo && tipo[1] === 's') valor = sst[+valor] != null ? sst[+valor] : '';
      }
      celulas[idx] = valor;
    }
    for (let i = 0; i < celulas.length; i++) if (celulas[i] == null) celulas[i] = '';
    linhas.push(celulas);
  }
  const cab = linhas.shift() || [];
  return linhas.map(l => {
    const o = {};
    cab.forEach((c, i) => { o[c] = l[i] == null ? '' : l[i]; });
    return o;
  });
}

export function lerBase(caminho, aba = 'Base_Medicamentos') {
  const linhas = /\.xlsx$/i.test(caminho) ? lerXLSX(caminho, aba) : lerCSV(caminho);
  if (!linhas.length) throw new Error('Arquivo sem linhas: ' + caminho);
  /* Validação de colunas: sem isto, uma mudança de cabeçalho na Anvisa
     importaria 26 mil registros com o campo errado, em silêncio. */
  const faltando = Object.values(COLUNAS).filter(c => !(c in linhas[0]));
  if (faltando.length) {
    throw new Error('Colunas ausentes no arquivo (a Anvisa mudou o cabeçalho?):\n  - ' + faltando.join('\n  - '));
  }
  return linhas;
}
