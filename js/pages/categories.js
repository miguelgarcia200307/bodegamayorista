import { getCategories } from '../lib/api.js';
import { $, categoryInitials, emptyState, escapeHtml, getCategoryUrl, localAsset } from '../lib/helpers.js';

const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
const CATEGORY_PAGE_SIZE = 60;

function categoryVisual(category) {
  if (category.image_url) {
    return `<img src="${escapeHtml(localAsset(category.image_url))}" alt="" loading="lazy" decoding="async">`;
  }
  return `<span class="category-card__fallback" aria-hidden="true"><i>${escapeHtml(categoryInitials(category.name))}</i><b></b></span>`;
}

function categoryCard(category, children) {
  const preview = children.slice(0, 3).map(item => item.name).join(' · ');
  const secondary = preview || 'Ver productos disponibles';
  return `<a class="category-card" href="${getCategoryUrl(category.slug)}">
    <span class="category-card__media">${categoryVisual(category)}</span>
    <span class="category-card__body"><strong>${escapeHtml(category.name)}</strong><small>${escapeHtml(secondary)}</small><span class="category-card__meta">${children.length ? `${children.length} secci${children.length === 1 ? 'ón' : 'ones'}` : 'Explorar'}</span></span>
  </a>`;
}

export async function initCategories() {
  const categories = await getCategories();
  const parents = categories.filter(item => !item.parent_id && item.slug !== 'promo').sort(byName);
  const root = $('#all-categories');
  root.classList.remove('skeleton-grid');
  if (!parents.length) {
    root.innerHTML = emptyState('Aún no hay categorías', 'Explora el catálogo completo mientras agregamos nuevas secciones.');
    return;
  }
  root.innerHTML = parents.map(parent => categoryCard(
    parent,
    categories.filter(item => item.parent_id === parent.id).sort(byName)
  )).join('');
}
