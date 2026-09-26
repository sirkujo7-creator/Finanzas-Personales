/* Intérprete de movimientos en lenguaje natural (funciona sin internet).
   Ejemplos: "almuerzo 15 mil nequi", "gasolina 40k ayer", "salario 3,2 millones",
   "pagué tarjeta 500 mil desde bancolombia", "retiré 200 mil del banco". */
(function (g) {
  'use strict';
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const CAT_WORDS = {
    'Mercado': ['mercado', 'supermercado', 'd1', 'ara', 'exito', 'olimpica', 'tienda', 'verdura', 'verduras', 'fruta', 'frutas', 'carne', 'pan', 'huevos', 'leche', 'mercar'],
    'Comidas fuera': ['almuerzo', 'desayuno', 'cena', 'comida', 'restaurante', 'cafe', 'tinto', 'empanada', 'empanadas', 'domicilio', 'rappi', 'hamburguesa', 'pizza', 'helado', 'onces', 'corrientazo', 'postre', 'jugo'],
    'Transporte': ['gasolina', 'tanqueo', 'tanquear', 'taxi', 'bus', 'buseta', 'uber', 'didi', 'indriver', 'peaje', 'peajes', 'parqueadero', 'soat', 'taller', 'aceite', 'llanta', 'llantas', 'moto', 'tecnomecanica', 'pasaje', 'pasajes', 'mecanico', 'repuesto', 'repuestos', 'lavada'],
    'Vivienda': ['arriendo', 'administracion', 'arrendamiento'],
    'Servicios': ['luz', 'agua', 'gas', 'internet', 'celular', 'energia', 'recibo', 'servicios', 'claro', 'movistar', 'tigo', 'wom'],
    'Salud': ['drogueria', 'medicina', 'medicinas', 'medicamento', 'medicamentos', 'cita', 'eps', 'farmacia', 'odontologo', 'medico', 'examen', 'examenes'],
    'Educación': ['libro', 'libros', 'universidad', 'matricula', 'curso', 'semestre', 'fotocopias', 'colegio', 'cuaderno', 'cuadernos'],
    'Ocio': ['cine', 'cerveza', 'cervezas', 'fiesta', 'viaje', 'paseo', 'concierto', 'rumba', 'trago', 'tragos', 'bar', 'hotel'],
    'Ropa': ['ropa', 'zapatos', 'camisa', 'tenis', 'pantalon', 'chaqueta', 'camiseta'],
    'Suscripciones': ['netflix', 'spotify', 'suscripcion', 'youtube', 'icloud', 'gemini', 'claude', 'chatgpt', 'disney', 'prime', 'hbo', 'max'],
    'Deudas': ['cuota', 'prestamo', 'credito', 'abono', 'deuda'],
    'Impuestos': ['impuesto', 'impuestos', 'predial', 'dian', 'renta', 'multa', 'comparendo'],
    'Regalos': ['regalo', 'regalos', 'detalle', 'cumpleanos']
  };
  const INC_WORDS = {
    'Salario': ['salario', 'sueldo', 'nomina', 'quincena'],
    'Prima': ['prima'],
    'Cesantías': ['cesantias'],
    'Ingreso variable': ['clase', 'clases', 'honorarios', 'venta', 'vendi', 'freelance', 'proyecto', 'asesoria', 'tutoria', 'pagaron', 'recibi', 'bono', 'extra'],
    'Otros ingresos': ['ingreso', 'reembolso', 'devolucion', 'regalaron']
  };
  const MULT = { millones: 1e6, millon: 1e6, palos: 1e6, palo: 1e6, mil: 1e3, k: 1e3, lucas: 1e3, luca: 1e3, barras: 1e3, barra: 1e3 };
  const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function parseDate(t, now) {
    const d = new Date(now); d.setHours(12, 0, 0, 0);
    let m;
    if ((m = t.match(/\b(antier|anteayer|antes de ayer)\b/))) { d.setDate(d.getDate() - 2); return { iso: iso(d), hit: m[0] }; }
    if ((m = t.match(/\bayer\b/))) { d.setDate(d.getDate() - 1); return { iso: iso(d), hit: m[0] }; }
    if ((m = t.match(/\bhoy\b/))) return { iso: iso(d), hit: m[0] };
    if ((m = t.match(/\bhace (\d{1,2}) dias?\b/))) { d.setDate(d.getDate() - +m[1]); return { iso: iso(d), hit: m[0] }; }
    if ((m = t.match(/\b(?:el )?(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/))) {
      const diff = (d.getDay() - DAYS.indexOf(m[1]) + 7) % 7; d.setDate(d.getDate() - diff); return { iso: iso(d), hit: m[0] };
    }
    if ((m = t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/))) {
      let y = m[3] ? +m[3] : d.getFullYear(); if (y < 100) y += 2000;
      const x = new Date(y, +m[2] - 1, +m[1], 12);
      if (!m[3] && x > d) x.setFullYear(y - 1);
      if (!isNaN(x) && x.getDate() === +m[1]) return { iso: iso(x), hit: m[0] };
    }
    return null;
  }

  function toNumber(s) {
    s = s.replace(/[.,]+$/, '');
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return +s.replace(/[.,]/g, '');
    return parseFloat(s.replace(',', '.'));
  }

  function parseAmount(t) {
    const re = /(\d[\d.,]*)(?:\s*(millones|millon|palos|palo|mil|k|lucas|luca|barras|barra))?/g;
    const found = []; let m;
    while ((m = re.exec(t))) {
      const prev = t[m.index - 1] || ' ';
      const next = t[m.index + m[0].length] || ' ';
      if (/[a-z]/.test(prev)) continue;              // "d1"
      if (m[2] && /[a-z]/.test(next)) continue;      // "kilos"
      if (!m[2] && /[a-z]/.test(next)) continue;
      const v = toNumber(m[1]);
      if (isNaN(v) || v <= 0) continue;
      found.push({ v, unit: m[2] || '', hit: m[0].trim() });
    }
    if (!found.length) return null;
    const a = found[0];
    let value = a.v * (MULT[a.unit] || 1), hits = [a.hit], assumed = false;
    if (MULT[a.unit] === 1e6 && found[1]) {
      const b = found[1];
      if (MULT[b.unit] === 1e3) { value += b.v * 1e3; hits.push(b.hit); }
      else if (!b.unit && b.v < 1000) { value += b.v * 1e3; hits.push(b.hit); }
    }
    if (!a.unit && value < 1000) { value *= 1000; assumed = true; }
    return { value: Math.round(value), hits, assumed };
  }

  function firstWord(tokens, dict) {
    let best = null, bestPos = Infinity;
    for (const [cat, words] of Object.entries(dict)) {
      for (const w of words) {
        const p = tokens.indexOf(w);
        if (p >= 0 && p < bestPos) { best = cat; bestPos = p; }
      }
    }
    return best;
  }

  function findAccounts(t, accounts) {
    const hits = [];
    for (const a of accounts) {
      const n = norm(a.name).trim();
      if (!n) continue;
      let i = t.indexOf(n);
      if (i < 0) {
        for (const w of n.split(/\s+/)) {
          if (w.length < 4) continue;
          const r = new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
          const mm = t.match(r); if (mm) { i = mm.index; break; }
        }
      }
      if (i >= 0) hits.push({ a, i, len: n.length });
    }
    const generic = [
      [/\b(efectivo|cash|billetes?)\b/, 'efectivo'],
      [/\b(tarjeta|tc|visa|mastercard)\b/, 'credito'],
      [/\b(banco|cuenta)\b/, 'banco']
    ];
    for (const [re, type] of generic) {
      const mm = t.match(re);
      if (mm && !hits.some(h => h.a.type === type)) {
        const a = accounts.find(x => x.type === type);
        if (a) hits.push({ a, i: mm.index, len: mm[0].length });
      }
    }
    return hits.sort((x, y) => x.i - y.i);
  }

  function parse(text, accounts, now) {
    accounts = accounts || []; now = now || new Date();
    const raw = String(text || '');
    let t = ' ' + norm(raw) + ' ';
    const out = { type: null, amount: null, category: null, accountId: null, toAccountId: null, date: null, note: '', assumed: false };

    const dt = parseDate(t, now);
    if (dt) { out.date = dt.iso; t = t.replace(dt.hit, ' '); }

    const am = parseAmount(t);
    if (am) { out.amount = am.value; out.assumed = am.assumed; }

    const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
    const accs = findAccounts(t, accounts);
    const credit = accounts.find(a => a.type === 'credito');
    const liquid = accounts.filter(a => a.type !== 'credito');

    const payCard = /\b(pago|pague|abono|abone)\b/.test(t) && /\b(tarjeta|tc)\b/.test(t) && credit;
    const withdraw = /\b(retire|retiro|saque)\b/.test(t);
    const moveWord = /\b(pase|paso|transferi|transferencia|traslade|traslado|movi)\b/.test(t);

    if (payCard) {
      out.type = 'transfer';
      const cardHit = accs.find(h => h.a.type === 'credito');
      out.toAccountId = cardHit ? cardHit.a.id : credit.id;
      const from = accs.find(h => h.a.type !== 'credito');
      out.accountId = from ? from.a.id : (liquid.find(a => a.type === 'banco') || liquid[0] || {}).id || null;
    } else if (withdraw) {
      out.type = 'transfer';
      const cash = accounts.find(a => a.type === 'efectivo');
      const from = accs.find(h => h.a.type !== 'efectivo');
      out.accountId = from ? from.a.id : (accounts.find(a => a.type === 'banco') || {}).id || null;
      out.toAccountId = cash ? cash.id : null;
    } else if (moveWord || accs.length >= 2) {
      out.type = 'transfer';
      const toHit = accs.find(h => /\b(a|al|hacia|para)\s*$/.test(t.slice(0, h.i)));
      const to = toHit || accs[accs.length - 1];
      const from = accs.find(h => h !== to);
      out.accountId = from ? from.a.id : null;
      out.toAccountId = to ? to.a.id : null;
    } else {
      const inc = firstWord(tokens, INC_WORDS) || (/\bme pagaron\b/.test(t) ? 'Ingreso variable' : null);
      if (inc) { out.type = 'ingreso'; out.category = inc; }
      else { out.type = 'gasto'; out.category = firstWord(tokens, CAT_WORDS); }
      if (accs[0]) out.accountId = accs[0].a.id;
    }

    // Nota legible a partir del texto original
    let note = raw;
    note = note.replace(/\d{1,2}[\/-]\d{1,2}([\/-]\d{2,4})?/g, ' ');
    note = note.replace(/\b(hoy|ayer|antier|anteayer|antes de ayer|hace\s+\d+\s+d[ií]as?|(el\s+)?(lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo))\b/gi, ' ');
    note = note.replace(/\d[\d.,]*(\s*(millones|millón|millon|palos?|mil|k|lucas?|barras?)\b)?/gi, (m, _a, _b, off, str) => /[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(str[off - 1] || '') ? m : ' ');
    for (const h of accs) note = note.replace(new RegExp(h.a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
    const FILL = new Set(['en', 'de', 'del', 'con', 'por', 'el', 'la', 'los', 'las', 'al', 'a', 'desde', 'hacia', 'para', 'pesos', 'pague', 'gaste', 'compre', 'efectivo', 'cash']);
    note = note.split(/\s+/).filter(w => w && !FILL.has(norm(w).replace(/[^a-z0-9]/g, ''))).join(' ').trim();
    out.note = note ? note.charAt(0).toUpperCase() + note.slice(1) : '';
    return out;
  }

  g.Parser = { parse, norm };
})(typeof window !== 'undefined' ? window : globalThis);
