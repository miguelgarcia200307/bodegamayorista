// Gráficas ligeras en HTML/CSS para el panel (sin librerías). Una sola serie por gráfica,
// barras delgadas con extremo redondeado, cuadrícula tenue y tooltip al pasar el cursor
// o al enfocar con teclado. Cada gráfica trae su vista de tabla para lectura accesible.
import { escapeHtml } from '../lib/helpers.js';

// Redondea el máximo del eje a un número limpio (1, 2, 2.5, 5 × 10^n).
function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find(candidate => candidate * power >= value);
  return step * power;
}

export function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 1e6) return `$${(amount / 1e6).toLocaleString('es-CO', { maximumFractionDigits: amount >= 1e7 ? 0 : 1 })} M`;
  if (amount >= 1e3) return `$${Math.round(amount / 1e3).toLocaleString('es-CO')} mil`;
  return `$${Math.round(amount).toLocaleString('es-CO')}`;
}

// series: [{ label, sublabel, value, tip }]; highlightLast marca el periodo actual.
export function columnChart(series, { format = compactMoney, caption = '', highlightLast = true, tableHead = ['Periodo', 'Valor'] } = {}) {
  const max = niceMax(Math.max(...series.map(item => item.value), 0));
  const ticks = [max, max / 2, 0];
  const empty = series.every(item => !item.value);
  return `<figure class="mc-columns">
    <div class="mc-columns__plot" role="img" aria-label="${escapeHtml(caption)}">
      <div class="mc-columns__grid" aria-hidden="true">${ticks.map(tick => `<span><small>${escapeHtml(format(tick))}</small></span>`).join('')}</div>
      <div class="mc-columns__bars">${series.map((item, position) => {
        const height = item.value ? Math.max(2, (item.value / max) * 100) : 0;
        const current = highlightLast && position === series.length - 1;
        return `<div class="mc-columns__slot${current ? ' is-current' : ''}" tabindex="0" data-tip="${escapeHtml(item.tip || `${item.label}: ${format(item.value)}`)}"><span class="mc-columns__bar" style="height:${height}%"></span><small>${escapeHtml(item.label)}${item.sublabel ? `<em>${escapeHtml(item.sublabel)}</em>` : ''}</small></div>`;
      }).join('')}</div>
      ${empty ? '<p class="mc-empty">Sin compras confirmadas en este periodo</p>' : ''}
    </div>
    <details class="mc-table"><summary>Ver datos en tabla</summary><div class="table-scroll"><table class="doc-table"><thead><tr>${tableHead.map(head => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead><tbody>${series.map(item => `<tr><td>${escapeHtml(`${item.label} ${item.sublabel || ''}`.trim())}</td>${(item.cells || [format(item.value)]).map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
  </figure>`;
}

// rows: [{ label, detail, value, display, tip }]; la barra se escala contra el mayor valor.
export function barList(rows, { format = compactMoney, limit = 6, empty = 'Sin datos todavía.' } = {}) {
  if (!rows.length) return `<p class="mc-empty mc-empty--inline">${escapeHtml(empty)}</p>`;
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  if (rest.length) shown.push({ label: `Otros (${rest.length})`, value: rest.reduce((sum, row) => sum + row.value, 0), muted: true });
  const max = Math.max(...shown.map(row => row.value), 1);
  return `<ul class="mc-bars">${shown.map(row => `<li class="mc-bars__row${row.muted ? ' is-muted' : ''}" tabindex="0" data-tip="${escapeHtml(row.tip || `${row.label}: ${format(row.value)}`)}"><span class="mc-bars__label"><strong>${escapeHtml(row.label)}</strong>${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ''}</span><span class="mc-bars__track"><span style="width:${Math.max(2, (row.value / max) * 100)}%"></span></span><span class="mc-bars__value">${escapeHtml(row.display || format(row.value))}</span></li>`).join('')}</ul>`;
}

// Medidor de rango: mínimo, promedio y máximo sobre una misma escala.
export function rangeMeter({ min, avg, max }, format = compactMoney) {
  const span = Math.max(max - min, 1);
  const position = Math.min(100, Math.max(0, ((avg - min) / span) * 100));
  return `<div class="mc-range" role="img" aria-label="Precio mínimo ${escapeHtml(format(min))}, promedio ${escapeHtml(format(avg))}, máximo ${escapeHtml(format(max))}"><div class="mc-range__track"><span class="mc-range__marker" style="left:${position}%"><b>${escapeHtml(format(avg))}</b></span></div><div class="mc-range__ends"><span><small>Mínimo</small>${escapeHtml(format(min))}</span><span><small>Máximo</small>${escapeHtml(format(max))}</span></div></div>`;
}

// Un único tooltip por contenedor; responde a cursor, toque y foco de teclado.
export function bindChartTooltips(root) {
  if (root.dataset.tooltips) return;
  root.dataset.tooltips = 'true';
  const tip = document.createElement('div');
  tip.className = 'mc-tooltip'; tip.setAttribute('role', 'status'); tip.hidden = true;
  document.body.append(tip);
  const show = target => {
    tip.textContent = target.dataset.tip; tip.hidden = false;
    const rect = target.getBoundingClientRect(); const box = tip.getBoundingClientRect();
    const left = Math.min(innerWidth - box.width - 8, Math.max(8, rect.left + rect.width / 2 - box.width / 2));
    const top = rect.top - box.height - 8 < 8 ? rect.bottom + 8 : rect.top - box.height - 8;
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  };
  const hide = () => { tip.hidden = true; };
  root.addEventListener('pointerover', event => { const target = event.target.closest('[data-tip]'); if (target && root.contains(target)) show(target); });
  root.addEventListener('pointerout', event => { if (!event.relatedTarget?.closest?.('[data-tip]')) hide(); });
  root.addEventListener('focusin', event => { const target = event.target.closest('[data-tip]'); if (target) show(target); });
  root.addEventListener('focusout', hide);
  root.closest('.modal')?.addEventListener('scroll', hide, { passive: true });
  // El tooltip vive en <body>: se elimina cuando el contenedor sale del documento.
  const observer = new MutationObserver(() => { if (!root.isConnected) { tip.remove(); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
}
