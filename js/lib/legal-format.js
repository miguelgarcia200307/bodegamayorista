// Convierte los textos planos del panel (términos, política de datos, envíos,
// garantía…) en HTML legible: títulos de sección, cláusulas numeradas con sangría,
// incisos a), viñetas, etiquetas "Campo:" en negrita y enlaces. No cambia ni una
// palabra del texto: solo le da estructura visual.
import { escapeHtml } from './helpers.js';

const isUpper = line => /\p{L}/u.test(line) && line === line.toLocaleUpperCase('es') && line.length <= 110;
const VERSION = /^versi[oó]n\s/i;

function inline(text) {
  let html = escapeHtml(text).replace(/\bhttps?:\/\/[^\s<)]+[^\s<).,;:]/g, url => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  // "Transferencia bancaria: …" → etiqueta en negrita (sin paréntesis, barras ni puntos).
  html = html.replace(/^([\p{Lu}][^.:()/<>]{1,48}):(\s)/u, '<strong>$1:</strong>$2');
  return html;
}

function lineBlock(line) {
  let match;
  if ((match = line.match(/^(\d+)\.\s+(.+)$/)) && isUpper(match[2])) return { type: 'heading', num: `${match[1]}.`, text: match[2] };
  if (isUpper(line) && !/[.:]$/.test(line)) return { type: 'heading', num: '', text: line };
  if ((match = line.match(/^(\d+(?:\.\d+)+\.?)\s+(.+)$/))) return { type: 'clause', level: 2, num: match[1], text: match[2] };
  if ((match = line.match(/^(\d+[.)])\s+(.+)$/))) return { type: 'clause', level: 1, num: match[1], text: match[2] };
  if ((match = line.match(/^([a-zñ][).])\s+(.+)$/))) return { type: 'clause', level: 3, num: match[1], text: match[2] };
  if ((match = line.match(/^[-•*·]\s+(.+)$/))) return { type: 'bullet', text: match[1] };
  return { type: 'paragraph', text: line };
}

/**
 * @param {string} text Texto plano tal como lo guarda el panel.
 * @param {{ dropTitle?: boolean, dropVersion?: boolean }} options
 *   dropTitle: omite el título en mayúsculas de la primera línea (la sección ya lo muestra).
 *   dropVersion: omite la línea "Versión …" inicial (se muestra aparte).
 */
export function formatLegal(text = '', { dropTitle = true, dropVersion = false } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
  const out = [];
  let bullets = [];
  let seenContent = false;
  const flush = () => { if (bullets.length) { out.push(`<ul class="legal__bullets">${bullets.join('')}</ul>`); bullets = []; } };

  lines.forEach((line, index) => {
    if (!line) { flush(); return; }
    if (index <= 3 && VERSION.test(line)) { seenContent = true; flush(); if (!dropVersion) out.push(`<p class="legal__meta">${escapeHtml(line)}</p>`); return; }
    const block = lineBlock(line);
    if (!seenContent && dropTitle && block.type === 'heading' && !block.num) { seenContent = true; return; }
    seenContent = true;
    if (block.type === 'bullet') { bullets.push(`<li>${inline(block.text)}</li>`); return; }
    flush();
    if (block.type === 'heading') out.push(`<h3 class="legal__heading">${block.num ? `<span class="legal__num">${escapeHtml(block.num)}</span> ` : ''}${escapeHtml(block.text)}</h3>`);
    else if (block.type === 'clause') out.push(`<p class="legal__clause legal__clause--l${block.level}"><span class="legal__num">${escapeHtml(block.num)}</span><span>${inline(block.text)}</span></p>`);
    else out.push(`<p>${inline(block.text)}</p>`);
  });
  flush();
  return `<div class="legal">${out.join('')}</div>`;
}

/** Línea "Versión …" con la que empieza el texto, si la tiene. */
export function legalVersionLine(text = '') {
  return String(text).split(/\r?\n/).slice(0, 3).map(line => line.trim()).find(line => VERSION.test(line)) || '';
}
