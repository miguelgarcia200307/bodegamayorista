import { getBrands, getCategories, getEntityBySlug, getFilterOptions, getHomepageBanners, getProducts, getProductsByIds, getWholesaleProductIds, searchProducts } from '../lib/api.js';
import { createHomeBanner } from '../lib/home-banner.js';
import { loadSettings } from '../components/layout.js';
import { getSiteData, whatsappLink } from '../site-config.js';
import { brandCard } from '../components/brand-card.js';
import { icon } from '../components/icons.js';
import { hasTiers, tierRanges } from '../lib/pricing.js';
import { renderProducts, renderProductSkeletons } from '../components/product-card.js';
import { renderProductSection } from '../components/product-section.js';
import { toast } from '../components/toast.js';
import { buildProductFilterSections, createFilterPanel } from '../components/filter-panel.js';
import { $, $$, categoryIdsWithDescendants, categoryInitials, currentPrice, discountPercent, emptyState, escapeHtml, formatMoney, getCategoryUrl, getProductUrl, isPromoActive, localAsset, normalizeText, params, productImage, routeSlug, sharePage } from '../lib/helpers.js';
import { getFavorites, setFavorites } from '../lib/store.js';

const PAGE_SIZE = 20;

export async function initHome() {
  renderProductSkeletons($('#promo-products'), 3);
  const [settings, site] = await Promise.all([loadSettings(), getSiteData()]);
  const [categories, brands, promos, newest, featured, banners, wholesaleIds] = await Promise.all([
    getCategories(), getBrands(), getProducts({ pageSize: 10, promotion: true }),
    getProducts({ pageSize: 8, sort: 'newest' }), getProducts({ pageSize: 8, featured: true }),
    settings.banner_enabled ? getHomepageBanners().catch(error => {
      console.warn('No se pudieron cargar los banners de inicio:', error);
      return [];
    }) : Promise.resolve([]),
    getWholesaleProductIds().catch(() => [])
  ]);

  renderCategoryRail(categories);
  renderHero(settings, banners);

  const promoted = promos.products
    .filter(product => isPromoActive(product))
    .sort((a, b) => Number(isAvailable(b)) - Number(isAvailable(a)) || discountPercent(b) - discountPercent(a))
    .slice(0, 10);
  if (promoted.length) renderProducts($('#promo-products'), promoted);
  else $('#home-promotions').hidden = true;

  await renderWholesale(site, wholesaleIds);

  if (brands.length) {
    $('#home-brand-section').hidden = false;
    $('#home-brands').innerHTML = brands.slice(0, 12).map(brandCard).join('');
  }

  const featuredProducts = featured.products.filter(isAvailable).slice(0, 8);
  renderProductSection($('#home-featured'), { eyebrow: 'Selección de la tienda', title: 'Destacados', products: featuredProducts, seeAllUrl: 'catalogo.html' });
  const featuredIds = new Set(featuredProducts.map(product => product.id));
  const newestProducts = newest.products.filter(product => isAvailable(product) && !featuredIds.has(product.id)).slice(0, 8);
  renderProductSection($('#home-new'), { eyebrow: 'Acaban de llegar', title: 'Novedades', products: newestProducts, seeAllUrl: 'catalogo.html?sort=newest' });

  renderSocialProof(site);
  renderInstitutional(site);
  await initHomeResults({ categories });
}

function renderCategoryRail(categories) {
  const parents = categories.filter(category => !category.parent_id && category.slug !== 'promo').slice(0, 12);
  const root = $('#home-categories');
  if (!parents.length) { root.closest('.home-categories').hidden = true; return; }
  const item = category => {
    const media = category.image_url
      ? `<img src="${escapeHtml(localAsset(category.image_url))}" alt="" width="64" height="64" loading="eager" decoding="async">`
      : `<span>${escapeHtml(categoryInitials(category.name))}</span>`;
    return `<a class="category-rail__item" href="${getCategoryUrl(category.slug)}"><span class="category-rail__media">${media}</span><span class="category-rail__label">${escapeHtml(category.name)}</span></a>`;
  };
  root.innerHTML = `${parents.map(item).join('')}<a class="category-rail__item category-rail__item--all" href="categorias.html"><span class="category-rail__media">${icon('grid', { size: 24 })}</span><span class="category-rail__label">Ver todas</span></a>`;
}

function renderHero(settings, banners) {
  if (!settings.banner_enabled || !banners.length) return;
  const section = $('#home-banner-section');
  section.hidden = false;
  // El panel usa 5 s por defecto; el rediseño pide 6 s. Un valor distinto al predeterminado se respeta.
  const configured = Number(settings.banner_interval_seconds);
  const intervalSeconds = !configured || configured === 5 ? 6 : configured;
  const controller = createHomeBanner($('#home-banner-root'), { enabled: true, intervalSeconds, banners }, { onEmpty: () => { section.hidden = true; } });
  addEventListener('pagehide', controller.stop, { once: true });
}

async function renderWholesale(site, ids) {
  const root = $('#home-wholesale');
  if (!ids.length) return;
  const products = (await getProductsByIds(ids.slice(0, 12)).catch(() => [])).filter(product => isAvailable(product) && hasTiers(product));
  const example = products[0];
  if (!example) return;
  const regular = currentPrice(example);
  const rows = tierRanges(example, regular);
  root.hidden = false;
  root.innerHTML = `<div class="wholesale-block">
    <div class="wholesale-block__copy">
      <span class="eyebrow-label">Compra al por mayor</span>
      <h2 id="home-wholesale-title">Entre más llevas, menos pagas</h2>
      <p>Los productos con precio por volumen bajan de precio automáticamente en tu carrito cuando alcanzas la cantidad. Puedes combinar colores y opciones del mismo producto.</p>
      <div class="wholesale-block__actions">
        <a class="btn btn--primary" href="catalogo.html?mayoreo=1">Ver precios por mayor</a>
        ${site.whatsapp ? `<a class="btn btn--secondary" href="${escapeHtml(whatsappLink(site.whatsapp.number, 'Hola, quiero cotizar una compra al por mayor.'))}" target="_blank" rel="noopener">${icon('whatsapp', { size: 18 })}Cotizar por WhatsApp</a>` : ''}
      </div>
    </div>
    <a class="wholesale-example" href="${getProductUrl(example.slug)}">
      <span class="wholesale-example__label">Ejemplo real</span>
      <span class="wholesale-example__product"><img src="${escapeHtml(productImage(example))}" alt="" width="64" height="64" loading="lazy"><strong>${escapeHtml(example.name)}</strong></span>
      <span class="tier-table">${rows.map(row => `<span class="tier-table__row"><span>${row.to ? `${row.from}–${row.to}` : `${row.from}+`} u</span><strong>${formatMoney(row.unit)} c/u</strong></span>`).join('')}</span>
    </a>
  </div>`;
}

function renderSocialProof(site) {
  const proof = site.socialProof || {};
  const reviews = (proof.reviews || []).filter(review => review?.name && review?.text);
  const orders = Number(proof.ordersServed) || 0;
  if (!reviews.length && !orders) return;
  const root = $('#home-social-proof');
  root.hidden = false;
  root.innerHTML = `<div class="container"><div class="section-head"><div><span class="eyebrow-label">Clientes</span><h2>Lo que dicen de nosotros</h2>${orders ? `<p>Más de ${orders.toLocaleString('es-CO')} pedidos atendidos.</p>` : ''}</div></div>${reviews.length ? `<div class="review-rail">${reviews.map(review => `<figure class="review-card"><blockquote>${escapeHtml(review.text)}</blockquote><figcaption>${escapeHtml(review.name)}${review.city ? ` · ${escapeHtml(review.city)}` : ''}</figcaption></figure>`).join('')}</div>` : ''}</div>`;
}

function renderInstitutional(site) {
  const details = [
    site.address ? `<li>${icon('pin')}<span>${escapeHtml(site.address)}${site.city ? `, ${escapeHtml(site.city)}` : ''}</span></li>` : '',
    site.schedule ? `<li>${icon('clock')}<span>${escapeHtml(site.schedule)}</span></li>` : ''
  ].filter(Boolean).join('');
  const actions = [
    site.mapsUrl ? `<a class="btn btn--primary" href="${escapeHtml(site.mapsUrl)}" target="_blank" rel="noopener">${icon('navigation', { size: 18 })}Cómo llegar</a>` : '',
    site.whatsapp ? `<a class="btn btn--secondary" href="${escapeHtml(site.whatsapp.url)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 18 })}Escríbenos</a>` : ''
  ].filter(Boolean).join('');
  $('#store-info').innerHTML = `<div class="institutional__card">
    <span class="eyebrow-label">${escapeHtml(site.businessName)}</span>
    <h2>${escapeHtml(site.tagline)}</h2>
    ${site.locationLine ? `<p class="institutional__location">${escapeHtml(site.locationLine)}</p>` : ''}
    <p>Productos para tu hogar, tu día a día y mucho más, con atención cercana y un catálogo que sigue creciendo.</p>
    ${details ? `<ul class="institutional__details">${details}</ul>` : ''}
    ${actions ? `<div class="institutional__actions">${actions}</div>` : ''}
  </div>`;
}

function homeFilterCount(state) {
  return ['category','brand','color','size'].reduce((count, key) => count + (state[key]?.length || 0), 0)
    + Number(Boolean(state.minPrice || state.maxPrice))
    + Number(Boolean(state.availability))
    + Number(Boolean(state.promotionOnly));
}

function writeHomeUrl(state, replace = false) {
  const query = new URLSearchParams();
  const names = { minPrice: 'min', maxPrice: 'max', promotionOnly: 'promotion' };
  for (const [key, value] of Object.entries(state)) {
    const serialized = Array.isArray(value) ? value.join(',') : value;
    if (serialized && key !== 'page' && !(key === 'sort' && serialized === 'relevance')) query.set(names[key] || key, serialized);
  }
  history[replace ? 'replaceState' : 'pushState'](null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
}

async function initHomeResults({ categories }) {
  const query = params();
  const state = {
    q: query.get('q')?.trim().replace(/\s+/g, ' ') || '',
    page: 0,
    sort: query.get('sort') || 'relevance',
    category: readFilterList(query, 'category'),
    brand: readFilterList(query, 'brand'),
    color: readFilterList(query, 'color'),
    size: readFilterList(query, 'size'),
    minPrice: query.get('min') || '',
    maxPrice: query.get('max') || '',
    availability: query.get('availability') || '',
    promotionOnly: query.get('promotion') || ''
  };
  const triggers = $$('[data-home-filter-trigger]');
  const filterRoot = $('#home-filters');
  const resultsSection = $('#home-results');
  const discovery = $('#home-discovery');
  const productRoot = $('#home-result-products');
  const sortSelect = $('#home-result-sort');
  let panel;
  let productPool = [];
  let setupPromise;

  function syncSearchInputs() {
    $$('[data-search-form]').forEach(form => {
      const input = form.querySelector('input[name="q"]');
      const clear = form.querySelector('.market-search__clear');
      const suggestions = form.querySelector('.search-suggestions');
      if (input) input.value = state.q;
      if (clear) clear.hidden = !state.q;
      if (suggestions) suggestions.hidden = true;
      input?.setAttribute('aria-expanded', 'false');
      form.classList.remove('is-open');
    });
  }

  function updateFilterTriggers() {
    const count = homeFilterCount(state);
    triggers.forEach(trigger => {
      trigger.classList.toggle('is-active', count > 0);
      const badge = trigger.querySelector('[data-home-filter-count]');
      badge.textContent = count;
      badge.hidden = !count;
    });
  }

  function variantSnapshot(product, candidate) {
    const selectedColorIds = new Set((product.product_colors || []).filter(color => candidate.color.includes(color.name)).map(color => color.id));
    const selectedSizeIds = new Set((product.product_sizes || []).filter(size => candidate.size.includes(size.name)).map(size => size.id));
    const variants = (product.product_variants || []).filter(variant => variant.active
      && (!candidate.color.length || selectedColorIds.has(variant.color_id))
      && (!candidate.size.length || selectedSizeIds.has(variant.size_id)));
    return { variants, stock: product.force_sold_out ? 0 : variants.reduce((total, variant) => total + Number(variant.stock || 0), 0) };
  }

  function matchesSearch(product, term) {
    if (!term) return true;
    const haystack = normalizeText([
      product.name, product.description, product.material, product.model, product.sku, product.brands?.name,
      ...(product.product_categories || []).map(item => item.categories?.name),
      ...(product.product_colors || []).map(item => item.name),
      ...(product.product_sizes || []).map(item => item.name)
    ].filter(Boolean).join(' '));
    return normalizeText(term).split(' ').filter(Boolean).every(word => haystack.includes(word));
  }

  function getMatches(candidate) {
    return productPool.filter(product => {
      const productCategories = (product.product_categories || []).map(item => item.categories?.slug).filter(Boolean);
      const snapshot = variantSnapshot(product, candidate);
      const lowStock = snapshot.stock > 0 && (product.force_last_units || snapshot.stock <= Number(product.low_stock_threshold ?? 3));
      return matchesSearch(product, candidate.q)
        && (!candidate.category.length || candidate.category.some(value => productCategories.includes(value)))
        && (!candidate.brand.length || candidate.brand.includes(product.brands?.slug))
        && ((!candidate.color.length && !candidate.size.length) || snapshot.variants.length > 0)
        && (!candidate.availability || candidate.availability === 'available' && snapshot.stock > 0 || candidate.availability === 'low' && lowStock || candidate.availability === 'sold' && snapshot.stock === 0)
        && (!candidate.promotionOnly || isPromoActive(product))
        && (!candidate.minPrice || currentPrice(product) >= Number(candidate.minPrice))
        && (!candidate.maxPrice || currentPrice(product) <= Number(candidate.maxPrice));
    });
  }

  function compareHomeResults(a, b) {
    if (state.sort === 'discount') return discountPercent(b) - discountPercent(a);
    if (state.sort === 'price-asc') return currentPrice(a) - currentPrice(b);
    if (state.sort === 'price-desc') return currentPrice(b) - currentPrice(a);
    if (state.sort === 'name') return a.name.localeCompare(b.name, 'es');
    if (state.sort === 'newest') return new Date(b.created_at) - new Date(a.created_at);
    return Number(isAvailable(b)) - Number(isAvailable(a)) || Number(b.featured) - Number(a.featured) || new Date(b.created_at) - new Date(a.created_at);
  }

  function renderResults() {
    const active = Boolean(state.q || homeFilterCount(state));
    resultsSection.hidden = !active;
    discovery.hidden = active;
    updateFilterTriggers();
    syncSearchInputs();
    if (!active || !panel) return;
    const matches = getMatches(state).sort(compareHomeResults);
    const visible = matches.slice(0, (state.page + 1) * PAGE_SIZE);
    $('#home-results-title').textContent = state.q ? `Resultados para “${state.q}”` : 'Resultados';
    $('#home-result-count').textContent = `${matches.length} producto${matches.length === 1 ? '' : 's'} encontrado${matches.length === 1 ? '' : 's'}`;
    if (visible.length) renderProducts(productRoot, visible);
    else productRoot.innerHTML = `<div class="empty-state"><span class="empty-state__icon" aria-hidden="true">⌕</span><h2>No encontramos productos con estos filtros</h2><p>Prueba quitando un filtro o cambiando la búsqueda.</p><div class="empty-state__actions"><button class="btn btn--primary" type="button" data-clear-home-results>Limpiar todo</button><a class="btn btn--ghost" href="catalogo.html">Ver catálogo</a></div></div>`;
    $('#home-load-more').hidden = visible.length >= matches.length;
    productRoot.querySelector('[data-clear-home-results]')?.addEventListener('click', clearEverything);
  }

  async function ensurePanel({ open = false } = {}) {
    if (!setupPromise) setupPromise = (async () => {
      triggers.forEach(trigger => { trigger.disabled = true; trigger.classList.add('is-loading'); });
      const [brands, options, first] = await Promise.all([getBrands(), getFilterOptions(), getProducts({ pageSize: 500, sort: 'featured' })]);
      productPool = [...first.products];
      for (let page = 1; productPool.length < (first.count || 0); page += 1) {
        const next = await getProducts({ page, pageSize: 500, sort: 'featured' });
        productPool.push(...next.products);
        if (!next.products.length) break;
      }
      const sections = buildProductFilterSections({ categories, brands, options, context: 'catalog' });
      panel = createFilterPanel({
        root: filterRoot,
        triggers,
        chipsRoot: $('#home-active-filters'),
        title: 'Filtrar productos',
        sections,
        initialState: state,
        resultNoun: { singular: 'producto', plural: 'productos' },
        chipsClearLabel: 'Limpiar filtros',
        desktopMode: 'drawer',
        getResultCount: draft => getMatches({ ...draft, q: state.q }).length,
        onApply: async next => {
          Object.assign(state, next, { q: state.q, page: 0 });
          writeHomeUrl(state);
          renderResults();
          toast(homeFilterCount(state) ? 'Filtros aplicados' : 'Filtros limpiados');
        },
        onRemove: async (key, value) => {
          if (key === 'price') { state.minPrice = ''; state.maxPrice = ''; }
          else if (Array.isArray(state[key])) state[key] = state[key].filter(item => item !== value);
          else state[key] = '';
          state.page = 0;
          writeHomeUrl(state);
          panel.setApplied(state);
          renderResults();
        },
        onClear: clearFilters
      });
      $('#home-filter-backdrop').addEventListener('click', () => panel.close());
      triggers.forEach(trigger => { trigger.disabled = false; trigger.classList.remove('is-loading'); });
      updateFilterTriggers();
    })().catch(error => {
      setupPromise = null;
      triggers.forEach(trigger => { trigger.disabled = false; trigger.classList.remove('is-loading'); });
      toast('No pudimos cargar los filtros. Intenta nuevamente.', 'error');
      throw error;
    });
    await setupPromise;
    if (open) panel.open();
    return panel;
  }

  function clearFilters() {
    Object.assign(state, { page: 0, category: [], brand: [], color: [], size: [], minPrice: '', maxPrice: '', availability: '', promotionOnly: '' });
    writeHomeUrl(state);
    panel.setApplied(state);
    renderResults();
  }

  function clearEverything() {
    Object.assign(state, { q: '', page: 0, sort: 'relevance', category: [], brand: [], color: [], size: [], minPrice: '', maxPrice: '', availability: '', promotionOnly: '' });
    sortSelect.value = 'relevance';
    writeHomeUrl(state);
    panel?.setApplied(state);
    renderResults();
    scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  async function activateQuery(value) {
    state.q = String(value || '').trim().replace(/\s+/g, ' ');
    state.page = 0;
    if (state.q || homeFilterCount(state)) await ensurePanel();
    writeHomeUrl(state);
    panel?.setApplied(state);
    renderResults();
  }

  const firstOpen = async event => {
    if (panel) return;
    event.preventDefault();
    try { await ensurePanel({ open: true }); }
    catch (error) { console.error(error); }
  };
  triggers.forEach(trigger => trigger.addEventListener('click', firstOpen));
  window.addEventListener('home:search', event => activateQuery(event.detail?.query).catch(error => console.error(error)));
  sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; state.page = 0; writeHomeUrl(state); renderResults(); });
  $('#home-load-more').addEventListener('click', () => { state.page += 1; renderResults(); });
  $('#home-clear-results').addEventListener('click', clearEverything);
  addEventListener('popstate', async () => {
    const current = params();
    Object.assign(state, {
      q: current.get('q')?.trim().replace(/\s+/g, ' ') || '', page: 0, sort: current.get('sort') || 'relevance',
      category: readFilterList(current, 'category'), brand: readFilterList(current, 'brand'),
      color: readFilterList(current, 'color'), size: readFilterList(current, 'size'), minPrice: current.get('min') || '',
      maxPrice: current.get('max') || '', availability: current.get('availability') || '', promotionOnly: current.get('promotion') || ''
    });
    sortSelect.value = state.sort;
    if (state.q || homeFilterCount(state)) await ensurePanel();
    panel?.setApplied(state);
    renderResults();
  });

  updateFilterTriggers();
  syncSearchInputs();
  if (state.q || homeFilterCount(state)) {
    await ensurePanel();
    panel.setApplied(state);
    renderResults();
  }
}

function isAvailable(product) {
  return !product.force_sold_out && (product.product_variants || []).some(variant => variant.active && Number(variant.stock) > 0);
}

function readFilterList(query, key) {
  return (query.get(key) || '').split(',').map(value => value.trim()).filter(Boolean);
}

export async function initFavorites() {
  let ids = getFavorites();
  const root = $('#favorite-products');
  const count = $('#favorite-count');
  const sort = $('#favorite-sort-select');
  let products = [];

  function render() {
    const ordered = [...products].sort((a, b) => compareFavorites(a, b, sort.value, ids));
    count.textContent = `${ordered.length} producto${ordered.length === 1 ? '' : 's'} guardado${ordered.length === 1 ? '' : 's'}`;
    if (ordered.length) renderProducts(root, ordered);
    else {
      root.classList.remove('skeleton-grid', 'is-loading');
      root.setAttribute('aria-busy', 'false');
      root.innerHTML = emptyState('Todavía no tienes favoritos', 'Guarda productos con el corazón para encontrarlos fácilmente después.', 'catalogo.html', 'Explorar productos', '♡');
    }
    sort.disabled = !ordered.length;
  }

  root.addEventListener('favorite:toggled', event => {
    if (event.detail.active) return;
    const card = event.target.closest('.product-card');
    card?.classList.add('is-removing');
    ids = ids.filter(id => id !== event.detail.id);
    setTimeout(() => {
      products = products.filter(product => product.id !== event.detail.id);
      render();
    }, 210);
  });
  sort.addEventListener('change', render);
  if (!ids.length) { render(); return; }
  renderProductSkeletons(root);
  products = await getProductsByIds(ids);
  const validIds = ids.filter(id => products.some(product => product.id === id));
  if (validIds.length !== ids.length) {
    ids = validIds;
    setFavorites(validIds);
  }
  render();
}

function compareFavorites(a, b, sort, ids) {
  if (sort === 'price-asc') return currentPrice(a) - currentPrice(b);
  if (sort === 'price-desc') return currentPrice(b) - currentPrice(a);
  if (sort === 'name') return a.name.localeCompare(b.name, 'es');
  if (sort === 'discount') return discountPercent(b) - discountPercent(a);
  return ids.indexOf(b.id) - ids.indexOf(a.id);
}
