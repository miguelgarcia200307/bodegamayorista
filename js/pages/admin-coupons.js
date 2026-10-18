// Cupones generales y relaciones de productos (reglas del recomendador).
// Los cupones personales nacen desde el análisis del cliente (ofertas). Aquí se crean
// códigos públicos o portadores con alcance, mínimos, topes, vigencia y límites de uso.
import { deleteProductRelationship, getCoupons, getProductCosts, getProductRelationships, saveCoupon, saveProductCost, saveProductRelationship } from '../lib/api.js';
import { RELATION_KINDS } from '../lib/reco-core.js';
import { confirmAction, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { $, debounce, escapeHtml, formatMoney, normalizeText, productImage, setButtonLoading } from '../lib/helpers.js';
import { icon } from '../components/icons.js';
import { dateText, dateTimeText, emptyMarkup, kpiTileMarkup, plural, requestError } from './admin-crm.js';

let ctx = null;
export function configureCoupons(context) { ctx = context; }

const AUDIENCE = { publico: 'Público', portador: 'Portador (transferible)', cliente_verificado: 'Cliente verificado' };
const STACKING = { sobre_precio_vigente: 'Sobre el precio vigente (acumula con promoción y tramo)', solo_precio_regular: 'Solo productos sin promoción ni tramo' };
const usesSummary = coupon => {
  const uses = coupon.coupon_uses || []; const now = Date.now();
  const reserved = uses.filter(use => use.status === 'reservada' && Date.parse(use.expires_at) > now).length;
  const consumed = uses.filter(use => use.status === 'consumida').length;
  const released = uses.filter(use => use.status === 'liberada').length;
  const expired = uses.filter(use => use.status === 'reservada' && Date.parse(use.expires_at) <= now).length;
  return { reserved, consumed, released, expired, text: `${consumed} usado${consumed === 1 ? '' : 's'} · ${reserved} reservado${reserved === 1 ? '' : 's'}${expired ? ` · ${expired} reserva(s) vencida(s) por revisar` : ''}${released ? ` · ${released} liberado(s)` : ''}` };
};
const toLocal = value => (value ? new Date(value).toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).slice(0, 16).replace(' ', 'T') : '');
const fromLocal = value => (value ? `${value}:00-05:00` : null);

// Estado efectivo del cupón (el servidor valida igual al aplicarlo en el carrito).
const couponState = coupon => {
  const now = Date.now(); const uses = usesSummary(coupon);
  if (coupon.ends_at && Date.parse(coupon.ends_at) < now) return ['expired', 'Vencido', 'muted'];
  if (!coupon.active) return ['inactive', 'Inactivo', 'muted'];
  if (coupon.max_uses_total && uses.consumed + uses.reserved >= coupon.max_uses_total) return ['exhausted', 'Agotado', 'warning'];
  if (coupon.starts_at && Date.parse(coupon.starts_at) > now) return ['scheduled', 'Programado', 'info'];
  return ['active', 'Activo', 'success'];
};
const daysLeft = iso => Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
const expiresSoon = coupon => couponState(coupon)[0] === 'active' && coupon.ends_at && daysLeft(coupon.ends_at) <= 7;
const COUPON_VIEWS = {
  all: { label: 'Todos', match: () => true },
  active: { label: 'Activos', match: coupon => couponState(coupon)[0] === 'active' },
  expiring: { label: 'Vencen pronto', match: expiresSoon },
  scheduled: { label: 'Programados', match: coupon => couponState(coupon)[0] === 'scheduled' },
  personal: { label: 'Ofertas personales', match: coupon => Boolean(coupon.customer_id) },
  public: { label: 'Generales', match: coupon => !coupon.customer_id },
  review: { label: 'Reservas por revisar', match: coupon => usesSummary(coupon).expired > 0 },
  closed: { label: 'Agotados, vencidos e inactivos', match: coupon => ['expired', 'inactive', 'exhausted'].includes(couponState(coupon)[0]) }
};
const COUPON_SORTS = { recent: 'Más recientes', used: 'Más usados', discount: 'Mayor descuento otorgado', expiring: 'Vencen primero' };
const grantedOf = coupon => (coupon.coupon_uses || []).filter(use => use.status === 'consumida').reduce((sum, use) => sum + Number(use.discount_total || 0), 0);
const couponValue = coupon => coupon.kind === 'porcentaje' ? `${Number(coupon.value)}%` : formatMoney(coupon.value);

function scopeSummary(coupon, labels) {
  const scopes = coupon.coupon_scopes || [];
  const name = scope => (labels.get(`${scope.scope_type}:${scope.target_id}`) || (scope.scope_type === 'variant' ? 'Opción específica de un producto' : 'Elemento eliminado')).replace(/^(Categoría|Marca|Producto) · /, (match, kind) => `${kind} `);
  const include = scopes.filter(scope => scope.mode !== 'excluir').map(name); const exclude = scopes.filter(scope => scope.mode === 'excluir').map(name);
  return { include: include.length ? include.join(', ') : 'Todo el catálogo', exclude: exclude.join(', ') };
}

function couponsKpisMarkup(coupons) {
  const uses = coupons.flatMap(coupon => coupon.coupon_uses || []);
  const consumed = uses.filter(use => use.status === 'consumida');
  const granted = consumed.reduce((sum, use) => sum + Number(use.discount_total || 0), 0);
  const now = Date.now(); const reserved = uses.filter(use => use.status === 'reservada' && Date.parse(use.expires_at) > now);
  const stale = uses.filter(use => use.status === 'reservada' && Date.parse(use.expires_at) <= now).length;
  const active = coupons.filter(COUPON_VIEWS.active.match); const soon = coupons.filter(expiresSoon);
  return `<section class="sales-kpis" aria-label="Resumen de cupones">
    ${kpiTileMarkup({ tone: 'hero', iconName: 'percent', label: 'Descuento otorgado', value: formatMoney(granted), detail: `${plural(consumed.length, 'uso confirmado', 'usos confirmados')} en ventas${reserved.length ? ` · ${formatMoney(reserved.reduce((sum, use) => sum + Number(use.discount_total || 0), 0))} reservados` : ''}` })}
    ${kpiTileMarkup({ view: 'active', tone: 'success', iconName: 'checkCircle', label: 'Activos', value: active.length, detail: `${plural(active.filter(coupon => coupon.customer_id).length, 'oferta personal', 'ofertas personales')} · ${plural(active.filter(coupon => !coupon.customer_id).length, 'general', 'generales')}` })}
    ${kpiTileMarkup({ view: 'expiring', tone: 'warning', iconName: 'clock', label: 'Vencen en 7 días', value: soon.length, detail: soon.length ? 'Recuérdales a tus clientes usarlos' : 'Ninguno por vencer' })}
    ${kpiTileMarkup({ view: 'review', tone: stale ? 'danger' : 'info', iconName: 'history', label: 'Reservas', value: reserved.length, detail: stale ? `<b class="is-down">${plural(stale, 'reserva vencida', 'reservas vencidas')} por revisar</b>` : 'Usos apartados por pedidos abiertos' })}
  </section>`;
}

function couponCardMarkup(coupon, labels, menuUp) {
  const [state, stateLabel, tone] = couponState(coupon); const uses = usesSummary(coupon); const scope = scopeSummary(coupon, labels);
  const limit = Number(coupon.max_uses_total) || 0; const taken = uses.consumed + uses.reserved;
  const meter = limit ? Math.min(100, Math.round((taken / limit) * 100)) : 0;
  const validity = coupon.ends_at ? (state === 'expired' ? `<span class="validity validity--bad">${icon('clock', { size: 13 })}Venció el ${escapeHtml(dateText(coupon.ends_at))}</span>`
    : (() => { const days = daysLeft(coupon.ends_at); return `<span class="validity ${days <= 7 ? 'validity--soon' : 'validity--ok'}">${icon('clock', { size: 13 })}${days <= 1 ? 'Vence hoy' : `Vence en ${days} días`}<small>· ${escapeHtml(dateTimeText(coupon.ends_at))}</small></span>`; })())
    : `<span class="validity">${icon('clock', { size: 13 })}Sin vencimiento</span>`;
  const starts = state === 'scheduled' ? `<span class="validity validity--ok">${icon('history', { size: 13 })}Empieza ${escapeHtml(dateTimeText(coupon.starts_at))}</span>` : '';
  const conditions = [coupon.max_discount && `Tope ${formatMoney(coupon.max_discount)}`, Number(coupon.min_eligible) && `Compra mínima ${formatMoney(coupon.min_eligible)}`, coupon.max_uses_per_customer && `${plural(Number(coupon.max_uses_per_customer), 'uso')} por cliente`, coupon.stacking === 'solo_precio_regular' ? 'No acumula con promociones' : 'Acumula con promociones'].filter(Boolean);
  const menu = [
    `<button data-copy-coupon type="button">${icon('link', { size: 16 })}<span>Copiar código</span></button>`,
    `<button class="${coupon.active ? 'is-danger' : ''}" data-toggle-coupon type="button">${icon(coupon.active ? 'x' : 'check', { size: 16 })}<span>${coupon.active ? 'Desactivar' : 'Activar'}</span></button>`
  ].join('');
  const primary = coupon.customer_id ? `<button class="small-btn sale-row__primary" data-open-customer type="button">${icon('user', { size: 16 })}<span>Ver cliente</span></button>` : `<button class="small-btn small-btn--primary sale-row__primary" data-edit-coupon type="button">${icon('pencil', { size: 16 })}<span>Editar</span></button>`;
  return `<article class="coupon-card coupon-card--${state}" data-coupon="${coupon.id}">
    <div class="coupon-card__stub" aria-hidden="true"><strong>${escapeHtml(couponValue(coupon))}</strong><small>${coupon.kind === 'porcentaje' ? 'de descuento' : 'menos'}</small></div>
    <div class="coupon-card__body">
      <div class="coupon-card__top"><button class="coupon-code" data-copy-coupon type="button" title="Copiar código">${escapeHtml(coupon.code)}${icon('link', { size: 13 })}</button><span class="status-pill status-pill--${tone}">${stateLabel}</span>${coupon.customer_id ? `<span class="customer-badge customer-badge--gold">${icon('star', { size: 12 })}Oferta personal</span>` : `<span class="task-tag">${escapeHtml(AUDIENCE[coupon.audience] || coupon.audience)}</span>`}</div>
      <h3 class="coupon-card__name">${escapeHtml(coupon.name)}</h3>
      <p class="coupon-card__scope">${icon('tag', { size: 14 })}<span><b>Aplica a:</b> ${escapeHtml(scope.include)}${scope.exclude ? ` <em>· excepto ${escapeHtml(scope.exclude)}</em>` : ''}</span></p>
      <div class="coupon-card__chips">${conditions.map(text => `<span>${escapeHtml(text)}</span>`).join('')}</div>
    </div>
    <div class="coupon-card__usage">
      <div class="coupon-meter"><div class="coupon-meter__head"><span>Usos</span><b>${limit ? `${taken} de ${limit}` : `${taken} · sin límite`}</b></div><div class="coupon-meter__track"><span style="width:${limit ? meter : Math.min(100, taken * 10)}%"></span></div><small>${uses.consumed} confirmado${uses.consumed === 1 ? '' : 's'} · ${uses.reserved} reservado${uses.reserved === 1 ? '' : 's'}${uses.released ? ` · ${uses.released} liberado${uses.released === 1 ? '' : 's'}` : ''}</small>${uses.expired ? `<small class="is-late">${plural(uses.expired, 'reserva vencida', 'reservas vencidas')} por revisar</small>` : ''}</div>
      <div class="quote-row__meta">${starts}${validity}</div>
      <span class="coupon-card__granted">Otorgado: <b>${formatMoney(grantedOf(coupon))}</b></span>
    </div>
    <div class="sale-row__actions coupon-card__actions">${primary}<details class="action-menu sale-menu ${menuUp ? 'action-menu--up' : ''}"><summary aria-label="Más acciones para ${escapeHtml(coupon.code)}" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${menu}</div></details></div>
  </article>`;
}

export async function renderCoupons() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', view: params.get('view') || 'all', sort: params.get('sort') || 'recent' };
  if (!COUPON_VIEWS[state.view]) state.view = 'all';
  if (!COUPON_SORTS[state.sort]) state.sort = 'recent';
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Ventas', 'Cupones', 'Códigos validados en el servidor. Aplicar en el carrito no consume usos; el pedido reserva y la venta confirmada consume una sola vez. No cambian el precio público.', '<button id="new-coupon" class="btn btn--primary" type="button">+ Nuevo cupón</button>')
    + `<div data-kpis></div><section class="admin-panel sales-panel">
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar código, nombre o producto" aria-label="Buscar cupones"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar cupones">${Object.entries(COUPON_SORTS).map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar cupones" data-tabs></div>
      <p class="results-meta" data-meta aria-live="polite"></p>
      <div class="sales-list" data-list></div>
    </section>`;
  const labels = new Map(scopeOptions().map(option => [`${option.type}:${option.id}`, option.label]));
  let coupons = [];
  const syncUrl = () => {
    const query = new URLSearchParams({ section: 'coupons' });
    if (state.view !== 'all') query.set('view', state.view); if (state.sort !== 'recent') query.set('sort', state.sort); if (state.q) query.set('q', state.q);
    history.replaceState({}, '', `${location.pathname}?${query}`);
  };
  const render = () => {
    syncUrl();
    root.querySelector('[data-kpis]').innerHTML = couponsKpisMarkup(coupons);
    root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => { state.view = tile.dataset.kpiView; render(); root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    const term = normalizeText(state.q);
    const textMatch = coupon => !term || normalizeText(`${coupon.code} ${coupon.name} ${scopeSummary(coupon, labels).include}`).includes(term);
    const base = coupons.filter(textMatch);
    root.querySelector('[data-tabs]').innerHTML = Object.entries(COUPON_VIEWS).map(([key, view]) => `<button class="sales-tab ${state.view === key ? 'active' : ''}" data-view="${key}" type="button" aria-pressed="${state.view === key}"><span>${view.label}</span><b>${base.filter(view.match).length}</b></button>`).join('');
    const used = coupon => usesSummary(coupon).consumed + usesSummary(coupon).reserved;
    const visible = base.filter(COUPON_VIEWS[state.view].match).sort({
      recent: (a, b) => String(b.created_at).localeCompare(String(a.created_at)), used: (a, b) => used(b) - used(a),
      discount: (a, b) => grantedOf(b) - grantedOf(a), expiring: (a, b) => String(a.ends_at || '9999').localeCompare(String(b.ends_at || '9999'))
    }[state.sort]);
    root.querySelector('[data-meta]').innerHTML = `<span>${plural(visible.length, 'cupón', 'cupones')} · ${formatMoney(visible.reduce((sum, coupon) => sum + grantedOf(coupon), 0))} otorgados</span>${state.q || state.view !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { state.q = ''; state.view = 'all'; root.querySelector('[data-search]').value = ''; render(); });
    root.querySelector('[data-list]').innerHTML = (coupons.truncated ? '<p class="sale-action__warn">Lista incompleta: se alcanzó el tope de lectura.</p>' : '')
      + (visible.length ? visible.map((coupon, position) => couponCardMarkup(coupon, labels, position >= visible.length - 2 && visible.length > 3)).join('')
        : coupons.length ? emptyMarkup('Sin cupones en esta vista', 'Prueba con otra búsqueda o vista.') : emptyMarkup('Sin cupones todavía', 'Crea un código general o prepara una oferta personal desde el análisis de un cliente.'));
    root.querySelectorAll('[data-view]').forEach(tab => tab.addEventListener('click', () => { state.view = tab.dataset.view; render(); }));
    root.querySelectorAll('[data-coupon]').forEach(card => {
      const coupon = coupons.find(item => item.id === card.dataset.coupon);
      const closeMenu = () => card.querySelector('details[open]')?.removeAttribute('open');
      card.querySelector('[data-edit-coupon]')?.addEventListener('click', event => openCouponForm(coupon, refresh, event.currentTarget));
      card.querySelectorAll('[data-open-customer]').forEach(button => button.addEventListener('click', () => ctx.navigateTo('customer', { id: coupon.customer_id, tab: 'offers' })));
      card.querySelectorAll('[data-copy-coupon]').forEach(button => button.addEventListener('click', async () => {
        closeMenu();
        try { await navigator.clipboard.writeText(coupon.code); toast(`Código ${coupon.code} copiado`); } catch { toast(`Código: ${coupon.code}`); }
      }));
      card.querySelector('[data-toggle-coupon]').addEventListener('click', async event => {
        const button = event.currentTarget; closeMenu();
        if (coupon.active && !await confirmAction(`${coupon.code} dejará de aceptarse en el carrito. Los pedidos y ventas que ya lo usaron conservan su descuento e historial.`, 'Desactivar cupón', { confirmLabel: 'Desactivar', trigger: button })) return;
        setButtonLoading(button, true, 'Guardando…');
        try { await saveCoupon(coupon.id, { ...couponPayload(coupon), active: !coupon.active }); toast(coupon.active ? 'Cupón desactivado (su historial se conserva)' : 'Cupón activado'); await refresh(); }
        catch (error) { toast(requestError(error, 'No pudimos cambiar el cupón.'), 'error'); setButtonLoading(button, false); }
      });
    });
  };
  const refresh = async () => { coupons = await getCoupons(); render(); };
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); render(); }, 250));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('#new-coupon').addEventListener('click', event => openCouponForm(null, refresh, event.currentTarget));
  await refresh();
}

const couponPayload = coupon => ({
  code: coupon.code, name: coupon.name, kind: coupon.kind, value: coupon.value, max_discount: coupon.max_discount, min_eligible: coupon.min_eligible, stacking: coupon.stacking,
  starts_at: coupon.starts_at, ends_at: coupon.ends_at, max_uses_total: coupon.max_uses_total, max_uses_per_customer: coupon.max_uses_per_customer, audience: coupon.audience,
  customer_id: coupon.customer_id, reservation_hours: coupon.reservation_hours, release_on_cancel: coupon.release_on_cancel, release_on_full_return: coupon.release_on_full_return, active: coupon.active,
  scopes: (coupon.coupon_scopes || []).map(scope => ({ scope_type: scope.scope_type, target_id: scope.target_id, mode: scope.mode }))
});

// Elementos que un cupón puede incluir o excluir: categorías, marcas y productos, con el
// número de productos y la foto para elegirlos con un clic.
const SCOPE_TYPE = { category: 'Categoría', brand: 'Marca', product: 'Producto', variant: 'Opción' };
function scopeOptions() {
  const categories = ctx.getCategories?.() || []; const products = ctx.getProducts();
  const brands = [...new Map(products.filter(product => product.brands).map(product => [product.brands.id, product.brands])).values()];
  const perCategory = new Map(); const perBrand = new Map();
  products.forEach(product => {
    (product.product_categories || []).forEach(link => { const id = link.category_id || link.categories?.id; if (id) perCategory.set(id, (perCategory.get(id) || 0) + 1); });
    if (product.brands?.id) perBrand.set(product.brands.id, (perBrand.get(product.brands.id) || 0) + 1);
  });
  return [
    ...categories.map(item => ({ type: 'category', id: item.id, name: item.name, label: `Categoría · ${item.name}`, count: perCategory.get(item.id) || 0 })),
    ...brands.map(item => ({ type: 'brand', id: item.id, name: item.name, label: `Marca · ${item.name}`, count: perBrand.get(item.id) || 0 })),
    ...products.map(item => ({ type: 'product', id: item.id, name: item.name, label: `Producto · ${item.name}`, image: productImage(item), sub: item.brands?.name || '' }))
  ];
}

// Selector por clic: buscar, filtrar por tipo y marcar/desmarcar. Mantiene los alcances
// guardados que no estén en el catálogo actual (p. ej. una opción concreta de una oferta).
function scopePickerMarkup(key, title, help) {
  return `<div class="scope-picker" data-picker="${key}"><div class="scope-picker__head"><div><strong>${title}</strong><small>${help}</small></div><button class="link-btn" data-clear-picker type="button" hidden>Quitar todo</button></div>
    <div class="scope-picker__chips" data-chips></div>
    <div class="scope-picker__tools"><div class="admin-search-wrap"><input class="admin-search" type="search" data-picker-search placeholder="Buscar categoría, marca o producto" aria-label="Buscar en ${title}"></div><div class="segmented" role="group" aria-label="Tipo" data-picker-types></div></div>
    <ul class="scope-picker__list" role="listbox" aria-multiselectable="true" aria-label="${title}" data-picker-list></ul></div>`;
}

function mountScopePicker(root, options, sets, onChange) {
  const state = { include: { q: '', type: 'all' }, exclude: { q: '', type: 'all' } };
  const byKey = new Map(options.map(option => [`${option.type}:${option.id}`, option]));
  const visual = option => option.image ? `<img src="${escapeHtml(option.image)}" alt="" loading="lazy" decoding="async">` : `<span>${icon(option.type === 'category' ? 'layers' : option.type === 'brand' ? 'tag' : 'package', { size: 16 })}</span>`;
  const detail = option => option.type === 'product' ? [SCOPE_TYPE.product, option.sub].filter(Boolean).join(' · ') : option.type === 'variant' ? 'Opción específica de un producto' : `${SCOPE_TYPE[option.type]} · ${plural(option.count || 0, 'producto')}`;
  const draw = key => {
    const picker = root.querySelector(`[data-picker="${key}"]`); const set = sets[key]; const other = sets[key === 'include' ? 'exclude' : 'include']; const view = state[key];
    picker.querySelector('[data-chips]').innerHTML = set.size ? [...set].map(id => { const option = byKey.get(id); return `<button class="scope-chip scope-chip--${key}" data-remove="${escapeHtml(id)}" type="button" title="Quitar">${escapeHtml(option?.name || 'Elemento eliminado')}${icon('x', { size: 12 })}</button>`; }).join('')
      : `<p class="scope-picker__empty">${key === 'include' ? `${icon('checkCircle', { size: 15 })}Sin selección: el cupón aplica a <b>todo el catálogo</b>.` : 'Nada excluido.'}</p>`;
    picker.querySelector('[data-clear-picker]').hidden = !set.size;
    const counts = { all: options.length, category: 0, brand: 0, product: 0 }; options.forEach(option => { if (counts[option.type] != null) counts[option.type] += 1; });
    picker.querySelector('[data-picker-types]').innerHTML = [['all', 'Todo'], ['category', 'Categorías'], ['brand', 'Marcas'], ['product', 'Productos']].filter(([type]) => type === 'all' || counts[type]).map(([type, label]) => `<button class="${view.type === type ? 'active' : ''}" data-type="${type}" type="button" aria-pressed="${view.type === type}">${label}</button>`).join('');
    const term = normalizeText(view.q);
    const matches = options.filter(option => (view.type === 'all' || option.type === view.type) && (!term || normalizeText(`${option.name} ${option.sub || ''}`).includes(term)));
    const shown = matches.slice(0, 80);
    picker.querySelector('[data-picker-list]').innerHTML = shown.length ? shown.map(option => {
      const id = `${option.type}:${option.id}`; const on = set.has(id); const blocked = other.has(id);
      return `<li><button class="scope-option ${on ? 'is-on' : ''}" data-toggle="${escapeHtml(id)}" type="button" role="option" aria-selected="${on}" ${blocked ? `title="Ya está en ${key === 'include' ? 'excluidos' : 'aplica a'}; al elegirlo aquí se mueve"` : ''}><span class="scope-option__check" aria-hidden="true">${icon('check', { size: 13 })}</span><span class="scope-option__visual">${visual(option)}</span><span class="scope-option__text"><strong>${escapeHtml(option.name)}</strong><small>${escapeHtml(detail(option))}${blocked ? ` · ${key === 'include' ? 'excluido' : 'incluido'}` : ''}</small></span></button></li>`;
    }).join('') + (matches.length > shown.length ? `<li class="scope-picker__more">Mostrando ${shown.length} de ${matches.length}: escribe para afinar la búsqueda.</li>` : '')
      : '<li class="scope-picker__more">Sin resultados para esta búsqueda.</li>';
  };
  const drawAll = () => { draw('include'); draw('exclude'); onChange(); };
  ['include', 'exclude'].forEach(key => {
    const picker = root.querySelector(`[data-picker="${key}"]`); const other = key === 'include' ? 'exclude' : 'include';
    picker.querySelector('[data-picker-search]').addEventListener('input', debounce(event => { state[key].q = event.target.value.trim(); draw(key); }, 150));
    picker.addEventListener('click', event => {
      const toggle = event.target.closest('[data-toggle]'); const remove = event.target.closest('[data-remove]'); const type = event.target.closest('[data-type]');
      if (toggle) { const id = toggle.dataset.toggle; if (sets[key].has(id)) sets[key].delete(id); else { sets[key].add(id); sets[other].delete(id); } drawAll(); }
      else if (remove) { sets[key].delete(remove.dataset.remove); drawAll(); }
      else if (type) { state[key].type = type.dataset.type; draw(key); }
      else if (event.target.closest('[data-clear-picker]')) { sets[key].clear(); drawAll(); }
    });
  });
  drawAll();
}

function openCouponForm(coupon, refresh, trigger) {
  const options = scopeOptions();
  const sets = { include: new Set(), exclude: new Set() };
  (coupon?.coupon_scopes || []).forEach(scope => {
    const id = `${scope.scope_type}:${scope.target_id}`;
    if (!options.some(option => `${option.type}:${option.id}` === id)) options.push({ type: scope.scope_type, id: scope.target_id, name: scope.scope_type === 'variant' ? 'Opción específica de un producto' : 'Elemento eliminado', label: id });
    sets[scope.mode === 'excluir' ? 'exclude' : 'include'].add(id);
  });
  const tile = (name, value, title, detail, iconName, checked) => `<label class="choice-tile"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span class="choice-tile__icon">${icon(iconName, { size: 18 })}</span><strong>${title}</strong><small>${detail}</small></label>`;
  const section = (number, title, help, body) => `<section class="coupon-step"><header class="coupon-step__head"><span class="coupon-step__num">${number}</span><div><h3>${title}</h3><p>${help}</p></div></header><div class="coupon-step__body">${body}</div></section>`;
  const field = (label, input, hint = '') => `<label class="sale-action__field"><span class="sale-action__label">${label}${hint ? ` <small>${hint}</small>` : ''}</span>${input}</label>`;
  const today = new Date();
  const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59);
  const quickEnd = days => toLocal(new Date(Date.now() + days * 86400000).toISOString());
  const kind = coupon?.kind || 'porcentaje';
  const form = document.createElement('form');
  form.className = 'coupon-form'; form.noValidate = true;
  form.innerHTML = `<div class="coupon-preview" aria-live="polite"><div class="coupon-preview__stub"><strong data-preview-value></strong><small data-preview-kind></small></div><div class="coupon-preview__body"><div class="coupon-preview__top"><span class="coupon-code" data-preview-code></span><span class="status-pill" data-preview-state></span></div><strong data-preview-name></strong><small data-preview-rules></small><p class="coupon-preview__example" data-preview-example></p></div></div>
    ${section(1, 'Código y beneficio', 'Lo que el cliente escribe en el carrito y cuánto descuenta.', `
      <div class="coupon-grid">${field('Código', `<div class="input-action"><input name="code" maxlength="24" value="${escapeHtml(coupon?.code || '')}" ${coupon ? 'readonly' : ''} placeholder="Automático si lo dejas vacío" autocapitalize="characters" spellcheck="false">${coupon ? '' : `<button class="small-btn" data-generate type="button">${icon('sparkles', { size: 15 })}<span>Generar</span></button>`}</div>`, coupon ? 'No se puede cambiar' : '4 a 24 letras, números o guiones')}
      ${field('Nombre interno', `<input name="name" required maxlength="120" value="${escapeHtml(coupon?.name || '')}" placeholder="Ej. Bienvenida clientes nuevos">`, 'Solo lo ves tú')}</div>
      <fieldset class="choice-tiles"><legend>Tipo de descuento</legend>${tile('kind', 'porcentaje', 'Porcentaje', 'Ej. 10 % sobre los productos elegibles', 'percent', kind === 'porcentaje')}${tile('kind', 'valor_fijo', 'Valor fijo', 'Ej. $ 50.000 menos en la compra', 'wallet', kind === 'valor_fijo')}</fieldset>
      ${field('Valor del descuento', `<div class="input-affix"><span data-affix-before>$</span><input name="value" type="number" min="1" step="1" required value="${escapeHtml(coupon?.value ?? '')}" placeholder="10" inputmode="numeric"><span data-affix-after>%</span></div>`)}`)}
    ${section(2, 'Condiciones', 'Topes y mínimos que protegen tu margen.', `
      <div class="coupon-grid">${field('Tope de descuento', `<div class="input-affix"><span>$</span><input name="max_discount" type="number" min="1" step="1" value="${escapeHtml(coupon?.max_discount ?? '')}" placeholder="Sin tope" inputmode="numeric"></div>`, 'Opcional')}
      ${field('Compra mínima elegible', `<div class="input-affix"><span>$</span><input name="min_eligible" type="number" min="0" step="1" value="${escapeHtml(coupon?.min_eligible ?? 0)}" inputmode="numeric"></div>`)}</div>
      <fieldset class="choice-tiles"><legend>¿Quién puede usarlo?</legend>${tile('audience', 'publico', AUDIENCE.publico, 'Cualquier cliente que tenga el código', 'store', (coupon?.audience || 'publico') === 'publico')}${tile('audience', 'portador', AUDIENCE.portador, 'Quien reciba el código, para compartir en campañas', 'link', coupon?.audience === 'portador')}</fieldset>
      <fieldset class="choice-tiles"><legend>¿Se suma a promociones?</legend>${tile('stacking', 'sobre_precio_vigente', 'Sí, acumula', 'Descuenta sobre el precio vigente, con promoción y tramo', 'layers', (coupon?.stacking || 'sobre_precio_vigente') === 'sobre_precio_vigente')}${tile('stacking', 'solo_precio_regular', 'No acumula', 'Solo productos sin promoción ni precio por volumen', 'shield', coupon?.stacking === 'solo_precio_regular')}</fieldset>`)}
    ${section(3, 'Vigencia y límites', 'Cuándo se puede usar y cuántas veces.', `
      <div class="reason-chips" role="group" aria-label="Vencimiento rápido">${[['', 'Sin vencimiento'], [quickEnd(7), '7 días'], [quickEnd(15), '15 días'], [quickEnd(30), '30 días'], [toLocal(endOfMonth.toISOString()), 'Fin de mes']].map(([value, label]) => `<button class="reason-chip" type="button" data-end="${value}">${label}</button>`).join('')}</div>
      <div class="coupon-grid">${field('Inicio', `<input name="starts_at" type="datetime-local" value="${toLocal(coupon?.starts_at)}">`, 'Opcional · vacío = desde ya')}
      ${field('Vencimiento', `<input name="ends_at" type="datetime-local" value="${toLocal(coupon?.ends_at)}">`, 'Opcional')}
      ${field('Usos totales', `<input name="max_uses_total" type="number" min="1" step="1" value="${escapeHtml(coupon?.max_uses_total ?? '')}" placeholder="Sin límite" inputmode="numeric">`)}
      ${field('Usos por cliente', `<input name="max_uses_per_customer" type="number" min="1" step="1" value="${escapeHtml(coupon?.max_uses_per_customer ?? 1)}" inputmode="numeric">`, 'Por teléfono del pedido')}</div>`)}
    ${section(4, 'Alcance', 'Haz clic para elegir y clic de nuevo para quitar. El envío nunca tiene descuento.', `${scopePickerMarkup('include', 'Aplica solo a', 'Vacío = todo el catálogo')}<details class="scope-exclude" ${sets.exclude.size ? 'open' : ''}><summary>${icon('x', { size: 14 })}Excluir productos, marcas o categorías <small data-exclude-count></small>${icon('chevronDown', { size: 14 })}</summary>${scopePickerMarkup('exclude', 'Excluir', 'Nunca reciben el descuento')}</details>`)}
    ${section(5, 'Reservas y políticas', 'Cómo se comporta el uso cuando el pedido o la venta cambian.', `
      ${field('Reserva del uso al crear pedido', `<div class="input-affix"><input name="reservation_hours" type="number" min="1" max="720" value="${escapeHtml(coupon?.reservation_hours ?? 72)}" inputmode="numeric"><span>horas</span></div>`, 'Mientras tanto el uso queda apartado')}
      <div class="switch-list">
        <label class="switch-row"><span><strong>Liberar si se cancela</strong><small>El uso vuelve a estar disponible si se cancela la venta o el pedido</small></span><input class="switch" name="release_on_cancel" type="checkbox" ${coupon?.release_on_cancel === false ? '' : 'checked'}></label>
        <label class="switch-row"><span><strong>Liberar si se devuelve todo</strong><small>El uso vuelve si el cliente devuelve la compra completa</small></span><input class="switch" name="release_on_full_return" type="checkbox" ${coupon?.release_on_full_return ? 'checked' : ''}></label>
        <label class="switch-row switch-row--main"><span><strong>Cupón activo</strong><small>Desactivado, el carrito no lo acepta; su historial se conserva</small></span><input class="switch" name="active" type="checkbox" ${coupon?.active === false ? '' : 'checked'}></label>
      </div>`)}
    <p class="sale-action__error" data-error role="alert" hidden></p><div class="coupon-form__actions"><button class="btn btn--ghost" data-cancel type="button">Cancelar</button><button class="btn btn--primary" type="submit">${icon('check', { size: 18 })}<span>${coupon ? 'Guardar cambios' : 'Crear cupón'}</span></button></div>`;
  const modal = openModal({ title: coupon ? `Editar ${coupon.code}` : 'Nuevo cupón', content: form, trigger, className: 'modal--wide modal--coupon', closeOnBackdrop: false, headerIcon: `<span class="sale-action__badge">${icon('percent', { size: 20 })}</span>` });
  const preview = () => {
    const data = new FormData(form); const isPercent = data.get('kind') === 'porcentaje'; const value = Number(data.get('value')) || 0;
    const cap = Number(data.get('max_discount')) || 0; const minimum = Number(data.get('min_eligible')) || 0;
    form.querySelector('[data-affix-before]').hidden = isPercent; form.querySelector('[data-affix-after]').hidden = !isPercent;
    form.querySelector('[data-preview-value]').textContent = isPercent ? `${value}%` : formatMoney(value);
    form.querySelector('[data-preview-kind]').textContent = isPercent ? 'de descuento' : 'menos';
    form.querySelector('[data-preview-code]').textContent = String(data.get('code') || '').toUpperCase() || 'CÓDIGO AUTOMÁTICO';
    form.querySelector('[data-preview-name]').textContent = String(data.get('name') || '').trim() || 'Nombre del cupón';
    const state = form.querySelector('[data-preview-state]'); const active = data.has('active');
    state.textContent = active ? 'Activo' : 'Inactivo'; state.className = `status-pill status-pill--${active ? 'success' : 'muted'}`;
    const ends = data.get('ends_at');
    form.querySelector('[data-preview-rules]').textContent = [cap && `tope ${formatMoney(cap)}`, minimum && `mínimo ${formatMoney(minimum)}`, ends ? `vence ${dateTimeText(fromLocal(ends))}` : 'sin vencimiento', data.get('max_uses_total') ? plural(Number(data.get('max_uses_total')), 'uso') : 'usos sin límite', sets.include.size ? `aplica a ${plural(sets.include.size, 'elemento')}` : 'todo el catálogo', sets.exclude.size && `${sets.exclude.size} excluido${sets.exclude.size === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    // Ejemplo con una compra elegible de referencia (el servidor hace el cálculo real).
    const sample = Math.max(minimum, 500000);
    const discount = value > 0 ? Math.min(isPercent ? Math.round((sample * Math.min(value, 100)) / 100) : value, cap || Infinity, sample) : 0;
    form.querySelector('[data-preview-example]').innerHTML = discount ? `${icon('info', { size: 13 })}Ejemplo: en una compra elegible de <b>${formatMoney(sample)}</b> descuenta <b>${formatMoney(discount)}</b> y el cliente paga <b>${formatMoney(sample - discount)}</b>.` : `${icon('info', { size: 13 })}Escribe el valor del descuento para ver un ejemplo.`;
    form.querySelector('[data-exclude-count]').textContent = sets.exclude.size ? `(${sets.exclude.size})` : '';
  };
  mountScopePicker(form, options, sets, () => { if (form.isConnected) preview(); });
  form.addEventListener('input', preview); form.addEventListener('change', preview); preview();
  form.querySelector('[data-generate]')?.addEventListener('click', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const random = crypto.getRandomValues(new Uint32Array(6));
    form.elements.code.value = `CUP-${[...random].map(n => alphabet[n % alphabet.length]).join('')}`; preview();
  });
  form.querySelectorAll('[data-end]').forEach(chip => chip.addEventListener('click', () => {
    form.querySelectorAll('[data-end]').forEach(other => other.classList.toggle('is-active', other === chip));
    form.elements.ends_at.value = chip.dataset.end; preview();
  }));
  form.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form); const error = form.querySelector('[data-error]');
    const kind = data.get('kind'); const value = Number(data.get('value'));
    const problem = !String(data.get('name')).trim() ? 'Escribe un nombre interno.' : !(value > 0) || (kind === 'porcentaje' && value > 100) ? 'El valor debe ser mayor que 0 (y máximo 100 en porcentaje).' : data.get('code') && !/^[A-Za-z0-9-]{4,24}$/.test(data.get('code')) ? 'El código usa 4 a 24 letras, números o guiones.' : data.get('starts_at') && data.get('ends_at') && data.get('ends_at') <= data.get('starts_at') ? 'El vencimiento debe ser posterior al inicio.' : '';
    if (problem) { error.textContent = problem; error.hidden = false; error.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
    const scopes = [...[...sets.include].map(id => ['incluir', id]), ...[...sets.exclude].map(id => ['excluir', id])]
      .map(([mode, id]) => { const [scope_type, target_id] = id.split(':'); return { scope_type, target_id, mode }; });
    const button = form.querySelector('[type="submit"]'); setButtonLoading(button, true, 'Guardando…');
    try {
      const saved = await saveCoupon(coupon?.id || null, { code: String(data.get('code') || '').toUpperCase(), name: data.get('name'), kind, value, max_discount: data.get('max_discount') || null, min_eligible: data.get('min_eligible') || 0, starts_at: fromLocal(data.get('starts_at')), ends_at: fromLocal(data.get('ends_at')), max_uses_total: data.get('max_uses_total') || null, max_uses_per_customer: data.get('max_uses_per_customer') || null, audience: data.get('audience'), stacking: data.get('stacking'), reservation_hours: data.get('reservation_hours'), release_on_cancel: data.has('release_on_cancel'), release_on_full_return: data.has('release_on_full_return'), active: data.has('active'), scopes, customer_id: coupon?.customer_id || null });
      toast(`Cupón ${saved.code} guardado`); modal.close(true); await refresh();
    } catch (saveError) { error.textContent = requestError(saveError, 'No pudimos guardar el cupón.'); error.hidden = false; error.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); setButtonLoading(button, false); }
  });
}

// --- Costos privados (solo propietario) ---------------------------------------------
// Sirven para ver el margen al preparar ofertas. Nunca se publican: tabla aparte con RLS.
export async function renderCosts() {
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Catálogo', 'Costos', 'Costo unitario de cada producto, visible solo para el propietario. Se usa para mostrar el margen al preparar ofertas; sin costo, el margen aparece como "no disponible".')
    + '<section class="admin-panel"><div class="admin-toolbar"><div class="admin-search-wrap"><input class="admin-search" type="search" data-cost-search placeholder="Buscar producto" aria-label="Buscar producto"></div><p class="results-meta" data-meta aria-live="polite"></p></div><div class="crm-list" data-list></div></section>';
  let costs = new Map();
  try { costs = new Map((await getProductCosts()).map(row => [row.product_id, Number(row.unit_cost)])); }
  catch (error) { root.querySelector('[data-list]').innerHTML = emptyMarkup('No disponible', requestError(error, 'Solo el propietario puede ver los costos.')); return; }
  const products = ctx.getProducts().slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const render = () => {
    const term = (root.querySelector('[data-cost-search]').value || '').toLowerCase();
    const visible = products.filter(product => !term || product.name.toLowerCase().includes(term));
    root.querySelector('[data-meta]').textContent = `${visible.length} producto(s) · ${costs.size} con costo registrado`;
    root.querySelector('[data-list]').innerHTML = visible.slice(0, 200).map(product => {
      const cost = costs.get(product.id); const price = Number(product.promo_price ?? product.base_price);
      return `<form class="crm-card" data-cost="${product.id}"><div><strong>${escapeHtml(product.name)}</strong><span>Precio de venta ${formatMoney(price)}${cost != null ? ` · margen bruto ${price ? Math.round(((price - cost) / price) * 100) : 0} % por unidad` : ''}</span></div><div class="admin-row-actions"><label><span class="sr-only">Costo de ${escapeHtml(product.name)}</span><input name="cost" type="number" min="0" step="1" inputmode="numeric" placeholder="Costo" value="${cost ?? ''}"></label><button class="small-btn small-btn--primary" type="submit">Guardar</button></div></form>`;
    }).join('') || emptyMarkup('Sin productos', 'Crea productos para registrar sus costos.');
    root.querySelectorAll('[data-cost]').forEach(form => form.addEventListener('submit', async event => {
      event.preventDefault();
      const raw = form.elements.cost.value.trim(); const value = raw === '' ? null : Number(raw);
      if (value != null && !(value >= 0)) { toast('Escribe un costo válido.', 'error'); return; }
      const button = event.submitter; setButtonLoading(button, true, 'Guardando…');
      try { await saveProductCost(form.dataset.cost, value); if (value == null) costs.delete(form.dataset.cost); else costs.set(form.dataset.cost, value); toast('Costo guardado'); render(); }
      catch (error) { toast(requestError(error, 'No pudimos guardar el costo.'), 'error'); setButtonLoading(button, false); }
    }));
  };
  root.querySelector('[data-cost-search]').addEventListener('input', render);
  render();
}

// --- Relaciones de productos -------------------------------------------------------------
// Sugerencias que el comerciante puede revisar y crear (no se aplican solas). Sirven de
// punto de partida para tiendas de tecnología y hogar; cada tienda define las suyas.
const PRESETS = [
  ['celulares', 'audio', 'complemento', 0.9], ['celulares', 'smartwatches', 'complemento', 0.7], ['computadores', 'audio', 'complemento', 0.6], ['televisores', 'audio', 'complemento', 0.7],
  ['estufas-hornos', 'menaje', 'complemento', 0.8], ['neveras', 'lavadoras', 'complemento', 0.5], ['pequenos-electrodomesticos', 'menaje', 'complemento', 0.6], ['menaje', 'pequenos-electrodomesticos', 'complemento', 0.5]
];

export async function renderRelationships() {
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Catálogo', 'Relaciones de productos', 'Reglas que usa el recomendador: complementos, alternativas, compatibilidad explícita entre modelos, reposición y exclusiones. Sin reglas no se presume compatibilidad.', '<button id="new-relationship" class="btn btn--primary" type="button">+ Nueva regla</button>')
    + '<section class="admin-panel" data-suggestions></section><section class="admin-panel"><div class="crm-list" data-list></div></section>';
  const categories = ctx.getCategories?.() || []; const products = ctx.getProducts();
  const name = (type, id) => (type === 'category' ? `Categoría ${categories.find(item => item.id === id)?.name || '(eliminada)'}` : products.find(item => item.id === id)?.name || 'Producto eliminado');
  const refresh = async () => {
    const rules = await getProductRelationships({ refresh: true });
    root.querySelector('[data-list]').innerHTML = rules.length ? rules.map(rule => `<article class="crm-card" data-rule="${rule.id}"><div><strong>${escapeHtml(name(rule.source_type, rule.source_id))} → ${escapeHtml(name(rule.target_type, rule.target_id))}</strong><span>${escapeHtml(RELATION_KINDS[rule.kind])} · fuerza ${Number(rule.strength).toFixed(2)}${rule.reposition_days ? ` · cada ${rule.reposition_days} días` : ''}${rule.active ? '' : ' · inactiva'}</span>${rule.note ? `<small>${escapeHtml(rule.note)}</small>` : ''}</div><div class="admin-row-actions"><button class="small-btn" data-edit-rule type="button">Editar</button><button class="small-btn small-btn--danger" data-delete-rule type="button">Eliminar</button></div></article>`).join('')
      : emptyMarkup('Sin reglas todavía', 'Agrega reglas para que las recomendaciones de la tienda y del CRM sugieran complementos y reposiciones.');
    root.querySelectorAll('[data-rule]').forEach(card => {
      const rule = rules.find(item => item.id === card.dataset.rule);
      card.querySelector('[data-edit-rule]').addEventListener('click', event => openRuleForm(rule, refresh, event.currentTarget));
      card.querySelector('[data-delete-rule]').addEventListener('click', async event => {
        if (!await confirmAction('La regla dejará de usarse en las recomendaciones.', 'Eliminar regla', { confirmLabel: 'Eliminar', trigger: event.currentTarget })) return;
        try { await deleteProductRelationship(rule.id); toast('Regla eliminada'); await refresh(); } catch (error) { toast(requestError(error, 'No pudimos eliminar la regla.'), 'error'); }
      });
    });
    renderSuggestions(rules);
  };
  const renderSuggestions = rules => {
    const bySlug = new Map(categories.map(item => [item.slug, item]));
    const existing = new Set(rules.map(rule => `${rule.source_id}:${rule.target_id}:${rule.kind}`));
    const suggestions = PRESETS.map(([from, to, kind, strength]) => ({ from: bySlug.get(from), to: bySlug.get(to), kind, strength })).filter(item => item.from && item.to && !existing.has(`${item.from.id}:${item.to.id}:${item.kind}`));
    const panel = root.querySelector('[data-suggestions]');
    panel.hidden = !suggestions.length;
    panel.innerHTML = suggestions.length ? `<div class="admin-panel__head"><h2>Sugerencias para revisar</h2></div><p class="form-help">Basadas en los nombres de tus categorías. Indican complementos habituales, no compatibilidad técnica. Créalas solo si aplican a tu tienda.</p><ul class="history-list">${suggestions.map((item, index) => `<li><span>${escapeHtml(item.from.name)} → ${escapeHtml(item.to.name)} · ${RELATION_KINDS[item.kind]}</span><button class="small-btn" data-suggestion="${index}" type="button">Crear</button></li>`).join('')}</ul>` : '';
    panel.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', async () => {
      const item = suggestions[Number(button.dataset.suggestion)];
      try { await saveProductRelationship({ source_type: 'category', source_id: item.from.id, target_type: 'category', target_id: item.to.id, kind: item.kind, strength: item.strength }); toast('Regla creada'); await refresh(); }
      catch (error) { toast(requestError(error, 'No pudimos crear la regla.'), 'error'); }
    }));
  };
  const openRuleForm = (rule, after, trigger) => {
    const entityOptions = (type, selected) => (type === 'category' ? categories.map(item => [item.id, item.name]) : products.map(item => [item.id, item.name])).map(([id, label]) => `<option value="${id}" ${id === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
    const form = document.createElement('form');
    form.className = 'admin-form';
    const draw = () => {
      const values = Object.fromEntries(new FormData(form));
      const sourceType = values.source_type || rule?.source_type || 'category'; const targetType = values.target_type || rule?.target_type || 'category'; const kind = values.kind || rule?.kind || 'complemento';
      const forcedProduct = kind === 'compatible_con';
      form.innerHTML = `<div class="form-grid"><label>Tipo de regla<select name="kind">${Object.entries(RELATION_KINDS).map(([value, label]) => `<option value="${value}" ${kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Fuerza (0,1 a 1)<input name="strength" type="number" min="0.1" max="1" step="0.05" value="${escapeHtml(values.strength || rule?.strength || 0.7)}"></label>
        <label>Origen<select name="source_type" ${forcedProduct ? 'disabled' : ''}><option value="category" ${!forcedProduct && sourceType === 'category' ? 'selected' : ''}>Categoría</option><option value="product" ${forcedProduct || sourceType === 'product' ? 'selected' : ''}>Producto / modelo</option></select></label>
        <label>Elemento de origen<select name="source_id">${entityOptions(forcedProduct ? 'product' : sourceType, values.source_id || rule?.source_id)}</select></label>
        <label>Destino<select name="target_type" ${forcedProduct ? 'disabled' : ''}><option value="category" ${!forcedProduct && targetType === 'category' ? 'selected' : ''}>Categoría</option><option value="product" ${forcedProduct || targetType === 'product' ? 'selected' : ''}>Producto / modelo</option></select></label>
        <label>Elemento de destino<select name="target_id">${entityOptions(forcedProduct ? 'product' : targetType, values.target_id || rule?.target_id)}</select></label>
        ${kind === 'reposicion' ? `<label>Reposición cada (días)<input name="reposition_days" type="number" min="1" max="3650" required value="${escapeHtml(values.reposition_days || rule?.reposition_days || 30)}"></label>` : ''}
        <label class="form-grid__full">Nota <small>${forcedProduct ? 'Indica la evidencia de compatibilidad (ficha técnica, modelo)' : 'Opcional'}</small><input name="note" maxlength="200" value="${escapeHtml(values.note || rule?.note || '')}" ${forcedProduct ? 'required' : ''}></label>
        <label class="check-field form-grid__full"><input name="active" type="checkbox" ${rule?.active === false ? '' : 'checked'}> Activa</label></div>
        ${forcedProduct ? '<p class="form-help">La compatibilidad solo se registra entre productos o modelos concretos, nunca por categoría o marca.</p>' : ''}
        <p class="product-form-error" data-error role="alert" hidden></p><div class="form-actions"><button class="btn btn--primary" type="submit">Guardar regla</button></div>`;
    };
    draw();
    form.addEventListener('change', event => { if (['kind', 'source_type', 'target_type'].includes(event.target.name)) draw(); });
    const modal = openModal({ title: rule ? 'Editar regla' : 'Nueva regla', content: form, trigger, className: 'modal--wide' });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form)); const forcedProduct = data.kind === 'compatible_con';
      const values = { kind: data.kind, strength: Number(data.strength), source_type: forcedProduct ? 'product' : data.source_type, source_id: data.source_id, target_type: forcedProduct ? 'product' : data.target_type, target_id: data.target_id, reposition_days: data.kind === 'reposicion' ? Number(data.reposition_days) : null, note: data.note || null, active: form.elements.active.checked };
      const error = form.querySelector('[data-error]');
      if (values.source_type === values.target_type && values.source_id === values.target_id && values.kind !== 'reposicion') { error.textContent = 'El origen y el destino deben ser distintos (salvo reposición del mismo producto).'; error.hidden = false; return; }
      const button = event.submitter; setButtonLoading(button, true, 'Guardando…');
      try { await saveProductRelationship(values, rule?.id || null); toast('Regla guardada'); modal.close(true); await after(); }
      catch (saveError) { error.textContent = requestError(saveError, 'No pudimos guardar la regla.'); error.hidden = false; setButtonLoading(button, false); }
    });
  };
  $('#new-relationship').addEventListener('click', event => openRuleForm(null, refresh, event.currentTarget));
  await refresh();
}

