/* Finanzas Personales — Fase 1
   Base: patrón de acceso, cuentas, registro rápido, movimientos fijos,
   4x1000, "¿cuánto puedo gastar hoy?" y respaldo. Datos solo en este dispositivo. */
(() => {
'use strict';

const VERSION = '1.0.0 (fase 1)';
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

const blank = () => ({ v: 1, accounts: [], txs: [], recurring: [], settings: { lock: null, fails: 0, lockUntil: 0, lastBackup: null, lastAcc: null } });
let S = null;
const save = () => Store.set('state', S).catch(() => toast('No se pudo guardar. Revisa el espacio del celular.'));

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
const TITLES = { inicio: 'Inicio', movs: 'Movimientos', cuentas: 'Cuentas', ajustes: 'Ajustes' };

function enterApp(to) {
  clearInterval(lockTimer);
  $('#lock').hidden = true; $('#lock').innerHTML = ''; $('#app').hidden = false; $('#tabs').hidden = false;
  const n = runRecurring();
  if (n) { save(); toast(`${n} movimiento${n > 1 ? 's' : ''} fijo${n > 1 ? 's' : ''} registrado${n > 1 ? 's' : ''}`); }
  go(to || tab);
}
function go(t) {
  tab = t; $('#title').textContent = TITLES[t];
  $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ({ inicio: renderInicio, movs: renderMovs, cuentas: renderCuentas, ajustes: renderAjustes })[t]();
  window.scrollTo(0, 0);
}
const refresh = () => go(tab);
$$('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
$('#fab').addEventListener('click', () => S.accounts.length ? entrySheet() : accountSheet(null, true));

/* ---------- Inicio ---------- */
function renderInicio() {
  const v = $('#view');
  if (!S.accounts.length) {
    v.innerHTML = `<div class="empty"><strong>Empieza por tus cuentas</strong><p>Agrega dónde tienes tu dinero: banco, Nequi, efectivo o tarjeta de crédito. Con eso la app calcula cuánto puedes gastar cada día.</p><button class="btn" id="addAcc">Agregar cuenta</button></div>`;
    $('#addAcc').onclick = () => accountSheet(null, true); return;
  }
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const [, end, last] = monthRange(y, m);
  const { liquid, debt, net } = totals();
  const pend = upcoming(end);
  const pendExp = pend.filter(p => p.r.type === 'gasto' && (accById(p.r.accountId) || {}).type !== 'credito').reduce((s, p) => s + p.r.amount + calcGmf(p.r.accountId, 'gasto', p.r.amount), 0);
  const pendInc = pend.filter(p => p.r.type === 'ingreso').reduce((s, p) => s + p.r.amount, 0);
  const daysLeft = last - now.getDate() + 1;
  const avail = liquid - pendExp;
  const perDay = avail / daysLeft;
  const st = monthStats(y, m);
  const saving = st.inc - st.exp;
  const rate = st.inc ? Math.round(saving / st.inc * 100) : null;

  let notices = '';
  const lb = S.settings.lastBackup;
  const daysSince = lb ? Math.floor((Date.now() - parseISO(lb)) / 864e5) : null;
  if (S.txs.length >= 5 && (lb === null || daysSince >= 7))
    notices += `<div class="notice"><span>${lb ? `Tu último respaldo fue hace ${daysSince} días.` : 'Aún no tienes un respaldo de tus datos.'}</span><button class="btn sm" id="bk">Respaldar</button></div>`;

  const heroText = avail >= 0
    ? `<p>Tienes ${money(avail)} para los ${daysLeft} ${daysLeft === 1 ? 'día' : 'días'} que quedan del mes, después de apartar ${money(pendExp)} de pagos fijos.</p>`
    : `<p>Tus pagos fijos pendientes superan tu dinero disponible en ${money(-avail)}. Revisa qué gasto puedes aplazar.</p>`;

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
  if ($('#bk')) $('#bk').onclick = exportData;
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
    <p class="small muted" id="info" style="margin:0 0 6px;min-height:1.2em"></p>
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);

  const amt = bindAmount($('#amt'), d.amount);
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
  const info = () => {
    const g = calcGmf($('#acc').value, type, amt.get());
    $('#info').textContent = g ? `Se suman ${money(g)} de 4x1000.` : '';
  };
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

/* ---------- Cuentas ---------- */
function renderCuentas() {
  const v = $('#view');
  const { liquid, debt } = totals();
  v.innerHTML = `
    ${S.accounts.length ? `<div class="sumline" style="margin-bottom:10px"><span>Disponible <b>${money(liquid)}</b></span><span>Deuda <b class="${debt > 0 ? 'neg' : ''}">${money(debt)}</b></span></div>
    <div class="panel">${S.accounts.map(a => { const b = accBalance(a); const cr = a.type === 'credito';
      return `<button class="tx" data-acc="${a.id}"><span><span class="t">${esc(a.name)}</span><span class="s">${ACC_TYPES[a.type]}${a.gmf ? ', cobra 4x1000' : ''}</span></span><span class="amt ${cr && b < 0 ? 'neg' : b < 0 ? 'neg' : ''}">${cr ? (b < 0 ? 'Debes ' + money(-b) : money(b)) : money(b)}</span></button>`; }).join('')}</div>`
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
    <div class="actions">${edit ? '<button class="btn ghost" id="del">Eliminar</button>' : first ? '' : '<button class="btn ghost" id="cancel">Cancelar</button>'}<button class="btn" id="save">Guardar</button></div>`);
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
      <h2>Respaldo</h2>
      <p class="small muted" style="margin:0 0 12px">Tus datos viven solo en este celular. Guarda un respaldo en Google Drive con el menú de compartir. ${lb ? `Último respaldo: ${dayLabel(lb).toLowerCase()}.` : 'Aún no has hecho ninguno.'}</p>
      <div class="actions"><button class="btn" id="exp">Respaldar ahora</button><button class="btn ghost" id="imp">Restaurar</button></div>
    </section>
    <section class="block">
      <h2>Seguridad</h2>
      <div class="actions"><button class="btn ghost" id="chg">Cambiar patrón</button><button class="btn ghost" id="lockNow">Bloquear ahora</button></div>
    </section>
    <section class="block">
      <h2>Datos</h2>
      <p class="small muted" style="margin:0 0 12px">${S.accounts.length} cuentas, ${S.txs.length} movimientos, ${S.recurring.length} fijos.</p>
      <button class="btn danger wide" id="wipe">Borrar todos los datos</button>
    </section>
    <p class="small muted">Finanzas Personales ${VERSION}</p>`;
  $('#exp').onclick = exportData;
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
  const data = JSON.stringify({ app: 'finanzas-personales', exportedAt: new Date().toISOString(), state: { ...S, settings: { ...S.settings, lock: null } } });
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

$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const st = obj.state || obj;
    if (!Array.isArray(st.accounts) || !Array.isArray(st.txs)) throw new Error('formato');
    if (!confirm(`El respaldo tiene ${st.accounts.length} cuentas y ${st.txs.length} movimientos. Reemplazará lo que hay en este celular. ¿Restaurar?`)) return;
    const lock = S.settings.lock;
    S = { ...blank(), ...st, settings: { ...blank().settings, ...(st.settings || {}), lock, fails: 0, lockUntil: 0 } };
    S.recurring = S.recurring || [];
    runRecurring(); await save(); go('inicio'); toast('Datos restaurados');
  } catch (err) { toast('Ese archivo no es un respaldo válido de la app.'); }
});

/* ---------- Arranque ---------- */
async function boot() {
  await Store.open();
  S = await Store.get('state') || blank();
  S.settings = { ...blank().settings, ...(S.settings || {}) };
  S.recurring = S.recurring || [];
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!S.settings.lock) showSetup(); else showUnlock();
}
boot();
})();
