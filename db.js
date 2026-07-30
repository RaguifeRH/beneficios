// ============================================================================
// db.js — Camada de dados compartilhada (Funcionário + RH).
// ÚNICA fonte de verdade: antes este arquivo era copiado nos dois HTMLs e as
// cópias divergiram (o RH ganhou regras de perfil, o portal ficou para trás).
// ============================================================================

import {
  db, collection, doc, getDoc, getDocs, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, writeBatch, arrayUnion
} from './firebase.js';
import { cpfHash, cpfSafe, firstName, id, normalizeCpf, voucherCode } from './utils.js';

// ============================================================================
// db.js — Camada de dados. Toda leitura/escrita no Firestore passa por aqui.
// Coleções (as "gavetas etiquetadas"):
//   settings · profiles · benefits · employees · raffles
//   raffle_entries · raffle_winners · imports · audit_logs
//
// Decisões de privacidade (LGPD):
//   - O CPF aberto NUNCA é gravado. O ID do documento do funcionário é o
//     hash SHA-256 do CPF. Guardamos apenas cpfMasked + cpfHash(=id).
//   - O funcionário só consegue LER o próprio documento (getDoc por id = hash);
//     não consegue listar/enumerar a coleção. Quem manda nisso são as regras
//     do Firestore (ver firestore.rules), não só o código.
// ============================================================================




const col = name => collection(db, name);
const ref = (name, docId) => doc(db, name, docId);

// ----------------------------------------------------------------------------
// SETTINGS (documento único: settings/main)
// ----------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  portalName: 'Portal de Benefícios',
  companyName: 'Raguife',
  privacyText: 'Utilizamos seu CPF apenas para identificar seu cadastro e exibir os ' +
    'benefícios disponíveis conforme seu perfil. Seus dados não serão exibidos ' +
    'publicamente. Em caso de dúvidas, procure o RH/DP.',
  theme: 'green',
  cardEnabled: true,      // mostrar a carteirinha
  cardProfileIds: [],     // perfis que veem a carteirinha (vazio = todos)
  cardLabel: '',          // a que a carteirinha dá direito. Vazio = não mostra.
  cardHint: '',           // instrução exibida abaixo da carteirinha. Vazio = não mostra.
  // Canal de ajuda mostrado ao funcionário quando o CPF não é encontrado.
  // Sem isso, o erro de login vira um beco sem saída e a pessoa desiste.
  supportWhats: '',       // só dígitos com DDI+DDD. Ex.: 5511999999999
  supportEmail: '',

  // --- Canal de denúncias -------------------------------------------------
  // O acesso NÃO é registrado em lugar nenhum: o app do funcionário não grava
  // auditoria. Isso é dito na tela, porque sem essa garantia ninguém usa.
  reportUrl: '',          // URL externa do canal (hotline, formulário etc.)
  reportNote: '',         // como funciona, prazo de resposta, se aceita anônimo

  // --- Apoio psicológico ---------------------------------------------------
  psychWhats: '',         // WhatsApp da psicóloga organizacional (só dígitos)
  psychName: '',          // Ex.: "Ana Lima · psicóloga organizacional"
  psychNote: '',          // texto de confidencialidade
  psychShowCvv: true,     // mostra o CVV 188 como retaguarda 24h

  // --- Atendimentos médicos ------------------------------------------------
  medicalBookingUrl: '',  // link único de agendamento
  medicalNote: ''         // instrução (documentos, onde é, o que levar)
};

async function getSettings() {
  const snap = await getDoc(ref('settings', 'main')).catch(() => null);
  return Object.assign({}, DEFAULT_SETTINGS, snap && snap.exists() ? snap.data() : {});
}
async function saveSettings(data) {
  await setDoc(ref('settings', 'main'), { ...data, updatedAt: Date.now() }, { merge: true });
}

// COMUNICADO (aviso/arte que aparece ao funcionário após o login).
// Guardado em settings/communication (leitura pública, escrita só RH).
async function getCommunication() {
  const snap = await getDoc(ref('settings', 'communication')).catch(() => null);
  return snap && snap.exists() ? snap.data() : null;
}
async function saveCommunication(data) {
  await setDoc(ref('settings', 'communication'), { ...data, updatedAt: Date.now() }, { merge: true });
}

// ----------------------------------------------------------------------------
// PROFILES
// ----------------------------------------------------------------------------
const DEFAULT_PROFILES = [
  { id: 'p_raguife', name: 'Raguife' },
  { id: 'p_bd', name: 'Raguife BD' },
  { id: 'p_comercial', name: 'Comercial' },
  { id: 'p_aprendiz', name: 'Estagiário/Aprendiz' }
];

async function listProfiles() {
  const snap = await getDocs(col('profiles'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function saveProfile(p) {
  const docId = p.id || ('p_' + id());
  const data = {
    name: p.name || 'Perfil',
    description: p.description || '',
    active: p.active !== false,
    updatedAt: Date.now()
  };
  if (!p.id) data.createdAt = Date.now();
  await setDoc(ref('profiles', docId), data, { merge: true });
  return docId;
}
async function deleteProfile(profileId) {
  await deleteDoc(ref('profiles', profileId));
}
// Garante que os 4 perfis padrão existam (chamado no primeiro acesso do RH).
async function seedProfilesIfEmpty() {
  const existing = await listProfiles();
  if (existing.length) return existing;
  for (const p of DEFAULT_PROFILES) {
    await setDoc(ref('profiles', p.id), {
      name: p.name, description: '', active: true, createdAt: Date.now(), updatedAt: Date.now()
    });
  }
  return listProfiles();
}

// ----------------------------------------------------------------------------
// PROFILE RULES  (amarração automática: Sindicato + Tipo -> Perfil)
// Coleção: profile_rules. Cada regra = { sindicato, tipo, profileId, active }.
// Ideia: em vez de escrever o "Perfil" de cada funcionário na planilha, o RH
// cadastra poucas regras aqui e a importação etiqueta todo mundo sozinha.
// ----------------------------------------------------------------------------

// Normaliza um texto de comparação: sem acento, minúsculo, sem espaços nas pontas.
// Usado para casar "SÃO PAULO " com "sao paulo" sem drama.
function normKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

async function listProfileRules() {
  const snap = await getDocs(col('profile_rules'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) =>
    normKey(a.sindicato).localeCompare(normKey(b.sindicato)) ||
    normKey(a.tipo).localeCompare(normKey(b.tipo)));
}
async function saveProfileRule(r) {
  const docId = r.id || ('rule_' + id());
  const data = {
    sindicato: String(r.sindicato || '').trim(),
    tipo: String(r.tipo || '').trim(),
    profileId: String(r.profileId || '').trim(),
    active: r.active !== false,
    updatedAt: Date.now()
  };
  if (!r.id) data.createdAt = Date.now();
  await setDoc(ref('profile_rules', docId), data, { merge: true });
  return docId;
}
async function deleteProfileRule(ruleId) {
  await deleteDoc(ref('profile_rules', ruleId));
}

// Casa (sindicato, tipo) contra a lista de regras. Retorna o profileId ou ''.
// Prioridade: 1) regra exata sindicato+tipo; 2) regra "coringa" (tipo vazio na
// regra vale para QUALQUER tipo daquele sindicato). Assim o RH pode cadastrar
// uma regra geral por sindicato e só detalhar as exceções.
function matchRule(sindicato, tipo, rules) {
  const s = normKey(sindicato), t = normKey(tipo);
  if (!s) return '';
  let r = rules.find(x => x.active !== false && normKey(x.sindicato) === s && normKey(x.tipo) === t && t);
  if (r) return r.profileId;
  r = rules.find(x => x.active !== false && normKey(x.sindicato) === s && !normKey(x.tipo));
  if (r) return r.profileId;
  return '';
}

// ----------------------------------------------------------------------------
// BENEFITS
// ----------------------------------------------------------------------------
async function listBenefits() {
  const snap = await getDocs(col('benefits'));
  const out = [];
  snap.forEach(d => out.push(normalizeBenefit({ id: d.id, ...d.data() })));
  return out.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
}
function normalizeBenefit(b) {
  return {
    id: b.id,
    name: b.name || 'Benefício sem nome',
    category: b.category || 'Geral',
    description: b.description || '',
    details: b.details || '',
    iconBase64: b.iconBase64 || '',
    bannerBase64: b.bannerBase64 || '',
    icon: b.icon || '💸',
    iconFit: b.iconFit === 'cover' ? 'cover' : 'contain',
    color: Number.isInteger(b.color) ? b.color : 0,
    active: b.active !== false,
    actionRequired: !!b.actionRequired,
    featured: !!b.featured,
    isNew: !!b.isNew,
    responsible: b.responsible || '',
    startDate: b.startDate || '',
    endDate: b.endDate || '',
    order: Number.isFinite(Number(b.order)) ? Number(b.order) : 0,
    profileIds: Array.isArray(b.profileIds) ? b.profileIds : [],
    units: Array.isArray(b.units) ? b.units : [],
    links: Array.isArray(b.links) ? b.links : [],
    documents: Array.isArray(b.documents) ? b.documents : [],
    createdAt: b.createdAt || Date.now(),
    updatedAt: b.updatedAt || Date.now()
  };
}
async function saveBenefit(b) {
  const docId = b.id || ('b_' + id());
  const data = normalizeBenefit({ ...b, id: docId });
  delete data.id;
  data.updatedAt = Date.now();
  if (!b.id) data.createdAt = Date.now();
  await setDoc(ref('benefits', docId), data, { merge: true });
  return docId;
}
async function deleteBenefit(benefitId) {
  await deleteDoc(ref('benefits', benefitId));
}

// ----------------------------------------------------------------------------
// EMPLOYEES  (ID do documento = hash do CPF)
// ----------------------------------------------------------------------------

// Login do funcionário: busca SÓ o próprio documento, por id = hash do CPF.
// Retorna null se não existir na base ativa.
async function getEmployeeByCpf(cpf) {
  const h = await cpfHash(cpf);
  const snap = await getDoc(ref('employees', h)).catch(() => null);
  if (!snap || !snap.exists()) return null;
  return { id: h, ...snap.data() };
}

// Reabre a sessão pelo hash (guardamos o hash, nunca o CPF, no dispositivo).
async function getEmployeeByHash(h) {
  const snap = await getDoc(ref('employees', h)).catch(() => null);
  if (!snap || !snap.exists()) return null;
  return { id: h, ...snap.data() };
}

// Atualiza só os perfis de UM funcionário (correção manual no RH).
async function updateEmployeeProfiles(cpfHash, profileIds) {
  await updateDoc(ref('employees', cpfHash), {
    profileIds: Array.isArray(profileIds) ? profileIds : [],
    updatedAt: Date.now()
  });
}

// Listagem completa (somente RH).
async function listEmployees() {
  const snap = await getDocs(col('employees'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// Mapeia o texto da coluna "Perfil" da planilha para ids de perfis cadastrados.
function resolveProfileIds(profileText, profiles) {
  const raw = String(profileText || '').trim().toLowerCase();
  if (!raw) return [];
  // 1) tenta casar o TEXTO INTEIRO com um perfil (cobre "Estagiário/Aprendiz")
  const full = profiles.find(p => String(p.name).trim().toLowerCase() === raw);
  if (full) return [full.id];
  // 2) senão, divide por separadores e casa cada parte
  const names = raw.split(/[;,|/]/).map(x => x.trim()).filter(Boolean);
  return profiles
    .filter(p => names.includes(String(p.name).trim().toLowerCase()))
    .map(p => p.id);
}

// Decide o(s) perfil(is) de UMA linha da planilha.
// Regra de negócio (definida com o RH):
//   1) Se a coluna "Perfil" veio preenchida -> ela vence (correção manual).
//   2) Senão -> aplica a amarração automática por Sindicato + Tipo.
//   3) Senão -> fica sem perfil (entra no contador para o RH caçar).
// Retorna { profileIds, source } com source em 'manual' | 'rule' | 'none'.
function resolveEmployeeProfiles(row, profiles, rules) {
  const manual = resolveProfileIds(row.profile, profiles);
  if (manual.length) return { profileIds: manual, source: 'manual' };
  const pid = matchRule(row.sindicato, row.tipo, rules);
  if (pid && profiles.some(p => p.id === pid)) return { profileIds: [pid], source: 'rule' };
  return { profileIds: [], source: 'none' };
}

// IMPORTAÇÃO: a nova planilha SUBSTITUI completamente a base anterior.
// rows: [{ name, cpf, profile, unit?, department?, role?, ... }]
// Retorna o resumo (totais) para exibir e gravar no histórico.
async function importEmployees(rows, meta = {}) {
  const profiles = await listProfiles();
  const rules = await listProfileRules();
  const existing = await listEmployees();
  const existingIds = new Set(existing.map(e => e.id));

  // Monta os novos documentos.
  const newDocs = [];
  const newIds = new Set();
  const totalsByProfile = {};
  let withoutProfile = 0, byManual = 0, byRule = 0;

  for (const r of rows) {
    const cpf = normalizeCpf(r.cpf);
    if (cpf.length !== 11) continue;
    const h = await cpfHash(cpf);
    if (newIds.has(h)) continue; // evita CPF duplicado na própria planilha
    newIds.add(h);

    const { profileIds, source } = resolveEmployeeProfiles(r, profiles, rules);
    if (source === 'manual') byManual++;
    else if (source === 'rule') byRule++;
    else withoutProfile++;
    profileIds.forEach(pid => { totalsByProfile[pid] = (totalsByProfile[pid] || 0) + 1; });

    newDocs.push({
      id: h,
      data: {
        name: String(r.name || '').trim(),
        firstName: firstName(r.name),
        cpfMasked: cpfSafe(cpf),
        profileIds,
        profileSource: source,               // como o perfil foi atribuído
        profileRaw: String(r.profile || '').trim(),
        sindicato: String(r.sindicato || '').trim(),
        tipo: String(r.tipo || '').trim(),
        unit: String(r.unit || '').trim(),
        department: String(r.department || '').trim(),
        role: String(r.role || '').trim(),
        situation: String(r.situation || '').trim(),
        admissionDate: String(r.admissionDate || '').trim(),
        registry: String(r.registry || '').trim(),
        wonFilms: [],          // títulos de filmes já ganhos (trava do sorteio)
        status: 'active',
        importId: meta.importId || '',
        updatedAt: Date.now()
      }
    });
  }

  // IDs a remover = existentes que não estão na nova planilha.
  const toRemove = [...existingIds].filter(x => !newIds.has(x));

  // Executa em lotes (limite do Firestore: 500 operações por batch).
  const ops = [];
  toRemove.forEach(rid => ops.push({ type: 'del', id: rid }));
  newDocs.forEach(nd => ops.push({ type: 'set', id: nd.id, data: nd.data }));

  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    for (const op of ops.slice(i, i + 450)) {
      if (op.type === 'del') batch.delete(ref('employees', op.id));
      else batch.set(ref('employees', op.id), op.data);
    }
    await batch.commit();
  }

  const summary = {
    fileName: meta.fileName || '',
    totalEmployees: newDocs.length,
    totalAdded: newDocs.filter(nd => !existingIds.has(nd.id)).length,
    totalRemoved: toRemove.length,
    totalsByProfile,
    withoutProfile,
    byManual,               // perfil veio escrito na planilha
    byRule,                 // perfil resolvido por amarração automática
    createdAt: Date.now(),
    createdBy: meta.userEmail || ''
  };
  return summary;
}

// Histórico de importações.
async function saveImportRecord(summary) {
  const docRef = await addDoc(col('imports'), summary);
  return docRef.id;
}
async function listImports() {
  const snap = await getDocs(col('imports'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ----------------------------------------------------------------------------
// ESPECIALIDADES — taxonomia única, usada no cadastro do RH e no portal.
// Cores tiradas do protótipo da Agenda Médica (legenda do PDF).
// ----------------------------------------------------------------------------
const SPECIALTIES = [
  { id: 'clinica_geral', name: 'Clínica Geral',                      color: '#2563eb', icon: '🩺' },
  { id: 'fisio_laboral', name: 'Fisioterapia Laboral',               color: '#16a34a', icon: '🤸' },
  { id: 'psiquiatria',   name: 'Psiquiatria',                        color: '#9333ea', icon: '🧠' },
  { id: 'clinico_fisio', name: 'Atendimento Clínico (Fisioterapia)', color: '#f97316', icon: '🩹' },
  { id: 'cardiologia',   name: 'Cardiologia',                        color: '#dc2626', icon: '❤️' },
  { id: 'med_trabalho',  name: 'Médico do Trabalho',                 color: '#0891b2', icon: '🏥' },
  { id: 'outro',         name: 'Outro',                              color: '#64748b', icon: '📌' }
];
function specialtyOf(sid) {
  return SPECIALTIES.find(x => x.id === sid) || SPECIALTIES[SPECIALTIES.length - 1];
}
// Rótulo exibido: o título livre manda; sem ele, o nome da especialidade.
// Slots antigos (cadastrados antes das especialidades) continuam funcionando:
// caem em "Outro" e mostram o título que já tinham.
function slotLabel(slot) {
  return String(slot?.title || '').trim() || specialtyOf(slot?.specialty).name;
}

// ----------------------------------------------------------------------------
// MEDICAL SLOTS (atendimentos médicos)
// Coleção: medical_slots. Cada documento = uma data de atendimento em UMA filial.
// A filial é obrigatória: o funcionário só enxerga as datas da unidade dele.
// ----------------------------------------------------------------------------
function normalizeSlot(s) {
  return {
    id: s.id,
    date: String(s.date || ''),              // 'YYYY-MM-DD'
    startTime: String(s.startTime || ''),    // 'HH:MM'
    endTime: String(s.endTime || ''),
    unit: String(s.unit || '').trim(),
    specialty: SPECIALTIES.some(x => x.id === s.specialty) ? s.specialty : 'outro',
    title: String(s.title || '').trim(),
    professional: String(s.professional || '').trim(),
    note: String(s.note || '').trim(),
    active: s.active !== false
  };
}
async function listMedicalSlots() {
  const snap = await getDocs(col('medical_slots'));
  const out = [];
  snap.forEach(d => out.push(normalizeSlot({ id: d.id, ...d.data() })));
  return out.sort((a, b) =>
    (a.date || '').localeCompare(b.date || '') ||
    (a.startTime || '').localeCompare(b.startTime || ''));
}
async function saveMedicalSlot(slot) {
  const docId = slot.id || ('ms_' + id());
  const data = normalizeSlot({ ...slot, id: docId });
  delete data.id;
  data.updatedAt = Date.now();
  if (!slot.id) data.createdAt = Date.now();
  await setDoc(ref('medical_slots', docId), data, { merge: true });
  return docId;
}
async function deleteMedicalSlot(slotId) {
  await deleteDoc(ref('medical_slots', slotId));
}

// ----------------------------------------------------------------------------
// MEDICAL REQUESTS (pedidos de agendamento feitos pelo funcionário)
// Coleção: medical_requests. ID = cpfHash → 1 pedido em aberto por pessoa.
// Modelo de privacidade igual ao dos raffle_entries: o funcionário CRIA e LÊ
// só o próprio (getDoc por id); ninguém lista os motivos alheios. Quem lista/
// confirma/exclui é o RH (regras do Firestore).
// Status: 'pendente' → (RH confirma e coloca data/hora) → 'confirmado'.
// ----------------------------------------------------------------------------
function normalizeRequest(r) {
  return {
    id: r.id,
    cpfHash: String(r.cpfHash || r.id || ''),
    employeeName: String(r.employeeName || ''),
    unit: String(r.unit || ''),
    specialty: SPECIALTIES.some(x => x.id === r.specialty) ? r.specialty : 'outro',
    reason: String(r.reason || ''),
    status: r.status === 'confirmado' ? 'confirmado' : 'pendente',
    date: String(r.date || ''),           // 'YYYY-MM-DD' — RH preenche na confirmação
    startTime: String(r.startTime || ''), // 'HH:MM'      — RH preenche na confirmação
    place: String(r.place || ''),         // onde comparecer (RH, opcional)
    rhNote: String(r.rhNote || ''),       // recado do RH (opcional)
    createdAt: r.createdAt || Date.now(),
    updatedAt: r.updatedAt || Date.now(),
    confirmedAt: r.confirmedAt || null,
    confirmedBy: r.confirmedBy || ''
  };
}

// Funcionário: consulta o PRÓPRIO pedido (getDoc por id = hash do CPF).
async function getMyMedicalRequest(h) {
  const snap = await getDoc(ref('medical_requests', h)).catch(() => null);
  return snap && snap.exists() ? normalizeRequest({ id: snap.id, ...snap.data() }) : null;
}

// Funcionário: cria o pedido. As regras só permitem CREATE (não UPDATE), então
// enquanto houver um pedido em aberto um novo é barrado — trava natural.
// Retorna { ok, reason?, request } para a tela dar uma mensagem amigável.
async function createMedicalRequest(employee, specialty, reason) {
  const h = employee.id; // já é o hash do CPF
  const existing = await getMyMedicalRequest(h);
  if (existing) return { ok: false, reason: 'exists', request: existing };
  const data = normalizeRequest({
    id: h, cpfHash: h,
    employeeName: employee.name || '',
    unit: employee.unit || '',
    specialty, reason,
    status: 'pendente', createdAt: Date.now(), updatedAt: Date.now()
  });
  delete data.id;
  await setDoc(ref('medical_requests', h), data);
  return { ok: true, request: { id: h, ...data } };
}

// RH: lista todos os pedidos (pendentes primeiro; dentro de cada grupo, recentes no topo).
async function listMedicalRequests() {
  const snap = await getDocs(col('medical_requests'));
  const out = [];
  snap.forEach(d => out.push(normalizeRequest({ id: d.id, ...d.data() })));
  return out.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'pendente' ? -1 : 1) ||
    (b.createdAt || 0) - (a.createdAt || 0));
}

// RH: confirma o pedido — grava data/hora/local e muda o status.
async function confirmMedicalRequest(cpfHash, info, userEmail) {
  await updateDoc(ref('medical_requests', cpfHash), {
    status: 'confirmado',
    date: String(info.date || ''),
    startTime: String(info.startTime || ''),
    place: String(info.place || '').trim(),
    rhNote: String(info.rhNote || '').trim(),
    confirmedAt: Date.now(),
    confirmedBy: userEmail || '',
    updatedAt: Date.now()
  });
}

// RH: remove o pedido (libera a pessoa para fazer um novo).
async function deleteMedicalRequest(cpfHash) {
  await deleteDoc(ref('medical_requests', cpfHash));
}

// ----------------------------------------------------------------------------
// RAFFLES  (sorteio semanal do cinema)
// status: draft → open → closed → drawn → published
// ----------------------------------------------------------------------------
async function listRaffles() {
  const snap = await getDocs(col('raffles'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Sorteio "atual" para o funcionário: o mais recente que não é rascunho.
async function getCurrentRaffle() {
  const all = await listRaffles();
  return all.find(r => r.status && r.status !== 'draft') || null;
}

async function saveRaffle(r) {
  const docId = r.id || ('rf_' + id());
  const data = {
    title: r.title || 'Sorteio do Cinema',
    description: r.description || '',
    status: r.status || 'draft',
    startAt: r.startAt || '',
    endAt: r.endAt || '',
    drawAt: r.drawAt || '',
    voucherStart: r.voucherStart || '',
    voucherEnd: r.voucherEnd || '',
    films: (r.films || []).map(f => ({
      id: f.id || ('flm_' + id()),
      title: f.title || 'Filme',
      quantity: Number(f.quantity || 0),
      active: f.active !== false
    })),
    updatedAt: Date.now()
  };
  if (!r.id) { data.createdAt = Date.now(); data.publishedAt = ''; }
  await setDoc(ref('raffles', docId), data, { merge: true });
  return docId;
}
async function deleteRaffle(raffleId) {
  await deleteDoc(ref('raffles', raffleId));
}
async function getRaffle(raffleId) {
  const snap = await getDoc(ref('raffles', raffleId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// ----------------------------------------------------------------------------
// RAFFLE ENTRIES (inscrições). ID = `${raffleId}_${cpfHash}_${filmId}`
// → permite inscrição em vários filmes; trava 1 inscrição por filme.
// ----------------------------------------------------------------------------
function entryKey(raffleId, h, filmId) { return `${raffleId}_${h}_${filmId}`; }
function winnerKey(raffleId, h) { return `${raffleId}_${h}`; } // 1 prêmio por pessoa

// Funcionário consulta as PRÓPRIAS inscrições (getDoc por id, um por filme).
async function getMyEntries(raffle, h) {
  const films = (raffle.films || []);
  const results = await Promise.all(films.map(f =>
    getDoc(ref('raffle_entries', entryKey(raffle.id, h, f.id)))
      .then(s => (s.exists() ? { id: s.id, ...s.data() } : null))
      .catch(() => null)
  ));
  return results.filter(Boolean);
}
// Funcionário cria a inscrição em UM filme. As regras só permitem CREATE
// (não UPDATE), então re-inscrever no mesmo filme é barrado.
async function createEntry(raffle, film, employee) {
  const h = employee.id; // já é o hash
  await setDoc(ref('raffle_entries', entryKey(raffle.id, h, film.id)), {
    raffleId: raffle.id,
    filmId: film.id,
    filmTitle: film.title,
    cpfHash: h,
    employeeName: employee.name || '',
    createdAt: Date.now()
  });
}
// Lista de inscritos (somente RH).
async function listEntries(raffleId) {
  const snap = await getDocs(query(col('raffle_entries'), where('raffleId', '==', raffleId)));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ----------------------------------------------------------------------------
// RAFFLE WINNERS (ganhadores). ID = `${raffleId}_${cpfHash}` → 1 prêmio/sorteio
// ----------------------------------------------------------------------------
// Funcionário consulta o PRÓPRIO resultado (getDoc por id).
async function getMyWinner(raffleId, h) {
  const snap = await getDoc(ref('raffle_winners', winnerKey(raffleId, h))).catch(() => null);
  return snap && snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
async function listWinners(raffleId) {
  const snap = await getDocs(query(col('raffle_winners'), where('raffleId', '==', raffleId)));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}
// Todos os ganhadores (para a trava: quem já ganhou cada filme).
async function listAllWinners() {
  const snap = await getDocs(col('raffle_winners'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// MOTOR DO SORTEIO (somente RH).
// Regras aplicadas:
//   - só concorre quem se inscreveu (clicou "Quero participar");
//   - ninguém ganha o mesmo TÍTULO de filme que já ganhou (agora ou no histórico);
//   - cada pessoa ganha no máximo 1 prêmio por sorteio.
async function drawRaffle(raffleId) {
  const raffle = await getRaffle(raffleId);
  if (!raffle) throw new Error('Sorteio não encontrado.');
  if (!raffle.films || !raffle.films.length) throw new Error('Cadastre ao menos um filme.');

  const entries = await listEntries(raffleId);
  const history = await listAllWinners();

  // Conjunto "cpfHash::tituloMinusculo" de filmes já ganhos no histórico.
  const wonBefore = new Set(
    history.map(w => `${w.cpfHash}::${String(w.filmTitle || '').trim().toLowerCase()}`)
  );

  const selectedThisRaffle = new Set(); // ninguém ganha 2x no mesmo sorteio
  const winners = [];

  for (const film of raffle.films) {
    if (film.active === false) continue;
    const titleKey = String(film.title || '').trim().toLowerCase();
    let pool = entries.filter(e =>
      e.filmId === film.id &&
      !selectedThisRaffle.has(e.cpfHash) &&
      !wonBefore.has(`${e.cpfHash}::${titleKey}`)
    );
    // Embaralha (Fisher–Yates) e escolhe a quantidade de ingressos.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, Math.max(0, Number(film.quantity || 0)));
    for (const e of picked) {
      selectedThisRaffle.add(e.cpfHash);
      winners.push({
        raffleId,
        filmId: film.id,
        filmTitle: film.title,
        cpfHash: e.cpfHash,
        employeeName: e.employeeName || '',
        voucherCode: voucherCode(),
        createdAt: Date.now()
      });
    }
  }

  // Grava ganhadores + atualiza wonFilms no doc do funcionário (em lotes).
  for (let i = 0; i < winners.length; i += 200) {
    const batch = writeBatch(db);
    for (const w of winners.slice(i, i + 200)) {
      batch.set(ref('raffle_winners', winnerKey(raffleId, w.cpfHash)), w);
      batch.update(ref('employees', w.cpfHash), {
        wonFilms: arrayUnionTitle(w.filmTitle)
      });
    }
    await batch.commit();
  }

  await updateDoc(ref('raffles', raffleId), {
    status: 'drawn', drawAt: Date.now(), updatedAt: Date.now()
  });
  return winners;
}

// Helper p/ arrayUnion (anexa o título do filme sem duplicar).
function arrayUnionTitle(title) { return arrayUnion(String(title || '').trim()); }

async function publishRaffle(raffleId) {
  await updateDoc(ref('raffles', raffleId), {
    status: 'published', publishedAt: Date.now(), updatedAt: Date.now()
  });
}

// ----------------------------------------------------------------------------
// AUDIT LOGS (registro de quem fez o quê)
// ----------------------------------------------------------------------------
async function logAudit(entry) {
  await addDoc(col('audit_logs'), {
    action: entry.action || '',
    entity: entry.entity || '',
    entityId: entry.entityId || '',
    userEmail: entry.userEmail || '',
    detail: entry.detail || '',
    createdAt: Date.now()
  }).catch(() => {}); // auditoria nunca deve quebrar a ação principal
}
async function listAudit(limitN = 100) {
  const snap = await getDocs(col('audit_logs'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limitN);
}

export { DEFAULT_PROFILES, SPECIALTIES, specialtyOf, slotLabel, listMedicalSlots, saveMedicalSlot, deleteMedicalSlot, normalizeSlot, normalizeRequest, getMyMedicalRequest, createMedicalRequest, listMedicalRequests, confirmMedicalRequest, deleteMedicalRequest, DEFAULT_SETTINGS, arrayUnionTitle, createEntry, deleteBenefit, deleteProfile, deleteProfileRule, deleteRaffle, drawRaffle, entryKey, getCommunication, getCurrentRaffle, getEmployeeByCpf, getEmployeeByHash, getMyEntries, getMyWinner, getRaffle, getSettings, importEmployees, listAllWinners, listAudit, listBenefits, listEmployees, listEntries, listImports, listProfileRules, listProfiles, listRaffles, listWinners, logAudit, matchRule, normKey, normalizeBenefit, publishRaffle, resolveEmployeeProfiles, resolveProfileIds, saveBenefit, saveCommunication, saveImportRecord, saveProfile, saveProfileRule, saveRaffle, saveSettings, seedProfilesIfEmpty, updateEmployeeProfiles, winnerKey };
