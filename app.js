/* Finanzas Personales — Fase 1
   Base: patrón de acceso, cuentas, registro rápido, movimientos fijos,
   4x1000, "¿cuánto puedo gastar hoy?" y respaldo. Datos solo en este dispositivo. */
(() => {
'use strict';

const VERSION = '4.0.0 (fase 4: Drive)';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayISO = () => iso(new Date());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const money = n => COP.format(Math.round(n || 0));
const monthFmt = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
const shortFmt = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' });

const CATS = {
  gasto: ['Mercado', 'Comidas fuera', 'Transporte', 'Vivienda', 'Servicios', 'Salud', 'Educación', 'Ocio', 'Ropa', 'Suscripciones', 'Deudas', 'Impuestos', 'Regalos', 'Otros gastos'],
  ingreso: ['Salario', 'Prima', 'Cesantías', 'Ingreso variable', 'Otros ingresos']
};
const FIXED_INCOME = ['Salario', 'Prima', 'Cesantías'];
const ACC_TYPES = { banco: 'Cuenta bancaria', billetera: 'Billetera digital', efectivo: 'Efectivo', credito: 'Tarjeta de crédito' };
const TYPE_LABEL = { gasto: 'Gasto', ingreso: 'Ingreso', transfer: 'Transferencia' };
const FREQ_LABEL = { mensual: 'Cada mes', quincenal: 'Cada quincena', semanal: 'Cada semana' };

/* ---------- Almacenamiento (IndexedDB, con respaldo en localStorage) ---------- */
const Store = {
  db: null,
  open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('finanzas-personales', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch (e) { res(); }
    });
  },
  get(k) {
    if (!this.db) { const v = localStorage.getItem(k); return Promise.resolve(v ? JSON.parse(v) : null); }
    return new Promise(res => {
      const q = this.db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result ?? null); q.onerror = () => res(null);
    });
  },
  set(k, v) {
    if (!this.db) { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
};

const blank = () => ({ v: 2, accounts: [], txs: [], recurring: [], budgets: {}, lessons: [], debts: [], goals: [], settings: { ipc: 6.24, ipcDate: 'agosto 2026, DANE', usura: null, lock: null, fails: 0, lockUntil: 0, lastBackup: null, lastAcc: null } });
let S = null;
const save = () => {
  if (typeof D !== 'undefined' && D.connected) { D.dirty = true; driveSave(); scheduleDrive(); }
  return Store.set('state', S).catch(() => toast('No se pudo guardar. Revisa el espacio del celular.'));
};

/* ---------- Cálculos ---------- */
const accById = id => S.accounts.find(a => a.id === id);
const accName = id => (accById(id) || {}).name || 'Cuenta eliminada';

function calcGmf(accountId, type, amount) {
  const a = accById(accountId);
  if (!a || !a.gmf || a.type === 'credito') return 0;
  return (type === 'gasto' || type === 'transfer') ? Math.round(amount * 0.004) : 0;
}

function accBalance(a) {
  let b = a.initial || 0;
  for (const t of S.txs) {
    if (t.accountId === a.id) b += t.type === 'ingreso' ? t.amount : -(t.amount + (t.gmf || 0));
    if (t.type === 'transfer' && t.toAccountId === a.id) b += t.amount;
  }
  return b;
}

function totals() {
  let liquid = 0, debt = 0;
  for (const a of S.accounts) {
    const b = accBalance(a);
    if (a.type === 'credito') debt += -b; else liquid += b;
  }
  return { liquid, debt, net: liquid - debt };
}

function monthRange(y, m) {
  const last = new Date(y, m + 1, 0).getDate();
  return [`${y}-${pad2(m + 1)}-01`, `${y}-${pad2(m + 1)}-${pad2(last)}`, last];
}

function monthStats(y, m) {
  const [a, b] = monthRange(y, m);
  let inc = 0, incFix = 0, exp = 0, gmf = 0; const byCat = {};
  for (const t of S.txs) {
    if (t.date < a || t.date > b) continue;
    if (t.type === 'ingreso') { inc += t.amount; if (FIXED_INCOME.includes(t.category)) incFix += t.amount; }
    else if (t.type === 'gasto') { exp += t.amount; byCat[t.category] = (byCat[t.category] || 0) + t.amount; }
    gmf += t.gmf || 0;
  }
  if (gmf) byCat['4x1000'] = (byCat['4x1000'] || 0) + gmf;
  return { inc, incFix, incVar: inc - incFix, exp: exp + gmf, gmf, byCat };
}

/* Movimientos fijos: mensual (mismo día), quincenal (15 y fin de mes), semanal */
function nextAfter(r, dateISO) {
  const d = parseISO(dateISO);
  if (r.freq === 'semanal') { d.setDate(d.getDate() + 7); return iso(d); }
  if (r.freq === 'quincenal') {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    if (d.getDate() < 15) return iso(new Date(d.getFullYear(), d.getMonth(), 15, 12));
    if (d.getDate() < last) return iso(new Date(d.getFullYear(), d.getMonth(), last, 12));
    return iso(new Date(d.getFullYear(), d.getMonth() + 1, 15, 12));
  }
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const last = new Date(y, m + 1, 0).getDate();
  return iso(new Date(y, m, Math.min(r.day || d.getDate(), last), 12));
}

function runRecurring() {
  const t = todayISO(); let n = 0;
  for (const r of S.recurring) {
    if (!r.active || !accById(r.accountId)) continue;
    let guard = 0;
    while (r.next <= t && guard++ < 60) {
      S.txs.push({ id: uid(), date: r.next, type: r.type, amount: r.amount, category: r.category, accountId: r.accountId,
        note: r.name, recurringId: r.id, gmf: calcGmf(r.accountId, r.type, r.amount) });
      r.next = nextAfter(r, r.next); n++;
    }
  }
  return n;
}

function upcoming(untilISO) {
  const t = todayISO(), list = [];
  for (const r of S.recurring) {
    if (!r.active) continue;
    let d = r.next, g = 0;
    while (d <= untilISO && g++ < 40) { if (d > t) list.push({ r, date: d }); d = nextAfter(r, d); }
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- Motor de decisiones (fase 2) ---------- */
const FREQ_FACTOR = { mensual: 1, quincenal: 2, semanal: 52 / 12 };
const SMALL_EXPENSE = 20000;

function monthlyFixed(type, filter) {
  return S.recurring.filter(r => r.active && r.type === type && (!filter || filter(r)))
    .reduce((s, r) => s + r.amount * (FREQ_FACTOR[r.freq] || 1), 0);
}

function avgMonthly(n = 3) {
  const now = new Date(); const rows = [];
  for (let i = 1; i <= 12 && rows.length < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const [a, b] = monthRange(d.getFullYear(), d.getMonth());
    if (!S.txs.some(t => t.date >= a && t.date <= b)) continue;
    rows.push({ ...monthStats(d.getFullYear(), d.getMonth()), y: d.getFullYear(), m: d.getMonth() });
  }
  if (!rows.length) return null;
  const byCat = {};
  rows.forEach(r => Object.entries(r.byCat).forEach(([c, v]) => byCat[c] = (byCat[c] || 0) + v / rows.length));
  return { n: rows.length, inc: rows.reduce((s, r) => s + r.inc, 0) / rows.length, exp: rows.reduce((s, r) => s + r.exp, 0) / rows.length, byCat, last: rows[0] };
}

function daily() {
  const now = new Date(), [, end, last] = monthRange(now.getFullYear(), now.getMonth());
  const { liquid } = totals();
  const pend = upcoming(end);
  const pendExp = pend.filter(p => p.r.type === 'gasto' && (accById(p.r.accountId) || {}).type !== 'credito')
    .reduce((s, p) => s + p.r.amount + calcGmf(p.r.accountId, 'gasto', p.r.amount), 0);
  const pendInc = pend.filter(p => p.r.type === 'ingreso').reduce((s, p) => s + p.r.amount, 0);
  const daysLeft = last - now.getDate() + 1;
  const reserved = Math.min(goalsReserved(), Math.max(0, liquid));
  const avail = liquid - pendExp - reserved;
  return { avail, perDay: avail / daysLeft, daysLeft, pendExp, pendInc, reserved };
}

function budgetRows(y, m) {
  const st = monthStats(y, m);
  const now = new Date(), [, , last] = monthRange(y, m);
  const isCur = y === now.getFullYear() && m === now.getMonth();
  const day = isCur ? now.getDate() : last;
  return Object.entries(S.budgets).filter(([, v]) => v > 0).map(([cat, limit]) => {
    const spent = st.byCat[cat] || 0;
    const projected = isCur && day >= 5 ? spent / day * last : spent;
    return { cat, limit, spent, projected, left: limit - spent, daysLeft: last - day + 1, pct: spent / limit };
  }).sort((a, b) => b.pct - a.pct);
}

function lessonHits(t, l) {
  if (t.type !== 'gasto' || (!l.category && !l.keyword)) return false;
  if (l.category && t.category !== l.category) return false;
  if (l.keyword && !Parser.norm(t.note || '').includes(Parser.norm(l.keyword))) return false;
  return t.amount >= (l.minAmount || 0);
}

function alerts() {
  const out = [];
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const [a, b] = monthRange(y, m);
  const st = monthStats(y, m);
  const dl = daily();

  S.accounts.filter(x => x.type !== 'credito').forEach(x => {
    const bal = accBalance(x);
    if (bal < 0) out.push({ lv: 'bad', t: `${x.name} está en negativo (${money(bal)}). Revisa si falta registrar un ingreso o si hay un sobregiro.` });
  });
  if (dl.avail < 0) out.push({ lv: 'bad', t: `Tus pagos fijos pendientes superan tu dinero disponible en ${money(-dl.avail)}. Aplaza gastos no esenciales hasta que llegue tu ingreso.` });

  budgetRows(y, m).forEach(r => {
    if (r.spent > r.limit) out.push({ lv: 'bad', t: `Te pasaste en ${r.cat} por ${money(r.spent - r.limit)} (límite ${money(r.limit)}).` });
    else if (r.projected > r.limit * 1.05) out.push({ lv: 'warn', t: `A este ritmo, ${r.cat} cerrará el mes en ${money(r.projected)}, ${money(r.projected - r.limit)} por encima del límite. Te quedan ${money(r.left)} para ${r.daysLeft} días.` });
    else if (r.pct >= 0.8) out.push({ lv: 'warn', t: `Ya usaste el ${Math.round(r.pct * 100)}% de tu límite en ${r.cat}. Quedan ${money(r.left)}.` });
  });

  const fixInc = monthlyFixed('ingreso');
  const planned = Object.values(S.budgets).reduce((s, v) => s + (v || 0), 0) + monthlyFixed('gasto', r => !S.budgets[r.category]);
  if (fixInc && planned > fixInc) out.push({ lv: 'warn', t: `Tu plan de gastos (${money(planned)}) supera tu ingreso fijo (${money(fixInc)}). Estás contando con ingresos variables que no son seguros.` });

  const cuotas = monthlyFixed('gasto', r => r.category === 'Deudas');
  if (fixInc && cuotas / fixInc > 0.4) out.push({ lv: 'bad', t: `Tus cuotas de deuda son el ${Math.round(cuotas / fixInc * 100)}% de tu ingreso fijo. Por encima del 40% es riesgoso tomar nuevos créditos.` });

  const small = S.txs.filter(t => t.type === 'gasto' && !t.recurringId && t.date >= a && t.date <= b && t.amount <= SMALL_EXPENSE);
  const smallSum = small.reduce((s, t) => s + t.amount, 0);
  const ref = fixInc || st.inc;
  if (small.length >= 6 && (ref ? smallSum >= ref * 0.08 : smallSum >= 150000))
    out.push({ lv: 'warn', t: `${small.length} gastos pequeños este mes suman ${money(smallSum)}${ref ? `, el ${Math.round(smallSum / ref * 100)}% de tu ingreso` : ''}. Son los más fáciles de recortar.` });

  S.accounts.filter(x => x.type !== 'efectivo' && S.txs.some(t => t.accountId === x.id) && (!x.reconciled || (Date.now() - parseISO(x.reconciled)) / 864e5 > 35))
    .slice(0, 1).forEach(x => out.push({ lv: 'warn', t: `${x.reconciled ? 'Hace más de un mes que no concilias' : 'Aún no has conciliado'} ${x.name}. Compara con el saldo real del banco (en Cuentas).` }));
  S.lessons.forEach(l => {
    const hits = S.txs.filter(t => t.date >= a && t.date <= b && t.date >= l.created && lessonHits(t, l));
    if (hits.length) out.push({ lv: 'bad', t: `Repetiste una lección ${hits.length === 1 ? 'una vez' : hits.length + ' veces'} este mes: "${l.text}". Suma ${money(hits.reduce((s, t) => s + t.amount, 0))}.` });
  });

  return out.sort((x, y2) => (x.lv === 'bad' ? 0 : 1) - (y2.lv === 'bad' ? 0 : 1));
}

function health() {
  const avg = avgMonthly(3);
  const { liquid, debt } = totals();
  const fixInc = monthlyFixed('ingreso');
  const fixExp = monthlyFixed('gasto');
  const incRef = fixInc || (avg && avg.inc) || 0;
  const expRef = (avg && avg.exp) || fixExp || 0;
  const lv = (v, ok, warn, higherBetter) => v == null ? 'na' : higherBetter ? (v >= ok ? 'ok' : v >= warn ? 'warn' : 'bad') : (v <= ok ? 'ok' : v <= warn ? 'warn' : 'bad');
  const pct = v => Math.round(v * 100) + '%';
  const list = [];

  const src = avg ? avg.last : null;
  const rate = src && src.inc ? (src.inc - src.exp) / src.inc : null;
  list.push({ name: 'Tasa de ahorro', val: rate == null ? 'Sin datos' : pct(rate), lv: lv(rate, 0.2, 0.1, true),
    why: rate == null ? 'Se calcula al cerrar tu primer mes completo.' : 'Del último mes cerrado. Lo sano es ahorrar al menos el 20% de lo que ganas.' });

  const months = expRef ? liquid / expRef : null;
  list.push({ name: 'Fondo de emergencia', val: months == null ? 'Sin datos' : `${months.toFixed(1)} meses`, lv: lv(months, 6, 3, true),
    why: 'Cuántos meses podrías vivir con tu dinero disponible si dejaras de recibir ingresos. La meta es entre 3 y 6.' });

  const cuotas = monthlyFixed('gasto', r => r.category === 'Deudas');
  const load = fixInc ? cuotas / fixInc : null;
  list.push({ name: 'Carga de deudas', val: load == null ? 'Sin datos' : pct(load), lv: lv(load, 0.3, 0.4, false),
    why: 'Cuotas fijas de deuda frente a tu ingreso fijo. Por debajo del 30% es sano; por encima del 40%, riesgoso.' });

  const cardRatio = incRef ? debt / incRef : null;
  list.push({ name: 'Deuda en tarjetas', val: cardRatio == null ? 'Sin datos' : pct(cardRatio) + ' del ingreso', lv: debt <= 0 ? 'ok' : lv(cardRatio, 0.3, 0.6, false),
    why: 'Lo que debes en tarjetas frente a un mes de ingresos. Es la deuda más cara: conviene pagarla completa cada mes.' });

  const fixedShare = fixInc ? fixExp / fixInc : null;
  list.push({ name: 'Gastos fijos', val: fixedShare == null ? 'Sin datos' : pct(fixedShare) + ' del ingreso', lv: lv(fixedShare, 0.5, 0.7, false),
    why: 'Pagos que no puedes evitar cada mes. Por debajo del 50% te deja margen para ahorrar y reaccionar.' });

  return { list, fixInc, avg };
}

/* ---------- Utilidades de interfaz ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
function openSheet(html) {
  $('#sheetBody').innerHTML = html; $('#sheet').hidden = false; $('#sheetBody').scrollTop = 0;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function bindAmount(el, init) {
  let v = Math.round(init || 0);
  const show = () => { el.value = v ? v.toLocaleString('es-CO') : ''; };
  el.addEventListener('input', () => { v = +el.value.replace(/\D/g, '') || 0; show(); el.dispatchEvent(new Event('amount')); });
  show();
  return { get: () => v, set: n => { v = Math.round(n) || 0; show(); el.dispatchEvent(new Event('amount')); } };
}
const options = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
const accOptions = (sel, filter) => options(S.accounts.filter(filter || (() => true)).map(a => [a.id, a.name]), sel);
const dayLabel = s => { const t = todayISO(); const y = new Date(); y.setDate(y.getDate() - 1);
  return s === t ? 'Hoy' : s === iso(y) ? 'Ayer' : dayFmt.format(parseISO(s)); };
function defaultAccount() {
  const last = S.settings.lastAcc && accById(S.settings.lastAcc);
  return (last || S.accounts.find(a => a.type !== 'credito') || S.accounts[0] || {}).id || '';
}

/* ---------- Patrón de acceso ---------- */
async function hashPattern(seq, salt) {
  const text = salt + ':' + seq.join('-');
  if (window.crypto && crypto.subtle) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return 'x' + (h >>> 0).toString(16);
}

function patternPad(el, onDone) {
  const P = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P.push({ x: 50 + c * 100, y: 50 + r * 100 });
  el.innerHTML = `<svg viewBox="0 0 300 300" class="pad" role="img" aria-label="Cuadrícula de patrón de 3 por 3">
    <polyline points=""/><line x1="0" y1="0" x2="0" y2="0" visibility="hidden"/>
    ${P.map((p, i) => `<circle class="ring" cx="${p.x}" cy="${p.y}" r="28"/><circle class="dot" data-i="${i}" cx="${p.x}" cy="${p.y}" r="10"/>`).join('')}</svg>`;
  const svg = $('svg', el), pl = $('polyline', svg), live = $('line', svg), dots = $$('.dot', svg);
  let seq = [], down = false, busy = false;
  const loc = e => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * 300 / r.width, y: (e.clientY - r.top) * 300 / r.height }; };
  const draw = () => {
    pl.setAttribute('points', seq.map(i => `${P[i].x},${P[i].y}`).join(' '));
    dots.forEach((d, i) => d.classList.toggle('on', seq.includes(i)));
  };
  const hit = p => P.forEach((q, i) => {
    if (seq.includes(i) || Math.hypot(p.x - q.x, p.y - q.y) > 34) return;
    if (seq.length) {
      const a = P[seq[seq.length - 1]];
      const mid = P.findIndex(z => z.x === (a.x + q.x) / 2 && z.y === (a.y + q.y) / 2);
      if (mid >= 0 && !seq.includes(mid)) seq.push(mid);
    }
    seq.push(i); draw();
    if (navigator.vibrate) navigator.vibrate(8);
  });
  svg.addEventListener('pointerdown', e => { if (busy) return; down = true; seq = []; draw(); svg.setPointerCapture(e.pointerId); hit(loc(e)); });
  svg.addEventListener('pointermove', e => {
    if (!down) return; const p = loc(e); hit(p);
    if (seq.length) { const a = P[seq[seq.length - 1]];
      live.setAttribute('x1', a.x); live.setAttribute('y1', a.y); live.setAttribute('x2', p.x); live.setAttribute('y2', p.y); live.setAttribute('visibility', 'visible'); }
  });
  const end = () => { if (!down) return; down = false; live.setAttribute('visibility', 'hidden'); if (seq.length) onDone(seq.slice()); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  return {
    reset() { seq = []; draw(); },
    error() { busy = true; svg.classList.add('err'); setTimeout(() => { svg.classList.remove('err'); busy = false; seq = []; draw(); }, 650); }
  };
}

let lockTimer;
const setMsg = m => { const el = $('#lockMsg'); if (el) el.textContent = m; };

function lockScreen(title, msg, onSeq, extra = '') {
  clearInterval(lockTimer); closeSheet();
  const el = $('#lock'); el.hidden = false; $('#app').hidden = true; $('#tabs').hidden = true;
  el.innerHTML = `<h1>${title}</h1><p id="lockMsg">${msg}</p><div id="padWrap"></div>${extra}`;
  const pad = patternPad($('#padWrap'), seq => onSeq(seq, pad));
  return pad;
}

function showSetup(opts = {}) {
  let first = null;
  lockScreen(opts.title || 'Crea tu patrón', 'Une al menos 4 puntos. Lo dibujarás cada vez que abras la app.', async (seq, pad) => {
    if (seq.length < 4) { setMsg('Une al menos 4 puntos.'); pad.error(); return; }
    if (!first) { first = seq.join('-'); setMsg('Dibújalo otra vez para confirmar.'); pad.reset(); return; }
    if (first !== seq.join('-')) { first = null; setMsg('Los patrones no coinciden. Empieza de nuevo.'); pad.error(); return; }
    const salt = uid() + uid();
    S.settings.lock = { salt, hash: await hashPattern(seq, salt) };
    S.settings.fails = 0; S.settings.lockUntil = 0;
    await save(); pad.reset();
    enterApp(opts.returnTo);
    if (opts.done) toast(opts.done);
    else if (!S.accounts.length) accountSheet(null, true);
  }, opts.cancel ? '<button class="link" id="cancelLock">Cancelar</button>' : '');
  if (opts.cancel) $('#cancelLock').onclick = () => enterApp(opts.returnTo);
}

function showUnlock(opts = {}) {
  lockScreen(opts.title || 'Finanzas Personales', 'Dibuja tu patrón', async (seq, pad) => {
    const st = S.settings;
    if (Date.now() < st.lockUntil) { pad.reset(); return; }
    if (await hashPattern(seq, st.lock.salt) === st.lock.hash) {
      st.fails = 0; st.lockUntil = 0; await save(); pad.reset(); clearInterval(lockTimer);
      opts.onOk ? opts.onOk() : enterApp();
    } else {
      st.fails = (st.fails || 0) + 1;
      if (st.fails >= 5) st.lockUntil = Date.now() + Math.min(900, 30 * 2 ** (st.fails - 5)) * 1000;
      await save(); pad.error(); lockMsgTick();
    }
  }, opts.onOk ? '<button class="link" id="cancelLock">Cancelar</button>' : '<button class="link" id="forgot">Olvidé mi patrón</button>');
  if (opts.onOk) $('#cancelLock').onclick = () => enterApp('ajustes');
  else $('#forgot').onclick = forgot;
  lockMsgTick();
}

function lockMsgTick() {
  const st = S.settings; clearInterval(lockTimer);
  const tick = () => {
    const left = Math.ceil((st.lockUntil - Date.now()) / 1000);
    if (left > 0) setMsg(`Demasiados intentos. Espera ${left} s.`);
    else { clearInterval(lockTimer); setMsg(st.fails ? `Patrón incorrecto (${st.fails} ${st.fails === 1 ? 'intento' : 'intentos'}).` : 'Dibuja tu patrón'); }
  };
  tick(); lockTimer = setInterval(tick, 1000);
}

async function forgot() {
  if (!confirm('Por seguridad, el patrón no se puede recuperar. Para continuar hay que borrar los datos de este celular y luego restaurar tu último respaldo desde Drive. ¿Continuar?')) return;
  const w = prompt('Escribe BORRAR para confirmar.');
  if ((w || '').trim().toUpperCase() !== 'BORRAR') return;
  S = blank(); await save();
  showSetup({ done: 'Listo. Restaura tu respaldo en Ajustes.', returnTo: 'ajustes' });
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (S && S.settings.lock && $('#lock').hidden && hiddenAt && Date.now() - hiddenAt > 60000) showUnlock();
});

/* ---------- Navegación ---------- */
let tab = 'inicio';
const view = { y: new Date().getFullYear(), m: new Date().getMonth() };
const TITLES = { inicio: 'Inicio', movs: 'Movimientos', plan: 'Plan', cuentas: 'Cuentas', ajustes: 'Ajustes' };

function enterApp(to) {
  clearInterval(lockTimer);
  $('#lock').hidden = true; $('#lock').innerHTML = ''; $('#app').hidden = false; $('#tabs').hidden = false;
  const n = runRecurring();
  if (n) { save(); toast(`${n} movimiento${n > 1 ? 's' : ''} fijo${n > 1 ? 's' : ''} registrado${n > 1 ? 's' : ''}`); }
  go(to || tab);
  if (driveResume) setTimeout(runDriveResume, 350);
  else if (D.connected && D.dirty) scheduleDrive();
}
function go(t) {
  tab = t; $('#title').textContent = TITLES[t];
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ({ inicio: renderInicio, movs: renderMovs, plan: renderPlan, cuentas: renderCuentas, ajustes: renderAjustes })[t]();
  $('#gear').classList.toggle('on', t === 'ajustes');
  window.scrollTo(0, 0);
}
const refresh = () => go(tab);
$$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
$('#gear').addEventListener('click', () => go('ajustes'));
$('#fab').addEventListener('click', () => S.accounts.length ? entrySheet() : accountSheet(null, true));

/* ---------- Inicio ---------- */
function renderInicio() {
  const v = $('#view');
  if (!S.accounts.length) {
    v.innerHTML = `<div class="empty"><strong>Empieza por tus cuentas</strong><p>Agrega dónde tienes tu dinero: banco, Nequi, efectivo o tarjeta de crédito. Con eso la app calcula cuánto puedes gastar cada día.</p><button class="btn" id="addAcc">Agregar cuenta</button></div>`;
    $('#addAcc').onclick = () => accountSheet(null, true); return;
  }
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const { liquid, debt, net } = totals();
  const { avail, perDay, daysLeft, pendExp, pendInc, reserved } = daily();
  const st = monthStats(y, m);
  const saving = st.inc - st.exp;
  const rate = st.inc ? Math.round(saving / st.inc * 100) : null;

  let notices = '';
  const lb = S.settings.lastBackup;
  const daysSince = lb ? Math.floor((Date.now() - parseISO(lb)) / 864e5) : null;
  const driveAge = D.last ? (Date.now() - new Date(D.last)) / 864e5 : null;
  if (D.connected && D.dirty && !driveOk() && (driveAge === null || driveAge >= 1))
    notices += `<div class="notice"><span>Tienes cambios sin respaldar en Drive. Google pide confirmar tu sesión.</span><button class="btn sm" id="bk">Respaldar</button></div>`;
  else if (!D.connected && S.txs.length >= 5 && (lb === null || daysSince >= 7))
    notices += `<div class="notice"><span>${lb ? `Tu último respaldo fue hace ${daysSince} días.` : 'Aún no tienes un respaldo de tus datos.'} Conecta Google Drive para que se haga solo.</span><button class="btn sm" id="bk">Conectar</button></div>`;

  const heroText = avail >= 0
    ? `<p>Tienes ${money(avail)} para los ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'} que quedan del mes, después de apartar ${money(pendExp)} de pagos fijos${reserved ? ` y ${money(reserved)} para tus metas` : ''}.</p>`
    : `<p>Tus pagos fijos pendientes superan tu dinero disponible en ${money(-avail)}. Revisa qué gasto puedes aplazar.</p>`;

  const al = alerts();
  const cats = Object.entries(st.byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCat = cats.length ? cats[0][1] : 1;
  const next = upcoming(iso(new Date(now.getTime() + 30 * 864e5))).slice(0, 5);

  v.innerHTML = `
    ${notices}
    <section class="hero">
      <p class="q">Puedes gastar hoy</p>
      <div class="big ${perDay < 0 ? 'neg' : ''}">${money(perDay)}</div>
      ${heroText}
      ${pendInc ? `<p>No cuento ${money(pendInc)} de ingresos fijos que aún no llegan.</p>` : ''}
    </section>

    <section class="block">
      <h2>Este mes</h2>
      <div class="row"><span class="l">Ingresos<span class="s">Fijos ${money(st.incFix)}, variables ${money(st.incVar)}</span></span><span class="amt pos">${money(st.inc)}</span></div>
      <div class="row"><span class="l">Gastos${st.gmf ? `<span class="s">Incluye ${money(st.gmf)} de 4x1000</span>` : ''}</span><span class="amt neg">${money(st.exp)}</span></div>
      <div class="row"><span class="l">Te quedó${rate !== null ? `<span class="s">${rate}% de lo que ganaste</span>` : ''}</span><span class="amt ${saving < 0 ? 'neg' : ''}">${money(saving)}</span></div>
      ${st.inc ? `<div class="bar ${st.exp > st.inc ? 'warn' : ''}" title="Gastos frente a ingresos"><i style="width:${Math.min(100, st.exp / st.inc * 100)}%"></i></div>` : ''}
    </section>

    ${al.length ? `<section class="block"><h2>Atención</h2>${al.slice(0, 3).map(alertHTML).join('')}${al.length > 3 ? `<button class="btn ghost sm" id="moreAl" style="margin-top:8px">Ver ${al.length - 3} alertas más</button>` : ''}</section>` : ''}

    ${cats.length ? `<section class="block"><h2>En qué se va el dinero</h2>
      ${cats.map(([c, a]) => `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between;gap:12px"><span>${esc(c)}</span><span class="amt">${money(a)}</span></div><div class="bar"><i style="width:${a / maxCat * 100}%"></i></div></div>`).join('')}
    </section>` : ''}

    ${next.length ? `<section class="block"><h2>Próximos fijos</h2>
      ${next.map(p => `<div class="row"><span class="l">${esc(p.r.name)}<span class="s">${shortFmt.format(parseISO(p.date))}, ${esc(accName(p.r.accountId))}</span></span><span class="amt ${p.r.type === 'ingreso' ? 'pos' : ''}">${p.r.type === 'ingreso' ? '+' : ''}${money(p.r.amount)}</span></div>`).join('')}
    </section>` : ''}

    <section class="block">
      <h2>Lo que tienes</h2>
      <div class="row"><span>Dinero disponible</span><span class="amt">${money(liquid)}</span></div>
      <div class="row"><span>Deuda en tarjetas</span><span class="amt ${debt > 0 ? 'neg' : ''}">${money(debt)}</span></div>
      <div class="row"><span class="strong">Patrimonio neto</span><span class="amt strong">${money(net)}</span></div>
    </section>`;
  if ($('#bk')) $('#bk').onclick = () => D.connected ? driveBackup(false) : driveAuth('connect');
  if ($('#moreAl')) $('#moreAl').onclick = () => go('plan');
}

/* ---------- Movimientos ---------- */
function renderMovs() {
  const v = $('#view');
  const [a, b] = monthRange(view.y, view.m);
  const list = S.txs.filter(t => t.date >= a && t.date <= b).sort((x, y) => y.date.localeCompare(x.date));
  const st = monthStats(view.y, view.m);
  const groups = {}; list.forEach(t => (groups[t.date] = groups[t.date] || []).push(t));
  const isNow = view.y === new Date().getFullYear() && view.m === new Date().getMonth();

  v.innerHTML = `
    <div class="month">
      <button class="iconbtn" id="mPrev" aria-label="Mes anterior">‹</button>
      <strong>${monthFmt.format(new Date(view.y, view.m, 1))}</strong>
      <button class="iconbtn" id="mNext" aria-label="Mes siguiente" ${isNow ? 'disabled style="opacity:.35"' : ''}>›</button>
    </div>
    <div class="sumline"><span>Ingresos <b class="pos">${money(st.inc)}</b></span><span>Gastos <b class="neg">${money(st.exp)}</b></span></div>
    ${list.length ? Object.keys(groups).map(d => `<div class="day">${esc(dayLabel(d))}</div>` + groups[d].map(txRow).join('')).join('')
      : `<div class="empty"><strong>Sin movimientos este mes</strong><p>Toca el botón + para registrar uno. Puedes escribirlo como lo dirías: "almuerzo 15 mil nequi".</p></div>`}
    <section class="block" style="margin-top:30px">
      <h2>Pagos e ingresos fijos</h2>
      <p class="small muted" style="margin:0 0 6px">Se registran solos en su fecha. Así la app descuenta lo que ya está comprometido.</p>
      ${S.recurring.length ? S.recurring.map(r => `<button class="tx" data-rec="${r.id}"><span><span class="t">${esc(r.name)}${r.active ? '' : ' (pausado)'}</span><span class="s">${FREQ_LABEL[r.freq]}, próximo ${shortFmt.format(parseISO(r.next))}</span></span><span class="amt ${r.type === 'ingreso' ? 'pos' : ''}">${r.type === 'ingreso' ? '+' : ''}${money(r.amount)}</span></button>`).join('') : ''}
      <button class="btn ghost wide" id="addRec" style="margin-top:12px">Agregar pago o ingreso fijo</button>
    </section>`;
  $("#mPrev").onclick = () => { view.m--; if (view.m < 0) { view.m = 11; view.y--; } renderMovs(); };
  $("#mNext").onclick = () => { if (isNow) return; view.m++; if (view.m > 11) { view.m = 0; view.y++; } renderMovs(); };
  $$('[data-tx]').forEach(el => el.onclick = () => entrySheet(S.txs.find(t => t.id === el.dataset.tx)));
  $$('[data-rec]').forEach(el => el.onclick = () => recSheet(S.recurring.find(r => r.id === el.dataset.rec)));
  $('#addRec').onclick = () => S.accounts.length ? recSheet() : accountSheet(null, true);
}

function txRow(t) {
  const title = t.note || (t.type === 'transfer' ? 'Transferencia' : t.category);
  let sub, amt, cls = '';
  if (t.type === 'transfer') { sub = `De ${accName(t.accountId)} a ${accName(t.toAccountId)}`; amt = money(t.amount); }
  else if (t.type === 'ingreso') { sub = `${t.category}, en ${accName(t.accountId)}`; amt = '+' + money(t.amount); cls = 'pos'; }
  else { sub = `${t.category}, ${accName(t.accountId)}`; amt = money(t.amount); }
  if (t.gmf) sub += `. 4x1000: ${money(t.gmf)}`;
  if (t.recurringId) sub += '. Fijo';
  return `<button class="tx" data-tx="${t.id}"><span><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span></span><span class="amt ${cls}">${amt}</span></button>`;
}

/* ---------- Hoja: registrar / editar movimiento ---------- */
function entrySheet(tx) {
  const edit = !!tx;
  const d = tx ? { ...tx } : { type: 'gasto', amount: 0, category: '', accountId: defaultAccount(), toAccountId: '', date: todayISO(), note: '' };
  openSheet(`
    <h2>${edit ? 'Editar movimiento' : 'Nuevo movimiento'}</h2>
    ${edit ? '' : `<input class="quick" id="q" placeholder="Escríbelo: almuerzo 15 mil nequi" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" aria-label="Registro rápido"><div class="chips" id="chips"></div>`}
    <div class="seg" id="seg">${Object.entries(TYPE_LABEL).map(([k, l]) => `<button type="button" data-k="${k}">${l}</button>`).join('')}</div>
    <label class="f"><span>Valor</span><input id="amt" class="amount-in" inputmode="numeric" placeholder="$ 0" autocomplete="off"></label>
    <label class="f" id="catWrap"><span>Categoría</span><select id="cat"></select></label>
    <div class="grid2">
      <label class="f" id="accWrap"><span id="accLbl">Cuenta</span><select id="acc">${accOptions(d.accountId)}</select></label>
      <label class="f" id="toWrap"><span>Hacia</span><select id="to">${accOptions(d.toAccountId)}</select></label>
      <label class="f"><span>Fecha</span><input id="date" type="date" value="${d.date}"></label>
      <label class="f"><span>Nota</span><input id="note" value="${esc(d.note)}" autocomplete="off"></label>
    </div>
    ${edit ? '' : `<label class="check"><input type="checkbox" id="fixed"> Se repite (pago o ingreso fijo)</label>
    <label class="f" id="freqWrap" hidden><span>Frecuencia</span><select id="freq">${options(Object.entries(FREQ_LABEL), 'mensual')}</select></label>`}
    <div id="info" class="small" style="margin:0 0 8px;min-height:1.2em"></div>
    ${edit && d.type === 'gasto' ? '<button class="btn ghost wide" id="toLesson" style="margin-bottom:10px">No quiero repetir esto</button>' : ''}
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);

  const amt = bindAmount($('#amt'), d.amount);
  if ($('#toLesson')) $('#toLesson').onclick = () => lessonSheet(null, tx);
  let type = d.type;
  const setCats = sel => { const list = CATS[type] || []; $('#cat').innerHTML = options(list.map(c => [c, c]), sel && list.includes(sel) ? sel : (type === 'gasto' ? 'Otros gastos' : 'Ingreso variable')); };
  const setType = (k, cat) => {
    type = k;
    $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    const tr = k === 'transfer';
    $('#catWrap').hidden = tr; $('#toWrap').hidden = !tr;
    $('#accWrap').classList.toggle('full', !tr);
    $('#accLbl').textContent = tr ? 'Desde' : (k === 'ingreso' ? 'Llega a' : 'Pagado con');
    if (!tr) setCats(cat ?? $('#cat').value);
    info();
  };
  const dl = daily();
  const curMonth = todayISO().slice(0, 7);
  const info = () => {
    const a = amt.get(), acc = $('#acc').value, cat = $('#cat').value, date = $('#date').value || todayISO();
    const g = calcGmf(acc, type, a);
    const lines = [];
    if (g) lines.push(`<p class="muted" style="margin:0 0 4px">Se suman ${money(g)} de 4x1000.</p>`);
    if (type === 'gasto' && a && !edit) {
      const onCard = (accById(acc) || {}).type === 'credito';
      if (dl.perDay > 0 && a > dl.perDay && !onCard) {
        const days = a / dl.perDay;
        lines.push(`<p class="muted" style="margin:0 0 4px">Equivale a ${days < 10 ? days.toFixed(1).replace('.', ',') : Math.round(days)} días de tu gasto diario disponible.</p>`);
      }
      if (onCard) lines.push(`<p class="muted" style="margin:0 0 4px">Con tarjeta: lo pagarás después, y si difieres a cuotas, con intereses.</p>`);
      const lim = S.budgets[cat];
      if (lim && date.slice(0, 7) === curMonth) {
        const spent = monthStats(new Date().getFullYear(), new Date().getMonth()).byCat[cat] || 0;
        const left = lim - spent - a;
        lines.push(left >= 0 ? `<p class="muted" style="margin:0 0 4px">Te quedarían ${money(left)} de ${money(lim)} en ${esc(cat)}.</p>`
          : `<p class="neg" style="margin:0 0 4px">Te pasarías de tu límite en ${esc(cat)} por ${money(-left)}.</p>`);
      }
      const probe = { type, category: cat, note: $('#note').value, amount: a };
      S.lessons.filter(l => lessonHits(probe, l)).forEach(l =>
        lines.push(`<div class="notice bad" style="margin:6px 0"><span><b>Tu lección:</b> ${esc(l.text)}${l.why ? `. ${esc(l.why)}` : ''}</span></div>`));
    }
    $('#info').innerHTML = lines.join('');
  };
  $('#cat').addEventListener('change', () => info());
  $('#note').addEventListener('input', () => info());
  $$('#seg button').forEach(b => b.onclick = () => setType(b.dataset.k));
  $('#acc').onchange = info; $('#amt').addEventListener('amount', info);
  if (!$('#to').value || $('#to').value === $('#acc').value) {
    const alt = S.accounts.find(a => a.id !== $('#acc').value); if (alt) $('#to').value = alt.id;
  }
  setType(type, d.category);

  if (!edit) {
    $('#fixed').onchange = () => { $('#freqWrap').hidden = !$('#fixed').checked; };
    $('#cancel').onclick = closeSheet;
    const q = $('#q');
    q.addEventListener('input', () => {
      const p = Parser.parse(q.value, S.accounts);
      if (p.type) setType(p.type, p.category);
      if (p.amount) amt.set(p.amount);
      if (p.accountId) $('#acc').value = p.accountId;
      if (p.toAccountId) $('#to').value = p.toAccountId;
      if (p.date) $('#date').value = p.date;
      $('#note').value = p.note || '';
      info();
      const chips = [];
      if (q.value.trim()) {
        chips.push(TYPE_LABEL[type]);
        if (p.amount) chips.push(money(p.amount) + (p.assumed ? ' (asumí miles)' : ''));
        if (type !== 'transfer' && p.category) chips.push(p.category);
        if (type === 'transfer' && p.accountId && p.toAccountId) chips.push(`${accName(p.accountId)} a ${accName(p.toAccountId)}`);
        else if (p.accountId) chips.push(accName(p.accountId));
        if (p.date) chips.push(dayLabel(p.date));
      }
      $('#chips').innerHTML = chips.map(c => `<span class="chip">${esc(c)}</span>`).join('');
    });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#save').click(); } });
    setTimeout(() => q.focus(), 80);
  } else {
    $('#del').onclick = async () => {
      if (!confirm('¿Eliminar este movimiento?')) return;
      S.txs = S.txs.filter(t => t.id !== tx.id); await save(); closeSheet(); refresh(); toast('Movimiento eliminado');
    };
  }

  $('#save').onclick = async () => {
    const amount = amt.get(), accountId = $('#acc').value, date = $('#date').value || todayISO();
    if (!amount) { toast('Escribe el valor.'); $('#amt').focus(); return; }
    if (!accountId) { toast('Elige una cuenta.'); return; }
    const toAccountId = type === 'transfer' ? $('#to').value : null;
    if (type === 'transfer' && (!toAccountId || toAccountId === accountId)) { toast('Elige dos cuentas distintas.'); return; }
    const category = type === 'transfer' ? null : $('#cat').value;
    const note = $('#note').value.trim();
    const gmf = calcGmf(accountId, type, amount);
    const today = todayISO();

    if (edit) {
      Object.assign(tx, { type, amount, category, accountId, toAccountId, date, note, gmf });
    } else if ($('#fixed').checked && type !== 'transfer') {
      const r = { id: uid(), name: note || category, type, amount, category, accountId, freq: $('#freq').value, day: parseISO(date).getDate(), active: true, next: date };
      if (date <= today) {
        S.txs.push({ id: uid(), type, amount, category, accountId, toAccountId: null, date, note: r.name, gmf, recurringId: r.id });
        r.next = nextAfter(r, date);
      }
      S.recurring.push(r);
    } else {
      S.txs.push({ id: uid(), type, amount, category, accountId, toAccountId, date, note, gmf });
    }
    S.settings.lastAcc = accountId;
    runRecurring();
    await save(); closeSheet(); refresh();
    toast(date > today && !edit ? 'Programado' : 'Guardado');
  };
}

/* ---------- Hoja: movimiento fijo ---------- */
function recSheet(r) {
  const edit = !!r;
  const d = r ? { ...r } : { name: '', type: 'gasto', amount: 0, category: 'Vivienda', accountId: defaultAccount(), freq: 'mensual', next: todayISO(), active: true };
  openSheet(`
    <h2>${edit ? 'Editar fijo' : 'Nuevo pago o ingreso fijo'}</h2>
    <p class="hint">Arriendo, servicios, salario, suscripciones. Se registran solos en cada fecha.</p>
    <div class="seg two" id="seg"><button type="button" data-k="gasto">Pago</button><button type="button" data-k="ingreso">Ingreso</button></div>
    <label class="f"><span>Nombre</span><input id="name" value="${esc(d.name)}" placeholder="Ej: Arriendo" autocomplete="off"></label>
    <label class="f"><span>Valor</span><input id="amt" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    <div class="grid2">
      <label class="f"><span>Categoría</span><select id="cat"></select></label>
      <label class="f"><span>Cuenta</span><select id="acc">${accOptions(d.accountId)}</select></label>
      <label class="f"><span>Frecuencia</span><select id="freq">${options(Object.entries(FREQ_LABEL), d.freq)}</select></label>
      <label class="f"><span>Próxima fecha</span><input id="next" type="date" value="${d.next}"></label>
    </div>
    ${edit ? `<label class="check"><input type="checkbox" id="active" ${d.active ? 'checked' : ''}> Activo</label>` : ''}
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
  const amt = bindAmount($('#amt'), d.amount);
  let type = d.type;
  const setType = (k, sel) => {
    type = k; $$('#seg button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    const list = CATS[k]; $('#cat').innerHTML = options(list.map(c => [c, c]), list.includes(sel) ? sel : list[0]);
  };
  $$('#seg button').forEach(b => b.onclick = () => setType(b.dataset.k));
  setType(type, d.category);
  if (edit) $('#del').onclick = async () => {
    if (!confirm('¿Eliminar este fijo? Los movimientos ya registrados se conservan.')) return;
    S.recurring = S.recurring.filter(x => x.id !== r.id); await save(); closeSheet(); refresh(); toast('Fijo eliminado');
  };
  else $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    const amount = amt.get(), name = $('#name').value.trim() || $('#cat').value, next = $('#next').value || todayISO();
    if (!amount) { toast('Escribe el valor.'); return; }
    const data = { name, type, amount, category: $('#cat').value, accountId: $('#acc').value, freq: $('#freq').value, next, day: parseISO(next).getDate(), active: edit ? $('#active').checked : true };
    if (edit) Object.assign(r, data); else S.recurring.push({ id: uid(), ...data });
    const n = runRecurring();
    await save(); closeSheet(); refresh(); toast(n ? `Guardado. ${n} registrado${n > 1 ? 's' : ''} hasta hoy.` : 'Guardado');
  };
}

/* ---------- Plan: salud, alertas, presupuesto, lecciones ---------- */
const LV_LABEL = { ok: 'Sano', warn: 'Atención', bad: 'Riesgo', na: 'Sin datos' };
const alertHTML = al => `<div class="alert ${al.lv}"><span class="dot ${al.lv}"></span><span>${esc(al.t)}</span></div>`;

function planResumen(v) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const h = health(), al = alerts(), rows = budgetRows(y, m);
  const totalBudget = Object.values(S.budgets).reduce((s, x) => s + (x || 0), 0);
  const unbudgetedFixed = monthlyFixed('gasto', r => !S.budgets[r.category]);

  v.innerHTML = `
    <section class="block">
      <h2>Salud financiera</h2>
      ${h.list.map(i => `<div class="row"><span class="l"><span class="ind"><span class="dot ${i.lv}" aria-label="${LV_LABEL[i.lv]}"></span>${i.name}</span><span class="s">${i.why}</span></span><span class="amt">${i.val}</span></div>`).join('')}
      ${h.fixInc ? '' : `<p class="small muted">Registra tu salario como ingreso fijo (en Movimientos) para que estos indicadores sean exactos.</p>`}
    </section>

    <section class="block">
      <h2>Alertas</h2>
      ${al.length ? al.map(alertHTML).join('') : '<p class="muted small" style="margin:0">Nada preocupante por ahora.</p>'}
    </section>

    <section class="block">
      <h2>Presupuesto de ${monthFmt.format(now).split(' ')[0]}</h2>
      ${totalBudget ? `<p class="small muted" style="margin:0 0 4px">Límites: ${money(totalBudget)}. Otros fijos: ${money(unbudgetedFixed)}. ${h.fixInc ? `Ingreso fijo: ${money(h.fixInc)}.` : ''}</p>` : ''}
      ${rows.length ? rows.map(r => `<button class="tx" data-bud="${esc(r.cat)}" style="display:block"><span style="display:flex;justify-content:space-between;gap:12px"><span class="t">${esc(r.cat)}</span><span class="amt ${r.spent > r.limit ? 'neg' : ''}">${money(r.spent)} <span class="muted small">de ${money(r.limit)}</span></span></span>
        <span class="bar ${r.spent > r.limit || r.projected > r.limit * 1.05 ? 'warn' : ''}" style="display:block"><i style="width:${Math.min(100, r.pct * 100)}%"></i></span>
        ${r.projected > r.limit * 1.05 && r.spent <= r.limit ? `<span class="s">Proyección al cierre: ${money(r.projected)}</span>` : ''}</button>`).join('')
      : `<p class="small muted" style="margin:0 0 8px">Pon un límite mensual a las categorías donde más se te va el dinero. La app te avisará antes de pasarte.</p>`}
      <div class="actions" style="margin-top:12px"><button class="btn ghost" id="suggest">Sugerir con mi historial</button><button class="btn" id="editBud">Editar límites</button></div>
    </section>

    <section class="block">
      <h2>Lecciones</h2>
      <p class="small muted" style="margin:0 0 6px">Situaciones que no deben repetirse. Te las recuerdo justo cuando vayas a registrar algo parecido.</p>
      ${S.lessons.map(l => { const n = S.txs.filter(t => t.date >= l.created && lessonHits(t, l)).length;
        return `<button class="tx" data-les="${l.id}"><span><span class="t">${esc(l.text)}</span><span class="s">${[l.category, l.keyword && `"${l.keyword}"`, l.minAmount && `desde ${money(l.minAmount)}`].filter(Boolean).join(', ')}${n ? `. Repetida ${n} ${n === 1 ? 'vez' : 'veces'}` : ''}</span></span></button>`; }).join('')}
      <button class="btn ghost wide" id="addLes" style="margin-top:12px">Agregar lección</button>
    </section>`;

  $$('[data-bud]').forEach(el => el.onclick = () => budgetSheet());
  $$('[data-les]').forEach(el => el.onclick = () => lessonSheet(S.lessons.find(l => l.id === el.dataset.les)));
  $('#editBud').onclick = () => budgetSheet();
  $('#addLes').onclick = () => lessonSheet();
  $('#suggest').onclick = () => {
    const avg = avgMonthly(3);
    if (!avg) { toast('Necesito al menos un mes cerrado con movimientos.'); return; }
    const sug = {};
    CATS.gasto.forEach(c => { const v = avg.byCat[c]; if (v >= 10000) sug[c] = Math.ceil(v / 10000) * 10000; });
    budgetSheet(sug, `Promedio de tus últimos ${avg.n === 1 ? 'mes' : avg.n + ' meses'}, redondeado. Ajusta lo que quieras recortar.`);
  };
}

function budgetSheet(prefill, hint) {
  const vals = { ...S.budgets, ...(prefill || {}) };
  const avg = avgMonthly(3);
  openSheet(`
    <h2>Límites mensuales</h2>
    <p class="hint">${hint || 'Deja en blanco las categorías sin límite.'}</p>
    ${CATS.gasto.map((c, i) => `<label class="f"><span>${esc(c)}${avg && avg.byCat[c] ? ` <span class="small">(promedio ${money(avg.byCat[c])})</span>` : ''}</span><input data-i="${i}" class="bud" inputmode="numeric" placeholder="Sin límite"></label>`).join('')}
    <div class="actions"><button class="btn ghost" id="cancel">Cancelar</button><button class="btn" id="save">Guardar</button></div>`);
  const inputs = $$('.bud').map(el => ({ cat: CATS.gasto[+el.dataset.i], b: bindAmount(el, vals[CATS.gasto[+el.dataset.i]] || 0) }));
  $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    S.budgets = {}; inputs.forEach(x => { if (x.b.get() > 0) S.budgets[x.cat] = x.b.get(); });
    await save(); closeSheet(); refresh(); toast('Límites guardados');
  };
}

function lessonSheet(l, fromTx) {
  const edit = !!l;
  const d = l ? { ...l } : { text: '', why: '', category: fromTx ? fromTx.category : '', keyword: fromTx && fromTx.note ? fromTx.note.split(/\s+/)[0] : '', minAmount: 0 };
  openSheet(`
    <h2>${edit ? 'Editar lección' : 'Nueva lección'}</h2>
    <p class="hint">Escribe lo que no quieres repetir. Te lo recordaré cuando registres un gasto que coincida.</p>
    <label class="f"><span>¿Qué no debe repetirse?</span><input id="ltext" value="${esc(d.text)}" placeholder="Ej: Pedir domicilio entre semana" autocomplete="off"></label>
    <label class="f"><span>¿Por qué? (opcional)</span><input id="lwhy" value="${esc(d.why)}" placeholder="Ej: En agosto se me fueron 300 mil así" autocomplete="off"></label>
    <div class="grid2">
      <label class="f"><span>Categoría</span><select id="lcat">${options([['', 'Cualquiera'], ...CATS.gasto.map(c => [c, c])], d.category || '')}</select></label>
      <label class="f"><span>Palabra en la nota</span><input id="lkey" value="${esc(d.keyword)}" placeholder="Ej: rappi" autocomplete="off"></label>
      <label class="f full"><span>Desde qué valor (opcional)</span><input id="lmin" inputmode="numeric" placeholder="$ 0"></label>
    </div>
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
  const min = bindAmount($('#lmin'), d.minAmount);
  if (edit) $('#del').onclick = async () => { if (!confirm('¿Eliminar esta lección?')) return; S.lessons = S.lessons.filter(x => x.id !== l.id); await save(); closeSheet(); refresh(); };
  else $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    const text = $('#ltext').value.trim();
    if (!text) { toast('Escribe la lección.'); return; }
    const data = { text, why: $('#lwhy').value.trim(), category: $('#lcat').value, keyword: $('#lkey').value.trim(), minAmount: min.get() };
    if (!data.category && !data.keyword) { toast('Elige una categoría o una palabra para poder reconocerla.'); return; }
    if (edit) Object.assign(l, data); else S.lessons.push({ id: uid(), created: todayISO(), ...data });
    await save(); closeSheet();
    if (tab === 'plan') refresh(); toast('Lección guardada');
  };
}

/* ---------- Fase 3: deudas, metas, inflación, conciliación e informe ---------- */
const eaToMv = ea => Math.pow(1 + ea / 100, 1 / 12) - 1;
const mvToEa = mv => (Math.pow(1 + mv / 100, 12) - 1) * 100;
const pctFmt = (v, d = 1) => v.toFixed(d).replace('.', ',') + '%';
const monthsBetween = (fromISO, toISO) => { const a = parseISO(fromISO), b = parseISO(toISO); return Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + (b.getDate() >= a.getDate() ? 0 : -1)); };
const ipc = () => S.settings.ipc || 0;

function debtBalance(d) {
  const a = d.accountId && accById(d.accountId);
  return a ? Math.max(0, -accBalance(a)) : d.balance || 0;
}

function simulate(list, extra, method) {
  const ds = list.map(d => ({ name: d.name, bal: debtBalance(d), rm: eaToMv(d.rate || 0), min: d.min || 0 })).filter(d => d.bal > 0);
  const budget = ds.reduce((s, d) => s + d.min, 0) + extra;
  let month = 0, interest = 0; const order = [];
  while (ds.some(d => d.bal > 1) && month < 480) {
    month++;
    ds.forEach(d => { if (d.bal > 1) { const i = d.bal * d.rm; d.bal += i; interest += i; } });
    let pay = budget;
    ds.forEach(d => { if (d.bal > 1) { const p = Math.min(d.min, d.bal, pay); d.bal -= p; pay -= p; } });
    const act = ds.filter(d => d.bal > 1).sort(method === 'snow' ? (a, b) => a.bal - b.bal : (a, b) => b.rm - a.rm || a.bal - b.bal);
    for (const d of act) { if (pay <= 0) break; const p = Math.min(pay, d.bal); d.bal -= p; pay -= p; }
    ds.forEach(d => { if (d.bal <= 1 && !order.some(o => o.name === d.name)) order.push({ name: d.name, month }); });
  }
  return { ok: !ds.some(d => d.bal > 1), months: month, interest, order, budget };
}

function goalsReserved() { return S.goals.reduce((s, g) => s + (g.saved || 0), 0); }

function savingCapacity() {
  const avg = avgMonthly(3);
  if (avg && avg.inc) return avg.inc - avg.exp;
  const fi = monthlyFixed('ingreso');
  return fi ? fi - monthlyFixed('gasto') - Object.entries(S.budgets).filter(([c]) => !S.recurring.some(r => r.active && r.category === c)).reduce((s, [, v]) => s + v, 0) : 0;
}

function goalPlan(g) {
  const months = Math.max(1, monthsBetween(todayISO(), g.date));
  const target = ipc() ? g.target * Math.pow(1 + ipc() / 100, months / 12) : g.target;
  const need = Math.max(0, target - (g.saved || 0));
  return { months, target, need, perMonth: need / months, pct: Math.min(1, (g.saved || 0) / target) };
}

function accBalanceAt(a, d) {
  let b = a.initial || 0;
  for (const t of S.txs) {
    if (t.date > d) continue;
    if (t.accountId === a.id) b += t.type === 'ingreso' ? t.amount : -(t.amount + (t.gmf || 0));
    if (t.type === 'transfer' && t.toAccountId === a.id) b += t.amount;
  }
  return b;
}

/* --- Plan con subsecciones --- */
let planSub = 'resumen';
const PLAN_SUBS = { resumen: 'Resumen', deudas: 'Deudas', metas: 'Metas', informe: 'Informe' };
function renderPlan() {
  const v = $('#view');
  if (!S.accounts.length) { v.innerHTML = `<div class="empty"><strong>Primero tus cuentas</strong><p>El plan necesita saber cuánto dinero tienes.</p></div>`; return; }
  v.innerHTML = `<div class="seg four" id="psub">${Object.entries(PLAN_SUBS).map(([k, l]) => `<button type="button" data-k="${k}" class="${k === planSub ? 'on' : ''}">${l}</button>`).join('')}</div><div id="pbody"></div>`;
  $$('#psub button').forEach(b => b.onclick = () => { planSub = b.dataset.k; renderPlan(); window.scrollTo(0, 0); });
  ({ resumen: planResumen, deudas: planDeudas, metas: planMetas, informe: planInforme })[planSub]($('#pbody'));
}

/* --- Deudas --- */
let debtExtra = 100000;
function planDeudas(v) {
  const list = S.debts.filter(d => debtBalance(d) > 0);
  const total = list.reduce((s, d) => s + debtBalance(d), 0);
  const unlinked = S.accounts.filter(a => a.type === 'credito' && !S.debts.some(d => d.accountId === a.id) && accBalance(a) < 0);
  const aval = list.length ? simulate(list, debtExtra, 'aval') : null;
  const snow = list.length ? simulate(list, debtExtra, 'snow') : null;
  const base = list.length ? simulate(list, 0, 'aval') : null;
  const fin = r => r.ok ? `${r.months} ${r.months === 1 ? 'mes' : 'meses'}` : 'No se alcanza a pagar';
  v.innerHTML = `
    <section class="block">
      <h2>Tus deudas</h2>
      ${S.debts.length ? S.debts.map(d => `<button class="tx" data-debt="${d.id}"><span><span class="t">${esc(d.name)}</span><span class="s">${pctFmt(d.rate || 0)} E.A. (${pctFmt(eaToMv(d.rate || 0) * 100, 2)} mensual), cuota mínima ${money(d.min)}</span></span><span class="amt neg">${money(debtBalance(d))}</span></button>`).join('')
        : '<p class="small muted" style="margin:0">Registra cada deuda con su tasa. Así sabrás cuál te cuesta más y en qué orden pagarlas.</p>'}
      ${unlinked.map(a => `<div class="notice" style="margin-top:10px"><span>${esc(a.name)} tiene saldo pendiente. Agrégala con su tasa para incluirla.</span><button class="btn sm" data-link="${a.id}">Agregar</button></div>`).join('')}
      <button class="btn ghost wide" id="addDebt" style="margin-top:12px">Agregar deuda</button>
    </section>
    ${list.length ? `
    <section class="block">
      <h2>¿En qué orden pagar?</h2>
      <p class="small muted" style="margin:0 0 10px">Pagando las cuotas mínimas más un extra mensual de:</p>
      <label class="f"><input id="extra" class="amount-in" inputmode="numeric"></label>
      <div class="compare">
        <div class="opt ${aval.interest <= snow.interest ? 'best' : ''}"><b>Avalancha</b><span class="s">Primero la de mayor tasa</span><span class="k">${fin(aval)}</span><span class="s">Intereses: ${money(aval.interest)}</span></div>
        <div class="opt ${snow.interest < aval.interest ? 'best' : ''}"><b>Bola de nieve</b><span class="s">Primero la más pequeña</span><span class="k">${fin(snow)}</span><span class="s">Intereses: ${money(snow.interest)}</span></div>
      </div>
      ${aval.ok ? `<p class="small" style="margin:10px 0 0">Con avalancha ahorras <b>${money(snow.interest - aval.interest)}</b> frente a bola de nieve${base.ok ? `, y <b>${money(base.interest - aval.interest)}</b> frente a pagar solo las mínimas (${base.months} meses)` : ''}. Bola de nieve cuesta más, pero te da victorias rápidas si te cuesta mantener la disciplina.</p>
        <p class="small muted" style="margin:8px 0 0">Orden sugerido: ${aval.order.map(o => `${esc(o.name)} (mes ${o.month})`).join(', ')}.</p>`
        : `<p class="neg small" style="margin:10px 0 0">Con estos pagos, al menos una deuda no se termina de pagar: los intereses superan la cuota. Aumenta el pago extra o renegocia la tasa.</p>`}
    </section>` : ''}
    <section class="block">
      <h2>¿Me conviene este crédito?</h2>
      <p class="small muted" style="margin:0 0 10px">Simula antes de firmar.</p>
      <div class="grid2">
        <label class="f full"><span>Monto</span><input id="cm" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
        <label class="f"><span>Tasa (%)</span><input id="cr" inputmode="decimal" placeholder="Ej: 24,5"></label>
        <label class="f"><span>Tipo de tasa</span><select id="ct"><option value="ea">Efectiva anual</option><option value="mv">Mensual</option></select></label>
        <label class="f full"><span>Plazo (meses)</span><input id="cn" inputmode="numeric" placeholder="Ej: 36"></label>
      </div>
      <div id="cres"></div>
    </section>`;
  $$('[data-debt]').forEach(el => el.onclick = () => debtSheet(S.debts.find(d => d.id === el.dataset.debt)));
  $$('[data-link]').forEach(el => el.onclick = () => { const a = accById(el.dataset.link); debtSheet(null, { name: a.name, accountId: a.id }); });
  $('#addDebt').onclick = () => debtSheet();
  if ($('#extra')) {
    const ex = bindAmount($('#extra'), debtExtra);
    $('#extra').addEventListener('change', () => { debtExtra = ex.get(); planDeudas(v); });
    $('#extra').addEventListener('keydown', e => { if (e.key === 'Enter') $('#extra').blur(); });
  }
  const cm = bindAmount($('#cm'), 0);
  const calc = () => {
    const P = cm.get(), raw = parseFloat(($('#cr').value || '').replace(',', '.')), n = parseInt($('#cn').value, 10);
    if (!P || !raw || !n) { $('#cres').innerHTML = ''; return; }
    const r = $('#ct').value === 'ea' ? eaToMv(raw) : raw / 100;
    const ea = $('#ct').value === 'ea' ? raw : mvToEa(raw);
    const cuota = P * r / (1 - Math.pow(1 + r, -n));
    const total = cuota * n, intereses = total - P;
    const fi = monthlyFixed('ingreso');
    const cuotas = monthlyFixed('gasto', x => x.category === 'Deudas');
    const load = fi ? (cuotas + cuota) / fi : null;
    const usura = S.settings.usura;
    $('#cres').innerHTML = `
      <div class="row"><span>Cuota mensual</span><span class="amt">${money(cuota)}</span></div>
      <div class="row"><span>Pagarás en total</span><span class="amt">${money(total)}</span></div>
      <div class="row"><span>Intereses</span><span class="amt neg">${money(intereses)} <span class="small muted">(${pctFmt(intereses / P * 100, 0)} del monto)</span></span></div>
      <div class="row"><span>Tasa efectiva anual</span><span class="amt">${pctFmt(ea)}</span></div>
      ${load != null ? `<div class="alert ${load > 0.4 ? 'bad' : load > 0.3 ? 'warn' : 'ok'}"><span class="dot ${load > 0.4 ? 'bad' : load > 0.3 ? 'warn' : 'ok'}"></span><span>Tus cuotas de deuda pasarían a ser el ${pctFmt(load * 100, 0)} de tu ingreso fijo. ${load > 0.4 ? 'Es riesgoso: por encima del 40% cualquier imprevisto te desbalancea.' : load > 0.3 ? 'Es manejable, pero te deja poco margen.' : 'Es una carga sana.'}</span></div>` : '<p class="small muted">Registra tu salario como ingreso fijo para saber si puedes asumir esta cuota.</p>'}
      ${usura ? (ea > usura ? `<div class="alert bad"><span class="dot bad"></span><span>Esta tasa supera la tasa de usura (${pctFmt(usura)} E.A.). Es ilegal cobrarla: no la aceptes.</span></div>` : ea > usura * 0.9 ? `<div class="alert warn"><span class="dot warn"></span><span>Esta tasa está muy cerca de la usura (${pctFmt(usura)} E.A.). Es de las más caras del mercado.</span></div>` : '') : ''}`;
  };
  ['#cr', '#cn'].forEach(s => $(s).addEventListener('input', calc));
  $('#ct').onchange = calc; $('#cm').addEventListener('amount', calc);
}

function debtSheet(d, prefill) {
  const edit = !!d;
  const x = d ? { ...d } : { name: '', balance: 0, rate: '', min: 0, accountId: '', ...(prefill || {}) };
  const cards = S.accounts.filter(a => a.type === 'credito');
  openSheet(`
    <h2>${edit ? 'Editar deuda' : 'Nueva deuda'}</h2>
    <p class="hint">La tasa está en el extracto o en el contrato. Si solo tienes la mensual, conviértela: la app acepta ambas.</p>
    <label class="f"><span>Nombre</span><input id="dn" value="${esc(x.name)}" placeholder="Ej: Crédito moto" autocomplete="off"></label>
    ${cards.length ? `<label class="f"><span>¿Es una tarjeta registrada?</span><select id="dacc">${options([['', 'No, es otra deuda'], ...cards.map(a => [a.id, a.name])], x.accountId || '')}</select></label>` : ''}
    <label class="f" id="dbalWrap"><span>Saldo pendiente</span><input id="db" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    <div class="grid2">
      <label class="f"><span>Tasa (%)</span><input id="dr" inputmode="decimal" value="${x.rate !== '' ? String(x.rate).replace('.', ',') : ''}" placeholder="Ej: 28,5"></label>
      <label class="f"><span>Tipo</span><select id="dt"><option value="ea">Efectiva anual</option><option value="mv">Mensual</option></select></label>
      <label class="f full"><span>Cuota mínima mensual</span><input id="dm" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    </div>
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
  const bal = bindAmount($('#db'), x.balance), min = bindAmount($('#dm'), x.min);
  const linked = () => $('#dacc') && $('#dacc').value;
  const upd = () => { $('#dbalWrap').hidden = !!linked(); };
  if ($('#dacc')) $('#dacc').onchange = upd; upd();
  if (edit) $('#del').onclick = async () => { if (!confirm('¿Eliminar esta deuda del plan? No borra movimientos.')) return; S.debts = S.debts.filter(y => y.id !== d.id); await save(); closeSheet(); refresh(); };
  else $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    const name = $('#dn').value.trim(), raw = parseFloat(($('#dr').value || '').replace(',', '.'));
    if (!name) { toast('Ponle un nombre.'); return; }
    if (!(raw >= 0)) { toast('Escribe la tasa de interés.'); return; }
    const rate = $('#dt').value === 'ea' ? raw : +mvToEa(raw).toFixed(2);
    const data = { name, rate, min: min.get(), accountId: linked() || '', balance: linked() ? 0 : bal.get() };
    if (!data.accountId && !data.balance) { toast('Escribe el saldo pendiente.'); return; }
    if (edit) Object.assign(d, data); else S.debts.push({ id: uid(), ...data });
    await save(); closeSheet(); refresh(); toast('Deuda guardada');
  };
}

/* --- Metas --- */
function planMetas(v) {
  const cap = savingCapacity();
  const reserved = goalsReserved();
  const totalPer = S.goals.reduce((s, g) => s + goalPlan(g).perMonth, 0);
  v.innerHTML = `
    <section class="block">
      <h2>Metas de ahorro</h2>
      <p class="small muted" style="margin:0 0 6px">El dinero que abonas a una meta queda apartado: no cuenta en "Puedes gastar hoy".${ipc() ? ` Los objetivos se ajustan con la inflación (${pctFmt(ipc(), 2)} anual).` : ''}</p>
      ${S.goals.length ? `<p class="small" style="margin:0 0 6px">Apartado: <b>${money(reserved)}</b>. Necesitas ahorrar <b>${money(totalPer)}</b> al mes para cumplirlas todas; tu capacidad de ahorro es de <b class="${totalPer > cap ? 'neg' : ''}">${money(cap)}</b>.</p>` : ''}
      ${S.goals.map(g => { const p = goalPlan(g); const lv = p.need <= 0 ? 'ok' : cap <= 0 ? 'bad' : p.perMonth <= cap * 0.5 ? 'ok' : p.perMonth <= cap ? 'warn' : 'bad';
        return `<div class="goal">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><span class="ind"><span class="dot ${lv}"></span><b>${esc(g.name)}</b></span><span class="amt">${money(g.saved)} <span class="small muted">de ${money(p.target)}</span></span></div>
          <div class="bar"><i style="width:${p.pct * 100}%"></i></div>
          <p class="small muted" style="margin:6px 0 8px">${p.need <= 0 ? '¡Meta cumplida!' : `${money(p.perMonth)} al mes durante ${p.months} ${p.months === 1 ? 'mes' : 'meses'} (hasta ${shortFmt.format(parseISO(g.date))}).${ipc() && p.target > g.target + 1 ? ` Con inflación, ${money(g.target)} de hoy serán ${money(p.target)}.` : ''}${lv === 'bad' ? ' Con tu ahorro actual no alcanza: amplía el plazo o recorta gastos.' : ''}`}</p>
          <div class="actions" style="margin:0"><button class="btn sm ghost" data-gedit="${g.id}">Editar</button><button class="btn sm" data-gadd="${g.id}">Abonar</button></div>
        </div>`; }).join('')}
      ${S.goals.length ? '' : '<p class="small muted">Ejemplos: fondo de emergencia, un viaje, capital para tu empresa. Con fecha y valor, la app te dice cuánto apartar cada mes y si es realista.</p>'}
      <button class="btn ghost wide" id="addGoal" style="margin-top:12px">Agregar meta</button>
    </section>`;
  $('#addGoal').onclick = () => goalSheet();
  $$('[data-gedit]').forEach(el => el.onclick = () => goalSheet(S.goals.find(g => g.id === el.dataset.gedit)));
  $$('[data-gadd]').forEach(el => el.onclick = () => contribSheet(S.goals.find(g => g.id === el.dataset.gadd)));
}

function goalSheet(g) {
  const edit = !!g;
  const d = g ? { ...g } : (() => { const x = new Date(); x.setFullYear(x.getFullYear() + 1); return { name: '', target: 0, date: iso(x), saved: 0 }; })();
  const fixExp = monthlyFixed('gasto') + Object.values(S.budgets).reduce((s, v) => s + v, 0);
  openSheet(`
    <h2>${edit ? 'Editar meta' : 'Nueva meta'}</h2>
    <label class="f"><span>Nombre</span><input id="gn" value="${esc(d.name)}" placeholder="Ej: Fondo de emergencia" autocomplete="off"></label>
    <label class="f"><span>Valor objetivo (en pesos de hoy)</span><input id="gt" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    ${!edit && fixExp ? `<button class="btn ghost sm" id="gEmer" style="margin:-4px 0 12px">Fondo de emergencia de 6 meses: ${money(fixExp * 6)}</button>` : ''}
    <div class="grid2">
      <label class="f"><span>Fecha límite</span><input id="gd" type="date" value="${d.date}"></label>
      <label class="f"><span>Ya tienes apartado</span><input id="gs" inputmode="numeric" placeholder="$ 0"></label>
    </div>
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
  const t = bindAmount($('#gt'), d.target), s = bindAmount($('#gs'), d.saved);
  if ($('#gEmer')) $('#gEmer').onclick = () => { $('#gn').value = $('#gn').value || 'Fondo de emergencia'; t.set(Math.ceil(fixExp * 6 / 100000) * 100000); };
  if (edit) $('#del').onclick = async () => { if (!confirm('¿Eliminar esta meta? El dinero apartado vuelve a estar disponible.')) return; S.goals = S.goals.filter(x => x.id !== g.id); await save(); closeSheet(); refresh(); };
  else $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    const name = $('#gn').value.trim(), date = $('#gd').value;
    if (!name || !t.get()) { toast('Escribe el nombre y el valor.'); return; }
    if (!date || date <= todayISO()) { toast('La fecha debe ser futura.'); return; }
    const { liquid } = totals();
    if (s.get() - (edit ? g.saved : 0) + goalsReserved() > liquid) { toast('No tienes suficiente dinero disponible para apartar eso.'); return; }
    const data = { name, target: t.get(), date, saved: s.get() };
    if (edit) Object.assign(g, data); else S.goals.push({ id: uid(), created: todayISO(), ...data });
    await save(); closeSheet(); refresh(); toast('Meta guardada');
  };
}

function contribSheet(g) {
  const p = goalPlan(g), { liquid } = totals(), free = liquid - goalsReserved();
  openSheet(`
    <h2>${esc(g.name)}</h2>
    <p class="hint">Aparta dinero para esta meta. Lo sugerido este mes: ${money(p.perMonth)}. Disponible sin apartar: ${money(free)}.</p>
    <div class="seg two" id="gseg"><button type="button" data-k="add" class="on">Abonar</button><button type="button" data-k="take">Retirar</button></div>
    <label class="f"><span>Valor</span><input id="ga" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    <div class="actions"><button class="btn ghost" id="cancel">Cancelar</button><button class="btn" id="save">Guardar</button></div>`);
  const a = bindAmount($('#ga'), Math.max(0, Math.min(Math.round(p.perMonth / 1000) * 1000, free)));
  let mode = 'add';
  $$('#gseg button').forEach(b => b.onclick = () => { mode = b.dataset.k; $$('#gseg button').forEach(x => x.classList.toggle('on', x === b)); });
  $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    const v = a.get(); if (!v) return;
    if (mode === 'add' && v > free) { toast(`Solo tienes ${money(free)} sin apartar.`); return; }
    if (mode === 'take' && v > g.saved) { toast('No puedes retirar más de lo apartado.'); return; }
    g.saved += mode === 'add' ? v : -v;
    (g.log = g.log || []).push({ date: todayISO(), amount: mode === 'add' ? v : -v });
    await save(); closeSheet(); refresh(); toast(mode === 'add' ? 'Abono registrado' : 'Retiro registrado');
  };
}

/* --- Informe mensual --- */
let repMonth = null;
function report(y, m) {
  const [a, b, last] = monthRange(y, m);
  const st = monthStats(y, m);
  const prevRows = []; for (let i = 1; i <= 3; i++) { const d = new Date(y, m - i, 1); const [pa, pb] = monthRange(d.getFullYear(), d.getMonth()); if (S.txs.some(t => t.date >= pa && t.date <= pb)) prevRows.push(monthStats(d.getFullYear(), d.getMonth())); }
  const avgExp = prevRows.length ? prevRows.reduce((s, r) => s + r.exp, 0) / prevRows.length : null;
  const avgCat = {}; prevRows.forEach(r => Object.entries(r.byCat).forEach(([c, v]) => avgCat[c] = (avgCat[c] || 0) + v / prevRows.length));
  const infl = Math.pow(1 + ipc() / 100, 2 / 12);
  const red = [], green = [], todo = [];
  const rate = st.inc ? (st.inc - st.exp) / st.inc : null;
  const now = new Date(); const isCur = y === now.getFullYear() && m === now.getMonth();

  if (rate != null && rate < 0) red.push(`Gastaste ${money(st.exp - st.inc)} más de lo que ganaste.`);
  else if (rate != null && rate < 0.1) red.push(`Solo ahorraste el ${pctFmt(rate * 100, 0)} de tus ingresos. Lo mínimo sano es 10% y la meta, 20%.`);
  else if (rate != null && rate >= 0.2) green.push(`Ahorraste el ${pctFmt(rate * 100, 0)} de tus ingresos.`);

  const bud = budgetRows(y, m);
  bud.filter(r => r.spent > r.limit).forEach(r => red.push(`${r.cat}: te pasaste ${money(r.spent - r.limit)} del límite.`));
  const okBud = bud.filter(r => r.spent <= r.limit);
  if (bud.length && okBud.length === bud.length && !isCur) green.push(`Cumpliste todos tus límites de presupuesto (${bud.length}).`);
  else if (okBud.length && !isCur) green.push(`Cumpliste ${okBud.length} de ${bud.length} límites.`);

  S.lessons.forEach(l => { const h = S.txs.filter(t => t.date >= a && t.date <= b && t.date >= l.created && lessonHits(t, l));
    if (h.length) red.push(`Repetiste "${l.text}" ${h.length === 1 ? 'una vez' : h.length + ' veces'} (${money(h.reduce((s, t) => s + t.amount, 0))}).`); });
  if (S.lessons.length && !red.some(r => r.startsWith('Repetiste')) && !isCur) green.push('No repetiste ninguna lección.');

  const small = S.txs.filter(t => t.type === 'gasto' && !t.recurringId && t.date >= a && t.date <= b && t.amount <= SMALL_EXPENSE);
  const smallSum = small.reduce((s, t) => s + t.amount, 0);
  if (small.length >= 6 && st.exp && smallSum / st.exp >= 0.08) red.push(`Gastos hormiga: ${small.length} compras pequeñas sumaron ${money(smallSum)} (${pctFmt(smallSum / st.exp * 100, 0)} de tus gastos).`);

  if (avgExp && st.exp && !isCur) {
    const real = st.exp / (avgExp * infl) - 1;
    if (real > 0.1) red.push(`Tus gastos subieron ${pctFmt(real * 100, 0)} por encima de la inflación frente a tu promedio.`);
    else if (real < -0.05) green.push(`Tus gastos bajaron ${pctFmt(-real * 100, 0)} en términos reales frente a tu promedio.`);
  }
  let worst = null;
  Object.entries(st.byCat).forEach(([c, v]) => { const base = avgCat[c]; if (!base || c === '4x1000') return;
    const real = v / (base * infl) - 1; if (real > 0.25 && v - base > 50000 && (!worst || v - base > worst.diff)) worst = { c, real, diff: v - base }; });
  if (worst) red.push(`${worst.c} creció ${pctFmt(worst.real * 100, 0)} por encima de la inflación (${money(worst.diff)} más que tu promedio).`);

  if (st.gmf >= 15000) red.push(`Pagaste ${money(st.gmf)} de 4x1000. Marca como exenta la cuenta desde la que más pagas.`);

  S.accounts.filter(x => x.type === 'credito').forEach(x => {
    const s0 = -accBalanceAt(x, iso(new Date(y, m, 0))), s1 = -accBalanceAt(x, b);
    if (s1 > s0 + 10000) red.push(`La deuda de ${x.name} creció ${money(s1 - s0)} en el mes.`);
    else if (s1 < s0 - 10000) green.push(`Redujiste la deuda de ${x.name} en ${money(s0 - s1)}.`);
  });

  // Decisiones para el próximo mes
  if (rate != null && rate < 0.2 && st.inc) {
    const gap = st.inc * 0.2 - (st.inc - st.exp);
    const cand = worst ? worst.c : Object.entries(st.byCat).filter(([c]) => !['Vivienda', 'Deudas', 'Impuestos', '4x1000'].includes(c)).sort((p, q) => q[1] - p[1])[0]?.[0];
    todo.push(`Para ahorrar el 20% necesitas liberar ${money(gap)} al mes${cand ? `. Empieza por ${cand}` : ''}.`);
  }
  const active = S.debts.filter(d => debtBalance(d) > 0);
  if (active.length) { const top = [...active].sort((p, q) => (q.rate || 0) - (p.rate || 0))[0]; todo.push(`Todo pago extra de deuda va a ${top.name} (${pctFmt(top.rate || 0)} E.A.), la más cara.`); }
  if (st.incVar > 0) { const g = S.goals.find(x => goalPlan(x).need > 0); todo.push(`Recibiste ${money(st.incVar)} de ingresos variables. Destínalos${g ? ` a "${g.name}"` : ' a una meta o a deuda'} en vez de al gasto del día a día.`); }
  const h = health().list.find(i => i.name === 'Fondo de emergencia');
  if (h && h.lv === 'bad') todo.push('Tu fondo de emergencia cubre menos de 3 meses. Antes de nuevos gastos grandes, fortalécelo.');
  const stale = S.accounts.filter(x => !x.reconciled || (Date.now() - parseISO(x.reconciled)) / 864e5 > 35);
  if (stale.length) todo.push(`Concilia ${stale.map(x => x.name).join(', ')} con el saldo real del banco para que estas cifras sean confiables.`);

  return { st, rate, red, green, todo, last, isCur };
}

function planInforme(v) {
  const now = new Date();
  if (!repMonth) repMonth = now.getDate() <= 7 ? { y: new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear(), m: (now.getMonth() + 11) % 12 } : { y: now.getFullYear(), m: now.getMonth() };
  const { y, m } = repMonth;
  const r = report(y, m);
  const isNow = y === now.getFullYear() && m === now.getMonth();
  const list = (arr, lv) => arr.map(t => `<div class="alert ${lv}"><span class="dot ${lv}"></span><span>${esc(t)}</span></div>`).join('');
  v.innerHTML = `
    <div class="month">
      <button class="iconbtn" id="rPrev" aria-label="Mes anterior">‹</button>
      <strong>${monthFmt.format(new Date(y, m, 1))}</strong>
      <button class="iconbtn" id="rNext" aria-label="Mes siguiente" ${isNow ? 'disabled style="opacity:.35"' : ''}>›</button>
    </div>
    ${r.isCur ? '<p class="small muted" style="margin:0 0 8px">Mes en curso: el informe es parcial.</p>' : ''}
    <section class="block">
      <div class="row"><span>Ingresos</span><span class="amt pos">${money(r.st.inc)}</span></div>
      <div class="row"><span>Gastos</span><span class="amt neg">${money(r.st.exp)}</span></div>
      <div class="row"><span class="strong">Ahorro</span><span class="amt strong">${money(r.st.inc - r.st.exp)}${r.rate != null ? ` <span class="small muted">(${pctFmt(r.rate * 100, 0)})</span>` : ''}</span></div>
    </section>
    <section class="block"><h2>Banderas rojas</h2>${r.red.length ? list(r.red, 'bad') : '<p class="small muted" style="margin:0">Ninguna. Buen mes.</p>'}</section>
    ${r.green.length ? `<section class="block"><h2>Lo que salió bien</h2>${list(r.green, 'ok')}</section>` : ''}
    ${r.todo.length ? `<section class="block"><h2>Decisiones para el próximo mes</h2>${list(r.todo, 'warn')}</section>` : ''}
    <p class="small muted">Inflación usada: ${pctFmt(ipc(), 2)} anual${S.settings.ipcDate ? ` (${esc(S.settings.ipcDate)})` : ''}. Puedes actualizarla en Ajustes.</p>`;
  $('#rPrev').onclick = () => { repMonth.m--; if (repMonth.m < 0) { repMonth.m = 11; repMonth.y--; } planInforme(v); };
  $('#rNext').onclick = () => { if (isNow) return; repMonth.m++; if (repMonth.m > 11) { repMonth.m = 0; repMonth.y++; } planInforme(v); };
}

/* --- Conciliación --- */
function reconcileSheet(a) {
  const bal = accBalance(a), cr = a.type === 'credito';
  openSheet(`
    <h2>Conciliar ${esc(a.name)}</h2>
    <p class="hint">Abre tu banco o app y escribe el ${cr ? 'saldo que debes' : 'saldo'} real de hoy. La app mostrará la diferencia.</p>
    <div class="row"><span>Según la app</span><span class="amt">${money(cr ? -bal : bal)}</span></div>
    <label class="f" style="margin-top:12px"><span>${cr ? 'Deuda real' : 'Saldo real'}</span><input id="rv" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    <div id="rdiff" class="small" style="min-height:1.4em;margin-bottom:8px"></div>
    <div class="actions"><button class="btn ghost" id="cancel">Cancelar</button><button class="btn" id="save">Conciliar</button></div>`);
  const rv = bindAmount($('#rv'), 0);
  const diff = () => { const real = cr ? -rv.get() : rv.get(); return real - bal; };
  const show = () => { if (!$('#rv').value) { $('#rdiff').innerHTML = ''; return; } const d = diff();
    $('#rdiff').innerHTML = Math.abs(d) < 1 ? '<span class="pos">Cuadra perfecto.</span>'
      : `<span class="${d < 0 ? 'neg' : ''}">Diferencia de ${money(Math.abs(d))}: ${d < 0 ? 'hay gastos o cobros sin registrar (comisiones, 4x1000, algún pago olvidado)' : 'hay ingresos sin registrar o un gasto registrado de más'}. Se creará un ajuste.</span>`; };
  $('#rv').addEventListener('amount', show);
  $('#cancel').onclick = closeSheet;
  $('#save').onclick = async () => {
    if (!$('#rv').value && rv.get() === 0 && !confirm('¿El saldo real es cero?')) return;
    const d = diff();
    if (Math.abs(d) >= 1) S.txs.push({ id: uid(), date: todayISO(), type: d > 0 ? 'ingreso' : 'gasto', amount: Math.abs(d), category: d > 0 ? 'Otros ingresos' : 'Otros gastos', accountId: a.id, note: 'Ajuste de conciliación', gmf: 0, adjust: true });
    a.reconciled = todayISO();
    await save(); closeSheet(); refresh(); toast(Math.abs(d) < 1 ? 'Conciliada' : 'Conciliada con ajuste');
  };
}

/* ---------- Cuentas ---------- */
function renderCuentas() {
  const v = $('#view');
  const { liquid, debt } = totals();
  v.innerHTML = `
    ${S.accounts.length ? `<div class="sumline" style="margin-bottom:10px"><span>Disponible <b>${money(liquid)}</b></span><span>Deuda <b class="${debt > 0 ? 'neg' : ''}">${money(debt)}</b></span></div>
    <div class="panel">${S.accounts.map(a => { const b = accBalance(a); const cr = a.type === 'credito';
      return `<button class="tx" data-acc="${a.id}"><span><span class="t">${esc(a.name)}</span><span class="s">${ACC_TYPES[a.type]}${a.gmf ? ', cobra 4x1000' : ''}${a.reconciled ? `. Conciliada ${dayLabel(a.reconciled).toLowerCase()}` : ''}</span></span><span class="amt ${cr && b < 0 ? 'neg' : b < 0 ? 'neg' : ''}">${cr ? (b < 0 ? 'Debes ' + money(-b) : money(b)) : money(b)}</span></button>`; }).join('')}</div>`
    : `<div class="empty"><strong>Sin cuentas todavía</strong><p>Agrega tu banco, billeteras digitales, efectivo y tarjetas de crédito.</p></div>`}
    <button class="btn wide" id="addAcc" style="margin-top:16px">Agregar cuenta</button>`;
  $$('[data-acc]').forEach(el => el.onclick = () => accountSheet(accById(el.dataset.acc)));
  $('#addAcc').onclick = () => accountSheet();
}

function accountSheet(a, first) {
  const edit = !!a;
  const bal = edit ? accBalance(a) : 0;
  const d = a ? { ...a } : { name: '', type: 'banco', gmf: true };
  openSheet(`
    <h2>${edit ? 'Editar cuenta' : first ? 'Tu primera cuenta' : 'Nueva cuenta'}</h2>
    ${first ? '<p class="hint">Empieza con la cuenta donde recibes tu salario. Luego agregas las demás.</p>' : ''}
    <label class="f"><span>Nombre</span><input id="name" value="${esc(d.name)}" placeholder="Ej: Bancolombia, Nequi, Efectivo" autocomplete="off"></label>
    <label class="f"><span>Tipo</span><select id="type">${options(Object.entries(ACC_TYPES), d.type)}</select></label>
    <label class="f"><span id="balLbl">Saldo actual</span><input id="bal" class="amount-in" inputmode="numeric" placeholder="$ 0"></label>
    <label class="check" id="gmfWrap"><input type="checkbox" id="gmf" ${d.gmf ? 'checked' : ''}> Cobra 4x1000</label>
    <p class="small muted" id="gmfHint" style="margin:-8px 0 14px">Desmárcalo si es tu cuenta marcada como exenta ante el banco.</p>
    ${edit ? '<button class="btn ghost wide" id="reco" style="margin-bottom:10px">Conciliar con el banco</button>' : ''}
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : first ? '' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
  if ($('#reco')) $('#reco').onclick = () => reconcileSheet(a);
  const cr = () => $('#type').value === 'credito';
  const balIn = bindAmount($('#bal'), Math.abs(bal));
  const upd = () => {
    $('#balLbl').textContent = cr() ? 'Deuda actual' : 'Saldo actual';
    $('#gmfWrap').hidden = $('#gmfHint').hidden = cr() || $('#type').value === 'efectivo';
  };
  $('#type').onchange = () => { const t = $('#type').value; $('#gmf').checked = t === 'banco'; upd(); };
  upd();
  if ($('#cancel')) $('#cancel').onclick = closeSheet;
  if (edit) $('#del').onclick = async () => {
    const n = S.txs.filter(t => t.accountId === a.id || t.toAccountId === a.id).length;
    if (!confirm(n ? `Esta cuenta tiene ${n} movimientos. Se eliminarán también, junto con sus fijos. ¿Continuar?` : '¿Eliminar esta cuenta?')) return;
    S.txs = S.txs.filter(t => t.accountId !== a.id && t.toAccountId !== a.id);
    S.recurring = S.recurring.filter(r => r.accountId !== a.id);
    S.accounts = S.accounts.filter(x => x.id !== a.id);
    await save(); closeSheet(); refresh(); toast('Cuenta eliminada');
  };
  $('#save').onclick = async () => {
    const name = $('#name').value.trim();
    if (!name) { toast('Ponle un nombre a la cuenta.'); $('#name').focus(); return; }
    const type = $('#type').value;
    const target = type === 'credito' ? -balIn.get() : balIn.get();
    const gmf = type !== 'credito' && type !== 'efectivo' && $('#gmf').checked;
    if (edit) {
      const cur = accBalance(a);
      Object.assign(a, { name, type, gmf });
      a.initial = (a.initial || 0) + (target - cur);
    } else {
      S.accounts.push({ id: uid(), name, type, gmf, initial: target });
    }
    await save(); closeSheet(); refresh(); toast(edit ? 'Cuenta actualizada' : 'Cuenta agregada');
  };
}

/* ---------- Ajustes y respaldo ---------- */
function renderAjustes() {
  const lb = S.settings.lastBackup;
  $('#view').innerHTML = `
    <section class="block">
      <h2>Respaldo en Google Drive</h2>
      ${D.connected ? `<p class="small muted" style="margin:0 0 12px">Conectado. Cada cambio se respalda solo en la carpeta "Finanzas Personales" de tu Drive, y se guarda una copia por mes. ${D.last ? `Último respaldo: ${new Date(D.last).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.` : ''}${D.dirty ? ' Hay cambios pendientes.' : ''}${driveOk() ? '' : ' La sesión de Google venció: el próximo respaldo te pedirá confirmarla.'}</p>
      <div class="actions"><button class="btn" id="dNow">Respaldar ahora</button><button class="btn ghost" id="dRes">Restaurar</button></div>
      <button class="btn ghost wide" id="dOff" style="margin-top:10px">Desconectar Drive</button>`
      : `<p class="small muted" style="margin:0 0 12px">Conecta tu cuenta de Google y tus datos se respaldarán solos. La app solo puede ver los archivos que ella misma crea, nunca el resto de tu Drive.</p>
      <div class="actions"><button class="btn" id="dCon">Conectar Google Drive</button><button class="btn ghost" id="dRes">Restaurar desde Drive</button></div>`}
    </section>
    <section class="block">
      <h2>Respaldo manual</h2>
      <p class="small muted" style="margin:0 0 12px">Un archivo que guardas donde quieras. ${lb ? `Último respaldo: ${dayLabel(lb).toLowerCase()}.` : ''}</p>
      <div class="actions"><button class="btn ghost" id="exp">Exportar archivo</button><button class="btn ghost" id="imp">Importar archivo</button></div>
    </section>
    <section class="block">
      <h2>Indicadores económicos</h2>
      <p class="small muted" style="margin:0 0 12px">Se usan en metas, informes y simulador de crédito. En la fase 4 se actualizarán solos, con tu confirmación.</p>
      <div class="grid2">
        <label class="f"><span>Inflación anual (IPC) %</span><input id="sIpc" inputmode="decimal" value="${S.settings.ipc != null ? String(S.settings.ipc).replace('.', ',') : ''}"></label>
        <label class="f"><span>Tasa de usura E.A. %</span><input id="sUsu" inputmode="decimal" value="${S.settings.usura != null ? String(S.settings.usura).replace('.', ',') : ''}" placeholder="Opcional"></label>
      </div>
      <p class="small muted" style="margin:-4px 0 10px">IPC: ${esc(S.settings.ipcDate || 'sin fuente')}. La usura la publica la Superfinanciera cada mes.</p>
      <button class="btn ghost wide" id="sEco">Guardar indicadores</button>
    </section>
    <section class="block">
      <h2>Seguridad</h2>
      <div class="actions"><button class="btn ghost" id="chg">Cambiar patrón</button><button class="btn ghost" id="lockNow">Bloquear ahora</button></div>
    </section>
    <section class="block">
      <h2>Datos</h2>
      <p class="small muted" style="margin:0 0 12px">${S.accounts.length} cuentas, ${S.txs.length} movimientos, ${S.recurring.length} fijos, ${Object.keys(S.budgets).length} límites, ${S.lessons.length} lecciones, ${S.debts.length} deudas, ${S.goals.length} metas.</p>
      <button class="btn danger wide" id="wipe">Borrar todos los datos</button>
    </section>
    <p class="small muted">Finanzas Personales ${VERSION}</p>`;
  $('#exp').onclick = exportData;
  if ($('#dCon')) $('#dCon').onclick = () => driveAuth('connect');
  if ($('#dNow')) $('#dNow').onclick = () => driveBackup(false);
  if ($('#dOff')) $('#dOff').onclick = driveDisconnect;
  $('#dRes').onclick = driveRestoreSheet;
  $('#sEco').onclick = async () => {
    const i = parseFloat(($('#sIpc').value || '').replace(',', '.')), u = parseFloat(($('#sUsu').value || '').replace(',', '.'));
    if (!(i >= -5 && i < 100)) { toast('Revisa el valor de inflación.'); return; }
    if (i !== S.settings.ipc) S.settings.ipcDate = 'ingresado manualmente el ' + shortFmt.format(new Date());
    S.settings.ipc = i; S.settings.usura = u > 0 ? u : null; await save(); refresh(); toast('Indicadores guardados');
  };
  $('#imp').onclick = () => $('#fileIn').click();
  $('#lockNow').onclick = () => showUnlock();
  $('#chg').onclick = () => showUnlock({ title: 'Patrón actual', onOk: () => showSetup({ title: 'Nuevo patrón', cancel: true, returnTo: 'ajustes', done: 'Patrón actualizado' }) });
  $('#wipe').onclick = async () => {
    if (!confirm('Esto borra cuentas, movimientos y fijos de este celular. ¿Ya tienes un respaldo?')) return;
    const w = prompt('Escribe BORRAR para confirmar.');
    if ((w || '').trim().toUpperCase() !== 'BORRAR') return;
    const lock = S.settings.lock; S = blank(); S.settings.lock = lock; await save(); go('inicio'); toast('Datos borrados');
  };
}

async function exportData() {
  const name = `finanzas-respaldo-${todayISO()}.json`;
  const data = backupJSON();
  const file = new File([data], name, { type: 'application/json' });
  const mark = async () => { S.settings.lastBackup = todayISO(); await save(); if (tab !== 'movs') refresh(); };
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Respaldo Finanzas Personales' }); await mark(); toast('Respaldo guardado'); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  await mark(); toast('Respaldo descargado');
}

async function restoreState(obj) {
  const st = obj && (obj.state || obj);
  if (!st || !Array.isArray(st.accounts) || !Array.isArray(st.txs)) { toast('Ese archivo no es un respaldo válido de la app.'); return; }
  if (!confirm(`El respaldo tiene ${st.accounts.length} cuentas y ${st.txs.length} movimientos. Reemplazará lo que hay en este celular. ¿Restaurar?`)) return;
  const lock = S.settings.lock;
  S = { ...blank(), ...st, settings: { ...blank().settings, ...(st.settings || {}), lock, fails: 0, lockUntil: 0 } };
  S.recurring = S.recurring || []; S.budgets = S.budgets || {}; S.lessons = S.lessons || []; S.debts = S.debts || []; S.goals = S.goals || [];
  runRecurring(); await save(); closeSheet(); go('inicio'); toast('Datos restaurados');
}

$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await restoreState(JSON.parse(await f.text())); }
  catch (err) { toast('Ese archivo no es un respaldo válido de la app.'); }
});

/* ---------- Google Drive: respaldo automático (fase 4a) ----------
   Permiso drive.file: la app solo ve los archivos que ella misma crea. */
const G_CLIENT = '1018549599126-2qabmmv1vrhuqis01e6met5pskn4h1dc.apps.googleusercontent.com';
const G_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const G_REDIRECT = location.hostname.endsWith('github.io') ? 'https://sirkujo7-creator.github.io/finanzas-personales/' : location.origin + location.pathname;
const G_API = 'https://www.googleapis.com/drive/v3/files';
const G_UP = 'https://www.googleapis.com/upload/drive/v3/files';
let D = { connected: false, token: null, exp: 0, folderId: null, fileId: null, monthly: {}, last: null, dirty: false, pending: null, pendingState: null };
let driveResume = null, driveTimer = null, driveBusy = false;
const driveSave = () => Store.set('drive', D).catch(() => {});
const driveOk = () => !!D.token && Date.now() < D.exp - 60000;

function driveAuth(action) {
  D.pending = action; D.pendingState = uid() + uid();
  driveSave().then(() => {
    const p = new URLSearchParams({ client_id: G_CLIENT, redirect_uri: G_REDIRECT, response_type: 'token', scope: G_SCOPE, include_granted_scopes: 'true', state: D.pendingState });
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  });
}

function driveCatch() {
  if (!/[#&](state|access_token|error)=/.test(location.hash)) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (!D.pendingState || h.get('state') !== D.pendingState) return { err: 'state' };
  const action = D.pending; D.pending = null; D.pendingState = null;
  if (h.get('error')) return { err: h.get('error'), action };
  D.token = h.get('access_token'); D.exp = Date.now() + (+h.get('expires_in') || 3600) * 1000; D.connected = true;
  return { action };
}

async function gapi(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + D.token } });
  if (r.status === 401) { D.token = null; await driveSave(); const e = new Error('auth'); e.status = 401; throw e; }
  if (!r.ok) { const e = new Error('http'); e.status = r.status; throw e; }
  return r;
}

async function ensureFolder() {
  if (D.folderId) {
    try { const j = await (await gapi(`${G_API}/${D.folderId}?fields=id,trashed`)).json(); if (!j.trashed) return D.folderId; }
    catch (e) { if (e.status === 401) throw e; }
  }
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and name='Finanzas Personales' and trashed=false");
  const j = await (await gapi(`${G_API}?q=${q}&fields=files(id)`)).json();
  if (j.files && j.files[0]) D.folderId = j.files[0].id;
  else D.folderId = (await (await gapi(`${G_API}?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Finanzas Personales', mimeType: 'application/vnd.google-apps.folder' }) })).json()).id;
  await driveSave(); return D.folderId;
}

async function upsert(name, content, id) {
  const b = 'fp' + uid();
  const meta = id ? { name } : { name, parents: [D.folderId], mimeType: 'application/json' };
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${b}--`;
  const send = fid => gapi(fid ? `${G_UP}/${fid}?uploadType=multipart&fields=id` : `${G_UP}?uploadType=multipart&fields=id`,
    { method: fid ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  try { return (await (await send(id)).json()).id; }
  catch (e) { if (id && e.status === 404) return (await (await send(null)).json()).id; throw e; }
}

function backupJSON() {
  return JSON.stringify({ app: 'finanzas-personales', version: VERSION, exportedAt: new Date().toISOString(), state: { ...S, settings: { ...S.settings, lock: null, fails: 0, lockUntil: 0 } } });
}

async function driveBackup(quiet) {
  if (!driveOk()) { if (!quiet) driveAuth('backup'); return false; }
  if (!S.accounts.length && !S.txs.length) { if (!quiet) toast('No hay datos para respaldar. Si quieres recuperar tus datos, usa Restaurar.'); return false; }
  if (driveBusy) return false; driveBusy = true;
  try {
    await ensureFolder();
    const content = backupJSON(), mk = todayISO().slice(0, 7);
    D.fileId = await upsert('respaldo-actual.json', content, D.fileId);
    D.monthly = D.monthly || {};
    D.monthly[mk] = await upsert(`respaldo-${mk}.json`, content, D.monthly[mk]);
    D.last = new Date().toISOString(); D.dirty = false; await driveSave();
    S.settings.lastBackup = todayISO(); await Store.set('state', S);
    if (!quiet) toast('Respaldado en Google Drive');
    if (tab === 'ajustes' || tab === 'inicio') refresh();
    return true;
  } catch (e) {
    if (e.status === 401) { if (!quiet) driveAuth('backup'); }
    else if (!quiet) toast('No se pudo respaldar en Drive. Revisa tu conexión.');
    return false;
  } finally { driveBusy = false; }
}

function scheduleDrive() {
  clearTimeout(driveTimer);
  if (driveOk()) driveTimer = setTimeout(() => driveBackup(true), 4000);
}

async function driveRestoreSheet() {
  if (!driveOk()) { driveAuth('restore'); return; }
  openSheet('<h2>Restaurar desde Drive</h2><p class="hint">Buscando tus respaldos…</p>');
  try {
    await ensureFolder();
    const q = encodeURIComponent(`'${D.folderId}' in parents and trashed=false`);
    const files = ((await (await gapi(`${G_API}?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`)).json()).files || []);
    const when = t => new Date(t).toLocaleString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    openSheet(`<h2>Restaurar desde Drive</h2>
      ${files.length ? `<p class="hint">"Respaldo actual" es el más reciente. Los mensuales guardan cómo estaban tus datos en cada mes.</p>
      ${files.map(f => `<button class="tx" data-f="${esc(f.id)}"><span><span class="t">${f.name === 'respaldo-actual.json' ? 'Respaldo actual' : 'Respaldo de ' + esc(f.name.replace(/^respaldo-|\.json$/g, ''))}</span><span class="s">Guardado el ${when(f.modifiedTime)}</span></span></button>`).join('')}`
      : '<p class="hint">No hay respaldos de esta app en tu Drive todavía.</p>'}
      <div class="actions" style="margin-top:12px"><button class="btn ghost" id="cancel">Cerrar</button></div>`);
    $('#cancel').onclick = closeSheet;
    $$('[data-f]').forEach(el => el.onclick = async () => {
      try { await restoreState(await (await gapi(`${G_API}/${el.dataset.f}?alt=media`)).json()); }
      catch (e) { toast(e.status === 401 ? 'La sesión de Google venció. Intenta de nuevo.' : 'No se pudo leer ese respaldo.'); }
    });
  } catch (e) {
    if (e.status === 401) driveAuth('restore'); else { closeSheet(); toast('No se pudo conectar con Drive. Revisa tu conexión.'); }
  }
}

async function driveDisconnect() {
  if (!confirm('¿Desconectar Google Drive? Tus respaldos siguen en Drive; solo dejarán de hacerse automáticamente.')) return;
  if (D.token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(D.token), { method: 'POST' }).catch(() => {});
  D.token = null; D.exp = 0; D.connected = false; await driveSave(); refresh(); toast('Drive desconectado');
}

function runDriveResume() {
  const r = driveResume; driveResume = null;
  if (!r) return;
  if (r.err === 'state') { toast('La conexión con Google se abrió fuera de la app. Inténtalo de nuevo desde la app.'); return; }
  if (r.err) { toast(r.err === 'access_denied' ? 'No se dio permiso a Google Drive.' : 'No se pudo conectar con Google: ' + r.err); return; }
  if (r.action === 'restore') driveRestoreSheet();
  else driveBackup(false).then(ok => { if (ok && r.action === 'connect') toast('Drive conectado. Tus datos se respaldarán solos.'); });
}

/* ---------- Arranque ---------- */
async function boot() {
  await Store.open();
  S = await Store.get('state') || blank();
  S.settings = { ...blank().settings, ...(S.settings || {}) };
  S.recurring = S.recurring || []; S.budgets = S.budgets || {}; S.lessons = S.lessons || []; S.debts = S.debts || []; S.goals = S.goals || [];
  D = { ...D, ...(await Store.get('drive') || {}) };
  driveResume = driveCatch(); if (driveResume) await driveSave();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!S.settings.lock) showSetup(); else showUnlock();
}
boot();
})();
