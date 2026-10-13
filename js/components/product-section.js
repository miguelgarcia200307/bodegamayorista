import { renderProducts } from './product-card.js';
import { escapeHtml } from '../lib/helpers.js';
import { icon } from './icons.js';

// Sección de productos con encabezado y "Ver todos". layout: 'grid' (2 columnas en
// móvil) o 'rail' (carrusel horizontal).
export function renderProductSection(root, { eyebrow = '', title, products = [], seeAllUrl = 'catalogo.html', seeAllText = 'Ver todos', layout = 'grid' }) {
  if (!root) return false;
  if (!products.length) {
    root.hidden = true;
    root.innerHTML = '';
    return false;
  }
  const titleId = `${root.id || 'section'}-title`;
  root.hidden = false;
  root.setAttribute('aria-labelledby', titleId);
  root.innerHTML = `<div class="container"><div class="section-head"><div>${eyebrow ? `<span class="eyebrow-label">${escapeHtml(eyebrow)}</span>` : ''}<h2 id="${titleId}">${escapeHtml(title)}</h2></div>${seeAllUrl ? `<a class="section-link" href="${seeAllUrl}">${escapeHtml(seeAllText)}${icon('chevronRight', { size: 18 })}</a>` : ''}</div><div class="${layout === 'rail' ? 'rail' : 'product-grid'}"></div></div>`;
  renderProducts(root.querySelector('.rail, .product-grid'), products);
  return true;
}
