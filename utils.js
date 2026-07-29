// ============================================================================
// helpers.js — utilitários puros, sem dependência de Firebase.
// Compartilhado entre Funcionário e RH.
// ============================================================================

// --- Identificadores e escape de HTML ---------------------------------------
function id() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"]/g, s => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]
  ));
}
function escAttr(v) {
  return esc(v).replace(/'/g, '&#39;');
}

// Versão "limpa" para prévias curtas: remove a marcação (** * _) e junta linhas.
function previewText(v) {
  return String(v || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

// Formata texto simples: **negrito**, *itálico* (ou _itálico_) e quebras de linha.
// Escapa o HTML primeiro (seguro), depois aplica a marcação leve.
function formatText(v) {
  let s = esc(v);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); // **negrito**
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>'); // *itálico*
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');   // _itálico_
  s = s.replace(/\n/g, '<br>');                               // quebras de linha
  return s;
}

// --- CPF ---------------------------------------------------------------------
// digits: extrai só os números. normalizeCpf: 11 dígitos com zeros à esquerda.
function digits(v) { return String(v ?? '').replace(/\D/g, ''); }
function normalizeCpf(v) { return digits(v).padStart(11, '0').slice(-11); }

// Máscara COMPLETA (uso interno/admin): 000.000.000-00
function cpfMaskFull(v) {
  return normalizeCpf(v).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}
// Máscara SEGURA (exibida ao funcionário e no admin): ***.456.789-**
function cpfSafe(v) {
  const d = normalizeCpf(v);
  return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**';
}
function isValidCpfLength(v) { return digits(v).length === 11; }

// Máscara PROGRESSIVA para digitação: vai formatando conforme a pessoa digita.
// 123 → "123" | 1234567 → "123.456.7" | 11 dígitos → "123.456.789-01"
function maskCpfInput(v) {
  const d = digits(v).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return d.slice(0, 3) + '.' + d.slice(3);
  if (d.length <= 9) return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6);
  return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
}


// Hash SHA-256 do CPF normalizado → usado como ID do documento do funcionário.
// O CPF aberto NUNCA é gravado no banco; guardamos apenas o hash + a máscara.
async function cpfHash(v) {
  const norm = normalizeCpf(v);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rgf:' + norm));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// --- Nomes -------------------------------------------------------------------
function firstName(n) {
  return String(n || '').trim().split(/\s+/)[0] || 'Colaborador';
}

// --- Datas -------------------------------------------------------------------
function nowLocalForInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function dt(v) {
  if (!v) return '';
  try { return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return String(v); }
}
function dateShort(v) {
  if (!v) return '';
  try { return new Date(v).toLocaleDateString('pt-BR'); } catch { return String(v); }
}
// Verifica se a data atual está dentro do intervalo [from, to] (ambos opcionais).
function dateOk(from, to) {
  const n = Date.now();
  if (from && new Date(from).getTime() > n) return false;
  if (to && new Date(to).getTime() < n) return false;
  return true;
}

// --- Voucher -----------------------------------------------------------------
function voucherCode() {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += s[Math.floor(Math.random() * s.length)];
  return out.slice(0, 4) + '-' + out.slice(4);
}

// --- Toast (notificação rápida) ----------------------------------------------
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// --- Leitura de arquivo como Data URL (para logos/ícones em Base64) ----------
function readFileDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Paleta dos cards de benefício (índice → cor). Tons com bom contraste p/ texto branco.
const CARD_COLORS = [
  '#024f2b', '#0a6b3c', '#1f7a4d', '#3d6b35', '#557024', '#739630', '#5a6b00',
  '#0d7d6b', '#2c5ca8', '#1f3a8a', '#7a3e9d', '#a83246', '#b0392b', '#b06b00',
  '#8a5a2b', '#4a4a4a', '#ffffff'
];

// Detecta cor clara (para trocar o texto para escuro automaticamente).
function isLightColor(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 186;
}

export {
  cpfHash, cpfMaskFull, maskCpfInput, cpfSafe, dateOk, dateShort, digits, dt, esc, escAttr, firstName, formatText, id, isLightColor, isValidCpfLength, normalizeCpf, nowLocalForInput, previewText, readFileDataURL, toast, voucherCode,
  CARD_COLORS
};
