// Carrito: revalida precios y stock contra la base, muestra ahorros y descuentos por
// volumen, permite deshacer al eliminar y cambiar la opción en una hoja inferior.
import { openSheet, confirmAction } from '../components/modal.js';
import { renderProducts } from '../components/product-card.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { getCategories, getProducts, getProductsByIds } from '../lib/api.js';
import { $, escapeHtml, formatMoney, getCategoryUrl, getProductUrl, productImage } from '../lib/helpers.js';
import { cartPricing, variantPrice } from '../lib/pricing.js';
import { clearCart, getCart, setCart, updateCartLine } from '../lib/store.js';

let productsById = new Map();
let lineStatus = new Map();
const realOption = value => Boolean(value) && !/^única$/i.test(String(value).trim());
const optionText = item => [item.color, item.size].filter(realOption).join(' · ');
const tiersOf = product => (product.price_tiers || []).map(tier => ({ min_quantity: Number(tier.min_quantity), unit_price: Number(tier.unit_price) }));

export async function initCart() {
  bindCartEvents();
  const saved = getCart();
  if (saved.length) {
    try {
      const products = await getProductsByIds([...new Set(saved.map(item => item.product_id).filter(Boolean))]);
      productsById = new Map(products.map(product => [product.id, product]));
      setCart(saved.map(refreshLine));
    } catch (error) {
      console.warn('No se pudo revalidar el carrito:', error);
      lineStatus = new Map(saved.map(item => [item.line_id, { valid: false, reason: 'No pudimos confirmar la disponibilidad. Revisa tu conexión e intenta de nuevo.' }]));
    }
  }
  renderCart();
  loadRecommendations([...productsById.values()]);
}

function refreshLine(item) {
  const product = productsById.get(item.product_id);
  if (!product) { lineStatus.set(item.line_id, { valid: false, reason: 'Este producto ya no está disponible en la tienda.' }); return item; }
  const variant = (product.product_variants || []).find(option => option.id === item.variant_id);
  if (!variant || !variant.active) { lineStatus.set(item.line_id, { valid: false, reason: 'Esta opción ya no está disponible.' }); return item; }
  const color = (product.product_colors || []).find(option => option.id === variant.color_id);
  const size = (product.product_sizes || []).find(option => option.id === variant.size_id);
  const stock = product.force_sold_out ? 0 : Number(variant.stock || 0);
  const price = variantPrice(product, variant);
  const valid = stock > 0 && stock >= Number(item.quantity);
  lineStatus.set(item.line_id, { valid, priceChanged: Number(item.price) !== price, reason: stock === 0 ? 'Esta opción se acaba de agotar.' : valid ? '' : `Solo quedan ${stock} unidades.` });
  return { ...item, name: product.name, slug: product.slug, brand: product.brands?.name || '', image: productImage(product, color?.id), color_id: color?.id || item.color_id, color: color?.name || item.color, size_id: size?.id || item.size_id, size: size?.name || item.size, stock, price, base_price: Number(product.base_price || price), price_tiers: tiersOf(product) };
}

function itemMarkup(item, line) {
  const status = lineStatus.get(item.line_id) || { valid: true };
  const options = optionText(item);
  const product = productsById.get(item.product_id);
  const canEdit = product && ((product.product_colors || []).some(color => realOption(color.name)) || (product.product_sizes || []).some(size => realOption(size.name)));
  return `<article class="cart-item${status.valid ? '' : ' cart-item--invalid'}" data-line="${escapeHtml(item.line_id)}">
    <a class="cart-item__media" href="${getProductUrl(item.slug)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(item.image)}" alt="" width="96" height="96" loading="lazy"></a>
    <div class="cart-item__body">
      ${item.brand ? `<span class="cart-item__brand">${escapeHtml(item.brand)}</span>` : ''}
      <h2 class="cart-item__name"><a href="${getProductUrl(item.slug)}">${escapeHtml(item.name)}</a></h2>
      ${options ? `<p class="cart-item__options">${escapeHtml(options)}</p>` : ''}
      ${canEdit ? `<button class="btn--tertiary cart-item__edit" type="button" data-action="edit">Cambiar opción</button>` : ''}
      ${status.valid ? '' : `<p class="cart-item__alert">${icon('alert', { size: 16 })}${escapeHtml(status.reason)}</p>`}
      ${status.priceChanged ? '<p class="cart-item__note">El precio se actualizó.</p>' : ''}
      ${line.wholesale ? `<p class="cart-item__wholesale">${icon('layers', { size: 16 })}Precio por mayor aplicado: ${formatMoney(line.unit)} c/u</p>` : ''}
      <div class="cart-item__row">
        <div class="stepper stepper--sm" role="group" aria-label="Cantidad de ${escapeHtml(item.name)}"><button data-action="minus" type="button" aria-label="Quitar una unidad" ${item.quantity <= 1 ? 'disabled' : ''}>${icon('minus', { size: 16 })}</button><input value="${item.quantity}" min="1" max="${Math.max(1, Number(item.stock || 1))}" inputmode="numeric" type="number" aria-label="Cantidad"><button data-action="plus" type="button" aria-label="Agregar una unidad" ${!status.valid || item.quantity >= Number(item.stock) ? 'disabled' : ''}>${icon('plus', { size: 16 })}</button></div>
        <div class="cart-item__price">${line.list > line.unit ? `<del>${formatMoney(line.list * item.quantity)}</del>` : ''}<strong>${formatMoney(line.total)}</strong>${item.quantity > 1 ? `<small>${formatMoney(line.unit)} c/u</small>` : ''}</div>
      </div>
    </div>
    <button class="icon-button cart-item__remove" type="button" data-action="remove" aria-label="Eliminar ${escapeHtml(item.name)} del carrito">${icon('trash', { size: 20 })}</button>
  </article>`;
}

// Progreso hacia el siguiente tramo por volumen (solo si el producto tiene tramos).
function progressMarkup(cart, pricing) {
  const seen = new Set();
  const hints = [];
  cart.forEach(item => {
    const line = pricing.lines.get(item.line_id);
    if (!line?.next || seen.has(item.product_id)) return;
    seen.add(item.product_id);
    const missing = line.next.min_quantity - line.productUnits;
    const start = line.tier?.min_quantity || 0;
    const percent = Math.min(100, Math.round(((line.productUnits - start) / Math.max(1, line.next.min_quantity - start)) * 100));
    hints.push(`<div class="cart-progress"><p>Te ${missing === 1 ? 'falta' : 'faltan'} <strong>${missing} unidad${missing === 1 ? '' : 'es'}</strong> de ${escapeHtml(item.name)} para pagar ${formatMoney(Math.min(line.regular, line.next.unit_price))} c/u.</p><div class="cart-progress__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div></div>`);
  });
  return hints.slice(0, 2).join('');
}

function renderCart() {
  const cart = getCart();
  const root = $('#cart-items');
  const pricing = cartPricing(cart);
  root.classList.remove('is-loading');
  $('#cart-count-label').textContent = cart.length ? `${pricing.units} producto${pricing.units === 1 ? '' : 's'}` : '';
  const changed = cart.filter(item => lineStatus.get(item.line_id)?.priceChanged).length;
  const invalid = cart.filter(item => lineStatus.get(item.line_id)?.valid === false).length;
  $('#cart-notices').innerHTML = `${changed ? `<p class="notice notice--info">${icon('info', { size: 18 })}${changed === 1 ? 'Actualizamos el precio de un producto.' : `Actualizamos el precio de ${changed} productos.`}</p>` : ''}${invalid ? `<p class="notice notice--warning">${icon('alert', { size: 18 })}Revisa ${invalid === 1 ? 'un producto' : `${invalid} productos`} antes de continuar.</p>` : ''}`;

  if (!cart.length) {
    document.body.classList.add('cart-empty');
    root.innerHTML = `<div class="empty-state cart-empty-state"><span class="empty-state__icon" aria-hidden="true">${icon('bag', { size: 28 })}</span><h2>Tu carrito está vacío</h2><p>Descubre las ofertas de hoy o explora nuestras categorías.</p><div class="empty-state__actions"><a class="btn btn--primary" href="promociones.html">Ver ofertas</a><a class="btn btn--secondary" href="categorias.html">Ver categorías</a></div><div class="cart-empty-state__categories" data-empty-categories></div></div>`;
    $('#cart-summary').hidden = true;
    $('#cart-sticky-checkout').hidden = true;
    loadPopularCategories();
    return;
  }
  document.body.classList.remove('cart-empty');
  root.innerHTML = `${progressMarkup(cart, pricing)}${cart.map(item => itemMarkup(item, pricing.lines.get(item.line_id))).join('')}`;
  renderSummary(cart, pricing, invalid > 0);
}

function renderSummary(cart, pricing, invalid) {
  const listTotal = pricing.subtotal + pricing.totalSavings;
  $('#cart-summary').hidden = false;
  $('#cart-summary').innerHTML = `<div class="summary__head"><h2>Resumen del pedido</h2><button id="clear-cart" class="btn--tertiary" type="button">Vaciar</button></div>
    <dl class="summary__lines">
      <div><dt>Subtotal (${pricing.units} producto${pricing.units === 1 ? '' : 's'})</dt><dd>${formatMoney(listTotal)}</dd></div>
      ${pricing.promoSavings > 0 ? `<div class="is-saving"><dt>Ahorro en ofertas</dt><dd>−${formatMoney(pricing.promoSavings)}</dd></div>` : ''}
      ${pricing.wholesaleSavings > 0 ? `<div class="is-saving"><dt>Descuento por mayor</dt><dd>−${formatMoney(pricing.wholesaleSavings)}</dd></div>` : ''}
      <div><dt>Envío</dt><dd class="summary__muted">Se calcula al confirmar</dd></div>
      <div class="summary__total"><dt>Total</dt><dd>${formatMoney(pricing.subtotal)}</dd></div>
    </dl>
    ${pricing.totalSavings > 0 ? `<p class="summary__savings">${icon('tag', { size: 18 })}Estás ahorrando ${formatMoney(pricing.totalSavings)}</p>` : ''}
    ${invalid ? '<button class="btn btn--primary btn--block" type="button" disabled>Revisa el carrito para continuar</button>' : '<a class="btn btn--primary btn--block" href="checkout.html">Continuar pedido</a>'}
    <p class="summary__note">Confirmarás tu pedido por WhatsApp. No se hacen pagos en la web.</p>`;
  const sticky = $('#cart-sticky-checkout');
  sticky.hidden = false;
  sticky.innerHTML = `<div class="sticky-buy__price"><small>Total</small><strong>${formatMoney(pricing.subtotal)}</strong></div>${invalid ? '<button class="btn btn--primary" type="button" disabled>Revisar carrito</button>' : '<a class="btn btn--primary" href="checkout.html">Continuar pedido</a>'}`;
  $('#clear-cart').addEventListener('click', async event => {
    if (!(await confirmAction('Se quitarán todos los productos del carrito.', '¿Vaciar el carrito?', { confirmLabel: 'Vaciar carrito', trigger: event.currentTarget }))) return;
    const previous = getCart();
    clearCart();
    lineStatus.clear();
    renderCart();
    toast('Carrito vacío', 'success', 5000, { label: 'Deshacer', onClick: () => { setCart(previous); renderCart(); } });
  });
}

function removeLine(item) {
  const previous = getCart();
  const index = previous.findIndex(candidate => candidate.line_id === item.line_id);
  setCart(previous.filter(candidate => candidate.line_id !== item.line_id));
  renderCart();
  toast(`Quitaste ${item.name}`, 'success', 5000, {
    label: 'Deshacer',
    onClick: () => {
      const cart = getCart();
      if (cart.some(candidate => candidate.line_id === item.line_id)) return;
      cart.splice(Math.min(index, cart.length), 0, item);
      setCart(cart);
      renderCart();
    }
  });
}

function setQuantity(item, requested) {
  const stock = Number(item.stock || 1);
  const value = Math.max(1, Math.min(stock, requested));
  if (requested > stock) toast(`Solo quedan ${stock} unidades`, 'error');
  updateCartLine(item.line_id, { quantity: value });
  const valid = stock > 0 && value <= stock;
  lineStatus.set(item.line_id, { ...(lineStatus.get(item.line_id) || {}), valid, reason: valid ? '' : `Solo quedan ${stock} unidades.` });
  renderCart();
}

function bindCartEvents() {
  const root = $('#cart-items');
  root.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    const row = event.target.closest('[data-line]');
    if (!action || !row) return;
    const item = getCart().find(candidate => candidate.line_id === row.dataset.line);
    if (!item) return;
    if (action === 'remove') removeLine(item);
    else if (action === 'edit') openVariantEditor(item, event.target.closest('[data-action]'));
    else setQuantity(item, item.quantity + (action === 'plus' ? 1 : -1));
  });
  root.addEventListener('change', event => {
    const input = event.target.closest('.stepper input');
    const row = event.target.closest('[data-line]');
    const item = row && getCart().find(candidate => candidate.line_id === row.dataset.line);
    if (input && item) setQuantity(item, Number(input.value) || 1);
  });
}

function openVariantEditor(item, trigger) {
  const product = productsById.get(item.product_id);
  if (!product) { toast('Este producto ya no se puede modificar', 'error'); return; }
  const variants = (product.product_variants || []).filter(variant => variant.active && Number(variant.stock) > 0 && !product.force_sold_out);
  if (!variants.length) { toast('No hay otras opciones disponibles', 'error'); return; }
  const colors = (product.product_colors || []).filter(color => variants.some(variant => variant.color_id === color.id)).sort((a, b) => a.sort_order - b.sort_order);
  const sizes = (product.product_sizes || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  let color = colors.find(option => option.id === item.color_id) || colors[0];
  const variantFor = sizeId => variants.find(variant => variant.color_id === color?.id && variant.size_id === sizeId);
  let size = sizes.find(option => option.id === item.size_id && variantFor(option.id)) || sizes.find(option => variantFor(option.id));
  const wrapper = document.createElement('div');
  wrapper.className = 'variant-editor';
  const sheet = openSheet({ title: 'Cambiar opción', content: wrapper, trigger });
  const draw = () => {
    const selected = variantFor(size?.id);
    wrapper.innerHTML = `<div class="variant-editor__product"><img src="${escapeHtml(productImage(product, color?.id))}" alt="" width="64" height="64"><div><strong>${escapeHtml(product.name)}</strong><span>${formatMoney(variantPrice(product, selected))}</span></div></div>
      ${colors.some(option => realOption(option.name)) ? `<fieldset class="variant-editor__group"><legend>${escapeHtml(product.option1_name || 'Opción')}</legend><div class="option-chips">${colors.map(option => `<button class="option-chip${option.id === color?.id ? ' active' : ''}" data-color="${option.id}" type="button" aria-pressed="${option.id === color?.id}">${escapeHtml(option.name)}</button>`).join('')}</div></fieldset>` : ''}
      ${sizes.some(option => realOption(option.name)) ? `<fieldset class="variant-editor__group"><legend>${escapeHtml(product.option2_name || 'Presentación')}</legend><div class="option-chips">${sizes.map(option => `<button class="option-chip${option.id === size?.id ? ' active' : ''}" data-size="${option.id}" type="button" aria-pressed="${option.id === size?.id}" ${variantFor(option.id) ? '' : 'disabled'}>${escapeHtml(option.name)}</button>`).join('')}</div></fieldset>` : ''}
      <p class="variant-editor__stock">${selected ? `${selected.stock} disponible${Number(selected.stock) === 1 ? '' : 's'}` : 'Elige una combinación disponible'}</p>
      <button class="btn btn--primary btn--block" data-save-variant type="button" ${selected ? '' : 'disabled'}>Guardar cambio</button>`;
  };
  wrapper.addEventListener('click', event => {
    const colorButton = event.target.closest('[data-color]');
    const sizeButton = event.target.closest('[data-size]');
    if (colorButton) { color = colors.find(option => option.id === colorButton.dataset.color); size = sizes.find(option => variantFor(option.id)); draw(); return; }
    if (sizeButton && !sizeButton.disabled) { size = sizes.find(option => option.id === sizeButton.dataset.size); draw(); return; }
    if (!event.target.closest('[data-save-variant]')) return;
    const variant = variantFor(size?.id);
    if (!variant) return;
    const quantity = Math.min(item.quantity, Number(variant.stock));
    updateCartLine(item.line_id, { variant_id: variant.id, color_id: color?.id, color: color?.name, size_id: size?.id, size: size?.name, stock: Number(variant.stock), quantity, image: productImage(product, color?.id), price: variantPrice(product, variant) });
    lineStatus.set(item.line_id, { valid: true, priceChanged: false, reason: '' });
    sheet.close();
    toast(quantity < item.quantity ? `Opción actualizada. Solo quedan ${quantity} unidades.` : 'Opción actualizada');
    renderCart();
  });
  draw();
}

async function loadPopularCategories() {
  try {
    const categories = (await getCategories()).filter(category => !category.parent_id).slice(0, 6);
    const root = document.querySelector('[data-empty-categories]');
    if (root && categories.length) root.innerHTML = `<p>Categorías populares</p><div class="chip-row">${categories.map(category => `<a class="chip" href="${getCategoryUrl(category.slug)}">${escapeHtml(category.name)}</a>`).join('')}</div>`;
  } catch { /* opcional */ }
}

async function loadRecommendations(cartProducts) {
  try {
    const first = cartProducts[0];
    const categoryId = first?.product_categories?.[0]?.category_id;
    const { products } = await getProducts({ categoryId, featured: first ? undefined : true, pageSize: 10 });
    const inCart = new Set(getCart().map(item => item.product_id));
    const recommendations = products.filter(product => !inCart.has(product.id) && !product.force_sold_out && product.product_variants.some(variant => variant.active && Number(variant.stock) > 0)).slice(0, 8);
    if (!recommendations.length) return;
    $('#cart-recommendations').hidden = false;
    renderProducts($('#cart-recommendation-products'), recommendations);
  } catch (error) { console.warn('No se pudieron cargar recomendaciones:', error); }
}

