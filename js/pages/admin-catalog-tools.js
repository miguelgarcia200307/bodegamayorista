// Herramientas de catálogo: relaciones de productos (reglas del recomendador) y costos
// privados con margen. Ambas secciones son visuales y se editan en el sitio, sin recargar.
import { deleteProductRelationship, getProductCosts, getProductRelationships, saveProductCost, saveProductRelationship } from '../lib/api.js';
import { RELATION_KINDS } from '../lib/reco-core.js';
import { confirmAction, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { $, currentPrice, debounce, escapeHtml, formatMoney, isPromoActive, localAsset, normalizeText, productImage, setButtonLoading } from '../lib/helpers.js';
import { kpiTileMarkup, plural, requestError } from './admin-crm.js';

let ctx = null;
export function configureCatalogTools(context) { ctx = context; }

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- Relaciones de productos -------------------------------------------------------------
// Cada tipo tiene color, icono y una frase que explica en lenguaje simple qué hará la regla.
const KIND_META = {
  complemento: { icon: 'plus', tone: 'green', short: 'Se compran juntos', help: 'Productos que suelen acompañar la compra. Ej.: celular → audífonos.', sentence: (a, b) => `Cuando un cliente vea o compre <b>${a}</b>, le sugeriremos <b>${b}</b> como complemento.` },
  alternativa: { icon: 'sliders', tone: 'blue', short: 'Opción parecida', help: 'Una opción similar para quien duda o no encuentra disponibilidad.', sentence: (a, b) => `En la ficha de <b>${a}</b> mostraremos <b>${b}</b> como alternativa.` },
  compatible_con: { icon: 'shield', tone: 'violet', short: 'Compatibilidad verificada', help: 'Solo entre modelos concretos y con evidencia (ficha técnica o modelo).', sentence: (a, b) => `Indicaremos que <b>${b}</b> es compatible con <b>${a}</b>.` },
  reposicion: { icon: 'history', tone: 'amber', short: 'Recompra periódica', help: 'Recordatorio en el CRM para volver a comprar cada cierto tiempo.', sentence: (a, b, days, same) => same ? `A quien compró <b>${a}</b> le recordaremos volver a comprarlo cada <b>${days} días</b>.` : `A quien compró <b>${a}</b> le recordaremos comprar <b>${b}</b> cada <b>${days} días</b>.` },
  excluir: { icon: 'x', tone: 'red', short: 'Nunca juntos', help: 'Bloquea sugerencias entre estos elementos aunque otra regla las proponga.', sentence: (a, b) => `Nunca sugeriremos <b>${b}</b> a quien vea o compre <b>${a}</b>.` }
};
const strengthLabel = value => (value >= 0.85 ? 'Muy alta' : value >= 0.65 ? 'Alta' : value >= 0.4 ? 'Media' : 'Baja');
const strengthMeter = value => `<span class="rel-meter" aria-hidden="true">${Array.from({ length: 5 }, (_, index) => `<i class="${index < Math.max(1, Math.round(value * 5)) ? 'on' : ''}"></i>`).join('')}</span>`;

// Sugerencias que el comerciante puede revisar y crear (no se aplican solas). Sirven de
// punto de partida para tiendas de tecnología y hogar; cada tienda define las suyas.
const PRESETS = [
  ['celulares', 'audio', 'complemento', 0.9], ['celulares', 'smartwatches', 'complemento', 0.7], ['computadores', 'audio', 'complemento', 0.6], ['televisores', 'audio', 'complemento', 0.7],
  ['estufas-hornos', 'menaje', 'complemento', 0.8], ['neveras', 'lavadoras', 'complemento', 0.5], ['pequenos-electrodomesticos', 'menaje', 'complemento', 0.6], ['menaje', 'pequenos-electrodomesticos', 'complemento', 0.5]
];

function catalogIndex() {
  const categories = ctx.getCategories?.() || []; const products = ctx.getProducts();
  const perCategory = new Map();
  products.forEach(product => (product.product_categories || []).forEach(link => { const id = link.category_id || link.categories?.id; if (id) perCategory.set(id, (perCategory.get(id) || 0) + 1); }));
  const entity = (type, id) => {
    if (type === 'category') {
      const category = categories.find(item => item.id === id);
      return { type, id, name: category?.name || 'Categoría eliminada', label: 'Categoría', image: category?.image_url ? localAsset(category.image_url) : '', sub: plural(perCategory.get(id) || 0, 'producto'), missing: !category };
    }
    const product = products.find(item => item.id === id);
    return { type, id, name: product?.name || 'Producto eliminado', label: 'Producto', image: product ? productImage(product) : '', sub: product?.brands?.name || '', missing: !product };
  };
  const options = type => (type === 'category' ? categories : products).map(item => entity(type, item.id));
  return { categories, products, entity, options };
}

const nodeVisual = (item, size = 18) => item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async">` : `<span>${icon(item.type === 'category' ? 'layers' : 'package', { size })}</span>`;
const nodeMarkup = item => `<div class="rel-node ${item.missing ? 'is-missing' : ''}"><span class="rel-node__visual">${nodeVisual(item)}</span><span class="rel-node__text"><small>${item.label}${item.sub ? ` · ${escapeHtml(item.sub)}` : ''}</small><strong>${escapeHtml(item.name)}</strong></span></div>`;

function ruleCardMarkup(rule, index) {
  const meta = KIND_META[rule.kind] || KIND_META.complemento; const strength = Number(rule.strength) || 0.5;
  const source = index.entity(rule.source_type, rule.source_id); const target = index.entity(rule.target_type, rule.target_id);
  const same = rule.source_type === rule.target_type && rule.source_id === rule.target_id;
  return `<article class="rel-card rel-tone--${meta.tone} ${rule.active === false ? 'is-off' : ''}" data-rule="${rule.id}">
    <div class="rel-card__flow">${nodeMarkup(source)}
      <div class="rel-link"><span class="rel-badge">${icon(meta.icon, { size: 14 })}${escapeHtml(RELATION_KINDS[rule.kind] || rule.kind)}</span><i class="rel-link__line" aria-hidden="true">${icon('arrowRight', { size: 14 })}</i></div>
      ${same ? `<div class="rel-node rel-node--same"><span class="rel-node__visual"><span>${icon('history', { size: 18 })}</span></span><span class="rel-node__text"><small>Mismo elemento</small><strong>Volver a comprarlo</strong></span></div>` : nodeMarkup(target)}</div>
    <div class="rel-card__meta">
      <span class="rel-chip" title="Prioridad de la regla en las recomendaciones: ${strength.toFixed(2)}">Prioridad <b>${strengthLabel(strength)}</b>${strengthMeter(strength)}</span>
      ${rule.kind === 'reposicion' && rule.reposition_days ? `<span class="rel-chip">${icon('clock', { size: 13 })}Cada <b>${Number(rule.reposition_days)} días</b></span>` : ''}
      ${rule.note ? `<span class="rel-note">${icon('info', { size: 13 })}${escapeHtml(rule.note)}</span>` : ''}
    </div>
    <div class="rel-card__actions">
      <label class="rel-toggle"><input class="switch" type="checkbox" data-toggle-rule ${rule.active === false ? '' : 'checked'} aria-label="Regla activa"><span>${rule.active === false ? 'Pausada' : 'Activa'}</span></label>
      <button class="small-btn" data-edit-rule type="button">${icon('pencil', { size: 15 })}<span>Editar</span></button>
      <button class="icon-btn icon-btn--danger" data-delete-rule type="button" aria-label="Eliminar regla" title="Eliminar regla">${icon('trash', { size: 16 })}</button>
    </div>
  </article>`;
}

const rulePayload = rule => ({ kind: rule.kind, strength: Number(rule.strength), source_type: rule.source_type, source_id: rule.source_id, target_type: rule.target_type, target_id: rule.target_id, reposition_days: rule.reposition_days ?? null, note: rule.note ?? null, active: rule.active !== false });

export async function renderRelationships() {
  const root = $('#admin-content'); const index = catalogIndex();
  const state = { kind: 'all', status: 'all', sort: 'kind', q: '' };
  let rules = [];
  root.innerHTML = ctx.heading('Catálogo', 'Relaciones de productos', 'Enseña a la tienda y al CRM qué productos recomendar juntos. Sin reglas, nunca se presume compatibilidad.', `<button id="new-relationship" class="btn btn--primary" type="button">${icon('plus', { size: 18 })}<span>Nueva regla</span></button>`)
    + `<details class="rel-howto" data-howto><summary>${icon('sparkles', { size: 18 })}<span><strong>¿Cómo funcionan las relaciones?</strong><small>Tres pasos y la tienda empieza a sugerir mejor.</small></span>${icon('chevronDown', { size: 16 })}</summary>
      <ol class="rel-howto__steps"><li><b>1</b><span><strong>Elige el tipo</strong><small>Complemento, alternativa, compatibilidad, reposición o exclusión.</small></span></li><li><b>2</b><span><strong>Conecta origen y destino</strong><small>Una categoría completa o un producto concreto.</small></span></li><li><b>3</b><span><strong>Ajusta la prioridad</strong><small>Las reglas con prioridad alta aparecen primero.</small></span></li></ol></details>
    <section class="rel-kinds" role="group" aria-label="Filtrar por tipo de regla" data-kinds></section>
    <section class="admin-panel rel-suggest" data-suggestions hidden></section>
    <section class="admin-panel rel-panel">
      <div class="rel-toolbar"><div class="admin-search-wrap"><input class="admin-search" type="search" data-search placeholder="Buscar producto o categoría" aria-label="Buscar reglas"></div>
        <div class="segmented" role="group" aria-label="Estado" data-status>${[['all', 'Todas'], ['active', 'Activas'], ['paused', 'Pausadas']].map(([value, label]) => `<button type="button" data-status-value="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('')}</div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar reglas"><option value="kind">Por tipo</option><option value="strength">Mayor prioridad</option><option value="name">Nombre del origen</option></select></label></div>
      <p class="results-meta" data-meta aria-live="polite"></p>
      <div class="rel-list" data-list></div>
    </section>`;

  const matchesText = rule => { const term = normalizeText(state.q); return !term || normalizeText(`${index.entity(rule.source_type, rule.source_id).name} ${index.entity(rule.target_type, rule.target_id).name} ${rule.note || ''}`).includes(term); };
  const render = () => {
    const base = rules.filter(matchesText).filter(rule => state.status === 'all' || (state.status === 'active' ? rule.active !== false : rule.active === false));
    root.querySelector('[data-kinds]').innerHTML = [['all', { icon: 'layers', tone: 'ink', short: 'Todas las reglas' }], ...Object.entries(KIND_META)].map(([kind, meta]) => {
      const count = kind === 'all' ? base.length : base.filter(rule => rule.kind === kind).length;
      return `<button class="rel-kind rel-tone--${meta.tone} ${state.kind === kind ? 'is-active' : ''}" type="button" data-kind="${kind}" aria-pressed="${state.kind === kind}"><span class="rel-kind__icon">${icon(meta.icon, { size: 18 })}</span><span class="rel-kind__text"><strong>${kind === 'all' ? 'Todas' : escapeHtml(RELATION_KINDS[kind])}</strong><small>${meta.short}</small></span><b>${count}</b></button>`;
    }).join('');
    const order = Object.keys(KIND_META);
    const visible = base.filter(rule => state.kind === 'all' || rule.kind === state.kind).sort({
      kind: (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || Number(b.strength) - Number(a.strength),
      strength: (a, b) => Number(b.strength) - Number(a.strength),
      name: (a, b) => index.entity(a.source_type, a.source_id).name.localeCompare(index.entity(b.source_type, b.source_id).name, 'es')
    }[state.sort]);
    const active = rules.filter(rule => rule.active !== false).length;
    root.querySelector('[data-meta]').innerHTML = `<span>${plural(visible.length, 'regla')} en esta vista · ${plural(active, 'activa')} de ${rules.length} en total</span>${state.q || state.kind !== 'all' || state.status !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    root.querySelector('[data-list]').innerHTML = visible.length ? visible.map(rule => ruleCardMarkup(rule, index)).join('')
      : rules.length ? `<div class="rel-empty rel-empty--small">${icon('search', { size: 22 })}<strong>Sin reglas en esta vista</strong><small>Prueba con otro tipo, estado o búsqueda.</small></div>`
        : `<div class="rel-empty"><div class="rel-empty__art" aria-hidden="true"><span>${icon('package', { size: 22 })}</span><i>${icon('arrowRight', { size: 16 })}</i><span>${icon('plus', { size: 22 })}</span></div><strong>Crea tu primera relación</strong><small>Por ejemplo: “Celulares → Audio” como complemento. La tienda la usará para sugerir productos en la ficha y el carrito.</small><button class="btn btn--primary" data-empty-new type="button">${icon('plus', { size: 18 })}<span>Nueva regla</span></button></div>`;
    root.querySelector('[data-howto]').open = !rules.length;
  };
  const renderSuggestions = () => {
    const bySlug = new Map(index.categories.map(item => [item.slug, item]));
    const existing = new Set(rules.map(rule => `${rule.source_id}:${rule.target_id}:${rule.kind}`));
    const suggestions = PRESETS.map(([from, to, kind, strength]) => ({ from: bySlug.get(from), to: bySlug.get(to), kind, strength })).filter(item => item.from && item.to && !existing.has(`${item.from.id}:${item.to.id}:${item.kind}`));
    const panel = root.querySelector('[data-suggestions]');
    panel.hidden = !suggestions.length;
    panel.innerHTML = suggestions.length ? `<div class="rel-suggest__head"><span class="rel-suggest__icon">${icon('sparkles', { size: 18 })}</span><div><h2>Sugerencias para tu tienda</h2><p>Basadas en los nombres de tus categorías. Indican complementos habituales, no compatibilidad técnica: créalas solo si aplican.</p></div>${suggestions.length > 1 ? `<button class="small-btn" data-create-all type="button">${icon('check', { size: 15 })}<span>Crear las ${suggestions.length}</span></button>` : ''}</div>
      <div class="rel-suggest__grid">${suggestions.map((item, position) => `<article class="rel-suggestion"><span>${escapeHtml(item.from.name)}</span>${icon('arrowRight', { size: 14 })}<span>${escapeHtml(item.to.name)}</span><small>${RELATION_KINDS[item.kind]} · prioridad ${strengthLabel(item.strength).toLowerCase()}</small><button class="small-btn small-btn--primary" data-suggestion="${position}" type="button">${icon('plus', { size: 15 })}<span>Crear</span></button></article>`).join('')}</div>` : '';
    const create = item => saveProductRelationship({ source_type: 'category', source_id: item.from.id, target_type: 'category', target_id: item.to.id, kind: item.kind, strength: item.strength, active: true });
    panel.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', async () => {
      setButtonLoading(button, true, 'Creando…');
      try { await create(suggestions[Number(button.dataset.suggestion)]); toast('Regla creada'); await refresh(); }
      catch (error) { toast(requestError(error, 'No pudimos crear la regla.'), 'error'); setButtonLoading(button, false); }
    }));
    panel.querySelector('[data-create-all]')?.addEventListener('click', async event => {
      const button = event.currentTarget; setButtonLoading(button, true, 'Creando…');
      try { for (const item of suggestions) await create(item); toast(`${plural(suggestions.length, 'regla creada', 'reglas creadas')}`); await refresh(); }
      catch (error) { toast(requestError(error, 'No pudimos crear todas las reglas.'), 'error'); await refresh(); }
    });
  };
  const refresh = async () => { rules = await getProductRelationships({ refresh: true }); render(); renderSuggestions(); };

  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); render(); }, 200));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; render(); });
  root.querySelector('[data-status]').addEventListener('click', event => {
    const button = event.target.closest('[data-status-value]'); if (!button) return;
    state.status = button.dataset.statusValue;
    root.querySelectorAll('[data-status-value]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); render();
  });
  root.querySelector('[data-kinds]').addEventListener('click', event => { const button = event.target.closest('[data-kind]'); if (button) { state.kind = button.dataset.kind; render(); } });
  root.querySelector('[data-meta]').addEventListener('click', event => {
    if (!event.target.closest('[data-clear]')) return;
    Object.assign(state, { kind: 'all', status: 'all', q: '' }); root.querySelector('[data-search]').value = '';
    root.querySelectorAll('[data-status-value]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.statusValue === 'all'))); render();
  });
  const list = root.querySelector('[data-list]');
  list.addEventListener('click', async event => {
    if (event.target.closest('[data-empty-new]')) { openRuleForm(null, refresh, event.target.closest('button'), index); return; }
    const card = event.target.closest('[data-rule]'); if (!card) return;
    const rule = rules.find(item => item.id === card.dataset.rule);
    const edit = event.target.closest('[data-edit-rule]'); const remove = event.target.closest('[data-delete-rule]');
    if (edit) openRuleForm(rule, refresh, edit, index);
    if (remove) {
      if (!await confirmAction('La regla dejará de usarse en las recomendaciones de la tienda y del CRM.', 'Eliminar regla', { confirmLabel: 'Eliminar', trigger: remove })) return;
      try { await deleteProductRelationship(rule.id); toast('Regla eliminada'); await refresh(); } catch (error) { toast(requestError(error, 'No pudimos eliminar la regla.'), 'error'); }
    }
  });
  list.addEventListener('change', async event => {
    const toggle = event.target.closest('[data-toggle-rule]'); if (!toggle) return;
    const rule = rules.find(item => item.id === toggle.closest('[data-rule]').dataset.rule); toggle.disabled = true;
    try { await saveProductRelationship({ ...rulePayload(rule), active: toggle.checked }, rule.id); rule.active = toggle.checked; toast(toggle.checked ? 'Regla activada' : 'Regla pausada: se conserva sin usarse'); render(); }
    catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; toast(requestError(error, 'No pudimos cambiar la regla.'), 'error'); }
  });
  $('#new-relationship').addEventListener('click', event => openRuleForm(null, refresh, event.currentTarget, index));
  await refresh();
}

// Formulario guiado: tipo → origen y destino (selector visual con búsqueda) → prioridad.
function openRuleForm(rule, after, trigger, index) {
  const state = {
    kind: rule?.kind || 'complemento',
    source: { type: rule?.source_type || 'category', id: rule?.source_id || '', q: '' },
    target: { type: rule?.target_type || 'category', id: rule?.target_id || '', q: '' }
  };
  const step = (number, title, help, body) => `<section class="coupon-step"><header class="coupon-step__head"><span class="coupon-step__num">${number}</span><div><h3>${title}</h3><p>${help}</p></div></header><div class="coupon-step__body">${body}</div></section>`;
  const picker = (key, title) => `<div class="rel-picker" data-picker="${key}"><div class="rel-picker__head"><strong>${title}</strong><div class="segmented" role="group" aria-label="Tipo de ${title.toLowerCase()}" data-picker-type></div></div>
    <div class="rel-picker__selected" data-picker-selected></div>
    <div class="admin-search-wrap"><input class="admin-search" type="search" data-picker-search placeholder="Buscar…" aria-label="Buscar ${title.toLowerCase()}"></div>
    <ul class="rel-picker__list" role="listbox" aria-label="${title}" data-picker-list></ul></div>`;
  const form = document.createElement('form');
  form.className = 'coupon-form rel-form'; form.noValidate = true;
  form.innerHTML = `<div class="rel-preview" aria-live="polite"><div class="rel-preview__flow" data-preview-flow></div><p data-preview-text></p></div>
    ${step(1, '¿Qué tipo de relación es?', 'Define cómo la usará el recomendador.', `<fieldset class="choice-tiles rel-kind-tiles"><legend class="sr-only">Tipo de regla</legend>${Object.entries(KIND_META).map(([value, meta]) => `<label class="choice-tile rel-tone--${meta.tone}"><input type="radio" name="kind" value="${value}" ${state.kind === value ? 'checked' : ''}><span class="choice-tile__icon">${icon(meta.icon, { size: 18 })}</span><strong>${escapeHtml(RELATION_KINDS[value])}</strong><small>${meta.help}</small></label>`).join('')}</fieldset>`)}
    ${step(2, 'Conecta origen y destino', 'Elige con un clic. Puedes usar una categoría completa o un producto concreto.', `<p class="rel-form__note" data-compat-note hidden>${icon('shield', { size: 15 })}La compatibilidad solo se registra entre productos o modelos concretos, nunca por categoría o marca.</p><div class="rel-pickers">${picker('source', 'Origen')}<span class="rel-pickers__arrow" aria-hidden="true">${icon('arrowRight', { size: 18 })}</span>${picker('target', 'Destino')}</div>`)}
    ${step(3, 'Ajustes', 'Prioridad, frecuencia y notas internas.', `
      <div class="rel-strength"><div class="rel-strength__head"><span>Prioridad en las recomendaciones</span><b data-strength-label></b></div><input type="range" name="strength" min="0.1" max="1" step="0.05" value="${escapeHtml(rule?.strength ?? 0.7)}" aria-describedby="rel-strength-help"><div class="rel-strength__scale" aria-hidden="true"><span>Baja</span><span>Media</span><span>Alta</span><span>Muy alta</span></div><small id="rel-strength-help">Cuando varias reglas compiten, se muestran primero las de mayor prioridad.</small></div>
      <div class="rel-days" data-days hidden><label class="sale-action__field"><span class="sale-action__label">Recordar cada</span><div class="input-affix"><input name="reposition_days" type="number" min="1" max="3650" inputmode="numeric" value="${escapeHtml(rule?.reposition_days || 30)}"><span>días</span></div></label><div class="reason-chips" role="group" aria-label="Frecuencias rápidas">${[15, 30, 60, 90, 180].map(days => `<button class="reason-chip" type="button" data-days-chip="${days}">${days} días</button>`).join('')}</div></div>
      <label class="sale-action__field"><span class="sale-action__label" data-note-label>Nota interna <small>Opcional</small></span><input name="note" maxlength="200" value="${escapeHtml(rule?.note || '')}" placeholder="Ej. Compatible según ficha técnica del fabricante"></label>
      <label class="switch-row switch-row--main"><span><strong>Regla activa</strong><small>Pausada se conserva, pero no se usa en las recomendaciones</small></span><input class="switch" name="active" type="checkbox" ${rule?.active === false ? '' : 'checked'}></label>`)}
    <p class="sale-action__error" data-error role="alert" hidden></p><div class="coupon-form__actions"><button class="btn btn--ghost" data-cancel type="button">Cancelar</button><button class="btn btn--primary" type="submit">${icon('check', { size: 18 })}<span>${rule ? 'Guardar cambios' : 'Crear regla'}</span></button></div>`;
  const modal = openModal({ title: rule ? 'Editar relación' : 'Nueva relación', content: form, trigger, className: 'modal--wide modal--coupon', closeOnBackdrop: false, headerIcon: `<span class="sale-action__badge">${icon('link', { size: 20 })}</span>` });

  const forced = () => state.kind === 'compatible_con';
  const typeOf = key => (forced() ? 'product' : state[key].type);
  const drawPicker = key => {
    const box = form.querySelector(`[data-picker="${key}"]`); const view = state[key]; const type = typeOf(key);
    box.querySelector('[data-picker-type]').innerHTML = [['category', 'Categoría'], ['product', 'Producto']].map(([value, label]) => `<button type="button" data-type="${value}" aria-pressed="${type === value}" ${forced() && value === 'category' ? 'disabled' : ''}>${label}</button>`).join('');
    const selected = view.id ? index.entity(type, view.id) : null;
    box.querySelector('[data-picker-selected]').innerHTML = selected && !selected.missing ? `<div class="rel-picked">${nodeMarkup(selected)}<button class="icon-btn" type="button" data-unpick aria-label="Quitar selección">${icon('x', { size: 14 })}</button></div>` : `<p class="rel-picker__empty">${icon('info', { size: 14 })}Elige ${type === 'category' ? 'una categoría' : 'un producto'} de la lista.</p>`;
    const term = normalizeText(view.q);
    const matches = index.options(type).filter(option => !term || normalizeText(`${option.name} ${option.sub}`).includes(term));
    const shown = matches.slice(0, 60);
    box.querySelector('[data-picker-list]').innerHTML = shown.length ? shown.map(option => `<li><button class="scope-option ${option.id === view.id ? 'is-on' : ''}" type="button" role="option" aria-selected="${option.id === view.id}" data-pick="${escapeHtml(option.id)}"><span class="scope-option__check" aria-hidden="true">${icon('check', { size: 13 })}</span><span class="scope-option__visual">${nodeVisual(option, 16)}</span><span class="scope-option__text"><strong>${escapeHtml(option.name)}</strong><small>${escapeHtml(option.sub || option.label)}</small></span></button></li>`).join('')
      + (matches.length > shown.length ? `<li class="scope-picker__more">Mostrando ${shown.length} de ${matches.length}: escribe para afinar.</li>` : '')
      : '<li class="scope-picker__more">Sin resultados para esta búsqueda.</li>';
  };
  const preview = () => {
    const strength = Number(form.elements.strength.value) || 0.7; const days = Number(form.elements.reposition_days.value) || 30;
    const source = state.source.id ? index.entity(typeOf('source'), state.source.id) : null; const target = state.target.id ? index.entity(typeOf('target'), state.target.id) : null;
    const meta = KIND_META[state.kind];
    form.querySelector('[data-strength-label]').textContent = `${strengthLabel(strength)} · ${strength.toFixed(2)}`;
    form.elements.strength.style.setProperty('--fill', `${((strength - 0.1) / 0.9) * 100}%`);
    form.querySelector('[data-days]').hidden = state.kind !== 'reposicion';
    form.querySelectorAll('[data-days-chip]').forEach(chip => chip.classList.toggle('is-active', Number(chip.dataset.daysChip) === days));
    form.querySelector('[data-compat-note]').hidden = !forced();
    form.querySelector('[data-note-label]').innerHTML = forced() ? 'Evidencia de compatibilidad <small>Obligatoria: ficha técnica, modelo, referencia</small>' : 'Nota interna <small>Opcional</small>';
    const placeholder = text => `<div class="rel-node rel-node--empty"><span class="rel-node__visual"><span>?</span></span><span class="rel-node__text"><small>Pendiente</small><strong>${text}</strong></span></div>`;
    form.querySelector('[data-preview-flow]').innerHTML = `${source ? nodeMarkup(source) : placeholder('Elige el origen')}<div class="rel-link rel-tone--${meta.tone}"><span class="rel-badge">${icon(meta.icon, { size: 14 })}${escapeHtml(RELATION_KINDS[state.kind])}</span><i class="rel-link__line" aria-hidden="true">${icon('arrowRight', { size: 14 })}</i></div>${target ? nodeMarkup(target) : placeholder('Elige el destino')}`;
    const same = source && target && source.type === target.type && source.id === target.id;
    form.querySelector('[data-preview-text]').innerHTML = source && target ? `${icon('sparkles', { size: 15 })}<span>${meta.sentence(escapeHtml(source.name), escapeHtml(target.name), days, same)} Prioridad <b>${strengthLabel(strength).toLowerCase()}</b>.</span>` : `${icon('info', { size: 15 })}<span>Elige el origen y el destino para ver cómo funcionará la regla.</span>`;
  };
  const drawAll = () => { drawPicker('source'); drawPicker('target'); preview(); };

  ['source', 'target'].forEach(key => {
    const box = form.querySelector(`[data-picker="${key}"]`);
    box.querySelector('[data-picker-search]').addEventListener('input', debounce(event => { state[key].q = event.target.value.trim(); drawPicker(key); }, 150));
    box.addEventListener('click', event => {
      const type = event.target.closest('[data-type]'); const pick = event.target.closest('[data-pick]');
      if (type && !type.disabled && type.dataset.type !== state[key].type) { state[key].type = type.dataset.type; state[key].id = ''; drawPicker(key); preview(); }
      else if (pick) { state[key].id = pick.dataset.pick; drawPicker(key); preview(); }
      else if (event.target.closest('[data-unpick]')) { state[key].id = ''; drawPicker(key); preview(); }
    });
  });
  form.addEventListener('change', event => {
    if (event.target.name !== 'kind') return;
    const wasForced = forced(); state.kind = event.target.value;
    if (forced()) ['source', 'target'].forEach(key => { if (state[key].type !== 'product') { state[key].type = 'product'; state[key].id = ''; } });
    else if (wasForced) ['source', 'target'].forEach(key => { state[key].type = 'product'; });
    drawAll();
  });
  form.addEventListener('input', event => { if (['strength', 'reposition_days'].includes(event.target.name)) preview(); });
  form.querySelectorAll('[data-days-chip]').forEach(chip => chip.addEventListener('click', () => { form.elements.reposition_days.value = chip.dataset.daysChip; preview(); }));
  form.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  drawAll();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = form.querySelector('[data-error]'); const note = form.elements.note.value.trim();
    const values = { kind: state.kind, strength: Number(form.elements.strength.value), source_type: typeOf('source'), source_id: state.source.id, target_type: typeOf('target'), target_id: state.target.id, reposition_days: state.kind === 'reposicion' ? Number(form.elements.reposition_days.value) : null, note: note || null, active: form.elements.active.checked };
    const problem = !values.source_id ? 'Elige el elemento de origen.' : !values.target_id ? 'Elige el elemento de destino.'
      : values.source_type === values.target_type && values.source_id === values.target_id && values.kind !== 'reposicion' ? 'El origen y el destino deben ser distintos (salvo reposición del mismo producto).'
        : values.kind === 'reposicion' && !(values.reposition_days >= 1 && values.reposition_days <= 3650) ? 'La frecuencia de reposición debe estar entre 1 y 3650 días.'
          : forced() && !note ? 'Indica la evidencia de compatibilidad (ficha técnica, modelo o referencia).' : '';
    if (problem) { error.textContent = problem; error.hidden = false; error.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }
    const button = event.submitter || form.querySelector('[type="submit"]'); setButtonLoading(button, true, 'Guardando…');
    try { await saveProductRelationship(values, rule?.id || null); toast(rule ? 'Regla actualizada' : 'Regla creada'); modal.close(true); await after(); }
    catch (saveError) { error.textContent = requestError(saveError, 'No pudimos guardar la regla.'); error.hidden = false; setButtonLoading(button, false); }
  });
}

// --- Costos privados (solo propietario) ---------------------------------------------
// Sirven para ver el margen al preparar ofertas. Nunca se publican: tabla aparte con RLS.
const LOW_MARGIN = 20;
const PAGE_SIZE = 40;
const marginOf = (price, cost) => (cost == null || !price ? null : ((price - cost) / price) * 100);
const marginState = margin => (margin == null ? 'none' : margin < 0 ? 'loss' : margin < LOW_MARGIN ? 'low' : 'ok');
const MARGIN_TEXT = { none: 'Sin costo', loss: 'En pérdida', low: 'Margen bajo', ok: 'Saludable' };
const COST_VIEWS = {
  all: { label: 'Todos', match: () => true },
  none: { label: 'Sin costo', match: row => row.state === 'none' },
  loss: { label: 'En pérdida', match: row => row.state === 'loss' },
  low: { label: `Margen bajo (< ${LOW_MARGIN} %)`, match: row => row.state === 'low' },
  ok: { label: 'Saludables', match: row => row.state === 'ok' }
};
const COST_SORTS = { name: 'Nombre (A-Z)', marginAsc: 'Menor margen primero', marginDesc: 'Mayor margen primero', price: 'Precio más alto' };
const percentText = value => `${Math.round(value)} %`;

export async function renderCosts() {
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Catálogo', 'Costos y márgenes', 'Registra cuánto te cuesta cada producto y mira al instante tu ganancia por unidad. Solo el propietario lo ve: nunca se publica en la tienda.')
    + `<div data-kpis></div>
    <section class="admin-panel cost-panel">
      <div class="cost-toolbar"><div class="admin-search-wrap"><input class="admin-search" type="search" data-search placeholder="Buscar producto o marca" aria-label="Buscar producto"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar productos">${Object.entries(COST_SORTS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <details class="cost-calc"><summary>${icon('chart', { size: 16 })}<span>Calculadora de precio</span></summary><div class="cost-calc__body">
          <label class="sale-action__field"><span class="sale-action__label">Costo</span><div class="input-affix"><span>$</span><input type="number" min="0" step="1" inputmode="numeric" data-calc-cost placeholder="100000"></div></label>
          <label class="sale-action__field"><span class="sale-action__label">Margen deseado</span><div class="input-affix"><input type="number" min="0" max="95" step="1" inputmode="numeric" data-calc-margin value="30"><span>%</span></div></label>
          <p class="cost-calc__result" data-calc-result aria-live="polite"></p></div></details></div>
      <div class="sales-tabs" role="group" aria-label="Filtrar por margen" data-tabs></div>
      <p class="results-meta" data-meta aria-live="polite"></p>
      <div class="cost-table" data-list></div>
      <div class="cost-more" data-more></div>
    </section>
    <div class="cost-savebar" data-savebar hidden><div><strong data-dirty-count></strong><small>Los cambios se guardan solo al confirmar.</small></div><div class="cost-savebar__actions"><button class="btn btn--ghost" data-discard type="button">Descartar</button><button class="btn btn--primary" data-save-all type="button">${icon('check', { size: 18 })}<span>Guardar todo</span></button></div></div>`;
  let costs = new Map();
  try { costs = new Map((await getProductCosts()).map(row => [row.product_id, Number(row.unit_cost)])); }
  catch (error) { root.querySelector('[data-list]').innerHTML = `<div class="rel-empty">${icon('shield', { size: 22 })}<strong>No disponible</strong><small>${escapeHtml(requestError(error, 'Solo el propietario puede ver los costos.'))}</small></div>`; root.querySelector('[data-kpis]').remove(); return; }
  const products = ctx.getProducts().slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const drafts = new Map();
  const state = { q: '', view: 'all', sort: 'name', limit: PAGE_SIZE };
  const rowFor = product => {
    const price = currentPrice(product); const cost = costs.has(product.id) ? costs.get(product.id) : null; const margin = marginOf(price, cost);
    return { product, price, cost, margin, state: marginState(margin) };
  };

  const kpis = () => {
    const rows = products.map(rowFor); const withCost = rows.filter(row => row.cost != null && row.price);
    const average = withCost.length ? withCost.reduce((sum, row) => sum + row.margin, 0) / withCost.length : null;
    const profit = withCost.length ? withCost.reduce((sum, row) => sum + (row.price - row.cost), 0) / withCost.length : 0;
    const coverage = products.length ? Math.round((withCost.length / products.length) * 100) : 0;
    const low = rows.filter(row => row.state === 'low').length; const loss = rows.filter(row => row.state === 'loss').length;
    root.querySelector('[data-kpis]').innerHTML = `<section class="sales-kpis" aria-label="Resumen de márgenes">
      ${kpiTileMarkup({ tone: 'hero', iconName: 'chart', label: 'Margen promedio', value: average == null ? '—' : percentText(average), detail: withCost.length ? `Ganancia promedio ${formatMoney(profit)} por unidad` : 'Registra costos para calcularlo' })}
      ${kpiTileMarkup({ view: 'none', tone: 'info', iconName: 'layers', label: 'Cobertura de costos', value: `${coverage} %`, detail: `<span class="cost-coverage"><i style="width:${coverage}%"></i></span>${withCost.length} de ${plural(products.length, 'producto')}` })}
      ${kpiTileMarkup({ view: 'low', tone: 'warning', iconName: 'alert', label: 'Margen bajo', value: low, detail: `Menos de ${LOW_MARGIN} % de ganancia` })}
      ${kpiTileMarkup({ view: 'loss', tone: loss ? 'danger' : 'success', iconName: loss ? 'alert' : 'checkCircle', label: 'En pérdida', value: loss, detail: loss ? 'El costo supera el precio de venta' : 'Ningún producto vende por debajo del costo' })}
    </section>`;
    root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => { state.view = tile.dataset.kpiView; state.limit = PAGE_SIZE; render(); root.querySelector('.cost-panel').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }));
  };

  // Celdas calculadas a partir del valor escrito (borrador) o del guardado.
  const computed = (product, raw) => {
    const price = currentPrice(product); const cost = raw === '' || raw == null ? null : Number(raw);
    const valid = cost == null || (Number.isFinite(cost) && cost >= 0);
    const margin = valid ? marginOf(price, cost) : null; const status = valid ? marginState(margin) : 'none';
    const bar = margin == null ? 0 : Math.max(4, Math.min(100, Math.abs(margin)));
    return { valid, status, html: {
      profit: cost == null || !valid ? '<span class="cost-muted">—</span>' : `<b class="${price - cost < 0 ? 'is-loss' : ''}">${formatMoney(price - cost)}</b><small>por unidad</small>`,
      margin: margin == null ? `<span class="cost-pill cost-pill--none">${valid ? 'Sin costo' : 'Valor inválido'}</span>` : `<span class="cost-pill cost-pill--${status}">${percentText(margin)}</span><span class="cost-bar"><i style="width:${bar}%"></i></span><small>${MARGIN_TEXT[status]}</small>`
    } };
  };
  const rowMarkup = row => {
    const { product } = row; const draft = drafts.has(product.id); const value = draft ? drafts.get(product.id) : (row.cost ?? '');
    const calc = computed(product, value); const promo = isPromoActive(product);
    return `<article class="cost-row ${draft ? 'is-dirty' : ''}" data-cost="${product.id}" data-state="${calc.status}">
      <div class="cost-row__product"><span class="cost-row__thumb">${productImage(product) ? `<img src="${escapeHtml(productImage(product))}" alt="" loading="lazy" decoding="async">` : icon('package', { size: 18 })}</span><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.brands?.name || 'Sin marca')}${product.status !== 'published' ? ' · No publicado' : ''}</small></span></div>
      <div class="cost-row__price" data-label="Precio de venta"><b>${formatMoney(row.price)}</b>${promo ? `<small class="cost-promo">Promo · antes ${formatMoney(product.base_price)}</small>` : '<small>Precio vigente</small>'}</div>
      <label class="cost-row__input" data-label="Tu costo"><span class="sr-only">Costo unitario de ${escapeHtml(product.name)}</span><span class="input-affix"><span>$</span><input name="cost" type="number" min="0" step="1" inputmode="numeric" placeholder="Costo" value="${escapeHtml(value)}"></span></label>
      <div class="cost-row__profit" data-label="Ganancia" data-profit>${calc.html.profit}</div>
      <div class="cost-row__margin" data-label="Margen" data-margin>${calc.html.margin}</div>
      <div class="cost-row__action"><button class="small-btn small-btn--primary" data-save-row type="button" ${draft ? '' : 'hidden'}>${icon('check', { size: 15 })}<span>Guardar</span></button><span class="cost-row__saved" ${draft || row.cost == null ? 'hidden' : ''} title="Costo guardado">${icon('checkCircle', { size: 18 })}</span></div>
    </article>`;
  };
  const render = () => {
    const term = normalizeText(state.q);
    const base = products.filter(product => !term || normalizeText(`${product.name} ${product.brands?.name || ''}`).includes(term)).map(rowFor);
    root.querySelector('[data-tabs]').innerHTML = Object.entries(COST_VIEWS).map(([key, view]) => `<button class="sales-tab ${state.view === key ? 'active' : ''}" data-view="${key}" type="button" aria-pressed="${state.view === key}"><span>${view.label}</span><b>${base.filter(view.match).length}</b></button>`).join('');
    const visible = base.filter(COST_VIEWS[state.view].match).sort({
      name: (a, b) => a.product.name.localeCompare(b.product.name, 'es'),
      marginAsc: (a, b) => (a.margin ?? Infinity) - (b.margin ?? Infinity),
      marginDesc: (a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity),
      price: (a, b) => b.price - a.price
    }[state.sort]);
    root.querySelector('[data-meta]').innerHTML = `<span>${plural(visible.length, 'producto')} · ${costs.size} con costo registrado</span><span class="cost-legend"><i class="cost-dot cost-dot--loss"></i>Pérdida<i class="cost-dot cost-dot--low"></i>Bajo<i class="cost-dot cost-dot--ok"></i>Saludable</span>${state.q || state.view !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    const shown = visible.slice(0, state.limit);
    root.querySelector('[data-list]').innerHTML = shown.length ? `<div class="cost-head" aria-hidden="true"><span>Producto</span><span>Precio de venta</span><span>Tu costo</span><span>Ganancia</span><span>Margen</span><span></span></div>${shown.map(rowMarkup).join('')}`
      : `<div class="rel-empty rel-empty--small">${icon('search', { size: 22 })}<strong>${products.length ? 'Sin productos en esta vista' : 'Sin productos'}</strong><small>${products.length ? 'Prueba con otro filtro o búsqueda.' : 'Crea productos para registrar sus costos.'}</small></div>`;
    root.querySelector('[data-more]').innerHTML = visible.length > shown.length ? `<button class="btn btn--ghost" data-more-btn type="button">Mostrar ${Math.min(PAGE_SIZE, visible.length - shown.length)} más <small>(${shown.length} de ${visible.length})</small></button>` : '';
    syncSavebar();
  };
  const syncSavebar = () => {
    const bar = root.querySelector('[data-savebar]'); bar.hidden = !drafts.size;
    root.querySelector('[data-dirty-count]').textContent = `${plural(drafts.size, 'cambio sin guardar', 'cambios sin guardar')}`;
  };
  const parseDraft = raw => (raw === '' ? null : Number(raw));
  const saveOne = async (productId, raw) => {
    const value = parseDraft(raw);
    if (value != null && !(Number.isFinite(value) && value >= 0)) throw new Error('Escribe un costo válido (número mayor o igual a 0).');
    await saveProductCost(productId, value);
    if (value == null) costs.delete(productId); else costs.set(productId, value);
    drafts.delete(productId);
  };

  const list = root.querySelector('[data-list]');
  list.addEventListener('input', event => {
    const input = event.target.closest('input[name="cost"]'); if (!input) return;
    const row = input.closest('[data-cost]'); const product = products.find(item => item.id === row.dataset.cost);
    const saved = costs.has(product.id) ? String(costs.get(product.id)) : '';
    if (input.value === saved) drafts.delete(product.id); else drafts.set(product.id, input.value);
    const calc = computed(product, input.value);
    row.dataset.state = calc.status; row.classList.toggle('is-dirty', drafts.has(product.id));
    row.querySelector('[data-profit]').innerHTML = calc.html.profit; row.querySelector('[data-margin]').innerHTML = calc.html.margin;
    row.querySelector('[data-save-row]').hidden = !drafts.has(product.id);
    row.querySelector('.cost-row__saved').hidden = drafts.has(product.id) || !costs.has(product.id);
    syncSavebar();
  });
  const saveRow = async row => {
    const button = row.querySelector('[data-save-row]'); const id = row.dataset.cost; if (!drafts.has(id)) return;
    setButtonLoading(button, true, 'Guardando…');
    try { await saveOne(id, drafts.get(id)); toast('Costo guardado'); kpis(); render(); }
    catch (error) { toast(requestError(error, 'No pudimos guardar el costo.'), 'error'); setButtonLoading(button, false); }
  };
  list.addEventListener('click', event => { const button = event.target.closest('[data-save-row]'); if (button) saveRow(button.closest('[data-cost]')); });
  list.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.name === 'cost') { event.preventDefault(); saveRow(event.target.closest('[data-cost]')); } });
  root.querySelector('[data-save-all]').addEventListener('click', async event => {
    const button = event.currentTarget; setButtonLoading(button, true, 'Guardando…');
    let saved = 0; const failed = [];
    for (const [id, raw] of [...drafts]) { try { await saveOne(id, raw); saved += 1; } catch (error) { failed.push(products.find(item => item.id === id)?.name || id); console.error(error); } }
    setButtonLoading(button, false);
    if (saved) toast(`${plural(saved, 'costo guardado', 'costos guardados')}`);
    if (failed.length) toast(`No pudimos guardar: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}. Revisa los valores.`, 'error');
    kpis(); render();
  });
  root.querySelector('[data-discard]').addEventListener('click', () => { drafts.clear(); render(); });
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.limit = PAGE_SIZE; render(); }, 200));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; render(); });
  root.querySelector('[data-tabs]').addEventListener('click', event => { const tab = event.target.closest('[data-view]'); if (tab) { state.view = tab.dataset.view; state.limit = PAGE_SIZE; render(); } });
  root.querySelector('[data-meta]').addEventListener('click', event => { if (event.target.closest('[data-clear]')) { state.q = ''; state.view = 'all'; root.querySelector('[data-search]').value = ''; render(); } });
  root.querySelector('[data-more]').addEventListener('click', event => { if (event.target.closest('[data-more-btn]')) { state.limit += PAGE_SIZE; render(); } });

  const calc = () => {
    const cost = Number(root.querySelector('[data-calc-cost]').value); const margin = Number(root.querySelector('[data-calc-margin]').value);
    const out = root.querySelector('[data-calc-result]');
    if (!(cost > 0) || !(margin >= 0 && margin < 100)) { out.innerHTML = `${icon('info', { size: 14 })}Escribe un costo y un margen entre 0 y 95 %.`; return; }
    const price = Math.ceil(cost / (1 - margin / 100) / 100) * 100;
    out.innerHTML = `Precio sugerido <b>${formatMoney(price)}</b><small>Ganancia de ${formatMoney(price - cost)} por unidad (redondeado a la centena).</small>`;
  };
  root.querySelectorAll('[data-calc-cost],[data-calc-margin]').forEach(input => input.addEventListener('input', calc));
  calc(); kpis(); render();
}
