// Tarjeta de producto única para toda la tienda (listados, rieles, favoritos, carrito).
import { currentPrice, discountPercent, escapeHtml, formatMoney, getProductUrl, isPromoActive, productImage } from '../lib/helpers.js';
import { bestTier, variantPrice } from '../lib/pricing.js';
import { addCartItem, buildCartItem, isFavorite, toggleFavorite } from '../lib/store.js';
import { icon } from './icons.js';
import { toast } from './toast.js';

const productCache = new Map();
const NEW_DAYS = 14;
const isRealOption = name => Boolean(name) && !/^única$/i.test(String(name).trim());

function activeVariants(product) {
  return (product.product_variants || []).filter(variant => variant.active);
}

export function productStock(product) {
  return product.force_sold_out ? 0 : activeVariants(product).reduce((sum, variant) => sum + Number(variant.stock || 0), 0);
}

// Un producto "sin variantes" tiene una sola combinación activa y sin opciones reales.
export function singleVariant(product) {
  const variants = activeVariants(product);
  const hasOptions = (product.product_colors || []).some(color => isRealOption(color.name)) || (product.product_sizes || []).some(size => isRealOption(size.name));
  return variants.length === 1 && !hasOptions ? variants[0] : null;
}

function badgeFor(product, stock) {
  if (stock === 0) return '<span class="badge-tag badge-tag--muted">Agotado</span>';
  if (isPromoActive(product) && discountPercent(product) > 0) return `<span class="badge-tag badge-tag--sale">-${discountPercent(product)}%</span>`;
  const threshold = Number(product.low_stock_threshold ?? 3);
  if (product.force_last_units || stock <= threshold) return `<span class="badge-tag badge-tag--low">${stock <= threshold ? `Últimas ${stock}` : 'Últimas unidades'}</span>`;
  const created = new Date(product.created_at).getTime();
  if (Number.isFinite(created) && Date.now() - created < NEW_DAYS * 86400000) return '<span class="badge-tag badge-tag--new">Nuevo</span>';
  return '';
}

export function priceMarkup(product, { className = '' } = {}) {
  const promo = isPromoActive(product) && discountPercent(product) > 0;
  return `<div class="price ${className}"><strong class="price__now">${formatMoney(currentPrice(product))}</strong>${promo ? `<del class="price__was">${formatMoney(product.base_price)}</del><span class="price__off">-${discountPercent(product)}%</span>` : ''}</div>`;
}

export function wholesaleHint(product) {
  const tier = bestTier(product);
  if (!tier) return '';
  const unit = Math.min(tier.unit_price, currentPrice(product));
  if (unit >= currentPrice(product)) return '';
  return `Desde ${formatMoney(unit)} c/u por ${tier.min_quantity}+ unidades`;
}

export function productCard(product, { eager = false } = {}) {
  productCache.set(product.id, product);
  const stock = productStock(product);
  const brand = product.brands?.name || '';
  const url = getProductUrl(product.slug);
  const favorite = isFavorite(product.id);
  const quick = stock > 0 ? singleVariant(product) : null;
  const wholesale = wholesaleHint(product);
  return `<article class="product-card${stock === 0 ? ' is-sold-out' : ''}" data-product-id="${escapeHtml(product.id)}">
    <div class="product-card__media">
      <img src="${escapeHtml(productImage(product))}" alt="${escapeHtml(product.name)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" width="600" height="600">
      ${badgeFor(product, stock)}
      <button class="product-card__favorite${favorite ? ' active' : ''}" type="button" data-favorite="${escapeHtml(product.id)}" aria-pressed="${favorite}" aria-label="${favorite ? 'Quitar de' : 'Agregar a'} favoritos: ${escapeHtml(product.name)}">${icon('heart', { size: 18 })}</button>
      ${quick ? `<button class="product-card__add" type="button" data-quick-add="${escapeHtml(product.id)}" aria-label="Agregar ${escapeHtml(product.name)} al carrito">${icon('plus', { size: 20 })}</button>` : ''}
    </div>
    <div class="product-card__body">
      <p class="product-card__brand">${escapeHtml(brand)}</p>
      <h3 class="product-card__title"><a class="product-card__link" href="${url}">${escapeHtml(product.name)}</a></h3>
      ${priceMarkup(product, { className: 'product-card__price' })}
      ${wholesale ? `<p class="product-card__wholesale">${escapeHtml(wholesale)}</p>` : ''}
    </div>
  </article>`;
}

function quickAdd(button) {
  const product = productCache.get(button.dataset.quickAdd);
  const variant = product && singleVariant(product);
  if (!variant || Number(variant.stock) <= 0) { toast('Este producto no está disponible ahora', 'error'); return; }
  const color = (product.product_colors || []).find(item => item.id === variant.color_id) || null;
  const size = (product.product_sizes || []).find(item => item.id === variant.size_id) || null;
  addCartItem(buildCartItem({ product, variant, color, size, quantity: 1, image: productImage(product), price: variantPrice(product, variant) }));
  button.classList.add('is-added');
  setTimeout(() => button.classList.remove('is-added'), 900);
  toast('Agregado al carrito', 'success', 3200, { label: 'Ver carrito', href: 'carrito.html' });
}

export function bindProductCards(root = document) {
  root.querySelectorAll('[data-favorite]:not([data-bound])').forEach(button => {
    button.dataset.bound = 'true';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      const active = toggleFavorite(button.dataset.favorite);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      const name = productCache.get(button.dataset.favorite)?.name;
      button.setAttribute('aria-label', `${active ? 'Quitar de' : 'Agregar a'} favoritos${name ? `: ${name}` : ''}`);
      toast(active ? 'Guardado en favoritos' : 'Eliminado de favoritos', 'success', 2600, active ? { label: 'Ver favoritos', href: 'favoritos.html' } : null);
      button.dispatchEvent(new CustomEvent('favorite:toggled', { bubbles: true, detail: { id: button.dataset.favorite, active } }));
    });
  });
  root.querySelectorAll('[data-quick-add]:not([data-bound])').forEach(button => {
    button.dataset.bound = 'true';
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); quickAdd(button); });
  });
}

export function renderProducts(root, products, options = {}) {
  root.classList.remove('skeleton-grid', 'is-loading');
  root.setAttribute('aria-busy', 'false');
  root.innerHTML = products.map((product, index) => productCard(product, { ...options, eager: options.eager && index < 2 })).join('');
  bindProductCards(root);
}

export function productSkeleton() {
  return '<article class="product-card product-card--skeleton" aria-hidden="true"><div class="product-card__media skeleton"></div><div class="product-card__body"><span class="skeleton skeleton--line skeleton--short"></span><span class="skeleton skeleton--line"></span><span class="skeleton skeleton--line skeleton--mid"></span></div></article>';
}

export function renderProductSkeletons(root, count = 8) {
  root.classList.add('is-loading');
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = Array.from({ length: count }, productSkeleton).join('');
}
