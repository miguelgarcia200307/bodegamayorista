import { icon } from '../components/icons.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

export function normalizeText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

export function categoryInitials(value = '') {
  const clean = normalizeText(value).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '•';
  const words = clean.split(' ').filter(word => !['de', 'del', 'la', 'el', 'las', 'los', 'y'].includes(word) && !/^\d+$/.test(word));
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : (words[0] || clean).slice(0, 2)).toUpperCase();
}

export function paymentInitials(value = '') {
  const clean = normalizeText(value).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '•';
  const aliases = { bancolombia: 'BC', daviplata: 'DP' };
  if (aliases[clean]) return aliases[clean];
  const words = clean.split(' ').filter(word => !['de', 'del', 'la', 'el', 'y'].includes(word));
  return (words.length > 1 ? words.slice(0, 2).map(word => word[0]).join('') : clean.slice(0, 2)).toUpperCase();
}

export function slugify(value = '') {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function categoryIdsWithDescendants(categories = [], categoryIds = []) {
  const ids = new Set((Array.isArray(categoryIds) ? categoryIds : [categoryIds]).filter(Boolean));
  let changed = true;
  while (changed) {
    changed = false;
    categories.forEach(category => {
      if (category.parent_id && ids.has(category.parent_id) && !ids.has(category.id)) {
        ids.add(category.id);
        changed = true;
      }
    });
  }
  return [...ids];
}

export function formatMoney(value = 0) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value) || 0);
}

export function getPromotionStatus(product, now = new Date()) {
  if (product?.promo_price == null) return 'none';
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const startTime = product.promo_start ? new Date(product.promo_start).getTime() : null;
  const endTime = product.promo_end ? new Date(product.promo_end).getTime() : null;
  if (endTime != null && Number.isFinite(endTime) && endTime < currentTime) return 'ended';
  if (product.promo_enabled === false) return 'inactive';
  if (startTime != null && Number.isFinite(startTime) && startTime > currentTime) return 'scheduled';
  return 'active';
}

export function isPromoActive(product, now = new Date()) {
  return getPromotionStatus(product, now) === 'active';
}

export const currentPrice = product => Number(isPromoActive(product) ? product.promo_price : product?.base_price || 0);

export function discountPercent(product) {
  if (!isPromoActive(product) || !Number(product.base_price)) return 0;
  return Math.round((1 - Number(product.promo_price) / Number(product.base_price)) * 100);
}

export function getProductUrl(slug) { return `producto.html?slug=${encodeURIComponent(slug)}`; }
export function getCategoryUrl(slug) { return `categoria.html?slug=${encodeURIComponent(slug)}`; }
export function getBrandUrl(slug) { return `marca.html?slug=${encodeURIComponent(slug)}`; }

export function pagePrefix() { return location.pathname.includes('/admin/') ? '../' : ''; }

export function localAsset(url = '') {
  if (!url) return `${pagePrefix()}assets/images/product-white.svg`;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${pagePrefix()}${url.replace(/^\/?/, '')}`;
}

export function productImage(product, colorId = null) {
  const images = product?.product_images || product?.images || [];
  const colorImages = colorId ? images.filter(image => image.color_id === colorId) : images;
  const selected = (colorImages.length ? colorImages : images)
    .slice().sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order)[0];
  return localAsset(selected?.url || product?.image_url);
}

export function debounce(fn, delay = 220) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

export function params() { return new URLSearchParams(location.search); }

export function routeSlug(name = 'slug') {
  const query = params();
  const raw = query.get(name)?.trim() || '';
  if (!raw) return '';

  // Some browser extensions and preview servers can append the current URL to
  // a relative link. Keep only the valid slug prefix so routing remains usable.
  const beforeUrl = raw.split(/https?:\/\//i, 1)[0].toLowerCase();
  const slug = beforeUrl.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)?.[0] || '';
  if (slug && slug !== raw) {
    query.set(name, slug);
    history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
  }
  return slug;
}

export async function sharePage({ title = document.title, text = '', url = location.href } = {}) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; }
    catch (error) { if (error.name === 'AbortError') return 'cancelled'; }
  }
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(url); copied = true; }
    catch { copied = false; }
  }
  if (!copied) {
    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    copied = true;
    input.remove();
  }
  return copied ? 'copied' : 'unavailable';
}

export function setButtonLoading(button, loading, label = 'Procesando…') {
  if (!button) return;
  // Tienda: spinner superpuesto que conserva el ancho del botón (sin saltos de layout).
  if (!document.body.dataset.page?.startsWith('admin')) {
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    if (loading) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    let status = button.querySelector('.btn__status');
    if (loading && !status) {
      status = document.createElement('span');
      status.className = 'sr-only btn__status';
      button.append(status);
    }
    if (status) status.textContent = loading ? label : '';
    return;
  }
  if (loading) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${escapeHtml(label)}`;
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || 'Listo';
    delete button.dataset.originalText;
  }
}

export function friendlyError(error, fallback = 'No pudimos completar la operación. Intenta nuevamente.') {
  console.error(error);
  return fallback;
}

const EMPTY_ICONS = { '○': 'package', '%': 'percent', '♡': 'heart', '⌕': 'search', '!': 'alert' };

export function emptyState(title, text, actionHref = 'catalogo.html', actionText = 'Ver todos los productos', iconName = 'package') {
  const glyph = icon(EMPTY_ICONS[iconName] || iconName, { size: 28 }) || escapeHtml(iconName);
  return `<div class="empty-state"><span class="empty-state__icon" aria-hidden="true">${glyph}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>${actionHref ? `<a class="btn btn--primary" href="${actionHref}">${escapeHtml(actionText)}</a>` : ''}</div>`;
}
