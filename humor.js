// ============================================================================
// humor.js — Pesquisa semanal de humor (anônima).
//
// COMO A ANONIMATO FUNCIONA (por que ninguém consegue ver quem respondeu o quê):
//   - A NOTA nunca é gravada junto com a pessoa. Cada resposta só soma +1 num
//     CONTADOR do grupo (semana + filial + setor): mood_stats/{semana__filial__setor}
//     = { n1..n5, total }. Não existe "documento da resposta".
//   - Para a pesquisa não reaparecer na mesma semana, gravamos uma MARCA sem nota:
//     mood_marks/{cpfHash_semana} = { week }. Ela diz só "já respondeu", nunca o quê.
//     Ninguém lista essa coleção (regras do Firestore): o portal só pergunta
//     "a MINHA marca existe?".
//   - O painel só mostra um setor com 4+ respostas na semana. Setores menores
//     entram em "Outros", e se "Outros" ficar com 1 a 3 respostas, o menor setor
//     visível também é escondido (senão daria para descobrir por subtração:
//     total geral menos os setores visíveis).
// ============================================================================

import { db, doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, writeBatch } from './firebase.js';
import { increment } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { esc, escAttr, digits, toast } from './utils.js';

const MIN_GROUP = 4; // "mais de 3 respondentes"
const DISMISS_KEY = 'rgf_mood_seen';

// 5 = melhor, 1 = pior. Mesma ordem e cores da sugestão recebida.
const FACES = [
  { v: 5, label: 'Ótimo',     color: '#7fd1b9' },
  { v: 4, label: 'Bem',       color: '#8fb8ea' },
  { v: 3, label: 'Neutro',    color: '#b9bec7' },
  { v: 2, label: 'Mal',       color: '#f3c97a' },
  { v: 1, label: 'Muito mal', color: '#ef9fb0' }
];
const faceOf = v => FACES.find(f => f.v === v);

const DEFAULT_LOW_TEXT =
  'Obrigado por contar como você está. Semanas difíceis acontecem, e você não precisa passar por isso sozinho. ' +
  'Abaixo estão os apoios que a empresa oferece. Procure quem você preferir, quando achar necessário.';

// --- Rostinhos (SVG, sem depender de emoji do celular) ----------------------
function faceSVG(v, size = 44) {
  const mouth = {
    5: '<path d="M14 26c3 5 13 5 16 0" stroke-width="2.6"/><path d="M14 17c1.5-2 4-2 5.5 0M24.5 17c1.5-2 4-2 5.5 0" stroke-width="2.4"/>',
    4: '<path d="M15 26c3 3.5 11 3.5 14 0" stroke-width="2.6"/><circle cx="16.5" cy="17.5" r="1.8" fill="currentColor"/><circle cx="27.5" cy="17.5" r="1.8" fill="currentColor"/>',
    3: '<path d="M15.5 27.5h13" stroke-width="2.6"/><circle cx="16.5" cy="17.5" r="1.8" fill="currentColor"/><circle cx="27.5" cy="17.5" r="1.8" fill="currentColor"/>',
    2: '<path d="M15 29.5c3-3.5 11-3.5 14 0" stroke-width="2.6"/><circle cx="16.5" cy="17.5" r="1.8" fill="currentColor"/><circle cx="27.5" cy="17.5" r="1.8" fill="currentColor"/>',
    1: '<path d="M15 30c3-4 11-4 14 0" stroke-width="2.6"/><path d="M14 19c1.8 1.2 4 1.2 5.5-.5M24.5 18.5c1.5 1.7 3.7 1.7 5.5.5" stroke-width="2.4"/>'
  }[v];
  return `<svg width="${size}" height="${size}" viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="22" cy="22" r="18" stroke-width="2.6"/>${mouth}</svg>`;
}

// --- Semanas (ISO: segunda a domingo) ----------------------------------------
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}
function weekMonday(key) {
  const [y, w] = String(key).split('-W').map(Number);
  const jan4 = new Date(y, 0, 4);
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
  return mon;
}
function weekShift(key, delta) {
  const d = weekMonday(key);
  d.setDate(d.getDate() + 7 * delta);
  return weekKey(d);
}
function weekLabel(key) {
  const a = weekMonday(key);
  const b = new Date(a); b.setDate(a.getDate() + 6);
  const f = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${f(a)} a ${f(b)}`;
}

// --- Dados -------------------------------------------------------------------
const nk = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const slug = (s, empty) => nk(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || empty;
const markId = (h, wk) => `${h}_${wk}`;
const statsId = (wk, unit, dept) => `${wk}__${slug(unit, 'sem-filial')}__${slug(dept, 'sem-setor')}`;

async function hasAnswered(h, wk) {
  const s = await getDoc(doc(db, 'mood_marks', markId(h, wk)));
  return s.exists();
}

// Grava a marca ("já respondeu") e soma +1 no contador do grupo, juntas
// (batch: ou as duas entram, ou nenhuma). A nota não fica ligada à pessoa.
async function submitMood(employee, v) {
  const wk = weekKey();
  const batch = writeBatch(db);
  batch.set(doc(db, 'mood_marks', markId(employee.id, wk)), { week: wk });
  const inc = {};
  for (let i = 1; i <= 5; i++) inc['n' + i] = increment(i === v ? 1 : 0);
  batch.set(doc(db, 'mood_stats', statsId(wk, employee.unit, employee.department)), {
    week: wk,
    unit: String(employee.unit || '').trim(),
    department: String(employee.department || '').trim(),
    ...inc,
    total: increment(1)
  }, { merge: true });
  await batch.commit();
}

async function listStats(weeks) {
  const out = [];
  // 'in' aceita até 30 valores; usamos no máximo 8 semanas.
  const snap = await getDocs(query(collection(db, 'mood_stats'), where('week', 'in', weeks)));
  snap.forEach(d => out.push(d.data()));
  return out;
}

// ============================================================================
// PORTAL DO FUNCIONÁRIO
// ============================================================================
let cssDone = false;
function injectCss() {
  if (cssDone) return; cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
  .mood-box{position:relative;width:min(420px,100%);background:#fff;padding:26px 18px 18px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.35);max-height:100%;overflow:auto}
  .mood-box h3{margin:0 0 6px;font-size:21px;line-height:26px;font-weight:800;color:var(--ink,#15201a);text-transform:uppercase}
  .mood-sub{margin:0 0 18px;font-size:13.5px;color:var(--muted,#5d6a62);line-height:1.5}
  .mood-faces{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-bottom:16px}
  .mood-face{border:0;background:transparent;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;padding:4px 0;color:#15201a;font-size:11px;font-weight:600}
  .mood-face i{width:54px;height:54px;border-radius:50%;display:grid;place-items:center;transition:transform .12s}
  .mood-face:active i,.mood-face:focus-visible i{transform:scale(1.08)}
  .mood-face:disabled{opacity:.45;cursor:default}
  .mood-lock{display:flex;gap:10px;align-items:flex-start;text-align:left;background:var(--lima-bg,#e7f2d2);color:#2f4a0c;padding:11px 12px;font-size:12.5px;line-height:1.5;margin-bottom:12px}
  .mood-skip{border:0;background:transparent;color:var(--muted,#5d6a62);font-weight:600;font-size:13.5px;min-height:44px;cursor:pointer;width:100%}
  .mood-help{text-align:left}
  .mood-help p{font-size:14px;line-height:1.6;margin:0 0 14px;color:var(--ink,#15201a);white-space:pre-line}
  .mood-help .lbl{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--verde,#024f2b);margin:14px 0 8px}
  .mood-go{display:flex;align-items:center;gap:10px;width:100%;background:#fff;border:1px solid var(--line,#dde5de);padding:12px 14px;min-height:50px;
    font-size:14px;font-weight:700;color:var(--verde,#024f2b);text-align:left;cursor:pointer;margin-bottom:8px;text-decoration:none}
  .mood-go span{margin-left:auto}
  .mood-cvv{font-size:13px;color:var(--muted,#5d6a62);line-height:1.6;border-top:1px solid var(--line,#dde5de);padding-top:12px;margin-top:6px}
  .mood-cvv b{color:var(--ink,#15201a)}`;
  document.head.appendChild(st);
}

// Espera os comunicados (pop-ups) fecharem antes de abrir a pesquisa.
function waitNoOverlay() {
  return new Promise(res => {
    const tick = () => (document.querySelector('.comm-overlay') ? setTimeout(tick, 400) : res());
    tick();
  });
}
function seenThisWeek(wk) { try { return localStorage.getItem(DISMISS_KEY) === wk; } catch (e) { return false; } }
function markSeen(wk) { try { localStorage.setItem(DISMISS_KEY, wk); } catch (e) {} }

const HEALTH_CATS = ['saude', 'saude mental', 'bem-estar', 'bem estar', 'qualidade de vida'];

// Chamada pelo index.html logo após o login (ou ao reabrir o app).
// ctx = { benefits: benefícios visíveis para a pessoa, canSchedule: filial tem atendimento? }
async function maybeShowMood(S, ctx = {}) {
  const st = S && S.settings;
  if (!S || !S.employee || !st || !st.moodEnabled) return;
  const wk = weekKey();
  if (seenThisWeek(wk)) return;                 // já viu (respondeu ou pulou) neste aparelho
  let done = false;
  try { done = await hasAnswered(S.employee.id, wk); } catch (e) { return; }
  if (done) { markSeen(wk); return; }           // respondeu em outro aparelho
  await waitNoOverlay();
  if (!S.employee || document.querySelector('.mood-overlay')) return;
  injectCss();
  markSeen(wk); // aparece só no 1º acesso da semana, mesmo que a pessoa pule

  const wrap = document.createElement('div');
  wrap.className = 'comm-overlay mood-overlay';
  const close = () => wrap.remove();
  const go = fn => { close(); fn(); };

  wrap.innerHTML = `<div class="mood-box" role="dialog" aria-modal="true" aria-labelledby="mood-t">
    <h3 id="mood-t">Como você está esta semana?</h3>
    <p class="mood-sub">Toque no rostinho que mais combina com você.</p>
    <div class="mood-faces">${FACES.map(f => `<button class="mood-face" data-v="${f.v}" aria-label="${escAttr(f.label)}">
      <i style="background:${f.color}">${faceSVG(f.v)}</i>${esc(f.label)}</button>`).join('')}</div>
    <div class="mood-lock"><span>🔐</span><span><b>Resposta anônima.</b> Não guardamos quem respondeu o quê,
      nem para o RH. A empresa vê só o resultado do grupo, e um setor só aparece com 4 respostas ou mais.</span></div>
    <button class="mood-skip">Agora não</button></div>`;
  wrap.querySelector('.mood-skip').onclick = close;

  wrap.querySelectorAll('.mood-face').forEach(btn => btn.onclick = async () => {
    const v = Number(btn.dataset.v);
    wrap.querySelectorAll('.mood-face').forEach(b => { b.disabled = true; });
    try { await submitMood(S.employee, v); }
    catch (e) {
      wrap.querySelectorAll('.mood-face').forEach(b => { b.disabled = false; });
      toast('Não consegui registrar agora. Tente de novo.');
      return;
    }
    if (v >= 3) { close(); toast('Obrigado por responder!'); return; }
    showHelp(wrap.querySelector('.mood-box'), st, ctx, go, close);
  });
  document.body.appendChild(wrap);
}

// Nota baixa: mostra os apoios que a empresa tem. Nada disso é registrado.
function showHelp(box, st, ctx, go, close) {
  const psych = digits(st.psychWhats || '');
  const health = (ctx.benefits || []).filter(b => HEALTH_CATS.includes(nk(b.category))).slice(0, 4);
  const items = [];
  if (psych) items.push(['💚', 'Apoio psicológico' + (st.psychName ? ` · ${st.psychName}` : ''), () => window.__openScreen && window.__openScreen('psych')]);
  if (ctx.canSchedule) items.push(['🩺', 'Agendar atendimento', () => window.__openScreen && window.__openScreen('schedule')]);
  health.forEach(b => items.push(['✚', b.name, () => window.__openBenefit && window.__openBenefit(b.id)]));

  box.innerHTML = `<div class="mood-help">
    <h3 style="text-align:center">Estamos aqui</h3>
    <p>${esc(String(st.moodLowText || '').trim() || DEFAULT_LOW_TEXT)}</p>
    ${items.length ? '<div class="lbl">Você pode contar com</div>' : ''}
    ${items.map((it, i) => `<button class="mood-go" data-i="${i}">${it[0]} ${esc(it[1])}<span>›</span></button>`).join('')}
    ${st.psychShowCvv !== false ? `<div class="mood-cvv">Se precisar falar com alguém agora, o <b>CVV</b> atende de graça,
      24 horas: ligue <b>188</b> ou acesse <a href="https://www.cvv.org.br" target="_blank" rel="noopener">cvv.org.br</a>.</div>` : ''}
    <button class="mood-skip" style="margin-top:8px">Fechar</button></div>`;
  box.querySelector('.mood-skip').onclick = close;
  box.querySelectorAll('.mood-go').forEach(b => b.onclick = () => go(items[Number(b.dataset.i)][2]));
}

// ============================================================================
// PAINEL RH — aba "Clima da equipe"
// ============================================================================
const M = { week: weekKey(), rows: [], loaded: '' };

function canSeeMood(admin) { return !!admin && admin.moodAccess === true; }

async function loadMood() {
  const weeks = [];
  for (let i = 7; i >= 0; i--) weeks.push(weekShift(M.week, -i));
  M.weeks = weeks;
  M.rows = await listStats(weeks);
  M.loaded = M.week;
}
function sumRows(rows) {
  const t = { n1: 0, n2: 0, n3: 0, n4: 0, n5: 0, total: 0 };
  rows.forEach(r => { for (const k in t) t[k] += Number(r[k] || 0); });
  return t;
}
const avgOf = t => t.total ? (t.n1 + 2 * t.n2 + 3 * t.n3 + 4 * t.n4 + 5 * t.n5) / t.total : 0;
const lowPct = t => t.total ? Math.round(100 * (t.n1 + t.n2) / t.total) : 0;

// Esconde grupos pequenos e protege contra descoberta por subtração.
function suppress(groups) {
  let visible = groups.filter(g => g.total >= MIN_GROUP).sort((a, b) => a.total - b.total);
  let hidden = groups.filter(g => g.total < MIN_GROUP);
  let hiddenSum = hidden.reduce((s, g) => s + g.total, 0);
  while (hiddenSum > 0 && hiddenSum < MIN_GROUP && visible.length) {
    const g = visible.shift(); hidden.push(g); hiddenSum += g.total;
  }
  return { visible, hidden, hiddenSum };
}

function distBar(t) {
  if (!t.total) return '';
  return `<div style="display:flex;height:12px;min-width:160px;border:1px solid var(--line)">${FACES.map(f => {
    const n = t['n' + f.v]; return n ? `<span title="${escAttr(f.label)}: ${n}" style="width:${100 * n / t.total}%;background:${f.color}"></span>` : '';
  }).join('')}</div>`;
}
function avgChip(t) {
  const a = avgOf(t);
  const f = faceOf(Math.round(a)) || FACES[2];
  return `<span style="display:inline-flex;align-items:center;gap:8px;font-weight:800"><i style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:${f.color}">${faceSVG(f.v, 24)}</i>${a.toFixed(1).replace('.', ',')}</span>`;
}

// ctx = { isMatriz, myUnit }
function moodView(ctx) {
  const st = ctx.settings || {};
  const inScope = r => ctx.isMatriz || nk(r.unit) === nk(ctx.myUnit);
  const rows = M.rows.filter(r => r.week === M.week && inScope(r));
  const all = sumRows(rows);
  const isCur = M.week === weekKey();

  const head = `<div class="rh-head"><div>
      <div class="eyebrow">Pessoas${ctx.isMatriz ? '' : ' · ' + esc(ctx.myUnit)}</div>
      <h1>Clima da equipe</h1>
      <p>Pesquisa semanal de humor, anônima. Ninguém, nem o administrador, consegue ver a resposta de uma pessoa. Um setor só aparece com ${MIN_GROUP} ou mais respostas na semana.</p></div>
    <div style="display:flex;align-items:center;gap:8px">
      <button class="btn line sm" onclick="window.__moodWeek(-1)" aria-label="Semana anterior">‹</button>
      <b style="min-width:150px;text-align:center">${isCur ? 'Esta semana' : 'Semana'}<br><span class="muted" style="font-weight:500;font-size:12.5px">${esc(weekLabel(M.week))}</span></b>
      <button class="btn line sm" onclick="window.__moodWeek(1)" ${isCur ? 'disabled' : ''} aria-label="Próxima semana">›</button></div></div>`;

  const off = !st.moodEnabled ? `<div class="hint" style="background:var(--warnSoft)">⚠️ A pesquisa está <b>desligada</b>: os funcionários não estão vendo. ${ctx.isMatriz ? 'Ligue em “Configuração da pesquisa”, abaixo.' : 'Quem liga é a matriz.'}</div>` : '';

  let body;
  if (all.total < MIN_GROUP) {
    body = `<div class="panel"><div class="empty">${all.total ? `Só ${all.total} resposta(s) nesta semana.` : 'Nenhuma resposta nesta semana.'} O resultado aparece a partir de ${MIN_GROUP} respostas, para ninguém ser identificado.</div></div>`;
  } else {
    const { visible, hidden, hiddenSum } = suppress(rows.map(r => ({ ...r, total: Number(r.total || 0) })));
    const groupRow = (name, sub, t) => `<tr><td><b>${esc(name)}</b>${sub ? `<br><span class="muted" style="font-size:12px">${esc(sub)}</span>` : ''}</td>
      <td>${avgChip(t)}</td><td>${distBar(t)}</td><td>${t.total}</td>
      <td>${lowPct(t) >= 30 ? `<span class="tag warn">${lowPct(t)}%</span>` : lowPct(t) + '%'}</td></tr>`;
    const tableRows = visible
      .sort((a, b) => nk(a.unit).localeCompare(nk(b.unit)) || nk(a.department).localeCompare(nk(b.department)))
      .map(g => groupRow(g.department || 'Sem setor', ctx.isMatriz ? (g.unit || 'Sem filial') : '', g)).join('')
      + (visible.length && hidden.length ? groupRow('Outros', `${hidden.length} setor(es) com poucas respostas, juntos`, sumRows(hidden)) : '');

    body = `<div class="cards-grid">
        <div class="kpi"><b>${all.total}</b><span>respostas na semana</span></div>
        <div class="kpi" style="border-top-color:#8fb8ea"><b>${avgOf(all).toFixed(1).replace('.', ',')}</b><span>média geral (1 a 5)</span></div>
        <div class="kpi" style="border-top-color:#ef9fb0"><b>${lowPct(all)}%</b><span>responderam “mal” ou “muito mal”</span></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Resultado geral</h2>${distLegend()}</div>
        <div class="panel-body">${distBar(all)}</div></div>
      <div class="panel"><div class="panel-head"><h2>Por setor</h2></div>
        ${visible.length ? `<table><thead><tr><th>Setor</th><th>Média</th><th>Distribuição</th><th>Respostas</th><th>Em baixa</th></tr></thead>
          <tbody>${tableRows}</tbody></table>`
          : `<div class="empty">Nenhum setor chegou a ${MIN_GROUP} respostas nesta semana. Veja só o resultado geral.</div>`}
        </div>`;
  }
  return head + off + body + trendPanel(inScope) + (ctx.isMatriz ? settingsPanel(st) : '');
}
function distLegend() {
  return `<div style="display:flex;gap:12px;flex-wrap:wrap">${FACES.map(f =>
    `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600"><span style="width:10px;height:10px;background:${f.color}"></span>${esc(f.label)}</span>`).join('')}</div>`;
}
function trendPanel(inScope) {
  const items = (M.weeks || []).map(wk => {
    const t = sumRows(M.rows.filter(r => r.week === wk && inScope(r)));
    const ok = t.total >= MIN_GROUP;
    const a = ok ? avgOf(t) : 0;
    const f = ok ? faceOf(Math.round(a)) : null;
    return `<div style="flex:1;min-width:52px;display:flex;flex-direction:column;align-items:center;gap:6px">
      <div style="height:110px;width:100%;display:flex;align-items:flex-end;justify-content:center">
        ${ok ? `<div title="${t.total} respostas" style="width:70%;height:${Math.max(6, (a / 5) * 100)}%;background:${f.color}"></div>` : '<div class="muted" style="font-size:11px">—</div>'}</div>
      <b style="font-size:13px">${ok ? a.toFixed(1).replace('.', ',') : ''}</b>
      <span class="muted" style="font-size:11px">${esc(weekLabel(wk).slice(0, 5))}</span></div>`;
  }).join('');
  return `<div class="panel"><div class="panel-head"><h2>Últimas 8 semanas</h2><span class="muted" style="font-size:12.5px">média geral · semanas com menos de ${MIN_GROUP} respostas ficam em branco</span></div>
    <div class="panel-body" style="display:flex;gap:6px">${items}</div></div>`;
}
function settingsPanel(st) {
  return `<div class="panel"><div class="panel-head"><h2>Configuração da pesquisa</h2></div><div class="panel-body">
    <label class="check" style="margin-bottom:14px"><input type="checkbox" id="md-on" ${st.moodEnabled ? 'checked' : ''}> Pesquisa ligada (aparece no 1º acesso de cada semana)</label>
    <label class="lbl">Mensagem para quem responder “mal” ou “muito mal”</label>
    <textarea class="field" id="md-low" style="min-height:96px">${esc(st.moodLowText || DEFAULT_LOW_TEXT)}</textarea>
    <p class="muted" style="font-size:12.5px;margin:6px 0 14px">Abaixo da mensagem aparecem, automaticamente: o apoio psicológico (Configurações), o agendamento de atendimento (se a filial tiver), os benefícios das categorias Saúde/Bem-estar e o CVV.</p>
    <button class="btn" onclick="window.__moodSave()">Salvar</button></div></div>`;
}

async function saveMoodSettings() {
  const data = {
    moodEnabled: !!document.getElementById('md-on')?.checked,
    moodLowText: (document.getElementById('md-low')?.value || '').trim(),
    updatedAt: Date.now()
  };
  await setDoc(doc(db, 'settings', 'main'), data, { merge: true });
  return data;
}
async function setMoodAccess(uid, on) {
  await updateDoc(doc(db, 'admins', uid), { moodAccess: !!on, updatedAt: Date.now() });
}

export {
  MIN_GROUP, FACES, weekKey, weekShift, weekLabel, suppress,
  maybeShowMood, submitMood, hasAnswered,
  M as moodState, canSeeMood, loadMood, moodView, saveMoodSettings, setMoodAccess
};
