// Ficha de producto.
import { getProductBySlug, getProducts, getProductsByIds } from '../lib/api.js';
import { renderProductSection } from '../components/product-section.js';
import { openModal, openSheet } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { getSiteData, whatsappLink } from '../site-config.js';
import { $, $$, escapeHtml, formatMoney, getCategoryUrl, localAsset, params, productImage, routeSlug, sharePage, setButtonLoading } from '../lib/helpers.js';
import { nextTier, priceTiers, tierFor, tierRanges, unitPriceFor, variantPrice } from '../lib/pricing.js';
import { addCartItem, buildCartItem, getCart, isFavorite, toggleFavorite, updateCartLine } from '../lib/store.js';

const RECENT_KEY = 'bodega_mayorista_fc_recent_products_v1';
const isRealOption = name => Boolean(name) && !/^única$/i.test(String(name).trim());
const text = value => escapeHtml(String(value || '').trim()).replace(/\r?\n/g, '<br>');

function rememberViewed(id) {
  try {
    const ids = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(item => typeof item === 'string' && item !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...ids].slice(0, 12)));
    return ids;
  } catch { return []; }
}

function accordionsMarkup(product, site) {
  const sections = [];
  if (String(product.description || '').trim()) sections.push(['description-panel', 'Descripción', `<p>${text(product.description)}</p>`]);
  const specs = Array.isArray(product.specifications?.items) ? product.specifications.items.filter(item => item?.label && item?.value) : [];
  const extra = [product.model ? { label: 'Modelo', value: product.model } : null, product.sku ? { label: 'Referencia', value: product.sku } : null, product.material ? { label: 'Materiales', value: product.material } : null].filter(Boolean);
  if (specs.length || extra.length) sections.push(['specs-panel', 'Especificaciones', `<dl class="product-specs">${[...specs, ...extra].map(item => `<div><dt>${escapeHtml(item.label)}</dt><dd>${text(item.value)}</dd></div>`).join('')}</dl>`]);
  if (String(product.care_instructions || '').trim()) sections.push(['care-panel', 'Uso y cuidado', `<p>${text(product.care_instructions)}</p>`]);
  const shipping = [
    product.purchase_delivery_info ? `<p>${text(product.purchase_delivery_info)}</p>` : '',
    site.deliveries.length ? `<ul class="plain-list">${site.deliveries.map(item => `<li><strong>${escapeHtml(item.name)}</strong>${item.instructions ? ` · ${escapeHtml(item.instructions)}` : ''}</li>`).join('')}</ul>` : '',
    site.shipsNationwide && !site.deliveries.length ? '<p>Enviamos a todo el país. Confirmamos el costo y el tiempo de entrega por WhatsApp.</p>' : '',
    site.warrantyText ? `<p><strong>Garantía:</strong> ${escapeHtml(site.warrantyText)}</p>` : ''
  ].filter(Boolean).join('');
  if (shipping) sections.push(['shipping-panel', 'Envíos y garantía', shipping]);
  if (!sections.length) return '';
  return `<div class="product-accordions" id="product-details">${sections.map(([id, title, content]) => `<section class="accordion"><h2><button type="button" aria-expanded="false" aria-controls="${id}"><span>${title}</span><span class="accordion__sign" aria-hidden="true"></span></button></h2><div id="${id}" class="accordion__panel" hidden>${content}</div></section>`).join('')}</div>`;
}

function trustMarkup(site) {
  const items = [];
  const topic = slug => site.helpTopics.some(item => item.slug === slug) ? `ayuda.html#${slug}` : '';
  if (site.shipsNationwide || site.deliveries.length) items.push({ icon: 'truck', label: site.shippingEstimates[0] ? `Envío a ${site.shippingEstimates[0].city}: ${site.shippingEstimates[0].time}` : 'Envíos a todo el país', href: topic('envios') });
  if (site.warrantyText) items.push({ icon: 'shield', label: site.warrantyText, href: topic('garantia') });
  if (site.payments.length) items.push({ icon: 'card', label: `Pago: ${site.payments.map(item => item.name).join(', ')}`, href: topic('pagos') });
  if (site.returnsPolicy) items.push({ icon: 'returns', label: 'Cambios y devoluciones', href: topic('cambios') });
  if (site.hasPhysicalStore) items.push({ icon: 'store', label: `Tienda física en ${site.city}`, href: site.mapsUrl });
  if (!items.length) return '';
  return `<ul class="product-trust">${items.map(item => `<li>${icon(item.icon, { size: 20 })}${item.href ? `<a href="${escapeHtml(item.href)}"${/^https?:/.test(item.href) ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`}</li>`).join('')}</ul>`;
}

function structuredData(product, image, price, stock, crumbs) {
  const url = location.href.split('#')[0];
  const data = [{
    '@context': 'https://schema.org', '@type': 'Product', name: product.name, image: [new URL(image, location.href).href],
    description: String(product.description || product.name).slice(0, 500), sku: product.sku || undefined,
    brand: product.brands?.name ? { '@type': 'Brand', name: product.brands.name } : undefined,
    offers: { '@type': 'Offer', url, priceCurrency: 'COP', price: Math.round(price), availability: `https://schema.org/${stock > 0 ? 'InStock' : 'OutOfStock'}`, seller: { '@type': 'Organization', name: 'Bodega Mayorista F.C.' } }
  }, {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: new URL(crumb.url, location.href).href }))
  }];
  const script = document.createElement('script');
  script.type = 'application/ld+json';
  script.textContent = JSON.stringify(data);
  document.head.append(script);
}

function setMeta(product, image) {
  const description = `${product.name}${product.brands?.name ? ` de ${product.brands.name}` : ''}. ${String(product.description || '').replace(/\s+/g, ' ').slice(0, 120)}`.trim();
  document.title = `${product.name} | Bodega Mayorista F.C.`;
  const set = (selector, attr, value) => { const element = document.querySelector(selector); if (element) element.setAttribute(attr, value); };
  set('meta[name="description"]', 'content', description);
  set('meta[property="og:title"]', 'content', product.name);
  set('meta[property="og:description"]', 'content', description);
  set('meta[property="og:image"]', 'content', new URL(image, location.href).href);
}

export async function initProduct() {
  const slug = routeSlug();
  if (!slug) throw new Error('Producto no indicado');
  const [product, site] = await Promise.all([getProductBySlug(slug), getSiteData()]);
  const previousViews = rememberViewed(product.id);

  const colors = (product.product_colors || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const sizes = (product.product_sizes || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const realColors = colors.filter(color => isRealOption(color.name));
  const realSizes = sizes.filter(size => isRealOption(size.name));
  const editLineId = params().get('edit');
  const editCandidate = editLineId ? getCart().find(item => item.line_id === editLineId) : null;
  const editing = editCandidate?.product_id === product.id ? editCandidate : null;
  const variantFor = (colorId, sizeId) => (product.product_variants || []).find(variant => (variant.color_id || null) === (colorId || null) && variant.size_id === sizeId && variant.active);
  const stockOf = variant => (product.force_sold_out ? 0 : Number(variant?.stock || 0));
  const firstAvailableSize = color => sizes.find(size => stockOf(variantFor(color?.id, size.id)) > 0) || null;
  const colorAvailable = color => sizes.some(size => stockOf(variantFor(color.id, size.id)) > 0);

  let selectedColor = colors.find(item => item.id === editing?.color_id) || colors.find(colorAvailable) || colors[0] || null;
  let selectedSize = sizes.find(item => item.id === editing?.size_id) || firstAvailableSize(selectedColor);
  let quantity = Math.max(1, Number(editing?.quantity || 1));
  let galleryImages = [];
  let galleryIndex = 0;

  const category = product.product_categories?.[0]?.categories;
  const crumbs = [{ name: 'Inicio', url: 'index.html' }, ...(category ? [{ name: category.name, url: getCategoryUrl(category.slug) }] : []), { name: product.name, url: `producto.html?slug=${encodeURIComponent(product.slug)}` }];
  $('#product-breadcrumbs').innerHTML = crumbs.map((crumb, index) => index === crumbs.length - 1 ? `<span aria-current="page">${escapeHtml(crumb.name)}</span>` : `<a href="${crumb.url}">${escapeHtml(crumb.name)}</a>${icon('chevronRight', { size: 14 })}`).join('');

  const optionGroup = (id, label, items, key, selected) => {
    if (!items.length) return `<div class="option-group" id="${id}" hidden></div>`;
    if (items.length === 1) return `<div class="option-group option-group--single" id="${id}"><p class="option-group__head"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(items[0].name)}</span></p><div id="${key}-options" hidden></div></div>`;
    return `<div class="option-group" id="${id}" role="radiogroup" aria-labelledby="${id}-label"><div class="option-group__head"><strong id="${id}-label">${escapeHtml(label)}</strong><span data-selected-${key}>${escapeHtml(selected?.name || '')}</span>${key === 'size' && (product.size_guide_text || product.size_guide_image_url) ? `<button id="size-guide" class="btn--tertiary option-group__guide" type="button">${icon('ruler', { size: 18 })}Ver guía</button>` : ''}</div><div id="${key}-options" class="option-chips"></div><p class="option-error" id="${key}-error" hidden>Elige una opción disponible.</p></div>`;
  };

  const root = $('#product-detail');
  root.innerHTML = `<section class="product-detail__gallery gallery" aria-label="Galería de ${escapeHtml(product.name)}">
      <div class="gallery__viewport">
        <div class="gallery__track" id="gallery-track" tabindex="0" aria-label="Imágenes del producto. Desliza para ver más."></div>
        <div class="gallery__actions">
          <button id="share-product" class="gallery__action" type="button" aria-label="Compartir producto">${icon('share', { size: 20 })}</button>
          <button id="product-favorite" class="gallery__action${isFavorite(product.id) ? ' active' : ''}" type="button" aria-pressed="${isFavorite(product.id)}" aria-label="${isFavorite(product.id) ? 'Quitar de' : 'Agregar a'} favoritos">${icon('heart', { size: 20 })}</button>
        </div>
        <span id="gallery-count" class="gallery__count" aria-live="polite"></span>
        <button id="gallery-zoom" class="gallery__zoom" type="button" aria-label="Ver imagen en pantalla completa">${icon('zoom', { size: 18 })}</button>
      </div>
      <div id="gallery-thumbs" class="gallery__thumbs" aria-label="Miniaturas"></div>
    </section>
    <section class="product-detail__info product-info">
      ${product.brands?.name ? `<a class="product-info__brand" href="marca.html?slug=${encodeURIComponent(product.brands.slug)}">${escapeHtml(product.brands.name)}</a>` : ''}
      <h1 class="product-info__title">${escapeHtml(product.name)}</h1>
      <div id="price-block" class="price-block"></div>
      <div id="tier-block" class="tier-block" hidden></div>
      ${optionGroup('color-group', product.option1_name || 'Opción', realColors, 'color', selectedColor)}
      ${optionGroup('size-group', product.option2_name || 'Presentación', realSizes, 'size', selectedSize)}
      <p id="stock-status" class="stock-status" role="status"></p>
      <div class="purchase">
        <div class="quantity-row"><span id="qty-label">Cantidad</span><div class="stepper" role="group" aria-labelledby="qty-label"><button id="qty-minus" type="button" aria-label="Quitar una unidad">${icon('minus', { size: 18 })}</button><input id="quantity" type="number" inputmode="numeric" min="1" value="${quantity}" aria-label="Cantidad"><button id="qty-plus" type="button" aria-label="Agregar una unidad">${icon('plus', { size: 18 })}</button></div></div>
        <p id="purchase-total" class="purchase__total" aria-live="polite"></p>
        <button id="add-cart" class="btn btn--primary btn--block" type="button"></button>
        ${site.whatsapp ? '<a id="ask-whatsapp" class="btn btn--whatsapp-outline btn--block" target="_blank" rel="noopener"></a>' : ''}
      </div>
      ${trustMarkup(site)}
      ${accordionsMarkup(product, site)}
    </section>`;

  document.querySelector('#product-sticky-buy')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div id="product-sticky-buy" class="sticky-buy" hidden><div class="sticky-buy__price"><small>Total</small><strong></strong></div><button type="button" class="btn btn--primary"></button></div>`);
  const sticky = $('#product-sticky-buy');

  function imagesForColor(color) {
    const all = (product.product_images || []).slice().sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order);
    const byColor = all.filter(image => image.color_id === color?.id);
    const general = all.filter(image => !image.color_id);
    const chosen = color ? (byColor.length ? [...byColor, ...general] : general.length ? general : all) : (general.length ? general : all);
    const seen = new Set();
    return chosen.filter(image => { const url = localAsset(image.url); if (seen.has(url)) return false; seen.add(url); return true; });
  }

  function renderGallery() {
    galleryImages = imagesForColor(selectedColor);
    if (!galleryImages.length) galleryImages = [{ url: productImage(product), alt_text: product.name }];
    galleryIndex = 0;
    $('#gallery-track').innerHTML = galleryImages.map((image, index) => `<figure class="gallery__slide"><img src="${escapeHtml(localAsset(image.url))}" alt="${escapeHtml(image.alt_text && !/\.(jpe?g|png|webp|avif)$/i.test(image.alt_text) ? image.alt_text : `${product.name}, imagen ${index + 1} de ${galleryImages.length}`)}" width="800" height="800" ${index === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async"></figure>`).join('');
    $('#gallery-track').scrollLeft = 0;
    $('#gallery-thumbs').innerHTML = galleryImages.length > 1 ? galleryImages.map((image, index) => `<button class="gallery__thumb${index ? '' : ' active'}" type="button" data-image="${index}" aria-label="Ver imagen ${index + 1}" aria-current="${index === 0}"><img src="${escapeHtml(localAsset(image.url))}" alt="" width="64" height="64" loading="lazy"></button>`).join('') : '';
    updateGalleryIndex(0);
  }

  function updateGalleryIndex(index) {
    galleryIndex = Math.max(0, Math.min(index, galleryImages.length - 1));
    $('#gallery-count').textContent = `${galleryIndex + 1}/${galleryImages.length}`;
    $('#gallery-count').hidden = galleryImages.length < 2;
    $$('.gallery__thumb').forEach((thumb, position) => { thumb.classList.toggle('active', position === galleryIndex); thumb.setAttribute('aria-current', String(position === galleryIndex)); });
  }

  function scrollToImage(index) {
    const track = $('#gallery-track');
    track.scrollTo({ left: track.clientWidth * index, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    updateGalleryIndex(index);
  }

  function openLightbox(startIndex, trigger) {
    const wrapper = document.createElement('div');
    wrapper.className = 'lightbox';
    wrapper.innerHTML = `<div class="lightbox__track">${galleryImages.map((image, index) => `<div class="lightbox__slide"><img src="${escapeHtml(localAsset(image.url))}" alt="${escapeHtml(`${product.name}, imagen ${index + 1}`)}" loading="${index === startIndex ? 'eager' : 'lazy'}"></div>`).join('')}</div>${galleryImages.length > 1 ? `<button class="lightbox__nav lightbox__nav--prev" type="button" aria-label="Imagen anterior">${icon('chevronLeft', { size: 24 })}</button><button class="lightbox__nav lightbox__nav--next" type="button" aria-label="Imagen siguiente">${icon('chevronRight', { size: 24 })}</button>` : ''}<p class="lightbox__hint">Toca la imagen para acercar · pellizca para hacer zoom</p>`;
    const modal = openModal({ title: `${startIndex + 1}/${galleryImages.length} · ${product.name}`, content: wrapper, className: 'modal--lightbox', trigger });
    const track = wrapper.querySelector('.lightbox__track');
    const title = modal.element.querySelector('.modal__head h2');
    requestAnimationFrame(() => { track.scrollLeft = track.clientWidth * startIndex; });
    const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    track.addEventListener('scroll', () => { title.textContent = `${current() + 1}/${galleryImages.length} · ${product.name}`; }, { passive: true });
    wrapper.addEventListener('click', event => {
      const nav = event.target.closest('.lightbox__nav');
      if (nav) { track.scrollTo({ left: track.clientWidth * (current() + (nav.classList.contains('lightbox__nav--next') ? 1 : -1)), behavior: 'smooth' }); return; }
      const slide = event.target.closest('.lightbox__slide');
      if (!slide) return;
      const image = slide.querySelector('img');
      const rect = image.getBoundingClientRect();
      const zoomed = slide.classList.toggle('is-zoomed');
      if (zoomed) {
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        requestAnimationFrame(() => { slide.scrollLeft = slide.scrollWidth * x - slide.clientWidth / 2; slide.scrollTop = slide.scrollHeight * y - slide.clientHeight / 2; });
      }
    });
  }

  function currentVariant() { return variantFor(selectedColor?.id, selectedSize?.id); }

  function renderOptions() {
    if (realColors.length > 1) {
      $('#color-options').innerHTML = colors.map(color => {
        const active = color.id === selectedColor?.id;
        const available = colorAvailable(color);
        return `<button class="option-chip${active ? ' active' : ''}${available ? '' : ' is-unavailable'}" type="button" role="radio" data-color="${color.id}" aria-checked="${active}" aria-pressed="${active}" aria-label="${escapeHtml(color.name)}${available ? '' : ', agotado'}">${color.hex_code ? `<span class="option-chip__swatch" style="--swatch:${escapeHtml(color.hex_code)}" aria-hidden="true"></span>` : ''}${escapeHtml(color.name)}</button>`;
      }).join('');
      $('[data-selected-color]').textContent = selectedColor?.name || '';
    }
    if (realSizes.length > 1) {
      $('#size-options').innerHTML = sizes.map(size => {
        const variant = variantFor(selectedColor?.id, size.id);
        const available = stockOf(variant) > 0;
        const active = size.id === selectedSize?.id && available;
        return `<button class="option-chip${active ? ' active' : ''}" type="button" role="radio" data-size="${size.id}" aria-checked="${active}" aria-pressed="${active}" ${available ? '' : `disabled aria-label="${escapeHtml(size.name)}, agotado"`}>${escapeHtml(size.name)}</button>`;
      }).join('');
      $('[data-selected-size]').textContent = selectedSize?.name || '';
    }
  }

  function cartUnitsOfProduct() {
    return getCart().filter(item => item.product_id === product.id && item.line_id !== editing?.line_id).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  }

  function update() {
    const variant = currentVariant();
    const stock = stockOf(variant);
    const regular = variantPrice(product, variant);
    const list = Math.max(regular, Number(product.base_price || 0));
    const units = quantity + cartUnitsOfProduct();
    const unit = unitPriceFor(regular, product, units);
    const total = unit * quantity;
    const off = list > regular ? Math.round((1 - regular / list) * 100) : 0;

    $('#price-block').innerHTML = `<div class="price price--lg"><strong class="price__now">${formatMoney(regular)}</strong>${off ? `<del class="price__was">${formatMoney(list)}</del><span class="badge-tag badge-tag--sale">-${off}%</span>` : ''}</div>${off ? `<p class="price-block__save">Ahorras ${formatMoney(list - regular)}</p>` : ''}`;

    const tiers = priceTiers(product);
    const tierBlock = $('#tier-block');
    if (tiers.length) {
      const active = tierFor(product, units);
      const next = nextTier(product, units);
      const rows = tierRanges(product, regular);
      tierBlock.hidden = false;
      tierBlock.innerHTML = `<p class="tier-block__title">${icon('layers', { size: 18 })}Precio por mayor</p><div class="tier-table">${rows.map(row => { const isActive = units >= row.from && (row.to == null || units <= row.to); return `<span class="tier-table__row${isActive ? ' is-active' : ''}"><span>${row.to ? `${row.from}–${row.to}` : `${row.from}+`} u</span><strong>${formatMoney(row.unit)} c/u</strong></span>`; }).join('')}</div>${next ? `<p class="tier-block__hint">Agrega ${next.min_quantity - units} más y pagas ${formatMoney(Math.min(regular, next.unit_price))} c/u.</p>` : active ? '<p class="tier-block__hint is-success">Tienes el mejor precio por volumen.</p>' : ''}${cartUnitsOfProduct() ? `<p class="tier-block__note">Incluye ${cartUnitsOfProduct()} u que ya tienes en el carrito.</p>` : ''}`;
    }

    const status = $('#stock-status');
    status.className = 'stock-status';
    if (!stock) { status.classList.add('stock-status--sold'); status.innerHTML = '<span aria-hidden="true"></span>Agotado en esta opción'; }
    else if (product.force_last_units || stock <= Number(product.low_stock_threshold ?? 3)) { status.classList.add('stock-status--low'); status.innerHTML = `<span aria-hidden="true"></span>¡Últimas ${stock} unidad${stock === 1 ? '' : 'es'}!`; }
    else status.innerHTML = '<span aria-hidden="true"></span>Disponible';

    const input = $('#quantity');
    input.max = Math.max(stock, 1);
    quantity = Math.max(1, Math.min(quantity, Math.max(stock, 1)));
    input.value = quantity;
    $('#qty-minus').disabled = quantity <= 1;
    $('#qty-plus').disabled = !stock || quantity >= stock;
    $('#purchase-total').innerHTML = quantity > 1 || unit < regular ? `Total: <strong>${formatMoney(total)}</strong> <span>(${quantity} × ${formatMoney(unit)})</span>` : '';

    const cta = $('#add-cart');
    if (!cta.classList.contains('is-loading')) {
      cta.disabled = !stock;
      cta.textContent = !stock ? 'Agotado' : editing ? 'Actualizar carrito' : 'Agregar al carrito';
    }
    sticky.querySelector('strong').textContent = formatMoney(stock ? total : regular);
    sticky.querySelector('button').disabled = !stock;
    sticky.querySelector('button').textContent = !stock ? 'Agotado' : editing ? 'Actualizar' : 'Agregar al carrito';

    const ask = $('#ask-whatsapp');
    if (ask) {
      const option = [selectedColor, selectedSize].filter(item => item && isRealOption(item.name)).map(item => item.name).join(' / ');
      const message = `Hola, quiero información sobre ${product.name}${option ? ` (${option})` : ''}. Cantidad: ${quantity}. ${location.href.split('#')[0]}`;
      ask.href = whatsappLink(site.whatsapp.number, message);
      ask.innerHTML = `${icon('whatsapp', { size: 20 })}<span>Preguntar por WhatsApp</span>`;
    }
    return { stock, regular };
  }

  function setQuantity(next) {
    const max = Number($('#quantity').max || 1);
    if (next > max) toast(`Solo quedan ${max} unidad${max === 1 ? '' : 'es'} disponibles`, 'error');
    quantity = Math.max(1, Math.min(max, next));
    update();
  }

  $('#color-options')?.addEventListener('click', event => {
    const button = event.target.closest('[data-color]');
    if (!button) return;
    selectedColor = colors.find(color => color.id === button.dataset.color) || null;
    if (!stockOf(currentVariant())) selectedSize = firstAvailableSize(selectedColor) || selectedSize;
    renderGallery(); renderOptions(); update();
  });
  $('#size-options')?.addEventListener('click', event => {
    const button = event.target.closest('[data-size]');
    if (!button || button.disabled) return;
    selectedSize = sizes.find(size => size.id === button.dataset.size) || null;
    renderOptions(); update();
  });
  $('#qty-minus').addEventListener('click', () => setQuantity(quantity - 1));
  $('#qty-plus').addEventListener('click', () => setQuantity(quantity + 1));
  $('#quantity').addEventListener('change', event => setQuantity(Number(event.target.value) || 1));

  const track = $('#gallery-track');
  let scrollTimer;
  track.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => updateGalleryIndex(Math.round(track.scrollLeft / Math.max(1, track.clientWidth))), 60); }, { passive: true });
  track.addEventListener('click', event => { if (event.target.closest('img')) openLightbox(galleryIndex, event.target); });
  track.addEventListener('keydown', event => { if (event.key === 'ArrowRight') scrollToImage(galleryIndex + 1); if (event.key === 'ArrowLeft') scrollToImage(galleryIndex - 1); });
  $('#gallery-thumbs').addEventListener('click', event => { const thumb = event.target.closest('[data-image]'); if (thumb) scrollToImage(Number(thumb.dataset.image)); });
  $('#gallery-zoom').addEventListener('click', event => openLightbox(galleryIndex, event.currentTarget));

  $('#product-favorite').addEventListener('click', event => {
    const active = toggleFavorite(product.id);
    const button = event.currentTarget;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${active ? 'Quitar de' : 'Agregar a'} favoritos`);
    toast(active ? 'Guardado en favoritos' : 'Eliminado de favoritos', 'success', 2600, active ? { label: 'Ver favoritos', href: 'favoritos.html' } : null);
  });
  $('#share-product').addEventListener('click', async () => {
    const result = await sharePage({ title: product.name, text: `Mira ${product.name} en Bodega Mayorista F.C.` });
    if (result === 'copied') toast('Enlace copiado');
  });
  $('#size-guide')?.addEventListener('click', event => openSheet({
    title: 'Guía del producto', trigger: event.currentTarget,
    content: `<div class="size-guide">${product.size_guide_text ? `<p>${text(product.size_guide_text)}</p>` : ''}${product.size_guide_image_url ? `<img src="${escapeHtml(localAsset(product.size_guide_image_url))}" alt="Guía de ${escapeHtml(product.name)}" loading="lazy">` : ''}</div>`
  }));
  $('.product-accordions')?.addEventListener('click', event => {
    const button = event.target.closest('button[aria-controls]');
    if (!button) return;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    document.getElementById(button.getAttribute('aria-controls')).hidden = expanded;
  });

  function showOptionError(type) {
    const group = $(`#${type}-group`);
    const error = $(`#${type}-error`);
    if (error) error.hidden = false;
    group?.classList.add('option-group--error');
    group?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => group?.classList.remove('option-group--error'), 1800);
    toast('Elige una opción disponible', 'error');
  }

  async function addToCart() {
    const variant = currentVariant();
    if (!variant) { showOptionError(realSizes.length > 1 ? 'size' : 'color'); return; }
    const stock = stockOf(variant);
    if (stock < quantity) { toast(stock ? `Solo quedan ${stock} unidades` : 'Esta opción está agotada', 'error'); return; }
    const button = $('#add-cart');
    setButtonLoading(button, true, 'Agregando…');
    try {
      const item = buildCartItem({ product, variant, color: selectedColor, size: selectedSize, quantity, image: productImage(product, selectedColor?.id), price: variantPrice(product, variant) });
      if (editing) updateCartLine(editing.line_id, item);
      else addCartItem(item);
      if (editing) { toast('Carrito actualizado'); setTimeout(() => { location.href = 'carrito.html'; }, 350); return; }
      toast('Agregado al carrito', 'success', 4000, { label: 'Ver carrito', href: 'carrito.html' });
      quantity = 1;
    } catch (error) {
      console.error(error);
      toast('No pudimos agregar el producto. Intenta nuevamente.', 'error');
    } finally {
      if (!editing) { setButtonLoading(button, false); update(); }
    }
  }
  $('#add-cart').addEventListener('click', addToCart);
  sticky.querySelector('button').addEventListener('click', () => $('#add-cart').click());

  // Barra fija: aparece cuando el botón principal sale de la vista.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      const show = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sticky.hidden = !show;
      document.body.classList.toggle('product-sticky-visible', show);
    }, { threshold: 0 }).observe($('#add-cart'));
  }

  renderGallery();
  renderOptions();
  const { stock, regular } = update();
  const mainImage = productImage(product, selectedColor?.id);
  setMeta(product, mainImage);
  structuredData(product, mainImage, regular, stock, crumbs);
  loadRelated(product, category?.id);
  loadRecent(previousViews);
}

async function loadRelated(product, categoryId) {
  try {
    const { products } = await getProducts({ categoryId, brandId: categoryId ? undefined : product.brand_id || undefined, pageSize: 10 });
    const related = products.filter(item => item.id !== product.id).slice(0, 8);
    renderProductSection($('#related-section'), { eyebrow: 'Te puede gustar', title: 'También te puede interesar', products: related, seeAllUrl: '', layout: 'rail' });
  } catch (error) { console.warn('No se cargaron productos relacionados:', error); }
}

async function loadRecent(ids) {
  if (!ids.length) return;
  try {
    const products = await getProductsByIds(ids.slice(0, 8));
    renderProductSection($('#recent-section'), { eyebrow: 'Tu historial', title: 'Vistos recientemente', products, seeAllUrl: '', layout: 'rail' });
  } catch (error) { console.warn('No se cargaron los productos vistos:', error); }
}
