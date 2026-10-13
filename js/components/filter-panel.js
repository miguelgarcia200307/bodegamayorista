import { escapeHtml, localAsset, normalizeText } from '../lib/helpers.js';

const cloneState = state => Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
const isSelected = (state, key, value) => Array.isArray(state[key]) ? state[key].includes(value) : state[key] === value;

function sectionCount(section, state) {
  if (section.type === 'price') return state[section.minKey] || state[section.maxKey] ? 1 : 0;
  return Array.isArray(state[section.key]) ? state[section.key].length : Number(Boolean(state[section.key]));
}

function activeCount(sections, state) {
  return sections.reduce((total, section) => total + sectionCount(section, state), 0);
}

function optionMarkup(section, option, state) {
  const value = String(option.value);
  const selected = isSelected(state, section.key, value);
  const image = option.image
    ? `<span class="filter-option__media${option.mediaType ? ` filter-option__media--${escapeHtml(option.mediaType)}` : ''}"><img src="${escapeHtml(localAsset(option.image))}" alt="" loading="lazy"></span>`
    : '';
  const meta = option.meta ? `<small>${escapeHtml(option.meta)}</small>` : '';
  const count = Number.isFinite(option.count) ? `<span class="filter-option__count">${option.count}</span>` : '';
  const swatch = section.type === 'swatches' && option.color
    ? `<span class="filter-swatch" style="--swatch:${escapeHtml(option.color)}" aria-hidden="true"></span>`
    : '';
  const control = section.control || (section.multiple === false && section.options.length > 1 ? 'radio' : 'checkbox');
  return `<label class="filter-option${section.type === 'chips' ? ' filter-option--chip' : ''}${section.type === 'swatches' ? ' filter-option--swatch' : ''}" data-filter-option data-search-value="${escapeHtml(normalizeText(`${option.label} ${option.meta || ''}`))}">
    <input type="${control}" name="${escapeHtml(section.key)}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}>
    ${swatch}${image}<span class="filter-option__copy"><strong>${escapeHtml(option.label)}</strong>${meta}</span>${count}
  </label>`;
}

function sectionMarkup(section, state, index) {
  const count = sectionCount(section, state);
  const open = section.open || count > 0;
  const bodyId = `filter-section-${section.key || index}`;
  let content = '';
  if (section.type === 'price') {
    content = `<div class="filter-price">
      <label><span>Desde</span><span class="filter-price__input"><b>$</b><input inputmode="numeric" type="number" name="${escapeHtml(section.minKey)}" min="0" step="1000" placeholder="0" value="${escapeHtml(state[section.minKey] || '')}"></span></label>
      <label><span>Hasta</span><span class="filter-price__input"><b>$</b><input inputmode="numeric" type="number" name="${escapeHtml(section.maxKey)}" min="0" step="1000" placeholder="Sin límite" value="${escapeHtml(state[section.maxKey] || '')}"></span></label>
    </div>`;
  } else {
    const search = section.options.length > (section.searchThreshold ?? 9)
      ? `<label class="filter-search"><span class="sr-only">Buscar ${escapeHtml(section.label.toLowerCase())}</span><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16.5 16.5 4 4"></path></svg><input type="search" data-filter-search autocomplete="off" placeholder="Buscar ${escapeHtml(section.label.toLowerCase())}…"></label>`
      : '';
    const options = section.options.map(option => optionMarkup(section, option, state)).join('');
    const limit = section.initialLimit || 8;
    const more = section.options.length > limit
      ? `<button class="filter-more" type="button" data-filter-more data-limit="${limit}">Ver ${section.options.length - limit} más</button>`
      : '';
    content = `${search}<div class="filter-options filter-options--${section.type || 'list'}" data-filter-options data-limit="${limit}">${options}</div><p class="filter-no-match" hidden>No encontramos coincidencias.</p>${more}`;
  }
  return `<section class="filter-section" data-filter-section="${escapeHtml(section.key || String(index))}">
    <h3><button class="filter-section__toggle" type="button" aria-expanded="${open}" aria-controls="${bodyId}"><span>${escapeHtml(section.label)}</span><span class="filter-section__status"><b ${count ? '' : 'hidden'}>${count}</b><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"></path></svg></span></button></h3>
    <div id="${bodyId}" class="filter-section__body" ${open ? '' : 'hidden'}>${content}</div>
  </section>`;
}

export function buildProductFilterSections({ categories, brands, options, context = 'catalog' }) {
  const categoryById = new Map(categories.map(category => [category.id, category]));
  const alphabetical = (a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' });
  const sections = [
    {
      key: 'category', label: 'Categoría', type: 'list', multiple: true, open: true, searchThreshold: 0,
      options: categories.map(category => ({
        value: category.slug, label: category.name,
        meta: category.parent_id ? categoryById.get(category.parent_id)?.name || '' : ''
      })).sort(alphabetical)
    },
    {
      key: 'brand', label: 'Marca', type: 'list', multiple: true, searchThreshold: 0,
      options: brands.map(brand => ({ value: brand.slug, label: brand.name, image: brand.logo_url })).sort(alphabetical)
    },
    { key: 'size', label: 'Capacidad / presentación', type: 'chips', multiple: true, options: options.sizes.map(name => ({ value: name, label: name })) },
    {
      key: 'color', label: 'Color / versión', type: 'swatches', multiple: true,
      options: (options.colorDetails || options.colors.map(name => ({ name })))
        .map(color => ({ value: color.name, label: color.name, color: color.hex_code })).sort(alphabetical)
    },
    {
      key: 'availability', label: 'Disponibilidad', type: 'list', multiple: false,
      options: context === 'promotions'
        ? [{ value: 'available', label: 'Disponible ahora' }]
        : [{ value: 'available', label: 'Disponible' }, { value: 'low', label: 'Últimas unidades' }, { value: 'sold', label: 'Agotado' }]
    }
  ];
  if (context === 'promotions') sections.push({
    key: 'minDiscount', label: 'Descuento', type: 'chips', multiple: false,
    options: [10, 20, 30, 50].map(value => ({ value: String(value), label: `${value}% o más` }))
  });
  sections.push({ key: 'price', label: 'Precio', type: 'price', minKey: 'minPrice', maxKey: 'maxPrice' });
  if (context !== 'promotions') sections.push({
    key: 'promotionOnly', label: 'Promoción', type: 'list', multiple: false,
    options: [{ value: 'true', label: 'Solo productos en promoción' }]
  });
  return sections.filter(section => section.type === 'price' || section.options?.length);
}

export function createFilterPanel({ root, trigger, triggers = [], chipsRoot, title, sections, initialState, getResultCount, onApply, onRemove, onClear, resultNoun = { singular: 'oferta', plural: 'ofertas' }, chipsClearLabel = 'Limpiar todo', desktopMode = 'sidebar' }) {
  let applied = cloneState(initialState);
  let draft = cloneState(initialState);
  let lastFocused = null;
  let previewCount = 0;
  const triggerElements = [...new Set([trigger, ...triggers].filter(Boolean))];
  root.innerHTML = `<div class="filters__head"><div><strong>${escapeHtml(title)}</strong><span class="filters__selection" aria-live="polite"></span></div><button class="filters__close" type="button" aria-label="Cerrar filtros"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button></div>
    <div class="filters__body">${sections.map((section, index) => sectionMarkup(section, draft, index)).join('')}</div>
    <div class="filters__apply"><button class="filter-clear" type="button">Limpiar</button><button class="btn btn--primary filter-submit" type="button"></button></div>`;

  const closeButton = root.querySelector('.filters__close');
  const clearButton = root.querySelector('.filter-clear');
  const applyButton = root.querySelector('.filter-submit');
  const selectionLabel = root.querySelector('.filters__selection');

  function syncOptionsFromDraft() {
    root.querySelectorAll('input[name]').forEach(input => {
      if (input.type === 'checkbox' || input.type === 'radio') input.checked = isSelected(draft, input.name, input.value);
      else input.value = draft[input.name] || '';
    });
  }

  function updateChrome() {
    const count = activeCount(sections, draft);
    selectionLabel.textContent = count ? `${count} filtro${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}` : 'Sin filtros seleccionados';
    clearButton.disabled = !count;
    const resultCount = getResultCount?.(draft);
    if (resultCount == null) {
      previewCount = 0;
      applyButton.textContent = 'Ver resultados';
      applyButton.disabled = false;
    } else {
      previewCount = Number(resultCount || 0);
      applyButton.textContent = `Ver ${previewCount} ${previewCount === 1 ? resultNoun.singular : resultNoun.plural}`;
      applyButton.disabled = previewCount === 0;
    }
    sections.forEach(section => {
      const sectionRoot = root.querySelector(`[data-filter-section="${CSS.escape(section.key)}"]`);
      const badge = sectionRoot?.querySelector('.filter-section__status b');
      if (!badge) return;
      const sectionTotal = sectionCount(section, draft);
      badge.textContent = sectionTotal;
      badge.hidden = !sectionTotal;
    });
  }

  function applyVisibility(sectionRoot) {
    const optionsRoot = sectionRoot.querySelector('[data-filter-options]');
    if (!optionsRoot) return;
    const query = normalizeText(sectionRoot.querySelector('[data-filter-search]')?.value || '');
    const expanded = sectionRoot.dataset.expanded === 'true';
    const limit = Number(optionsRoot.dataset.limit || 8);
    let matches = 0;
    [...optionsRoot.querySelectorAll('[data-filter-option]')].forEach((option, index) => {
      const match = !query || option.dataset.searchValue.includes(query);
      const visible = match && (Boolean(query) || expanded || index < limit || option.querySelector('input').checked);
      option.hidden = !visible;
      if (match) matches += 1;
    });
    const noMatch = sectionRoot.querySelector('.filter-no-match');
    if (noMatch) noMatch.hidden = matches > 0;
    const more = sectionRoot.querySelector('[data-filter-more]');
    if (more) {
      more.hidden = Boolean(query) || matches <= limit;
      more.textContent = expanded ? 'Ver menos' : `Ver ${Math.max(0, matches - limit)} más`;
    }
  }

  function renderChips() {
    if (!chipsRoot) return;
    const chips = [];
    sections.forEach(section => {
      if (section.type === 'price') {
        if (applied[section.minKey] || applied[section.maxKey]) {
          const from = applied[section.minKey] ? `$${Number(applied[section.minKey]).toLocaleString('es-CO')}` : '$0';
          const to = applied[section.maxKey] ? `$${Number(applied[section.maxKey]).toLocaleString('es-CO')}` : 'sin límite';
          chips.push({ key: section.key, value: '', label: `${from} – ${to}` });
        }
        return;
      }
      const values = Array.isArray(applied[section.key]) ? applied[section.key] : applied[section.key] ? [applied[section.key]] : [];
      values.forEach(value => {
        const option = section.options.find(item => String(item.value) === String(value));
        if (option) chips.push({ key: section.key, value, label: option.label });
      });
    });
    const total = activeCount(sections, applied);
    chipsRoot.hidden = !total;
    chipsRoot.innerHTML = total ? `<div class="active-filter-chips" aria-label="Filtros activos">${chips.slice(0, 6).map(chip => `<button type="button" data-remove-filter="${escapeHtml(chip.key)}" data-remove-value="${escapeHtml(chip.value)}"><span>${escapeHtml(chip.label)}</span><b aria-hidden="true">×</b><span class="sr-only">Quitar ${escapeHtml(chip.label)}</span></button>`).join('')}${total > 6 ? `<span class="active-filter-overflow">+${total - 6}</span>` : ''}</div><button class="active-filter-clear" type="button">${escapeHtml(chipsClearLabel)}</button>` : '';
  }

  function open() {
    if (desktopMode === 'sidebar' && matchMedia('(min-width: 800px)').matches) {
      root.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      root.querySelector('.filter-section__toggle')?.focus();
      return;
    }
    draft = cloneState(applied);
    syncOptionsFromDraft();
    root.querySelectorAll('[data-filter-section]').forEach(applyVisibility);
    updateChrome();
    lastFocused = document.activeElement;
    root.classList.add('open');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    triggerElements.forEach(element => element.setAttribute('aria-expanded', 'true'));
    document.body.classList.add('filters-open');
    if (desktopMode === 'drawer' || matchMedia('(max-width: 799px)').matches) document.body.classList.add('no-scroll');
    closeButton.focus();
  }

  function close({ restore = true } = {}) {
    root.classList.remove('open');
    root.removeAttribute('role');
    root.removeAttribute('aria-modal');
    triggerElements.forEach(element => element.setAttribute('aria-expanded', 'false'));
    document.body.classList.remove('filters-open', 'no-scroll');
    if (restore) lastFocused?.focus?.();
  }

  triggerElements.forEach(element => element.addEventListener('click', open));
  closeButton.addEventListener('click', () => close());
  root.addEventListener('click', event => {
    const toggle = event.target.closest('.filter-section__toggle');
    if (toggle) {
      const body = root.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls'))}`);
      const willOpen = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(willOpen));
      body.hidden = !willOpen;
      return;
    }
    const more = event.target.closest('[data-filter-more]');
    if (more) {
      const sectionRoot = more.closest('[data-filter-section]');
      sectionRoot.dataset.expanded = String(sectionRoot.dataset.expanded !== 'true');
      applyVisibility(sectionRoot);
    }
  });
  root.addEventListener('input', event => {
    if (event.target.matches('[data-filter-search]')) applyVisibility(event.target.closest('[data-filter-section]'));
    if (event.target.type === 'number') {
      draft[event.target.name] = event.target.value;
      updateChrome();
    }
  });
  root.addEventListener('change', event => {
    const input = event.target;
    if (!input.name || !['checkbox', 'radio'].includes(input.type)) return;
    const section = sections.find(item => item.key === input.name);
    if (section?.multiple === false) draft[input.name] = input.checked ? input.value : '';
    else {
      const values = new Set(Array.isArray(draft[input.name]) ? draft[input.name] : []);
      input.checked ? values.add(input.value) : values.delete(input.value);
      draft[input.name] = [...values];
    }
    applyVisibility(input.closest('[data-filter-section]'));
    updateChrome();
  });
  clearButton.addEventListener('click', () => {
    sections.forEach(section => {
      if (section.type === 'price') {
        draft[section.minKey] = '';
        draft[section.maxKey] = '';
      } else draft[section.key] = Array.isArray(draft[section.key]) ? [] : '';
    });
    syncOptionsFromDraft();
    root.querySelectorAll('[data-filter-section]').forEach(applyVisibility);
    updateChrome();
  });
  applyButton.addEventListener('click', async () => {
    const label = applyButton.textContent;
    applyButton.disabled = true;
    applyButton.textContent = 'Aplicando…';
    try {
      await onApply(cloneState(draft));
      applied = cloneState(draft);
      renderChips();
      close();
    } catch (error) {
      applyButton.textContent = label;
      applyButton.disabled = false;
      throw error;
    }
  });
  chipsRoot?.addEventListener('click', async event => {
    const clear = event.target.closest('.active-filter-clear');
    const remove = event.target.closest('[data-remove-filter]');
    if (!clear && !remove) return;
    if (clear) {
      await onClear?.();
      return;
    }
    await onRemove?.(remove.dataset.removeFilter, remove.dataset.removeValue);
  });
  document.addEventListener('keydown', event => {
    if (!root.classList.contains('open')) return;
    if (event.key === 'Escape') close();
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not([disabled]),input:not([disabled]):not([hidden])')].filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  root.querySelectorAll('[data-filter-section]').forEach(applyVisibility);
  updateChrome();
  renderChips();
  return {
    open,
    close,
    setApplied(next) { applied = cloneState(next); draft = cloneState(next); syncOptionsFromDraft(); updateChrome(); renderChips(); },
    getApplied: () => cloneState(applied),
    getCount: () => activeCount(sections, applied)
  };
}
