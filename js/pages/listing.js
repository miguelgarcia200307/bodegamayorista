// Listados unificados: categoría, marca, catálogo/búsqueda y ofertas.
// Carga el conjunto de productos del contexto y filtra/ordena en el navegador, con
// "Filtrar (n)" y "Ordenar" en hoja inferior, chips removibles, "Cargar más" y
// restauración de la posición al volver desde la ficha de producto.
import { getBrands, getCategories, getEntityBySlug, getProducts, getProductsByIds, getWholesaleProductIds, searchProducts } from '../lib/api.js';
import { renderProducts, renderProductSkeletons, productStock } from '../components/product-card.js';
import { createFilterPanel } from '../components/filter-panel.js';
import { openSheet } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { brandCard } from '../components/brand-card.js';
import { $, categoryIdsWithDescendants, currentPrice, discountPercent, escapeHtml, getCategoryUrl, isPromoActive, params, routeSlug, sharePage } from '../lib/helpers.js';
import { hasTiers } from '../lib/pricing.js';

const PAGE_SIZE = 20;
const RESTORE_KEY = 'bodega_mayorista_fc_listing_restore_v1';
const SORTS = [['relevance', 'Relevancia'], ['price-asc', 'Menor precio'], ['price-desc', 'Mayor precio'], ['discount', 'Mayor descuento'], ['newest', 'Novedades']];
const byName = (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
const isAvailable = product => productStock(product) > 0;

async function loadAll(options) {
  const byId = new Map();
  for (let page = 0; page < 20; page += 1) {
    const { products, count } = await getProducts({ ...options, page, pageSize: 500 });
    const before = byId.size;
    products.forEach(product => byId.set(product.id, product));
    if (byId.size === before || byId.size >= (count || 0) || products.length < 500) break;
  }
  return [...byId.values()];
}

function setMeta(title, description) {
  document.title = `${title} | Bodega Mayorista F.C.`;
  let meta = document.querySelector('meta[name="description"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'description'; document.head.append(meta); }
  meta.content = description;
}

function breadcrumbs(items) {
  $('#breadcrumbs').innerHTML = items.map((item, index) => index === items.length - 1
    ? `<span aria-current="page">${escapeHtml(item.name)}</span>`
    : `<a href="${item.url}">${escapeHtml(item.name)}</a>${icon('chevronRight', { size: 14 })}`).join('');
  const script = document.querySelector('#breadcrumb-jsonld') || Object.assign(document.createElement('script'), { id: 'breadcrumb-jsonld', type: 'application/ld+json' });
  script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: new URL(item.url || location.href, location.href).href })) });
  document.head.append(script);
}

// Contexto de la página: productos base, títulos y filtros disponibles.
async function resolveContext(mode) {
  const query = params();
  const categories = await getCategories();
  if (mode === 'category') {
    const slug = routeSlug();
    const requested = categories.find(item => item.slug === slug);
    if (!requested) throw new Error('Categoría no encontrada');
    const parent = requested.parent_id ? categories.find(item => item.id === requested.parent_id) || requested : requested;
    const children = categories.filter(item => item.parent_id === parent.id).sort(byName);
    const pool = await loadAll({ categoryId: categoryIdsWithDescendants(categories, parent.id) });
    const initialSub = requested.parent_id ? [requested.slug] : list(query.get('sub'));
    return {
      title: parent.name, description: parent.description || `Encuentra productos de ${parent.name} y elige la opción ideal para ti.`,
      crumbs: [{ name: 'Inicio', url: 'index.html' }, { name: 'Categorías', url: 'categorias.html' }, { name: parent.name, url: getCategoryUrl(parent.slug) }],
      pool, categories, children, parent, initial: { sub: initialSub }, sections: ['sub', 'brand', 'price', 'availability', 'promotion'], showBrands: true
    };
  }
  if (mode === 'brand') {
    const entity = await getEntityBySlug('brand', routeSlug());
    const pool = await loadAll({ brandId: entity.id });
    return {
      title: entity.name, description: entity.description || `Todos los productos disponibles de ${entity.name}.`,
      crumbs: [{ name: 'Inicio', url: 'index.html' }, { name: 'Marcas', url: 'index.html#marcas' }, { name: entity.name, url: `marca.html?slug=${encodeURIComponent(entity.slug)}` }],
      pool, categories, sections: ['category', 'price', 'availability', 'promotion'], initial: {}
    };
  }
  if (mode === 'promotions') {
    const pool = (await loadAll({ promotion: true })).filter(isPromoActive);
    return {
      title: 'Ofertas', description: 'Precios especiales por tiempo limitado en tecnología, hogar y más.',
      crumbs: [{ name: 'Inicio', url: 'index.html' }, { name: 'Ofertas', url: 'promociones.html' }],
      pool, categories, sections: ['category', 'brand', 'price', 'availability', 'minDiscount'], initial: { minDiscount: query.get('discount') || '' }, defaultSort: 'discount', emptyTitle: 'Por ahora no hay ofertas activas', emptyText: 'Explora el catálogo mientras llegan nuevas ofertas.'
    };
  }
  // Catálogo general, búsqueda y catálogo mayorista.
  const term = query.get('q')?.trim() || '';
  const wholesale = query.get('mayoreo') === '1';
  let pool;
  let ids = null;
  if (term) {
    ids = (await searchProducts(term, 60)).map(item => item.id);
    pool = ids.length ? await getProductsByIds(ids) : [];
  } else if (wholesale) {
    ids = await getWholesaleProductIds();
    pool = (ids.length ? await getProductsByIds(ids) : []).filter(hasTiers);
  } else pool = await loadAll({ sort: 'featured' });
  const title = term ? `Resultados para “${term}”` : wholesale ? 'Precios por mayor' : 'Todos los productos';
  return {
    title, description: term ? 'Coincidencias en productos, marcas y categorías.' : wholesale ? 'Productos que bajan de precio al comprar por volumen.' : 'Explora el catálogo completo de Bodega Mayorista F.C.',
    crumbs: [{ name: 'Inicio', url: 'index.html' }, { name: term ? 'Búsqueda' : wholesale ? 'Por mayor' : 'Catálogo', url: location.pathname.split('/').pop() + location.search }],
    pool, categories, relevanceIds: ids, term,
    sections: ['category', 'brand', 'price', 'availability', 'promotion'],
    initial: { category: list(query.get('category')), brand: list(query.get('brand')) },
    emptyTitle: term ? `No encontramos “${term}”` : undefined, emptyText: term ? 'Revisa la ortografía o prueba con una palabra más general.' : undefined
  };
}

function buildSections(context) {
  const { pool, categories } = context;
  const inPool = new Set(pool.flatMap(product => (product.product_categories || []).map(item => item.category_id)));
  const brands = [...new Map(pool.map(product => product.brands).filter(Boolean).map(brand => [brand.slug, brand])).values()].sort(byName);
  const factories = {
    sub: () => context.children?.length ? { key: 'sub', label: 'Subcategoría', type: 'list', multiple: true, open: true, options: context.children.map(child => ({ value: child.slug, label: child.name })) } : null,
    category: () => {
      const options = categories.filter(category => inPool.has(category.id)).sort(byName).map(category => ({ value: category.slug, label: category.name, meta: category.parent_id ? categories.find(item => item.id === category.parent_id)?.name || '' : '' }));
      return options.length > 1 ? { key: 'category', label: 'Categoría', type: 'list', multiple: true, open: true, options } : null;
    },
    brand: () => brands.length > 1 ? { key: 'brand', label: 'Marca', type: 'list', multiple: true, options: brands.map(brand => ({ value: brand.slug, label: brand.name })) } : null,
    price: () => ({ key: 'price', label: 'Precio', type: 'price', minKey: 'minPrice', maxKey: 'maxPrice' }),
    availability: () => ({ key: 'availability', label: 'Disponibilidad', type: 'list', multiple: false, options: [{ value: 'available', label: 'Solo disponibles' }] }),
    promotion: () => pool.some(isPromoActive) ? { key: 'promotionOnly', label: 'Ofertas', type: 'list', multiple: false, options: [{ value: 'true', label: 'Solo productos en oferta' }] } : null,
    minDiscount: () => ({ key: 'minDiscount', label: 'Descuento', type: 'chips', multiple: false, options: [10, 20, 30, 50].map(value => ({ value: String(value), label: `${value}% o más` })) })
  };
  return context.sections.map(key => factories[key]()).filter(Boolean);
}

function matches(product, state, context) {
  const categorySlugs = (product.product_categories || []).map(item => item.categories?.slug).filter(Boolean);
  const subIds = state.sub?.length ? new Set(state.sub.flatMap(slug => {
    const child = context.children?.find(item => item.slug === slug);
    return child ? categoryIdsWithDescendants(context.categories, child.id) : [];
  })) : null;
  const price = currentPrice(product);
  return (!subIds || (product.product_categories || []).some(item => subIds.has(item.category_id)))
    && (!state.category?.length || state.category.some(slug => categorySlugs.includes(slug)))
    && (!state.brand?.length || state.brand.includes(product.brands?.slug))
    && (!state.availability || isAvailable(product))
    && (!state.promotionOnly || isPromoActive(product))
    && (!state.minDiscount || discountPercent(product) >= Number(state.minDiscount))
    && (!state.minPrice || price >= Number(state.minPrice))
    && (!state.maxPrice || price <= Number(state.maxPrice));
}

function sorter(sort, context) {
  if (sort === 'price-asc') return (a, b) => currentPrice(a) - currentPrice(b);
  if (sort === 'price-desc') return (a, b) => currentPrice(b) - currentPrice(a);
  if (sort === 'discount') return (a, b) => discountPercent(b) - discountPercent(a) || Number(isAvailable(b)) - Number(isAvailable(a));
  if (sort === 'newest') return (a, b) => new Date(b.created_at) - new Date(a.created_at);
  const order = context.relevanceIds;
  if (order?.length) return (a, b) => order.indexOf(a.id) - order.indexOf(b.id);
  return (a, b) => Number(isAvailable(b)) - Number(isAvailable(a)) || Number(b.featured) - Number(a.featured) || new Date(b.created_at) - new Date(a.created_at);
}

const FILTER_KEYS = ['sub', 'category', 'brand', 'minPrice', 'maxPrice', 'availability', 'promotionOnly', 'minDiscount'];
const URL_NAMES = { minPrice: 'min', maxPrice: 'max', promotionOnly: 'oferta', minDiscount: 'discount' };

function filterCount(state) {
  return ['sub', 'category', 'brand'].reduce((total, key) => total + (state[key]?.length || 0), 0)
    + Number(Boolean(state.minPrice || state.maxPrice)) + Number(Boolean(state.availability)) + Number(Boolean(state.promotionOnly)) + Number(Boolean(state.minDiscount));
}

function readState(context) {
  const query = params();
  const state = { page: 0, sort: query.get('sort') || context.defaultSort || 'relevance' };
  if (!SORTS.some(([value]) => value === state.sort)) state.sort = 'relevance';
  FILTER_KEYS.forEach(key => {
    const raw = query.get(URL_NAMES[key] || key);
    state[key] = ['sub', 'category', 'brand'].includes(key) ? (raw ? list(raw) : (context.initial[key] || [])) : (raw || context.initial[key] || '');
  });
  return state;
}

function writeState(state, context) {
  const query = new URLSearchParams(location.search);
  FILTER_KEYS.forEach(key => query.delete(URL_NAMES[key] || key));
  query.delete('sort');
  FILTER_KEYS.forEach(key => {
    const value = Array.isArray(state[key]) ? state[key].join(',') : state[key];
    if (value) query.set(URL_NAMES[key] || key, value);
  });
  if (state.sort !== (context.defaultSort || 'relevance')) query.set('sort', state.sort);
  history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
}

export async function initListingPage(mode) {
  const grid = $('#listing-products');
  renderProductSkeletons(grid, 8);
  const context = await resolveContext(mode);
  const state = readState(context);
  $('#listing-title').textContent = context.title;
  $('#listing-description').textContent = context.description;
  setMeta(context.title, context.description);
  breadcrumbs(context.crumbs);

  const sections = buildSections(context);
  const toolbarFilter = $('#open-filters');
  const sortButton = $('#open-sort');
  const countLabel = $('#result-count');
  const loadMore = $('#load-more');
  toolbarFilter.hidden = !sections.length;

  function renderSubcategoryChips() {
    const root = $('#listing-subcategories');
    if (!root || !context.children?.length) return;
    root.hidden = false;
    const current = state.sub || [];
    root.innerHTML = `<button class="chip${current.length ? '' : ' active'}" type="button" data-sub="" aria-pressed="${!current.length}">Todos</button>${context.children.map(child => { const active = current.length === 1 && current[0] === child.slug; return `<button class="chip${active ? ' active' : ''}" type="button" data-sub="${escapeHtml(child.slug)}" aria-pressed="${active}">${escapeHtml(child.name)}</button>`; }).join('')}`;
  }

  function renderBrands(products) {
    const root = $('#listing-brands');
    if (!root || !context.showBrands) return;
    const brands = [...new Map(products.map(product => product.brands).filter(Boolean).map(brand => [brand.id, brand])).values()].sort(byName);
    root.hidden = brands.length < 2;
    root.innerHTML = brands.length < 2 ? '' : `<div class="section-head"><div><h2>Explora por marca</h2></div></div><div class="brand-rail">${brands.map(brandCard).join('')}</div>`;
  }

  function render({ restoreScroll = null } = {}) {
    const results = context.pool.filter(product => matches(product, state, context)).sort(sorter(state.sort, context));
    const visible = results.slice(0, (state.page + 1) * PAGE_SIZE);
    const filters = filterCount(state);
    countLabel.textContent = `${results.length} producto${results.length === 1 ? '' : 's'}`;
    const badge = toolbarFilter.querySelector('[data-filter-count]');
    badge.textContent = filters;
    badge.hidden = !filters;
    toolbarFilter.classList.toggle('is-active', filters > 0);
    toolbarFilter.setAttribute('aria-label', filters ? `Filtrar, ${filters} filtro${filters === 1 ? '' : 's'} activo${filters === 1 ? '' : 's'}` : 'Filtrar');
    sortButton.querySelector('[data-sort-label]').textContent = SORTS.find(([value]) => value === state.sort)?.[1] || 'Relevancia';
    if (visible.length) renderProducts(grid, visible);
    else {
      grid.classList.remove('is-loading');
      grid.setAttribute('aria-busy', 'false');
      grid.innerHTML = filters
        ? `<div class="empty-state"><span class="empty-state__icon" aria-hidden="true">${icon('sliders', { size: 28 })}</span><h2>No hay productos con estos filtros</h2><p>Prueba quitando alguno de los filtros activos.</p><button class="btn btn--primary" type="button" data-clear-filters>Quitar filtros</button></div>`
        : `<div class="empty-state"><span class="empty-state__icon" aria-hidden="true">${icon('package', { size: 28 })}</span><h2>${escapeHtml(context.emptyTitle || 'Todavía no hay productos aquí')}</h2><p>${escapeHtml(context.emptyText || 'Explora otras categorías mientras agregamos novedades.')}</p><div class="empty-state__actions"><a class="btn btn--primary" href="categorias.html">Ver categorías</a><a class="btn btn--secondary" href="promociones.html">Ver ofertas</a></div></div>`;
    }
    loadMore.hidden = visible.length >= results.length;
    renderSubcategoryChips();
    renderBrands(context.pool);
    if (restoreScroll != null) requestAnimationFrame(() => scrollTo({ top: restoreScroll, behavior: 'instant' }));
  }

  const panel = sections.length ? createFilterPanel({
    root: $('#filters'), trigger: toolbarFilter, chipsRoot: $('#active-filters'), title: 'Filtrar productos', sections,
    initialState: state, resultNoun: { singular: 'producto', plural: 'productos' }, desktopMode: 'drawer',
    getResultCount: draft => context.pool.filter(product => matches(product, { ...state, ...draft }, context)).length,
    onApply: async next => { Object.assign(state, next, { page: 0 }); writeState(state, context); render(); },
    onRemove: async (key, value) => {
      if (key === 'price') { state.minPrice = ''; state.maxPrice = ''; }
      else if (Array.isArray(state[key])) state[key] = state[key].filter(item => item !== value);
      else state[key] = '';
      state.page = 0; writeState(state, context); panel.setApplied(state); render();
    },
    onClear: clearFilters
  }) : null;

  function clearFilters() {
    FILTER_KEYS.forEach(key => { state[key] = Array.isArray(state[key]) ? [] : ''; });
    state.page = 0;
    writeState(state, context);
    panel?.setApplied(state);
    render();
  }

  $('#filter-backdrop')?.addEventListener('click', () => panel?.close());
  grid.addEventListener('click', event => {
    if (event.target.closest('[data-clear-filters]')) { clearFilters(); return; }
    if (event.target.closest('a[href*="producto.html"]')) {
      try { sessionStorage.setItem(RESTORE_KEY, JSON.stringify({ url: location.href, page: state.page, y: scrollY })); } catch { /* sin almacenamiento */ }
    }
  });
  $('#listing-subcategories')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-sub]');
    if (!chip) return;
    state.sub = chip.dataset.sub ? [chip.dataset.sub] : [];
    state.page = 0;
    writeState(state, context);
    panel?.setApplied(state);
    render();
  });
  loadMore.addEventListener('click', () => { state.page += 1; render(); });
  sortButton.addEventListener('click', () => {
    const content = document.createElement('ul');
    content.className = 'option-list';
    content.setAttribute('role', 'radiogroup');
    content.innerHTML = SORTS.map(([value, label]) => `<li><label><span>${label}</span><input type="radio" name="listing-sort" value="${value}" ${value === state.sort ? 'checked' : ''}></label></li>`).join('');
    const sheet = openSheet({ title: 'Ordenar por', content, trigger: sortButton, initialFocus: 'input:checked' });
    content.addEventListener('change', event => {
      state.sort = event.target.value;
      state.page = 0;
      writeState(state, context);
      render();
      sheet.close();
    });
  });
  $('#share-listing')?.addEventListener('click', async () => {
    const result = await sharePage({ title: document.title, text: `Mira ${context.title} en Bodega Mayorista F.C.` });
    if (result === 'copied') toast('Enlace copiado');
  });

  let restore = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(RESTORE_KEY) || 'null');
    if (saved?.url === location.href) { restore = saved; state.page = Math.max(0, Number(saved.page) || 0); }
    sessionStorage.removeItem(RESTORE_KEY);
  } catch { restore = null; }
  if (restore && 'scrollRestoration' in history) history.scrollRestoration = 'manual';
  render({ restoreScroll: restore ? restore.y : null });
}
