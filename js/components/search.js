// Buscador de la tienda: al enfocarlo abre una vista con búsquedas recientes, categorías
// populares y resultados en vivo (miniatura, nombre y precio) con 250 ms de espera.
import { clearRecentSearches, getPopularCategories, getRecentSearches, getSearchSuggestions, saveRecentSearch } from '../lib/search.js';
import { currentPrice, debounce, escapeHtml, formatMoney, getBrandUrl, getCategoryUrl, getProductUrl, localAsset } from '../lib/helpers.js';
import { icon } from './icons.js';

async function popularMarkup() {
  const categories = await getPopularCategories().catch(() => []);
  if (!categories.length) return '';
  return `<div class="search-panel__section"><p class="search-panel__label">Categorías populares</p><div class="search-panel__chips">${categories.map(category => `<a class="chip" href="${getCategoryUrl(category.slug)}">${escapeHtml(category.name)}</a>`).join('')}</div></div>`;
}

async function initialPanel() {
  const recent = getRecentSearches();
  const recentMarkup = recent.length ? `<div class="search-panel__section"><div class="search-panel__head"><p class="search-panel__label">Búsquedas recientes</p><button type="button" class="btn--tertiary search-panel__clear" data-clear-recent>Borrar</button></div><ul class="search-recent">${recent.map(term => `<li><button type="button" data-search-term="${escapeHtml(term)}">${icon('history', { size: 18 })}<span>${escapeHtml(term)}</span></button></li>`).join('')}</ul></div>` : '';
  return `${recentMarkup}${await popularMarkup()}` || '<p class="search-panel__hint">Escribe al menos dos letras para buscar.</p>';
}

function entityRow(item, type) {
  const url = type === 'category' ? getCategoryUrl(item.slug) : getBrandUrl(item.slug);
  const image = type === 'category' ? item.image_url : item.logo_url;
  return `<a class="search-result search-result--entity" href="${url}">
    <span class="search-result__thumb">${image ? `<img src="${escapeHtml(localAsset(image))}" alt="" width="48" height="48" loading="lazy">` : icon(type === 'category' ? 'grid' : 'tag')}</span>
    <span class="search-result__text"><small>${type === 'category' ? 'Categoría' : 'Marca'}</small><strong>${escapeHtml(item.name)}</strong></span>${icon('chevronRight', { size: 18, className: 'search-result__arrow' })}
  </a>`;
}

function productRow(item) {
  return `<a class="search-result" href="${getProductUrl(item.slug)}">
    <span class="search-result__thumb"><img src="${escapeHtml(localAsset(item.image_url))}" alt="" width="48" height="48" loading="lazy"></span>
    <span class="search-result__text"><small>${item.promotion ? 'En oferta' : escapeHtml(item.brand_name || 'Producto')}</small><strong>${escapeHtml(item.name)}</strong></span>
    <span class="search-result__price">${formatMoney(currentPrice(item))}</span>
  </a>`;
}

async function resultsPanel(results, term) {
  const entities = [...results.categories.map(item => entityRow(item, 'category')), ...results.brands.map(item => entityRow(item, 'brand'))];
  const products = results.products.map(productRow);
  if (!entities.length && !products.length) {
    return `<div class="search-empty">${icon('search', { size: 28 })}<strong>No encontramos “${escapeHtml(term)}”</strong><span>Revisa la ortografía o prueba con una palabra más general.</span></div>${await popularMarkup()}<a class="search-all" href="catalogo.html">Ver todos los productos ${icon('arrowRight', { size: 18 })}</a>`;
  }
  return `${entities.length ? `<p class="search-panel__label">Explora</p>${entities.join('')}` : ''}${products.length ? `<p class="search-panel__label">Productos</p>${products.join('')}` : ''}<a class="search-all" href="catalogo.html?q=${encodeURIComponent(term)}">Ver todos los resultados ${icon('arrowRight', { size: 18 })}</a>`;
}

export function searchBox(id, mobile = false) {
  return `<form class="market-search${mobile ? ' market-search--mobile' : ''}" data-search-form role="search" action="catalogo.html">
    <label class="sr-only" for="${id}">Buscar en la tienda</label>
    <button class="market-search__back" type="button" data-search-close aria-label="Cerrar búsqueda">${icon('arrowLeft', { size: 22 })}</button>
    <span class="market-search__icon" aria-hidden="true">${icon('search', { size: 20 })}</span>
    <input id="${id}" type="search" name="q" placeholder="Buscar productos o marcas" autocomplete="off" enterkeyhint="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-panel">
    <button class="market-search__clear" type="button" aria-label="Borrar búsqueda" hidden>${icon('x', { size: 18 })}</button>
    <div class="search-suggestions" id="${id}-panel" role="region" aria-label="Sugerencias de búsqueda" hidden></div>
  </form>`;
}

export function bindSearch(root = document) {
  root.querySelectorAll('[data-search-form]').forEach(form => {
    const input = form.querySelector('input');
    const panel = form.querySelector('.search-suggestions');
    const clear = form.querySelector('.market-search__clear');
    let requestId = 0;
    let activeIndex = -1;
    const mobileOverlay = () => form.classList.contains('market-search--mobile') && matchMedia('(max-width: 1023px)').matches;

    const setOpen = open => {
      panel.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
      form.classList.toggle('is-open', open);
      const overlay = open && mobileOverlay();
      form.classList.toggle('is-overlay', overlay);
      document.body.classList.toggle('search-open', overlay);
    };
    const renderInitial = async () => {
      const current = ++requestId;
      const markup = await initialPanel();
      if (current !== requestId) return;
      panel.innerHTML = markup;
      setOpen(true);
      activeIndex = -1;
    };
    const runSearch = debounce(async () => {
      const term = input.value.trim();
      clear.hidden = !term;
      if (term.length < 2) { renderInitial(); return; }
      const current = ++requestId;
      panel.innerHTML = '<div class="search-loading"><span class="spinner" aria-hidden="true"></span><span>Buscando…</span></div>';
      setOpen(true);
      try {
        const results = await getSearchSuggestions(term);
        if (current !== requestId || term !== input.value.trim()) return;
        const markup = await resultsPanel(results, term);
        if (current !== requestId) return;
        panel.innerHTML = markup;
        activeIndex = -1;
      } catch (error) {
        if (current !== requestId) return;
        console.warn('Búsqueda no disponible:', error);
        panel.innerHTML = '<div class="search-empty"><strong>No pudimos buscar ahora</strong><span>Revisa tu conexión e intenta nuevamente.</span></div>';
      }
    }, 250);

    input.addEventListener('focus', () => (input.value.trim().length >= 2 ? runSearch() : renderInitial()));
    input.addEventListener('input', runSearch);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { setOpen(false); input.blur(); return; }
      const options = [...panel.querySelectorAll('a, [data-search-term]')];
      if (!options.length || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
      if (event.key === 'Enter' && activeIndex < 0) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % options.length;
      if (event.key === 'ArrowUp') activeIndex = (activeIndex - 1 + options.length) % options.length;
      options.forEach((option, index) => option.classList.toggle('is-active', index === activeIndex));
      options[activeIndex]?.scrollIntoView({ block: 'nearest' });
      if (event.key === 'Enter') options[activeIndex]?.click();
    });
    panel.addEventListener('click', event => {
      const termButton = event.target.closest('[data-search-term]');
      if (termButton) { input.value = termButton.dataset.searchTerm; clear.hidden = false; runSearch(); input.focus(); return; }
      if (event.target.closest('[data-clear-recent]')) { clearRecentSearches(); renderInitial(); input.focus(); return; }
      const link = event.target.closest('a');
      if (!link) return;
      saveRecentSearch(input.value);
      if (document.body.dataset.page === 'home' && link.matches('.search-all') && input.value.trim()) {
        event.preventDefault();
        setOpen(false);
        window.dispatchEvent(new CustomEvent('home:search', { detail: { query: input.value.trim() } }));
      }
    });
    form.querySelector('[data-search-close]').addEventListener('click', () => { setOpen(false); input.blur(); });
    clear.addEventListener('click', () => {
      input.value = '';
      clear.hidden = true;
      renderInitial();
      input.focus();
      if (document.body.dataset.page === 'home') window.dispatchEvent(new CustomEvent('home:search', { detail: { query: '' } }));
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      const term = input.value.trim();
      if (!term) return;
      saveRecentSearch(term);
      setOpen(false);
      input.blur();
      if (document.body.dataset.page === 'home') {
        window.dispatchEvent(new CustomEvent('home:search', { detail: { query: term } }));
        return;
      }
      location.href = `catalogo.html?q=${encodeURIComponent(term)}`;
    });
    document.addEventListener('pointerdown', event => { if (!form.contains(event.target) && !form.classList.contains('is-overlay')) setOpen(false); });
  });
}
