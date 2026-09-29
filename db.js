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
//   admins · communications
//
// Decisões de privacidade (LGPD):
//   - O CPF aberto NUNCA é gravado. O ID do documento do funcionário é o
//     hash SHA-256 do CPF. Guardamos apenas cpfMasked + cpfHash(=id).
//   - O funcionário só consegue LER o próprio documento (getDoc por id = hash);
//     não consegue listar/enumerar a coleção. Quem manda nisso são as regras
//     do Firestore (ver firestore.rules), não só o código.
//
// Filiais com RH próprio ("apartamentos"):
//   - Cada usuário do painel tem um documento em admins/{uid} com o campo
//     `unit`. unit vazio = MATRIZ (vê e gerencia tudo). unit preenchido =
//     RH daquela filial (vê e gerencia só a própria filial).
//   - Perfis, regras de perfil, benefícios, sugestões, importações e
//     comunicados carregam a filial dona. Vazio = matriz.
//   - O texto da filial é gravado EXATAMENTE como está no admin, porque as
//     regras do Firestore comparam texto puro (não ignoram acento/maiúscula).
// ============================================================================




const col = name => collection(db, name);
const ref = (name, docId) => doc(db, name, docId);

// Normaliza um texto de comparação: sem acento, minúsculo, sem espaços nas pontas.
// Usado para casar "SÃO PAULO " com "sao paulo" sem drama.
function normKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
// Mesma filial? (ignora acento, maiúscula e espaços nas pontas)
function sameUnit(a, b) {
  return normKey(a) === normKey(b);
}
// Lista de filiais permitidas: vazia = todas. Sem unidade = só entra se a
// lista estiver vazia (mesma lógica dos benefícios).
function unitAllowed(list, unit) {
  if (!Array.isArray(list) || !list.length) return true;
  if (!String(unit || '').trim()) return false;
  return list.some(u => sameUnit(u, unit));
}
// Id de documento a partir do nome da filial ("Bom Despacho" -> "bom-despacho").
function unitSlug(unit) {
  return normKey(unit).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sem-filial';
}

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
  medicalNote: '',        // instrução (documentos, onde é, o que levar)
  // Aviso fixo mostrado ao funcionário na página de agendamento. Deixa claro
  // que a agenda pode mudar por necessidade da empresa e o pedido ser refeito.
  medicalScheduleNotice: 'A agenda pode sofrer alterações conforme a necessidade da empresa, e seu agendamento pode ser refeito. Se isso acontecer, a nova data aparece aqui ao consultar seu CPF.',
  doctors: [],            // médicos pré-cadastrados (sugestões no formulário)
  // Filiais que têm atendimento médico (vazio = todas). Quem está fora não vê
  // "Agendar atendimento" nem "Agenda médica".
  medicalUnits: []
};

// ----------------------------------------------------------------------------
// CAMPANHAS DO PORTAL (ex.: Outubro Rosa). Guardadas em settings.campaign:
//   { theme, start, end, color, text, link }
// Dentro do período (start..end, datas inclusivas), o portal troca as cores do
// topo e dos destaques e mostra uma faixa com a frase. Logo e marca não mudam.
//   main  = fundo do topo e botões (texto branco por cima: contraste ≥ 4.5:1)
//   dark  = tom mais escuro;  accent = destaques (faixa, traços, botão do sorteio)
//   light = textos claros sobre o topo
// ----------------------------------------------------------------------------
const CAMPAIGNS = [
  { id: 'rosa', name: 'Outubro Rosa', main: '#a3195b', dark: '#7a0f43', accent: '#f9a8cb', light: '#fcd6e7',
    text: 'Outubro Rosa: cuide-se. Faça o autoexame e seus exames de rotina.' },
  { id: 'azul', name: 'Novembro Azul', main: '#1d4f91', dark: '#123566', accent: '#8ec5ff', light: '#cfe4ff',
    text: 'Novembro Azul: cuidar da saúde também é coisa de homem.' },
  { id: 'amarelo', name: 'Setembro Amarelo', main: '#8a5a00', dark: '#5f3e00', accent: '#ffd23f', light: '#ffe9a3',
    text: 'Setembro Amarelo: falar é a melhor solução. Você não está sozinho.' },
  { id: 'livre', name: 'Tema livre', main: '#024f2b', dark: '#01361d', accent: '#9dcd46', light: '#cfe6a8', text: '' }
];
function campaignOf(id) { return CAMPAIGNS.find(c => c.id === id) || null; }
// Hex -> mistura com branco/preto (t de 0 a 1). Usado para derivar as cores do tema livre.
function mixHex(hex, target, t) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
  const to = target === 'white' ? 255 : 0;
  const c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
    .map(v => Math.round(v + (to - v) * t).toString(16).padStart(2, '0'));
  return '#' + c.join('');
}
// Campanha em vigor hoje (ou null). `today` = 'YYYY-MM-DD' local.
function campaignTheme(settings, today) {
  const c = settings && settings.campaign;
  if (!c || !c.theme) return null;
  const base = campaignOf(c.theme);
  if (!base) return null;
  if (c.start && today < c.start) return null;
  if (c.end && today > c.end) return null;
  const t = { ...base };
  if (c.theme === 'livre' && /^#[0-9a-fA-F]{6}$/.test(c.color || '')) {
    t.main = c.color; t.dark = mixHex(c.color, 'black', 0.3);
    t.accent = mixHex(c.color, 'white', 0.6); t.light = mixHex(c.color, 'white', 0.8);
  }
  t.text = String(c.text || '').trim() || base.text;
  t.link = String(c.link || '').trim();
  return t;
}

async function getSettings() {
  const snap = await getDoc(ref('settings', 'main')).catch(() => null);
  return Object.assign({}, DEFAULT_SETTINGS, snap && snap.exists() ? snap.data() : {});
}
async function saveSettings(data) {
  await setDoc(ref('settings', 'main'), { ...data, updatedAt: Date.now() }, { merge: true });
}
// A filial tem atendimento médico?
function medicalAllowed(settings, unit) {
  return unitAllowed(settings && settings.medicalUnits, unit);
}

// COMUNICADO (aviso/arte que aparece ao funcionário após o login).
// Geral (da matriz, para todas as filiais): settings/communication.
// Da filial: communications/{slug da filial}, com o campo `unit`.
async function getCommunication() {
  const snap = await getDoc(ref('settings', 'communication')).catch(() => null);
  return snap && snap.exists() ? snap.data() : null;
}
async function saveCommunication(data) {
  await setDoc(ref('settings', 'communication'), { ...data, updatedAt: Date.now() }, { merge: true });
}
async function getUnitCommunication(unit) {
  if (!String(unit || '').trim()) return null;
  const snap = await getDoc(ref('communications', unitSlug(unit))).catch(() => null);
  return snap && snap.exists() ? snap.data() : null;
}
async function saveUnitCommunication(unit, data) {
  await setDoc(ref('communications', unitSlug(unit)),
    { ...data, unit: String(unit || '').trim(), updatedAt: Date.now() }, { merge: true });
}

// ----------------------------------------------------------------------------
// ADMINS (usuários do painel RH). id do documento = uid do Firebase Auth.
// { email, unit ('' = matriz), active, createdAt, createdBy }
// ----------------------------------------------------------------------------
async function getAdmin(uid) {
  const snap = await getDoc(ref('admins', uid)).catch(() => null);
  return snap && snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
async function listAdmins() {
  const snap = await getDocs(col('admins'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => String(a.unit || '').localeCompare(String(b.unit || '')) ||
    String(a.email || '').localeCompare(String(b.email || '')));
}
async function saveAdmin(uid, data) {
  const payload = {
    email: String(data.email || '').trim(),
    unit: String(data.unit || '').trim(),
    active: data.active !== false,
    updatedAt: Date.now()
  };
  if (data.createdAt) payload.createdAt = data.createdAt;
  if (data.createdBy) payload.createdBy = data.createdBy;
  await setDoc(ref('admins', uid), payload, { merge: true });
}
// Filiais que têm RH próprio (os "apartamentos"). A importação da matriz não
// mexe nos funcionários delas.
function independentUnits(admins) {
  const seen = new Map();
  (admins || []).forEach(a => {
    const u = String(a.unit || '').trim();
    if (u && a.active !== false && !seen.has(normKey(u))) seen.set(normKey(u), u);
  });
  return [...seen.values()];
}

// ----------------------------------------------------------------------------
// PROFILES  (unit: '' = matriz; preenchido = perfil da filial)
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
  snap.forEach(d => out.push({ id: d.id, unit: '', ...d.data() }));
  return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
async function saveProfile(p) {
  const docId = p.id || ('p_' + id());
  const data = {
    name: p.name || 'Perfil',
    description: p.description || '',
    active: p.active !== false,
    unit: String(p.unit || '').trim(),
    updatedAt: Date.now()
  };
  if (!p.id) data.createdAt = Date.now();
  await setDoc(ref('profiles', docId), data, { merge: true });
  return docId;
}
async function deleteProfile(profileId) {
  await deleteDoc(ref('profiles', profileId));
}
// Garante que os 4 perfis padrão existam (chamado no primeiro acesso da matriz).
async function seedProfilesIfEmpty() {
  const existing = await listProfiles();
  if (existing.length) return existing;
  for (const p of DEFAULT_PROFILES) {
    await setDoc(ref('profiles', p.id), {
      name: p.name, description: '', active: true, unit: '', createdAt: Date.now(), updatedAt: Date.now()
    });
  }
  return listProfiles();
}

// ----------------------------------------------------------------------------
// PROFILE RULES  (amarração automática: Sindicato + Tipo -> Perfil)
// Coleção: profile_rules. Cada regra = { sindicato, tipo, profileId, active, unit }.
// Ideia: em vez de escrever o "Perfil" de cada funcionário na planilha, o RH
// cadastra poucas regras aqui e a importação etiqueta todo mundo sozinha.
// Cada filial com RH próprio tem as próprias regras (unit preenchido).
// ----------------------------------------------------------------------------
async function listProfileRules() {
  const snap = await getDocs(col('profile_rules'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, unit: '', ...d.data() }));
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
    unit: String(r.unit || '').trim(),
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
//   units     = filiais que VEEM o benefício (vazio = todas)
//   ownerUnit = filial DONA (quem pode editar). Vazio = matriz.
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
    ownerUnit: String(b.ownerUnit || '').trim(),
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

// Listagem (somente RH). Com `unit`, traz só os funcionários daquela filial —
// é o único jeito que o RH de uma filial tem permissão de listar.
async function listEmployees(unit) {
  const u = String(unit || '').trim();
  const snap = await getDocs(u ? query(col('employees'), where('unit', '==', u)) : col('employees'));
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

// IMPORTAÇÃO: a nova planilha SUBSTITUI os funcionários DO ESCOPO de quem importa.
//   - RH de filial (meta.scopeUnit preenchido): substitui só os funcionários
//     daquela filial. A coluna Unidade é ignorada: todos entram na filial dele.
//     Usa só os perfis e as regras da filial.
//   - Matriz (meta.scopeUnit vazio): substitui todos, MENOS os das filiais com
//     RH próprio (meta.independentUnits). Linhas dessas filiais são ignoradas.
//   - Um CPF que já está cadastrado em outro escopo não é mexido (conflito):
//     entra no resumo para o RH resolver.
// rows: [{ name, cpf, profile, unit?, department?, role?, ... }]
// Retorna o resumo (totais) para exibir e gravar no histórico.
async function importEmployees(rows, meta = {}) {
  const scopeUnit = String(meta.scopeUnit || '').trim();
  const independent = (meta.independentUnits || []).map(normKey);
  const isIndependent = u => !!normKey(u) && independent.includes(normKey(u));
  // A qual escopo um funcionário pertence: a filial (se tem RH próprio) ou a matriz.
  const inScope = emp => scopeUnit ? sameUnit(emp.unit, scopeUnit) : !isIndependent(emp.unit);

  const profiles = (await listProfiles()).filter(p => sameUnit(p.unit, scopeUnit));
  const rules = (await listProfileRules()).filter(r => sameUnit(r.unit, scopeUnit));
  const existing = (await listEmployees(scopeUnit)).filter(inScope);
  const existingIds = new Set(existing.map(e => e.id));

  // Monta os novos documentos.
  const newDocs = [];
  const newIds = new Set();
  const totalsByProfile = {};
  let withoutProfile = 0, byManual = 0, byRule = 0, skippedOtherUnit = 0;
  const conflicts = []; // CPFs que já pertencem a outro escopo

  const candidates = [];
  for (const r of rows) {
    const cpf = normalizeCpf(r.cpf);
    if (cpf.length !== 11) continue;
    // Matriz não importa gente das filiais com RH próprio.
    if (!scopeUnit && isIndependent(r.unit)) { skippedOtherUnit++; continue; }
    const h = await cpfHash(cpf);
    if (newIds.has(h)) continue; // evita CPF duplicado na própria planilha
    newIds.add(h);
    candidates.push({ r, h });
  }

  // CPFs novos para este escopo: confere se já existem em outro escopo.
  const unknown = candidates.filter(c => !existingIds.has(c.h));
  const owners = await Promise.all(unknown.map(c =>
    getDoc(ref('employees', c.h)).then(s => (s.exists() ? s.data() : null)).catch(() => null)));
  const taken = new Set();
  unknown.forEach((c, i) => {
    const other = owners[i];
    if (other && !inScope(other)) {
      taken.add(c.h);
      conflicts.push({ name: String(c.r.name || '').trim(), unit: other.unit || '' });
    }
  });

  for (const { r, h } of candidates) {
    if (taken.has(h)) { newIds.delete(h); continue; }
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
        cpfMasked: cpfSafe(normalizeCpf(r.cpf)),
        profileIds,
        profileSource: source,               // como o perfil foi atribuído
        profileRaw: String(r.profile || '').trim(),
        sindicato: String(r.sindicato || '').trim(),
        tipo: String(r.tipo || '').trim(),
        unit: scopeUnit || String(r.unit || '').trim(),
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

  // IDs a remover = existentes (do escopo) que não estão na nova planilha.
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
    unit: scopeUnit,
    totalEmployees: newDocs.length,
    totalAdded: newDocs.filter(nd => !existingIds.has(nd.id)).length,
    totalRemoved: toRemove.length,
    totalsByProfile,
    withoutProfile,
    byManual,               // perfil veio escrito na planilha
    byRule,                 // perfil resolvido por amarração automática
    skippedOtherUnit,       // linhas de filiais com RH próprio (só na matriz)
    conflicts: conflicts.slice(0, 50),
    conflictCount: conflicts.length,
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
async function listImports(unit) {
  const u = String(unit || '').trim();
  const snap = await getDocs(u ? query(col('imports'), where('unit', '==', u)) : col('imports'));
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
  // Status: 'pendente' → RH confirma → 'confirmado'
  //                   ↘ RH devolve pedindo mais info → 'devolvido' (a pessoa refaz)
  //                   ↘ pessoa dá ciência da devolução → 'encerrado' (some do portal)
  const status = ['pendente', 'confirmado', 'devolvido', 'encerrado'].includes(r.status) ? r.status : 'pendente';
  return {
    id: r.id,
    cpfHash: String(r.cpfHash || r.id || ''),
    employeeName: String(r.employeeName || ''),
    unit: String(r.unit || ''),
    specialty: SPECIALTIES.some(x => x.id === r.specialty) ? r.specialty : 'outro',
    reason: String(r.reason || ''),
    status,
    date: String(r.date || ''),           // 'YYYY-MM-DD' — RH preenche na confirmação
    startTime: String(r.startTime || ''), // 'HH:MM'      — RH preenche na confirmação
    place: String(r.place || ''),         // onde comparecer (RH, opcional)
    rhNote: String(r.rhNote || ''),       // recado do RH (opcional)
    // Devolução: RH pede mais informações; a pessoa vê e refaz o pedido.
    rhQuestion: String(r.rhQuestion || ''),   // o que o RH quer que seja esclarecido
    returnedAt: r.returnedAt || null,
    returnedBy: r.returnedBy || '',
    // Remarcação: RH mudou a data de um pedido já confirmado.
    rescheduled: r.rescheduled === true,
    previousDate: String(r.previousDate || ''),        // data anterior à remarcação
    previousStartTime: String(r.previousStartTime || ''),
    rescheduledAt: r.rescheduledAt || null,
    createdAt: r.createdAt || Date.now(),
    updatedAt: r.updatedAt || Date.now(),
    confirmedAt: r.confirmedAt || null,
    confirmedBy: r.confirmedBy || ''
  };
}

// id = `${cpfHash}_${especialidade}` → um pedido por especialidade por pessoa.
function requestKey(h, specialty) { return `${h}_${specialty}`; }

// Funcionário: consulta os PRÓPRIOS pedidos (getDoc por id, um por especialidade).
// Não LISTA a coleção (privacidade) — busca cada id possível e fica com os que existem.
async function getMyMedicalRequests(h) {
  const results = await Promise.all(SPECIALTIES.map(sp =>
    getDoc(ref('medical_requests', requestKey(h, sp.id)))
      .then(s => (s.exists() ? normalizeRequest({ id: s.id, ...s.data() }) : null))
      .catch(() => null)
  ));
  return results.filter(Boolean);
}

// Funcionário: cria o pedido de UMA especialidade. As regras só permitem CREATE
// (não UPDATE), então re-pedir a mesma especialidade enquanto ela existir é barrado.
// Filial sem atendimento médico (Configurações → Atendimentos médicos) não envia.
async function createMedicalRequest(employee, specialty, reason) {
  const settings = await getSettings();
  if (!medicalAllowed(settings, employee.unit)) return { ok: false, reason: 'unit' };
  const h = employee.id; // já é o hash do CPF
  const key = requestKey(h, specialty);
  const snap = await getDoc(ref('medical_requests', key)).catch(() => null);
  const existing = snap && snap.exists() ? snap.data() : null;
  // Bloqueia só se já existe e está ATIVO (pendente/confirmado). Um pedido
  // devolvido OU encerrado pode ser refeito pela própria pessoa: o setDoc abaixo
  // sobrescreve, voltando a 'pendente' e limpando a devolução (normalizeRequest
  // zera rhQuestion/returned*). Obs.: as regras do Firestore precisam permitir
  // esse write quando o doc atual estiver 'devolvido' ou 'encerrado' (ver firestore.rules).
  if (existing && existing.status !== 'devolvido' && existing.status !== 'encerrado') return { ok: false, reason: 'exists' };
  const data = normalizeRequest({
    id: key, cpfHash: h,
    employeeName: employee.name || '',
    unit: employee.unit || '',
    specialty, reason,
    status: 'pendente',
    createdAt: existing?.createdAt || Date.now(), // preserva a data original do 1º pedido
    updatedAt: Date.now()
  });
  delete data.id;
  await setDoc(ref('medical_requests', key), data);
  return { ok: true, request: { id: key, ...data } };
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

// RH/Ambulatório: confirma o pedido — grava data/hora/local e muda o status.
// Se o pedido JÁ estava confirmado e a data/hora mudou, marca como remarcado e
// guarda a data anterior — a página do funcionário destaca a nova data.
// Retorna { rescheduled } para o RH ajustar a mensagem exibida.
async function confirmMedicalRequest(reqId, info, userEmail) {
  const snap = await getDoc(ref('medical_requests', reqId)).catch(() => null);
  const cur = snap && snap.exists() ? snap.data() : null;
  const wasConfirmed = !!(cur && cur.status === 'confirmado' && cur.date);
  const newDate = String(info.date || '');
  const newTime = String(info.startTime || '');
  const changed = wasConfirmed &&
    (newDate !== String(cur.date || '') || newTime !== String(cur.startTime || ''));

  const patch = {
    status: 'confirmado',
    date: newDate,
    startTime: newTime,
    place: String(info.place || '').trim(),
    rhNote: String(info.rhNote || '').trim(),
    // confirmar encerra qualquer pendência de devolução
    rhQuestion: '', returnedAt: null, returnedBy: '',
    confirmedAt: Date.now(),
    confirmedBy: userEmail || '',
    updatedAt: Date.now()
  };
  if (changed) {
    patch.rescheduled = true;
    patch.previousDate = String(cur.date || '');
    patch.previousStartTime = String(cur.startTime || '');
    patch.rescheduledAt = Date.now();
  }
  await updateDoc(ref('medical_requests', reqId), patch);
  return { rescheduled: !!changed };
}

// RH: DEVOLVE o pedido pedindo mais informações (não apaga). Muda para
// 'devolvido' e anexa a pergunta. A pessoa vê o motivo na página de
// agendamento e refaz o pedido (createMedicalRequest sobrescreve o devolvido).
async function returnMedicalRequest(reqId, question, userEmail) {
  await updateDoc(ref('medical_requests', reqId), {
    status: 'devolvido',
    rhQuestion: String(question || '').trim(),
    returnedAt: Date.now(),
    returnedBy: userEmail || '',
    // some qualquer confirmação/remarcação anterior
    date: '', startTime: '', place: '', rhNote: '',
    rescheduled: false, previousDate: '', previousStartTime: '', rescheduledAt: null,
    confirmedAt: null, confirmedBy: '',
    updatedAt: Date.now()
  });
}

// Funcionário: dá CIÊNCIA de um pedido devolvido. O aviso (pop-up) some de vez:
// o pedido passa de 'devolvido' para 'encerrado', libera a especialidade e sai
// da lista do portal. A pessoa refaz o pedido quando quiser (createMedicalRequest
// sobrescreve o encerrado). Sem login: as regras do Firestore permitem só a
// transição devolvido → encerrado, do mesmo dono e especialidade.
async function ackReturnedRequest(reqId) {
  await updateDoc(ref('medical_requests', reqId), {
    status: 'encerrado',
    rhQuestion: '',
    updatedAt: Date.now()
  });
}

// RH/Ambulatório: remove o pedido (libera a pessoa para fazer um novo daquela especialidade).
async function deleteMedicalRequest(reqId) {
  await deleteDoc(ref('medical_requests', reqId));
}

// ----------------------------------------------------------------------------
// RAFFLES  (sorteio semanal do cinema)
// status: draft → open → closed → drawn → published
// units: filiais que participam (vazio = todas)
// ----------------------------------------------------------------------------
async function listRaffles() {
  const snap = await getDocs(col('raffles'));
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// A filial participa deste sorteio?
function raffleForUnit(r, unit) {
  return unitAllowed(r && r.units, unit);
}

// Sorteio "atual" para o funcionário: o mais recente que não é rascunho e do
// qual a filial dele participa. Sem argumento, ignora a filial (uso do RH).
async function getCurrentRaffle(unit) {
  const all = await listRaffles();
  return all.find(r => r.status && r.status !== 'draft' &&
    (unit === undefined || raffleForUnit(r, unit))) || null;
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
    units: Array.isArray(r.units) ? r.units.map(u => String(u || '').trim()).filter(Boolean) : [],
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
// SUGESTÕES (caixinha de sugestões dos funcionários)
// Coleção: suggestions. Duas naturezas de mensagem:
//   - ANÔNIMA: id aleatório, SEM cpfHash/nome. Ninguém devolve resposta — não há
//     como: nada liga a sugestão a uma pessoa. O RH apenas lê. Guarda só a
//     FILIAL, para a mensagem chegar ao RH certo.
//   - IDENTIFICADA: o funcionário CRIA e LÊ as próprias; o RH lê todas e responde.
//     Privacidade igual aos medical_requests: o funcionário NUNCA lista a coleção.
//     Como uma pessoa pode mandar VÁRIAS, guardamos um índice pessoal em
//     suggestions_index/{cpfHash} = { ids: [...] }. Só a própria pessoa monta esse
//     id (é o hash do CPF dela); o portal lê o índice e busca cada sugestão por id.
// Status: 'enviada' → (RH responde) → 'respondida'.
// ----------------------------------------------------------------------------
const SUGGESTION_CATEGORIES = [
  { id: 'ambiente',   name: 'Ambiente de trabalho', icon: '🏢', color: '#2563eb' },
  { id: 'seguranca',  name: 'Segurança / EPI',      icon: '🛡️', color: '#dc2626' },
  { id: 'processos',  name: 'Processos e rotina',    icon: '📋', color: '#0891b2' },
  { id: 'refeitorio', name: 'Refeitório / copa',     icon: '🍽️', color: '#f97316' },
  { id: 'outro',      name: 'Outro',                 icon: '✨', color: '#64748b' }
];
function suggestionCategoryOf(cid) {
  return SUGGESTION_CATEGORIES.find(x => x.id === cid) ||
    SUGGESTION_CATEGORIES[SUGGESTION_CATEGORIES.length - 1];
}
function normalizeSuggestion(s) {
  const anon = !!s.anonymous;
  return {
    id: s.id,
    category: SUGGESTION_CATEGORIES.some(x => x.id === s.category) ? s.category : 'outro',
    text: String(s.text || ''),
    anonymous: anon,
    // Só existem em sugestões IDENTIFICADAS. Nas anônimas ficam vazios (privacidade).
    cpfHash: anon ? '' : String(s.cpfHash || ''),
    employeeName: anon ? '' : String(s.employeeName || ''),
    // Filial: nas duas naturezas, para a mensagem chegar ao RH certo.
    unit: String(s.unit || ''),
    status: s.status === 'respondida' ? 'respondida' : 'enviada',
    reply: String(s.reply || ''),          // resposta do RH (só nas identificadas)
    createdAt: s.createdAt || Date.now(),
    updatedAt: s.updatedAt || Date.now(),
    repliedAt: s.repliedAt || null,
    repliedBy: s.repliedBy || ''
  };
}

// Funcionário: cria uma sugestão.
//   - anônima  -> id aleatório, nada ligado ao CPF, fora do índice pessoal;
//   - identificada -> grava cpfHash + nome e anexa o id ao índice da pessoa.
async function createSuggestion(employee, category, text, anonymous) {
  const sid = 'sug_' + id();
  const isAnon = !!anonymous;
  const data = normalizeSuggestion({
    id: sid, category, text, anonymous: isAnon,
    cpfHash: isAnon ? '' : employee.id,
    employeeName: isAnon ? '' : (employee.name || ''),
    unit: employee.unit || '',
    status: 'enviada', createdAt: Date.now(), updatedAt: Date.now()
  });
  delete data.id;
  await setDoc(ref('suggestions', sid), data);
  // Só as identificadas entram no índice pessoal (para a pessoa reler depois).
  if (!isAnon) {
    await setDoc(ref('suggestions_index', employee.id),
      { ids: arrayUnion(sid), updatedAt: Date.now() }, { merge: true });
  }
  return { id: sid, ...data };
}

// Funcionário: lê as PRÓPRIAS sugestões (identificadas). Monta a lista pelo
// índice — não LISTA a coleção. Anônimas não voltam nem para quem as enviou.
async function getMySuggestions(h) {
  const idxSnap = await getDoc(ref('suggestions_index', h)).catch(() => null);
  const ids = (idxSnap && idxSnap.exists() ? (idxSnap.data().ids || []) : []);
  if (!ids.length) return [];
  const results = await Promise.all(ids.map(sid =>
    getDoc(ref('suggestions', sid))
      .then(s => (s.exists() ? normalizeSuggestion({ id: s.id, ...s.data() }) : null))
      .catch(() => null)
  ));
  // Ignora ids órfãos (sugestão excluída pelo RH) e mostra as mais recentes no topo.
  return results.filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// RH: lista (não respondidas primeiro; dentro de cada grupo, recentes no topo).
// Com `unit`, só as daquela filial (é o que o RH da filial pode ler).
async function listSuggestions(unit) {
  const u = String(unit || '').trim();
  const snap = await getDocs(u ? query(col('suggestions'), where('unit', '==', u)) : col('suggestions'));
  const out = [];
  snap.forEach(d => out.push(normalizeSuggestion({ id: d.id, ...d.data() })));
  return out.sort((a, b) =>
    (a.status === b.status ? 0 : a.status === 'enviada' ? -1 : 1) ||
    (b.createdAt || 0) - (a.createdAt || 0));
}

// RH: responde uma sugestão identificada (anônima não tem para onde voltar).
async function replySuggestion(sid, reply, userEmail) {
  await updateDoc(ref('suggestions', sid), {
    reply: String(reply || '').trim(),
    status: 'respondida',
    repliedAt: Date.now(),
    repliedBy: userEmail || '',
    updatedAt: Date.now()
  });
}

// RH: exclui uma sugestão. Não mexe no índice pessoal: um id órfão simplesmente
// não retorna documento e é descartado na leitura do funcionário.
async function deleteSuggestion(sid) {
  await deleteDoc(ref('suggestions', sid));
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
    unit: entry.unit || '',
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

export { SUGGESTION_CATEGORIES, suggestionCategoryOf, createSuggestion, getMySuggestions, listSuggestions, replySuggestion, deleteSuggestion, DEFAULT_PROFILES, SPECIALTIES, specialtyOf, slotLabel, listMedicalSlots, saveMedicalSlot, deleteMedicalSlot, normalizeSlot, normalizeRequest, requestKey, getMyMedicalRequests, createMedicalRequest, listMedicalRequests, confirmMedicalRequest, returnMedicalRequest, ackReturnedRequest, deleteMedicalRequest, DEFAULT_SETTINGS, arrayUnionTitle, createEntry, deleteBenefit, deleteProfile, deleteProfileRule, deleteRaffle, drawRaffle, entryKey, getCommunication, getCurrentRaffle, getEmployeeByCpf, getEmployeeByHash, getMyEntries, getMyWinner, getRaffle, getSettings, importEmployees, listAllWinners, listAudit, listBenefits, listEmployees, listEntries, listImports, listProfileRules, listProfiles, listRaffles, listWinners, logAudit, matchRule, normKey, normalizeBenefit, publishRaffle, resolveEmployeeProfiles, resolveProfileIds, saveBenefit, saveCommunication, saveImportRecord, saveProfile, saveProfileRule, saveRaffle, saveSettings, seedProfilesIfEmpty, updateEmployeeProfiles, winnerKey,
  CAMPAIGNS, campaignOf, campaignTheme,
  sameUnit, unitAllowed, unitSlug, medicalAllowed, raffleForUnit, getUnitCommunication, saveUnitCommunication,
  getAdmin, listAdmins, saveAdmin, independentUnits };
