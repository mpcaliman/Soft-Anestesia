window.SoftQR = (function () {
  const ECC = { L: 0, M: 1, Q: 2, H: 3 };
  const FMT = { L: 1, M: 0, Q: 3, H: 2 };
  const ECC_CW = [
    [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
    [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
    [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]
  ];
  const ECC_BLOCKS = [
    [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
    [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
    [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
    [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81]
  ];
  function generate(text, eclName) {
    const ecl = ECC[eclName || 'M'];
    const bytes = new TextEncoder().encode(text);
    const numRawDataModules = (ver) => {
      let r = (16 * ver + 128) * ver + 64;
      if (ver >= 2) { const a = Math.floor(ver / 7) + 2; r -= (25 * a - 10) * a - 55; if (ver >= 7) r -= 36; }
      return r;
    };
    const numDataCw = (ver) => Math.floor(numRawDataModules(ver) / 8) - ECC_CW[ecl][ver] * ECC_BLOCKS[ecl][ver];
    let ver = 1;
    for (; ver <= 40; ver++) {
      const need = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (need <= numDataCw(ver) * 8) break;
    }
    if (ver > 40) throw new Error('texto longo demais para QR');
    const ccBits = ver < 10 ? 8 : 16;
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(bytes.length, ccBits);
    for (const b of bytes) push(b, 8);
    const dataCapacityBits = numDataCw(ver) * 8;
    push(0, Math.min(4, dataCapacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    for (let pad = 0xEC; bits.length < dataCapacityBits; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; dataCodewords.push(b); }
    const numBlocks = ECC_BLOCKS[ecl][ver], eccPerBlock = ECC_CW[ecl][ver];
    const totalCw = Math.floor(numRawDataModules(ver) / 8);
    const numShort = numBlocks - (totalCw % numBlocks), shortLen = Math.floor(totalCw / numBlocks);
    const gen = rsGenerator(eccPerBlock), blocks = [];
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortLen - eccPerBlock + (i < numShort ? 0 : 1);
      const dat = dataCodewords.slice(k, k + datLen); k += datLen;
      blocks.push({ dat, ecc: rsRemainder(dat, gen) });
    }
    const result = [], maxDat = Math.max.apply(null, blocks.map(b => b.dat.length));
    for (let i = 0; i < maxDat; i++) for (let b = 0; b < numBlocks; b++) if (i < blocks[b].dat.length) result.push(blocks[b].dat[i]);
    for (let i = 0; i < eccPerBlock; i++) for (let b = 0; b < numBlocks; b++) result.push(blocks[b].ecc[i]);
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunc = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, d) => { if (x >= 0 && x < size && y >= 0 && y < size) { modules[y][x] = d; isFunc[y][x] = true; } };
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); setF(cx + dx, cy + dy, d !== 2 && d !== 4); } };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const alignPos = alignmentPositions(ver, size);
    for (const ay of alignPos) for (const ax of alignPos) {
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    setF(8, size - 8, true);
    for (let i = 0; i <= 8; i++) { setF(8, i, false); setF(i, 8, false); }
    for (let i = 0; i < 8; i++) { setF(size - 1 - i, 8, false); setF(8, size - 1 - i, false); }
    if (ver >= 7) for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, b = Math.floor(i / 3); setF(a, b, false); setF(b, a, false); }
    const allBits = [];
    for (const cw of result) for (let i = 7; i >= 0; i--) allBits.push((cw >>> i) & 1);
    let bitIdx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!isFunc[y][x] && bitIdx < allBits.length) { modules[y][x] = allBits[bitIdx] === 1; bitIdx++; }
      }
    }
    let bestPenalty = Infinity, bestModules = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = modules.map(r => r.slice());
      applyMask(m, isFunc, mask, size);
      drawFormat(m, FMT[eclName || 'M'], mask, size);
      if (ver >= 7) drawVersion(m, ver, size);
      const p = penalty(m, size);
      if (p < bestPenalty) { bestPenalty = p; bestModules = m; }
    }
    return { size, modules: bestModules };

    function alignmentPositions(v, sz) {
      if (v === 1) return [];
      const num = Math.floor(v / 7) + 2;
      const step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (num * 2 - 2)) * 2;
      const pos = [6];
      for (let p = sz - 7; pos.length < num; p -= step) pos.splice(1, 0, p);
      return pos;
    }
    function applyMask(m, fn, mask, sz) {
      for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
        if (fn[y][x]) continue;
        let inv = false;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (inv) m[y][x] = !m[y][x];
      }
    }
    function drawFormat(m, ec, mask, sz) {
      const data = ec << 3 | mask;
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bF = (data << 10 | rem) ^ 0x5412, get = i => (bF >>> i) & 1;
      for (let i = 0; i <= 5; i++) m[i][8] = get(i) === 1;
      m[7][8] = get(6) === 1; m[8][8] = get(7) === 1; m[8][7] = get(8) === 1;
      for (let i = 9; i < 15; i++) m[8][14 - i] = get(i) === 1;
      for (let i = 0; i < 8; i++) m[8][sz - 1 - i] = get(i) === 1;
      for (let i = 8; i < 15; i++) m[sz - 15 + i][8] = get(i) === 1;
      m[sz - 8][8] = true;
    }
    function drawVersion(m, v, sz) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bV = v << 12 | rem;
      for (let i = 0; i < 18; i++) { const bit = ((bV >>> i) & 1) === 1, a = sz - 11 + i % 3, b = Math.floor(i / 3); m[b][a] = bit; m[a][b] = bit; }
    }
    function penalty(m, sz) {
      let p = 0;
      for (let y = 0; y < sz; y++) { let run = 1; for (let x = 1; x < sz; x++) { if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (let x = 0; x < sz; x++) { let run = 1; for (let y = 1; y < sz; y++) { if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (let y = 0; y < sz - 1; y++) for (let x = 0; x < sz - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      let dark = 0; for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) if (m[y][x]) dark++;
      p += Math.floor(Math.abs(dark / (sz * sz) * 20 - 10)) * 10;
      return p;
    }
    function rsGenerator(deg) {
      const res = new Array(deg).fill(0); res[deg - 1] = 1; let root = 1;
      for (let i = 0; i < deg; i++) {
        for (let j = 0; j < res.length; j++) { res[j] = gfMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
        root = gfMul(root, 0x02);
      }
      return res;
    }
    function rsRemainder(data, g) {
      const res = new Array(g.length).fill(0);
      for (const b of data) { const factor = b ^ res.shift(); res.push(0); for (let i = 0; i < g.length; i++) res[i] ^= gfMul(g[i], factor); }
      return res;
    }
    function gfMul(a, b) {
      let z = 0;
      for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((b >>> i) & 1) * a; }
      return z & 0xFF;
    }
  }
  // SVG compacto (um único <path>). px = tamanho total em px; quiet = margem em módulos.
  function svg(text, opts) {
    opts = opts || {};
    const ecl = opts.ecl || 'M', quiet = opts.quiet == null ? 4 : opts.quiet, px = opts.px || 96;
    let qr;
    try { qr = generate(text, ecl); } catch (e) { return ''; }
    const dim = qr.size + quiet * 2;
    let d = '';
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) d += 'M' + (x + quiet) + ',' + (y + quiet) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR de validação">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/>' +
      '<path d="' + d + '" fill="#000"/></svg>';
  }
  return { generate, svg };
})();
