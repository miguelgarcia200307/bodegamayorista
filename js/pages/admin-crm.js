// Panel comercial: Resumen, Clientes (CRM y cumpleaños), Pedidos, Cotizaciones y
// Ventas/Comprobantes. Los importes, estados e inventario se modifican solo mediante
// funciones transaccionales de la base de datos; aquí solo se presentan y se solicitan.
import {
  cancelSale, confirmSale, convertQuoteToSale, createAdminOrder, deleteAdminQuote, createManualSale, createSaleFromOrder, getCustomerHistory,
  getCustomer, getCustomers, getDeliveryMethods, getOpenTasks, getOrders, getPaymentMethods, getQuotes, getSales, getSettings, mergeCustomers,
  recordConsent, registerSaleReturn, saveAdminQuote, saveBirthdayContact, saveCustomer, setQuoteStatus, setSaleStatus, updateOrder, updateSaleNotes
} from '../lib/api.js';
import { confirmAction, openModal } from '../components/modal.js';
import { withLoading } from '../components/loading-dialog.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { barList, bindChartTooltips, columnChart, rangeMeter } from '../components/mini-charts.js';
import { diagnoseCustomer } from '../lib/customer-diagnosis.js';
import { $, $$, currentPrice, debounce, escapeHtml, formatMoney, normalizeText, setButtonLoading } from '../lib/helpers.js';
import { tierFor } from '../lib/pricing.js';
import { downloadCommercialDocument, printCommercialDocument } from '../lib/documents.js';
import { birthdayInfo, bogotaTodayIso, isValidBirthDate } from '../lib/crm-dates.js';
import { DOC_ITEMS, DOC_NUMBER, analyzeCustomer, catalogIndex, daysBetween, describeLine, groupByProduct, returnedBySaleItem, saleDate } from '../lib/customer-insights.js';
import { bogotaDate, isPurchase, purchaseDate, saleEconomics } from '../lib/metrics.js';

const PAGE_SIZE = 20;
const CONFIRMED_SALE = ['confirmada', 'pagada', 'entregada'];
const OPEN_QUOTE = ['borrador', 'enviada', 'aceptada'];
const ORDER_STATUS = { pendiente: 'Pendiente', contactado: 'Contactado', confirmado: 'Confirmado', cancelado: 'Cancelado', abandonado: 'Abandonado' };
const QUOTE_STATUS = { borrador: 'Borrador', enviada: 'Enviada', aceptada: 'Aceptada', rechazada: 'Rechazada', vencida: 'Vencida', convertida: 'Convertida' };
const SALE_STATUS = { solicitud: 'Solicitud', confirmada: 'Confirmada', pagada: 'Pagada', entregada: 'Entregada', cancelada: 'Cancelada', devuelta: 'Devuelta' };
const CONTACT_STATUS = { pendiente: 'Pendiente', contactado: 'Contactado', obsequio_ofrecido: 'Obsequio ofrecido', completado: 'Completado', no_contactar: 'No contactar' };
const SOURCES = { tienda: 'Tienda web', WhatsApp: 'WhatsApp', presencial: 'Presencial', manual: 'Manual', pedido: 'Pedido web', cotizacion: 'Cotización' };
const TONES = { pendiente: 'warning', solicitud: 'warning', borrador: 'muted', enviada: 'info', aceptada: 'success', confirmado: 'success', confirmada: 'success', pagada: 'success', entregada: 'success', convertida: 'success', cancelado: 'danger', cancelada: 'danger', rechazada: 'danger', abandonado: 'muted', vencida: 'muted', devuelta: 'danger', contactado: 'info' };

let ctx = null;
let settingsCache = null;

export function configureCrm(context) { ctx = context; }

// --- Utilidades --------------------------------------------------------------
const pill = (status, labels) => `<span class="status-pill status-pill--${TONES[status] || 'muted'}">${escapeHtml(labels[status] || status)}</span>`;
const waDigits = customer => String(customer?.phone_normalized || '').replace(/\D/g, '');
const waLink = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
const dateText = value => value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const dateTimeText = value => value ? new Date(value).toLocaleString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const optionText = snapshot => Object.entries(snapshot || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ');
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
const isQuoteExpired = quote => OPEN_QUOTE.includes(quote.status) && quote.valid_until && quote.valid_until < bogotaTodayIso();
const emptyMarkup = (title, text) => `<div class="empty-state empty-state--admin"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
const requestError = (error, fallback) => {
  console.error(error);
  if (error?.code === '23505') return 'Ya existe un registro con ese dato (por ejemplo, el mismo teléfono).';
  if (error?.code === '42501') return 'Tu sesión no tiene permiso para esta acción.';
  return error?.message && !/fetch|network|jwt/i.test(error.message) ? error.message : fallback;
};
const editableMoney = value => new Intl.NumberFormat('es-CO', { minimumFractionDigits: Number(value) % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(Number(value) || 0);
const moneyCents = value => Math.round((Number(value) || 0) * 100);
const fromCents = value => Math.round(value) / 100;
function parseMoneyInput(value) {
  let clean = String(value ?? '').trim().replace(/[$\s]/g, '');
  if (!clean) return 0;
  if (!/^[\d.,]+$/.test(clean)) return null;
  const comma = clean.lastIndexOf(','); const dot = clean.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.'; const thousands = decimal === ',' ? /\./g : /,/g;
    clean = clean.replace(thousands, '').replace(decimal, '.');
  } else if (comma >= 0) {
    const decimals = clean.length - comma - 1;
    clean = decimals > 0 && decimals <= 2 ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
  } else if (dot >= 0) {
    const pieces = clean.split('.'); const last = pieces.at(-1).length;
    clean = pieces.length > 2 || (last === 3 && pieces[0].length <= 3) ? pieces.join('') : clean.replace(/,/g, '');
  }
  const amount = Number(clean);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}
function addIsoDays(iso, days) { const date = new Date(`${iso}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function configuredValidityDays(terms) {
  const match = String(terms || '').match(/v[aá]lida?\s+por\s+(\d{1,3})\s+d[ií]as?/i);
  return match ? Math.max(1, Math.min(365, Number(match[1]))) : null;
}

async function settings() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}
// Nombre comercial configurado (los mensajes no llevan marcas fijas en el código).
export const businessName = () => String(settingsCache?.business_name || '').trim() || 'nuestra tienda';
export function invalidateCrmSettings() { settingsCache = null; }

function syncUrl(section, state) {
  const query = new URLSearchParams({ section });
  Object.entries(state).forEach(([key, value]) => { if (value && value !== 'all' && !(key === 'page' && value === 1)) query.set(key, value); });
  history.replaceState({}, '', `${location.pathname}?${query}`);
}

function paginate(items, state) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(Math.max(1, Number(state.page) || 1), pages);
  return { pageItems: items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE), pages };
}
function paginationMarkup(page, pages) {
  if (pages <= 1) return '';
  return `<nav class="pagination" aria-label="Paginación"><button data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} type="button">← Anterior</button><span>Página ${page} de ${pages}</span><button data-page="${page + 1}" ${page === pages ? 'disabled' : ''} type="button">Siguiente →</button></nav>`;
}
function bindPagination(root, state, render) {
  root.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { state.page = Number(button.dataset.page); render(); root.scrollIntoView({ block: 'start' }); }));
}
function chips(options, active, name = 'status') {
  return `<div class="admin-chips" role="group" aria-label="Filtrar">${Object.entries(options).map(([value, label]) => `<button class="filter-chip ${active === value ? 'active' : ''}" data-${name}="${value}" type="button" aria-pressed="${active === value}">${escapeHtml(label)}</button>`).join('')}</div>`;
}
function toolbar(state, placeholder, chipOptions, chipName = 'status') {
  return `<div class="admin-toolbar"><div class="admin-toolbar__row"><div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q || '')}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}"></div></div>${chips(chipOptions, state[chipName] || 'all', chipName)}<p class="results-meta" data-results-meta aria-live="polite"></p></div>`;
}
function bindToolbar(root, state, render, chipName = 'status') {
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.page = 1; render(); }, 250));
  root.querySelectorAll(`[data-${chipName}]`).forEach(button => button.addEventListener('click', () => {
    state[chipName] = button.dataset[chipName]; state.page = 1;
    root.querySelectorAll(`[data-${chipName}]`).forEach(chip => { const active = chip === button; chip.classList.toggle('active', active); chip.setAttribute('aria-pressed', String(active)); });
    render();
  }));
}

// Revisión explícita cuando el servidor detecta precios distintos o vigencia vencida.
async function runWithReview(action, button, label) {
  try { return await action(false); }
  catch (error) {
    if (error?.code !== 'BM001') throw error;
    const accepted = await confirmAction(`${error.message}\n\n${error.details || error.detail || ''}`, 'Revisión requerida', { confirmLabel: label, tone: 'primary', trigger: button });
    if (!accepted) return null;
    return action(true);
  }
}

// La reserva del cupón venció o se liberó: el administrador ve el detalle y decide.
async function runWithCouponReview(action, button) {
  try { return await action(false); }
  catch (error) {
    if (error?.code !== 'BM002') throw error;
    const accepted = await confirmAction(`${error.message}\n\n${error.details || error.detail || ''}\n\nSi confirmas, se respetará el descuento pactado en el pedido y quedará registrado como revisado.`, 'Revisión del código de descuento', { confirmLabel: 'Respetar descuento y confirmar', tone: 'primary', trigger: button });
    return accepted ? action(true) : null;
  }
}

function marketingAllowed(customer) {
  const records = (customer.customer_consents || []).filter(item => item.purpose === 'marketing_birthday').sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  return Boolean(records[0]?.granted && !records[0]?.withdrawn_at);
}
function contactThisYear(customer) {
  const year = Number(bogotaTodayIso().slice(0, 4));
  return (customer.birthday_contacts || []).find(item => item.contact_year === year) || null;
}
function doNotContact(customer) { return (customer.birthday_contacts || []).some(item => item.status === 'no_contactar'); }

// --- Documentos: líneas con foto, categoría y marca -----------------------------------
const KIND_LABEL = { sale: 'Venta', quote: 'Cotización', order: 'Pedido' };
const KIND_STATUS = { sale: SALE_STATUS, quote: QUOTE_STATUS, order: ORDER_STATUS };
const lineIndex = () => catalogIndex(ctx.getProducts(), ctx.getCategories?.() || []);
const insightOptions = (extra = {}) => ({ products: ctx.getProducts(), categories: ctx.getCategories?.() || [], ...extra });
const docItems = (kind, doc) => (doc?.[DOC_ITEMS[kind]] || []).slice().sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0));
const docUnits = items => items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
const docDate = (kind, doc) => kind === 'sale' ? saleDate(doc) : doc.created_at;
const plural = (count, singular, pluralText = `${singular}s`) => `${count} ${count === 1 ? singular : pluralText}`;
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
const relativeDays = days => days == null ? '—' : days <= 0 ? 'Hoy' : days === 1 ? 'Ayer' : `Hace ${days} días`;
const percent = value => `${Math.round((Number(value) || 0) * 100)} %`;

function itemsPreview(items, max = 2) {
  if (!items?.length) return 'Sin productos';
  const names = items.slice(0, max).map(item => `${item.product_name}${Number(item.quantity) > 1 ? ` ×${item.quantity}` : ''}`);
  return `${names.join(', ')}${items.length > max ? ` y ${items.length - max} más` : ''}`;
}

// --- Por qué el cliente paga ese valor: precio de lista → promoción/tramo → cupón -----
// unit_price ya trae la promoción o el tramo aplicados. Si la línea guarda price_snapshot
// (precio de lista y regla al crearla) se usa tal cual; si no, se reconstruye con el
// catálogo actual y solo se nombra la regla cuando el precio coincide exactamente con ella.
const PRICE_REASON = { promocion: 'Promoción', tramo: 'Precio por volumen', promocion_tramo: 'Promoción + volumen', precio_especial: 'Precio especial' };
const COUPON_AUDIENCE = { publico: 'Público', portador: 'Portador (transferible)', cliente_verificado: 'Solo el cliente verificado' };
const COUPON_STACKING = { sobre_precio_vigente: 'Se suma a promociones y precios por volumen', solo_precio_regular: 'Solo productos sin promoción ni tramo' };
const couponOf = doc => doc?.coupon_snapshot?.code ? doc.coupon_snapshot : doc?.coupon_code ? { code: doc.coupon_code } : null;
const couponRule = coupon => coupon.kind === 'porcentaje' ? `${Number(coupon.value)} %` : coupon.kind === 'valor_fijo' ? formatMoney(coupon.value) : '';

function linePricing(item, items, index) {
  const unit = Number(item.unit_price) || 0; const quantity = Number(item.quantity) || 0;
  let list; let reason = null; let tier = null; let inferred = false;
  const snapshot = item.price_snapshot;
  if (snapshot?.list_price != null) {
    list = Number(snapshot.list_price); reason = snapshot.reason || null; tier = snapshot.tier_min_quantity ? Number(snapshot.tier_min_quantity) : null;
  } else {
    const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id);
    if (!product) return { unit, list: unit, saving: 0, reason: null };
    const variant = (product.product_variants || []).find(entry => entry.id === item.variant_id);
    const own = variant?.price != null && variant.price !== '' ? Number(variant.price) : null;
    const regular = own ?? currentPrice(product);
    list = own ?? Number(product.base_price || 0);
    const key = item.product_id || product.id;
    const units = items.filter(other => (other.product_id || index.variantToProduct.get(other.variant_id)?.id) === key).reduce((sum, other) => sum + Number(other.quantity || 0), 0);
    const step = tierFor(product.price_tiers, units); const tierUnit = step ? Math.min(regular, step.unit_price) : regular;
    inferred = true;
    if (unit < list) {
      if (step && tierUnit < regular && Math.abs(unit - tierUnit) < 0.5) { reason = regular < list ? 'promocion_tramo' : 'tramo'; tier = step.min_quantity; }
      else if (own == null && regular < list && Math.abs(unit - regular) < 0.5) reason = 'promocion';
      else reason = 'precio_especial';
    }
  }
  if (!(list > unit)) return { unit, list: unit, saving: 0, reason: null, inferred };
  return { unit, list, saving: (list - unit) * quantity, percent: Math.round((1 - unit / list) * 100), reason, tier, inferred };
}

function docLinesMarkup(items, { returned = new Map(), doc = null } = {}) {
  if (!items.length) return '<p class="history-empty">Este documento no tiene productos.</p>';
  const index = lineIndex(); const coupon = couponOf(doc);
  return `<ul class="doc-lines">${items.map(item => {
    const line = describeLine(item, index); const back = returned.get(item.id) || 0; const options = optionText(item.option_snapshot);
    const detail = [options, line.sku ? `Ref. ${line.sku}` : ''].filter(Boolean).join(' · ');
    const price = linePricing(item, items, index); const discount = Number(item.discount) || 0;
    const priceTag = price.reason ? `<span class="tag tag--promo" title="${price.inferred ? 'Reconstruido con el catálogo actual' : 'Registrado al crear el documento'}">${icon('tag', { size: 12 })}${PRICE_REASON[price.reason]} −${price.percent} %${price.tier ? ` · desde ${price.tier} u` : ''}</span>` : '';
    const couponTag = discount ? `<span class="tag tag--coupon">${icon('percent', { size: 12 })}${coupon ? `Cupón ${escapeHtml(coupon.code)}` : 'Descuento'}</span>` : '';
    return `<li class="doc-line"><img class="doc-line__thumb" src="${escapeHtml(line.image)}" alt="" loading="lazy" decoding="async"><div class="doc-line__main"><strong>${escapeHtml(line.name)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}<span class="doc-line__tags"><span class="tag">${escapeHtml(line.category)}</span>${line.brand !== 'Sin marca' ? `<span class="tag tag--soft">${escapeHtml(line.brand)}</span>` : ''}${priceTag}${couponTag}${back ? `<span class="tag tag--danger">Devueltas: ${back}</span>` : ''}</span></div><div class="doc-line__qty">${price.saving ? `<small class="doc-line__list">Lista <s>${formatMoney(price.list)}</s></small>` : ''}<span>${Number(item.quantity)} × ${formatMoney(item.unit_price)}</span>${discount ? `<small class="doc-line__coupon">${coupon ? 'Cupón' : 'Desc.'} − ${formatMoney(discount)}</small>` : ''}</div><strong class="doc-line__total">${formatMoney(item.line_total)}</strong></li>`;
  }).join('')}</ul>`;
}

function docTotalsMarkup(doc, items = []) {
  const index = lineIndex();
  const priceSaving = items.reduce((sum, item) => sum + linePricing(item, items, index).saving, 0);
  const discount = Number(doc.discount_total) || 0; const coupon = couponOf(doc);
  const listTotal = Number(doc.subtotal) + priceSaving; const saved = priceSaving + discount;
  const rows = [
    priceSaving ? ['Precio de lista', formatMoney(listTotal), 'is-list'] : null,
    priceSaving ? ['Promociones y precios por volumen', `− ${formatMoney(priceSaving)}`, 'is-saving'] : null,
    ['Subtotal', formatMoney(doc.subtotal), ''],
    discount ? [coupon ? `Cupón <code>${escapeHtml(coupon.code)}</code>${coupon.kind ? ` · ${couponRule(coupon)}` : ''}` : 'Descuentos', `− ${formatMoney(discount)}`, 'is-saving'] : null,
    ['Entrega', formatMoney(doc.delivery_cost), '']
  ].filter(Boolean);
  return `<dl class="doc-sum">${rows.map(([label, value, tone]) => `<div class="${tone}"><dt>${label}</dt><dd>${value}</dd></div>`).join('')}<div class="doc-sum__total"><dt>Total</dt><dd>${formatMoney(doc.total)}</dd></div>${saved > 0 && listTotal > 0 ? `<div class="doc-sum__saved"><dt>${icon('sparkles', { size: 14 })}Ahorro del cliente</dt><dd>${formatMoney(saved)} · ${Math.round((saved / listTotal) * 100)} %</dd></div>` : ''}</dl>`;
}

// Cupón usado: la foto guardada al aplicarlo (código, regla, alcance, vigencia).
function couponDetailMarkup(doc) {
  const coupon = couponOf(doc); const discount = Number(doc.discount_total) || 0;
  if (!coupon) return '';
  const index = lineIndex();
  const target = scope => {
    const id = scope.target_id;
    if (scope.scope_type === 'product') return index.productById.get(id)?.name || 'Producto eliminado';
    if (scope.scope_type === 'variant') { const product = index.variantToProduct.get(id); return product ? `${product.name} (opción específica)` : 'Opción eliminada'; }
    if (scope.scope_type === 'brand') return `Marca ${index.products.find(product => product.brands?.id === id)?.brands?.name || 'eliminada'}`;
    if (scope.scope_type === 'category') return `Categoría ${index.categoryById.get(id)?.name || 'eliminada'}`;
    return scope.scope_type;
  };
  const scopes = coupon.scopes || [];
  const included = scopes.filter(scope => scope.mode !== 'excluir').map(target); const excluded = scopes.filter(scope => scope.mode === 'excluir').map(target);
  const rule = coupon.kind ? `${couponRule(coupon)} ${coupon.kind === 'porcentaje' ? 'sobre los productos elegibles' : 'de descuento'}${coupon.max_discount ? ` · tope ${formatMoney(coupon.max_discount)}` : ''}${Number(coupon.min_eligible) ? ` · compra mínima ${formatMoney(coupon.min_eligible)}` : ''}` : '';
  const facts = [
    rule && ['Regla', escapeHtml(rule)],
    coupon.kind && ['Aplica a', escapeHtml(included.length ? included.join(', ') : 'Todo el catálogo') + (excluded.length ? `<small>Excepto ${escapeHtml(excluded.join(', '))}</small>` : '')],
    coupon.stacking && ['Acumulación', escapeHtml(COUPON_STACKING[coupon.stacking] || coupon.stacking)],
    coupon.audience && ['Quién puede usarlo', escapeHtml(COUPON_AUDIENCE[coupon.audience] || coupon.audience)],
    coupon.kind && ['Vigencia', coupon.ends_at ? `Hasta ${escapeHtml(dateText(coupon.ends_at))}` : 'Sin fecha de vencimiento']
  ].filter(Boolean);
  return `<section class="coupon-detail" aria-label="Cupón aplicado"><span class="coupon-detail__icon" aria-hidden="true">${icon('percent', { size: 22 })}</span><div class="coupon-detail__main"><small>Cupón aplicado${/^OF-/.test(coupon.code) ? ' · oferta personal' : ''}</small><h3><code>${escapeHtml(coupon.code)}</code>${discount ? `<span>− ${formatMoney(discount)}</span>` : ''}</h3>${coupon.name ? `<p>${escapeHtml(coupon.name)}</p>` : ''}${facts.length ? `<dl>${facts.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` : ''}</div></section>`;
}

// meta: fragmentos ya escapados.
function docHeroMarkup({ kicker, status, meta = [], total, items }) {
  return `<section class="doc-hero"><div class="doc-hero__main"><span class="doc-hero__kicker">${escapeHtml(kicker)}</span><div class="doc-hero__status">${status}</div>${meta.length ? `<p>${meta.filter(Boolean).join('<span aria-hidden="true"> · </span>')}</p>` : ''}</div><div class="doc-hero__amount"><small>Total</small><strong>${formatMoney(total)}</strong><span>${plural(items.length, 'producto')} · ${plural(docUnits(items), 'unidad', 'unidades')}</span></div></section>`;
}

const infoCard = (iconName, title, body, action = '') => `<article class="info-card"><span class="info-card__icon" aria-hidden="true">${icon(iconName, { size: 18 })}</span><div><h3>${title}</h3>${body}${action}</div></article>`;
const customerLink = (customerId, fromProfile) => customerId && !fromProfile ? `<button class="link-btn" data-open-customer-id="${escapeHtml(customerId)}" type="button">Ver ficha y análisis →</button>` : '';
const customerCardBody = (name, phone, city) => `<p><strong>${escapeHtml(name || '—')}</strong>${phone ? `<span>${escapeHtml(phone)}</span>` : ''}${city ? `<span>${escapeHtml(city)}</span>` : ''}</p>`;

function bindCustomerLinks(root) {
  root.querySelectorAll('[data-open-customer-id]').forEach(button => button.addEventListener('click', async () => {
    setButtonLoading(button, true, 'Abriendo…');
    try {
      const id = button.dataset.openCustomerId;
      const customer = await getCustomer(id);
      if (!customer) { toast('No encontramos la ficha de este cliente.', 'error'); return; }
      await openCustomerProfile(customer, async () => {}, button);
    } catch (error) { toast(requestError(error, 'No pudimos abrir la ficha.'), 'error'); }
    finally { setButtonLoading(button, false); }
  }));
}

function openDocument(kind, doc, refresh, trigger, options = {}) {
  if (kind === 'sale') return openSaleDetail(doc, refresh, trigger, options);
  if (kind === 'quote') return openQuoteDetail(doc, refresh, trigger, options);
  return openOrderDetail(doc, refresh, trigger, options);
}

// --- Selector de clientes y editor de líneas ------------------------------------
function customerSummary(customer) {
  if (!customer) return '';
  const secondary = [customer.phone_original, customer.identification ? `Doc. ${customer.identification}` : '', customer.city].filter(Boolean);
  return `<span><strong>${escapeHtml(customer.full_name)}</strong>${secondary.length ? `<small>${escapeHtml(secondary.join(' · '))}</small>` : ''}</span><button class="small-btn" data-change-customer type="button">Cambiar</button>`;
}

function customerPickerMarkup(customers, selected = '', { allowCreate = true } = {}) {
  const customer = customers.find(item => item.id === selected); const listId = `customer-results-${crypto.randomUUID()}`;
  return `<div class="customer-picker form-grid__full" data-customer-picker><div class="customer-picker__head"><label data-customer-search-wrap ${customer ? 'hidden' : ''}>Cliente<input type="search" data-customer-search role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" placeholder="Nombre, teléfono o documento" autocomplete="off"></label>${allowCreate ? '<button class="small-btn" data-new-customer type="button">+ Nuevo cliente</button>' : ''}</div><input type="hidden" name="customer_id" value="${escapeHtml(selected)}" required><div id="${listId}" class="autocomplete-results" data-customer-results role="listbox" hidden></div><div class="customer-selection" data-customer-selection ${customer ? '' : 'hidden'}>${customerSummary(customer)}</div><p class="field-status" data-customer-status aria-live="polite"></p></div>`;
}

function bindCustomerPicker(form, customers, { allowCreate = true } = {}) {
  const root = form.querySelector('[data-customer-picker]'); const value = form.elements.customer_id;
  const search = root.querySelector('[data-customer-search]'); const searchWrap = root.querySelector('[data-customer-search-wrap]');
  const results = root.querySelector('[data-customer-results]'); const selection = root.querySelector('[data-customer-selection]'); const status = root.querySelector('[data-customer-status]');
  let visible = []; let active = -1; let request = 0;
  const close = () => { results.hidden = true; search.setAttribute('aria-expanded', 'false'); active = -1; };
  const bindChange = () => selection.querySelector('[data-change-customer]')?.addEventListener('click', () => { searchWrap.hidden = false; selection.hidden = true; search.focus(); renderResults(); });
  const select = customer => {
    value.value = customer.id; value.dispatchEvent(new Event('change', { bubbles: true })); selection.innerHTML = customerSummary(customer); selection.hidden = false; searchWrap.hidden = true; search.value = ''; close();
    status.textContent = `${customer.full_name} seleccionado`; bindChange();
  };
  const renderResults = () => {
    const current = ++request; const term = normalizeText(search.value); status.textContent = 'Buscando…';
    queueMicrotask(() => {
      if (current !== request) return;
      visible = customers.filter(customer => !term || normalizeText(`${customer.full_name} ${customer.phone_original || ''} ${customer.phone_normalized || ''} ${customer.identification || ''}`).includes(term)).slice(0, 8);
      results.innerHTML = visible.length ? visible.map((customer, index) => `<button type="button" role="option" data-customer-option="${index}" aria-selected="false"><span><strong>${escapeHtml(customer.full_name)}</strong><small>${escapeHtml([customer.phone_original, customer.identification ? `Doc. ${customer.identification}` : '', customer.city].filter(Boolean).join(' · ') || 'Sin datos adicionales')}</small></span><b>Seleccionar</b></button>`).join('') : '<p class="autocomplete-empty">No encontramos clientes con esos datos.</p>';
      results.hidden = false; search.setAttribute('aria-expanded', 'true'); status.textContent = visible.length ? `${visible.length} resultado${visible.length === 1 ? '' : 's'}` : 'Sin resultados'; active = -1;
    });
  };
  const optionButtons = () => [...results.querySelectorAll('[data-customer-option]')];
  search.addEventListener('focus', renderResults); search.addEventListener('input', renderResults);
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (results.hidden) renderResults(); active = event.key === 'ArrowDown' ? Math.min(active + 1, visible.length - 1) : Math.max(active - 1, 0); optionButtons()[active]?.focus(); }
    if (event.key === 'Enter' && visible.length) { event.preventDefault(); select(visible[Math.max(0, active)]); }
  });
  results.addEventListener('click', event => { const button = event.target.closest('[data-customer-option]'); if (button) select(visible[Number(button.dataset.customerOption)]); });
  results.addEventListener('keydown', event => {
    const button = event.target.closest('[data-customer-option]'); if (!button) return; active = Number(button.dataset.customerOption);
    if (event.key === 'Enter') { event.preventDefault(); select(visible[active]); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = event.key === 'ArrowDown' ? Math.min(active + 1, visible.length - 1) : Math.max(active - 1, 0); optionButtons()[active]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); search.focus(); }
  });
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) close(); });
  const initial = customers.find(customer => customer.id === value.value); if (initial) select(initial);
  if (allowCreate) root.querySelector('[data-new-customer]')?.addEventListener('click', event => openCustomerForm(null, saved => { customers.unshift(saved); select(saved); }, event.currentTarget));
  return { selected: () => customers.find(customer => customer.id === value.value) || null };
}

function variantCatalog() {
  return ctx.getProducts().flatMap(product => (product.product_variants || []).map(variant => {
    const color = product.product_colors?.find(item => item.id === variant.color_id)?.name;
    const size = product.product_sizes?.find(item => item.id === variant.size_id)?.name;
    const options = [color, size].filter(value => value && !/^única$/i.test(value)).join(' · ');
    return { id: variant.id, product, variant, label: `${product.name}${options ? ` · ${options}` : ''}`, reference: variant.sku || product.sku || product.model || '', price: currentPrice(product), stock: Number(variant.stock || 0), active: variant.active !== false && product.status !== 'hidden' };
  })).sort((a, b) => a.label.localeCompare(b.label, 'es'));
}

function lineEditorMarkup() {
  const listId = `product-results-${crypto.randomUUID()}`;
  return `<fieldset class="line-editor form-grid__full"><legend>Productos</legend><div class="line-editor__search"><label for="${listId}-input">Agregar producto</label><input id="${listId}-input" type="search" data-line-search role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" placeholder="Nombre o referencia / SKU" autocomplete="off"><div id="${listId}" class="autocomplete-results autocomplete-results--products" data-line-results role="listbox" hidden></div><p class="field-status" data-line-status aria-live="polite"></p></div><div class="line-editor__lines" data-lines></div><div class="line-editor__totals" data-line-totals aria-live="polite"></div></fieldset>`;
}

// customPrice/discount: cotizaciones y ventas manuales admiten precio pactado y descuento.
function mountLineEditor(form, { customPrice = false, discount = false, initial = [], deliveryInput = null, onChange = () => {} } = {}) {
  const catalog = variantCatalog();
  const lines = initial.slice().sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0)).map(item => ({ key: crypto.randomUUID(), variant_id: item.variant_id, label: [item.product_name, optionText(item.option_snapshot)].filter(Boolean).join(' · '), quantity: Number(item.quantity), unit_price: Number(item.unit_price), discount: Number(item.discount || 0), catalog: catalog.find(entry => entry.id === item.variant_id) }));
  const root = form.querySelector('.line-editor'); const search = root.querySelector('[data-line-search]'); const results = root.querySelector('[data-line-results]'); const searchStatus = root.querySelector('[data-line-status]');
  root.dataset.discount = String(discount); root.dataset.customPrice = String(customPrice);
  let visible = []; let active = -1; let request = 0;
  const closeResults = () => { results.hidden = true; search.setAttribute('aria-expanded', 'false'); active = -1; };
  const totals = () => {
    const gross = lines.reduce((sum, line) => sum + moneyCents(line.unit_price) * line.quantity, 0); const disc = lines.reduce((sum, line) => sum + moneyCents(line.discount), 0);
    const deliveryValue = parseMoneyInput(deliveryInput?.value || 0); const delivery = moneyCents(deliveryValue ?? 0); const total = gross - disc + delivery;
    root.querySelector('[data-line-totals]').innerHTML = lines.length ? `<span>Subtotal ${formatMoney(fromCents(gross))}</span>${disc ? `<span>Descuentos − ${formatMoney(fromCents(disc))}</span>` : ''}${deliveryInput ? `<span>Entrega ${formatMoney(fromCents(delivery))}</span>` : ''}<strong>Total ${formatMoney(fromCents(total))}</strong>` : '';
    onChange({ gross: fromCents(gross), discount: fromCents(disc), delivery: fromCents(delivery), total: fromCents(total) }); return fromCents(total);
  };
  const render = () => {
    root.querySelector('[data-lines]').innerHTML = lines.length ? `<div class="line-table__head" aria-hidden="true"><span>Producto</span><span>Cantidad</span><span>Precio unit. (COP)</span>${discount ? '<span>Descuento (COP)</span>' : ''}<span>Importe</span><span></span></div>${lines.map(line => `<div class="line-row" data-key="${line.key}"><div class="line-row__name"><strong>${escapeHtml(line.label)}</strong>${line.catalog ? `<small>${line.catalog.reference ? `Ref. ${escapeHtml(line.catalog.reference)} · ` : ''}Precio vigente ${formatMoney(line.catalog.price)} · stock ${line.catalog.stock}</small>` : '<small>La variante ya no está en el catálogo</small>'}</div><label><span>Cantidad</span><input data-field="quantity" type="number" min="1" step="1" inputmode="numeric" value="${line.quantity}" required></label><label><span>Precio unit. (COP)</span>${customPrice ? `<input data-field="unit_price" data-money type="text" inputmode="decimal" value="${editableMoney(line.unit_price)}" required>` : `<output>${formatMoney(line.unit_price)}</output>`}</label>${discount ? `<label><span>Descuento (COP)</span><input data-field="discount" data-money type="text" inputmode="decimal" value="${editableMoney(line.discount)}"></label>` : ''}<output class="line-row__total" aria-label="Importe">${formatMoney(fromCents(moneyCents(line.unit_price) * line.quantity - moneyCents(line.discount)))}</output><button class="line-row__remove" data-remove-line type="button" aria-label="Quitar ${escapeHtml(line.label)}">×</button></div>`).join('')}` : '<p class="line-editor__empty">Busca y agrega al menos un producto.</p>';
    totals();
  };
  const addEntry = entry => {
    if (!entry?.active) return;
    const existing = lines.find(line => line.variant_id === entry.id && moneyCents(line.unit_price) === moneyCents(entry.price) && moneyCents(line.discount) === 0);
    if (existing) existing.quantity += 1;
    else lines.push({ key: crypto.randomUUID(), variant_id: entry.id, label: entry.label, quantity: 1, unit_price: entry.price, discount: 0, catalog: entry });
    search.value = ''; closeResults(); render(); searchStatus.textContent = `${entry.label} agregado`; search.focus();
  };
  const renderResults = () => {
    const current = ++request; const term = normalizeText(search.value); searchStatus.textContent = 'Buscando…';
    queueMicrotask(() => {
      if (current !== request) return;
      visible = catalog.filter(entry => !term || normalizeText(`${entry.label} ${entry.reference} ${entry.product.model || ''} ${entry.product.brands?.name || ''}`).includes(term)).slice(0, 10);
      results.innerHTML = visible.length ? visible.map((entry, index) => `<button type="button" role="option" data-line-option="${index}" ${entry.active ? '' : 'disabled'}><span><strong>${escapeHtml(entry.label)}</strong><small>${entry.reference ? `Ref. ${escapeHtml(entry.reference)} · ` : ''}${formatMoney(entry.price)} · stock ${entry.stock}${entry.active ? '' : ' · no disponible'}</small></span><b>${entry.active ? 'Agregar' : 'No disponible'}</b></button>`).join('') : '<p class="autocomplete-empty">No encontramos productos con esa búsqueda.</p>';
      results.hidden = false; search.setAttribute('aria-expanded', 'true'); searchStatus.textContent = visible.length ? `${visible.length} resultado${visible.length === 1 ? '' : 's'}` : 'Sin resultados'; active = -1;
    });
  };
  search.addEventListener('focus', renderResults); search.addEventListener('input', renderResults);
  search.addEventListener('keydown', event => {
    const enabled = visible.filter(entry => entry.active); const buttons = [...results.querySelectorAll('[data-line-option]:not([disabled])')];
    if (event.key === 'Escape') { event.preventDefault(); closeResults(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (results.hidden) renderResults(); active = event.key === 'ArrowDown' ? Math.min(active + 1, enabled.length - 1) : Math.max(active - 1, 0); buttons[active]?.focus(); }
    else if (event.key === 'Enter' && enabled.length) { event.preventDefault(); addEntry(enabled[Math.max(0, active)]); }
  });
  results.addEventListener('click', event => { const button = event.target.closest('[data-line-option]'); if (button) addEntry(visible[Number(button.dataset.lineOption)]); });
  results.addEventListener('keydown', event => {
    const button = event.target.closest('[data-line-option]'); if (!button) return; const buttons = [...results.querySelectorAll('[data-line-option]:not([disabled])')]; active = buttons.indexOf(button);
    if (event.key === 'Enter') { event.preventDefault(); addEntry(visible[Number(button.dataset.lineOption)]); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); active = event.key === 'ArrowDown' ? Math.min(active + 1, buttons.length - 1) : Math.max(active - 1, 0); buttons[active]?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeResults(); search.focus(); }
  });
  root.querySelector('.line-editor__search').addEventListener('focusout', event => { if (!root.querySelector('.line-editor__search').contains(event.relatedTarget)) closeResults(); });
  root.querySelector('[data-lines]').addEventListener('input', event => {
    const row = event.target.closest('[data-key]'); const line = lines.find(item => item.key === row?.dataset.key);
    if (!line || !event.target.dataset.field) return;
    const field = event.target.dataset.field; const parsed = event.target.dataset.money != null ? parseMoneyInput(event.target.value) : Number(event.target.value);
    event.target.setAttribute('aria-invalid', String(parsed == null || (field === 'quantity' && (!Number.isInteger(parsed) || parsed < 1))));
    if (parsed != null) line[field] = field === 'quantity' ? Math.max(0, parsed) : parsed;
    row.querySelector('.line-row__total').textContent = formatMoney(fromCents(Math.max(0, moneyCents(line.unit_price) * line.quantity - moneyCents(line.discount)))); totals();
  });
  root.querySelector('[data-lines]').addEventListener('focusout', event => { if (event.target.matches('[data-money]')) { const value = parseMoneyInput(event.target.value); if (value != null) event.target.value = editableMoney(value); } });
  root.querySelector('[data-lines]').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-line]'); if (!button) return;
    lines.splice(lines.findIndex(line => line.key === button.closest('[data-key]').dataset.key), 1);
    render();
  });
  if (deliveryInput) {
    deliveryInput.value = editableMoney(parseMoneyInput(deliveryInput.value) ?? 0);
    deliveryInput.addEventListener('input', () => { const value = parseMoneyInput(deliveryInput.value); deliveryInput.setAttribute('aria-invalid', String(value == null)); totals(); });
    deliveryInput.addEventListener('blur', () => { const value = parseMoneyInput(deliveryInput.value); if (value != null) deliveryInput.value = editableMoney(value); });
  }
  render();
  return {
    validate() {
      if (!lines.length) return 'Agrega al menos un producto.';
      if (deliveryInput && parseMoneyInput(deliveryInput.value) == null) return 'Revisa el costo de entrega.';
      const invalid = lines.find(line => !Number.isInteger(line.quantity) || line.quantity < 1 || line.unit_price < 0 || line.discount < 0 || moneyCents(line.discount) > moneyCents(line.unit_price) * line.quantity);
      return invalid ? `Revisa cantidad y descuento de ${invalid.label}.` : '';
    },
    items: () => lines.map(line => ({ variant_id: line.variant_id, quantity: line.quantity, ...(customPrice ? { unit_price: fromCents(moneyCents(line.unit_price)) } : {}), ...(discount ? { discount: fromCents(moneyCents(line.discount)) } : {}) })), total: totals,
    signature: () => JSON.stringify(lines.map(line => [line.variant_id, line.quantity, line.unit_price, line.discount]))
  };
}

function guardUnsaved(getSignature) {
  let initial = getSignature();
  return {
    reset() { initial = getSignature(); },
    async beforeClose() {
      if (getSignature() === initial) return true;
      return confirmAction('Tienes cambios sin guardar. Si cierras ahora se perderán.', 'Descartar cambios', { confirmLabel: 'Descartar cambios', cancelLabel: 'Seguir editando' });
    }
  };
}

// --- Resumen ----------------------------------------------------------------------
// Barras por día del mes en curso (ventas netas confirmadas). Días futuros quedan como guía.
function dashMonthChart(daily, today) {
  const [year, month, day] = today.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const max = Math.max(1, ...daily.values());
  const monthName = new Date(Date.UTC(year, month - 1, 15)).toLocaleDateString('es-CO', { month: 'short', timeZone: 'UTC' }).replace('.', '');
  const bars = Array.from({ length: days }, (_, index) => {
    const dayNumber = index + 1; const cents = daily.get(dayNumber) || 0; const future = dayNumber > day;
    const height = cents ? Math.max(6, Math.round((cents / max) * 100)) : 0;
    return `<span class="dash-bars__day${future ? ' is-future' : ''}${dayNumber === day ? ' is-today' : ''}${cents ? ' has-sales' : ''}" style="--h:${height}%" title="${dayNumber} ${monthName}: ${cents ? formatMoney(fromCents(cents)) : future ? 'aún no llega' : 'sin ventas'}"><i></i></span>`;
  }).join('');
  return `<div class="dash-bars" role="img" aria-label="Ventas por día de ${monthName}: ${[...daily.values()].filter(Boolean).length} días con ventas">${bars}</div><div class="dash-bars__axis" aria-hidden="true"><span>1 ${monthName}</span><span>${days} ${monthName}</span></div>`;
}

export async function renderDashboard() {
  // Cada fuente puede fallar por separado: un error se muestra como "no disponible",
  // nunca como cero.
  const labels = ['pedidos', 'clientes', 'cotizaciones', 'ventas', 'configuración', 'métodos de pago', 'métodos de entrega', 'tareas'];
  const results = await Promise.allSettled([getOrders(), getCustomers(), getQuotes(), getSales(), settings(), getPaymentMethods({ all: true }), getDeliveryMethods({ all: true }), getOpenTasks()]);
  const value = index => (results[index].status === 'fulfilled' ? results[index].value : null);
  const failed = labels.filter((_, index) => results[index].status === 'rejected');
  const truncated = labels.filter((_, index) => value(index)?.truncated);
  const [orders, customers, quotes, sales, config, payments, deliveries, tasks] = labels.map((_, index) => value(index));
  const today = bogotaTodayIso();
  const monthPrefix = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const prevPrefix = (() => { const [y, m] = monthPrefix.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const monthLabel = iso => new Date(`${iso}-15T12:00:00Z`).toLocaleDateString('es-CO', { month: 'long', timeZone: 'UTC' });
  const pending = orders ? orders.filter(item => item.status === 'pendiente') : null;
  const openQuotes = quotes ? quotes.filter(item => OPEN_QUOTE.includes(item.status) && !isQuoteExpired(item)) : null;
  const expiringQuotes = openQuotes ? openQuotes.filter(item => item.valid_until && item.valid_until <= addIsoDays(today, 3)) : null;
  // Ventas del mes = compras confirmadas en el mes (cohorte), netas de devoluciones.
  const purchases = sales ? sales.filter(isPurchase) : null;
  const monthSales = purchases ? purchases.filter(sale => purchaseDate(sale).startsWith(monthPrefix)) : null;
  const keptCents = sale => saleEconomics(sale).productsKeptCents;
  const monthCents = monthSales ? monthSales.reduce((sum, sale) => sum + keptCents(sale), 0) : null;
  // Comparación justa: el mes anterior hasta el mismo día.
  const prevCents = purchases ? purchases.filter(sale => { const date = purchaseDate(sale); return date.startsWith(prevPrefix) && Number(date.slice(8, 10)) <= dayOfMonth; }).reduce((sum, sale) => sum + keptCents(sale), 0) : null;
  const delta = monthCents != null && prevCents > 0 ? Math.round(((monthCents - prevCents) / prevCents) * 100) : null;
  const todayCents = monthSales ? monthSales.filter(sale => purchaseDate(sale) === today).reduce((sum, sale) => sum + keptCents(sale), 0) : null;
  const daily = new Map(); (monthSales || []).forEach(sale => { const dayNumber = Number(purchaseDate(sale).slice(8, 10)); daily.set(dayNumber, (daily.get(dayNumber) || 0) + keptCents(sale)); });
  const pick = view => sales ? sales.filter(SALE_VIEWS[view].match) : null;
  const toConfirm = pick('to_confirm'); const toCollect = pick('to_collect'); const toDeliver = pick('to_deliver');
  const birthdays = customers ? customers.map(customer => ({ customer, info: birthdayInfo(customer.birth_date) })).filter(item => item.info && item.info.days <= 7).sort((a, b) => a.info.days - b.info.days) : [];
  const birthdaysToday = birthdays.filter(item => item.info.days === 0).length;
  const newCustomers = customers ? customers.filter(item => item.created_at && bogotaDate(item.created_at).startsWith(monthPrefix)).length : null;
  const monthOrders = orders ? orders.filter(item => item.created_at && bogotaDate(item.created_at).startsWith(monthPrefix)).length : null;
  const due = tasks ? tasks.filter(task => task.status === 'pendiente' || (task.next_review_at && task.next_review_at <= today)) : null;
  const overdue = due ? due.filter(task => task.due_at && task.due_at < today).length : 0;
  const products = ctx.getProducts();
  const low = products.filter(ctx.isProductLow).length;
  const published = products.filter(product => product.status !== 'hidden').length;
  const setupChecks = config ? [
    [Boolean(config.whatsapp), 'WhatsApp del negocio', 'Sin él, el checkout de la tienda está bloqueado.', true],
    [!deliveries || deliveries.some(item => item.active), 'Al menos un método de entrega activo', '', true],
    [!payments || payments.some(item => item.active), 'Al menos un método de pago activo', '', true],
    [Boolean(config.logo_url), 'Logo oficial para documentos', ''],
    [Boolean(config.address && config.city), 'Dirección y ciudad del negocio', ''],
    [Boolean(config.data_policy_text && config.data_policy_version), 'Texto y versión de tratamiento de datos', ''],
    [Boolean(config.privacy_controller_name), 'Responsable del tratamiento de datos', 'Aparece en la página de privacidad.'],
    [Boolean(config.sale_terms), 'Condiciones del comprobante', ''], [Boolean(config.warranty_text), 'Política de garantía', ''], [Boolean(config.quote_terms), 'Condiciones de cotización', '']
  ] : [];
  const missing = setupChecks.filter(([done]) => !done);
  const critical = missing.filter(item => item[3]);

  const go = (section, params = {}) => `data-go="${section}" data-params='${escapeHtml(JSON.stringify(params))}'`;
  const money = cents => cents == null ? '—' : formatMoney(fromCents(cents));
  const dateLong = new Date(`${today}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const updated = new Date().toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });

  // Agenda: solo lo que pide una acción hoy, de lo más urgente a lo menos.
  const agenda = [
    critical.length && { tone: 'danger', icon: 'alert', count: critical.length, title: critical.length === 1 ? 'Ajuste crítico pendiente' : 'Ajustes críticos pendientes', hint: critical.map(item => item[1]).join(' · '), target: go('settings') },
    due?.length && { tone: overdue ? 'danger' : 'warning', icon: 'check', count: due.length, title: due.length === 1 ? 'Cliente por atender' : 'Clientes por atender', hint: overdue ? `${plural(overdue, 'tarea vencida', 'tareas vencidas')} · seguimientos y postventa` : 'Seguimientos, postventa y recordatorios', target: go('today') },
    pending?.length && { tone: 'warning', icon: 'bag', count: pending.length, title: pending.length === 1 ? 'Solicitud sin atender' : 'Solicitudes sin atender', hint: `Pedidos nuevos por ${formatMoney(pending.reduce((sum, item) => sum + Number(item.total || 0), 0))}`, target: go('orders', { status: 'pendiente' }) },
    toConfirm?.length && { tone: 'warning', icon: 'package', count: toConfirm.length, title: toConfirm.length === 1 ? 'Venta por confirmar' : 'Ventas por confirmar', hint: 'Aún no descuentan inventario', target: go('sales', { status: 'to_confirm' }) },
    toCollect?.length && { tone: 'info', icon: 'wallet', count: toCollect.length, title: toCollect.length === 1 ? 'Venta por cobrar' : 'Ventas por cobrar', hint: `${formatMoney(toCollect.reduce((sum, item) => sum + Number(item.total || 0), 0))} pendientes de pago`, target: go('sales', { status: 'to_collect' }) },
    toDeliver?.length && { tone: 'info', icon: 'truck', count: toDeliver.length, title: toDeliver.length === 1 ? 'Venta por entregar' : 'Ventas por entregar', hint: 'Confirmadas o pagadas sin entrega registrada', target: go('sales', { status: 'to_deliver' }) },
    expiringQuotes?.length && { tone: 'info', icon: 'clock', count: expiringQuotes.length, title: expiringQuotes.length === 1 ? 'Cotización vence pronto' : 'Cotizaciones vencen pronto', hint: 'En los próximos 3 días: buen momento para insistir', target: go('quotes', { status: 'open' }) },
    low && { tone: 'danger', icon: 'layers', count: low, title: low === 1 ? 'Producto con stock bajo' : 'Productos con stock bajo', hint: 'Agotados o en últimas unidades', target: go('stock', { status: 'low' }) },
    birthdaysToday && { tone: 'gold', icon: 'star', count: birthdaysToday, title: birthdaysToday === 1 ? 'Cumpleaños hoy' : 'Cumpleaños hoy', hint: 'Un saludo a tiempo fideliza', target: go('customers', { view: 'today' }) }
  ].filter(Boolean);
  const agendaTotal = agenda.reduce((sum, item) => sum + item.count, 0);
  const AGENDA_VISIBLE = 5;

  const stat = (label, valueText, detail, target) => `<button class="dash-stat" ${target} type="button"><span class="dash-stat__label">${label}</span><strong class="dash-stat__value">${valueText}</strong><span class="dash-stat__detail">${detail}</span></button>`;
  const quick = [['orders', 'bag', 'Registrar pedido', 'WhatsApp o en persona'], ['sales', 'wallet', 'Venta manual', 'Compra ya cerrada'], ['quotes', 'layers', 'Nueva cotización', 'Con PDF para enviar'], ['customers', 'user', 'Nuevo cliente', 'Ficha en segundos']];

  $('#admin-content').innerHTML = `<div class="dash">`
    + `<header class="admin-heading dash-head"><div><span class="eyebrow">Panel administrador</span><h1>Resumen</h1><p><span class="dash-head__date">${escapeHtml(dateLong)}</span> · ${agendaTotal ? `tienes <b>${plural(agenda.length, 'asunto', 'asuntos')}</b> por atender` : 'todo al día por ahora'}</p></div><button class="dash-refresh" data-refresh type="button">${icon('history', { size: 16 })}<span>Actualizado ${escapeHtml(updated)}</span></button></header>`
    + (failed.length || truncated.length ? `<p class="doc-alert doc-alert--warning" role="status">${failed.length ? `No se pudieron cargar: ${escapeHtml(failed.join(', '))}. ` : ''}${truncated.length ? `Se alcanzó el tope de lectura en: ${escapeHtml(truncated.join(', '))}; los totales pueden estar incompletos.` : ''}</p>` : '')
    + `<div class="dash-top">
      <section class="dash-month" aria-labelledby="dash-month-title">
        <header class="dash-month__head"><div><h2 id="dash-month-title">Ventas de ${escapeHtml(monthLabel(monthPrefix))}</h2><small>Confirmadas, netas de devoluciones</small></div>${delta == null ? '' : `<span class="dash-delta ${delta >= 0 ? 'is-up' : 'is-down'}" title="Comparado con ${escapeHtml(monthLabel(prevPrefix))} hasta el día ${dayOfMonth}">${icon('arrowRight', { size: 14 })}${delta >= 0 ? '+' : '−'}${Math.abs(delta)} % vs. ${escapeHtml(monthLabel(prevPrefix).slice(0, 3))}.</span>`}</header>
        <strong class="dash-month__figure">${money(monthCents)}</strong>
        <dl class="dash-month__facts">
          <div><dt>Ventas</dt><dd>${monthSales ? monthSales.length : '—'}</dd></div>
          <div><dt>Ticket promedio</dt><dd>${monthSales?.length ? money(Math.round(monthCents / monthSales.length)) : '—'}</dd></div>
          <div><dt>Hoy</dt><dd>${money(todayCents)}</dd></div>
        </dl>
        ${sales ? dashMonthChart(daily, today) : '<p class="dash-muted">No se pudieron cargar las ventas.</p>'}
        <button class="dash-link" ${go('sales', { status: 'confirmed' })} type="button">Ver ventas del mes${icon('arrowRight', { size: 15 })}</button>
      </section>
      <section class="dash-agenda" aria-labelledby="dash-agenda-title">
        <header><h2 id="dash-agenda-title">Para atender</h2><span>${agendaTotal ? plural(agendaTotal, 'pendiente', 'pendientes') : 'Al día'}</span></header>
        ${agenda.length ? `<ol class="dash-agenda__list">${agenda.map((item, index) => `<li ${index >= AGENDA_VISIBLE ? 'class="is-extra" hidden' : ''}><button class="dash-task dash-task--${item.tone}" ${item.target} type="button"><span class="dash-task__count">${item.count}</span><span class="dash-task__text"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.hint)}</small></span>${icon('chevronRight', { size: 16 })}</button></li>`).join('')}</ol>${agenda.length > AGENDA_VISIBLE ? `<button class="dash-agenda__more" data-agenda-more type="button" aria-expanded="false">Ver ${agenda.length - AGENDA_VISIBLE} más${icon('chevronDown', { size: 15 })}</button>` : ''}` : `<div class="dash-agenda__clear">${icon('checkCircle', { size: 28 })}<strong>Nada urgente por ahora</strong><p>No hay solicitudes, ventas ni tareas esperando. Buen momento para revisar el catálogo o crear una cotización.</p></div>`}
      </section>
    </div>`
    + `<section class="dash-strip" aria-label="Indicadores generales">
      ${stat('Clientes', customers ? customers.length : '—', newCustomers ? `+${newCustomers} este mes` : 'Sin altas este mes', go('customers'))}
      ${stat('Cotizaciones abiertas', openQuotes ? openQuotes.length : '—', openQuotes?.length ? `${formatMoney(openQuotes.reduce((sum, item) => sum + Number(item.total || 0), 0))} en juego` : 'Ninguna en curso', go('quotes', { status: 'open' }))}
      ${stat('Pedidos del mes', monthOrders ?? '—', pending?.length ? `${pending.length} sin atender` : 'Todos atendidos', go('orders'))}
      ${stat('Catálogo publicado', published, low ? `${low} con stock bajo` : 'Stock en orden', go('products'))}
    </section>`
    + `<div class="dash-bottom">
      <section class="dash-panel dash-birthdays" aria-labelledby="dash-bd-title">
        <header><h2 id="dash-bd-title">Cumpleaños de la semana</h2>${birthdays.length ? `<button class="dash-link" ${go('customers', { view: 'week' })} type="button">Ver todos${icon('arrowRight', { size: 15 })}</button>` : ''}</header>
        ${birthdays.length ? `<div class="dash-birthdays__list">${birthdays.slice(0, 4).map(({ customer, info }) => `<div class="dash-bd"><span class="dash-bd__date${info.days === 0 ? ' is-today' : ''}"><b>${Number(info.next.slice(8, 10))}</b><small>${escapeHtml(new Date(`${info.next}T12:00:00Z`).toLocaleDateString('es-CO', { month: 'short', timeZone: 'UTC' }).replace('.', ''))}</small></span>${birthdayCard(customer, info)}</div>`).join('')}</div>` : `<p class="dash-muted">${customers ? 'Nadie cumple años en los próximos 7 días. Registra la fecha de nacimiento en la ficha para no perderte ninguno.' : 'No se pudo cargar la lista de clientes.'}</p>`}
      </section>
      <div class="dash-side">
        <section class="dash-panel" aria-labelledby="dash-quick-title">
          <header><h2 id="dash-quick-title">Atajos</h2></header>
          <div class="dash-quick">${quick.map(([section, iconName, label, hint]) => `<button class="dash-quick__btn" ${go(section, { new: '1' })} type="button"><span class="dash-quick__icon">${icon(iconName, { size: 18 })}</span><span><strong>${label}</strong><small>${hint}</small></span></button>`).join('')}</div>
        </section>
        ${missing.length ? `<section class="dash-panel dash-setup" role="status" aria-labelledby="dash-setup-title">
          <header><h2 id="dash-setup-title">Configuración pendiente</h2><span>${setupChecks.length - missing.length} de ${setupChecks.length}</span></header>
          <span class="dash-setup__bar" aria-hidden="true"><i style="width:${Math.round(((setupChecks.length - missing.length) / setupChecks.length) * 100)}%"></i></span>
          <ul>${missing.slice(0, 4).map(([, label, hint, isCritical]) => `<li class="${isCritical ? 'is-critical' : ''}"><span>${escapeHtml(label)}</span>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</li>`).join('')}${missing.length > 4 ? `<li class="is-more">y ${missing.length - 4} más</li>` : ''}</ul>
          <button class="small-btn small-btn--primary" ${go('settings')} type="button">Completar configuración</button>
        </section>` : ''}
      </div>
    </div>`
    + `</div>`;
  $$('#admin-content [data-go]').forEach(button => button.addEventListener('click', () => ctx.navigateTo(button.dataset.go, JSON.parse(button.dataset.params || '{}'))));
  $('#admin-content [data-agenda-more]')?.addEventListener('click', event => {
    const button = event.currentTarget; const open = button.getAttribute('aria-expanded') !== 'true';
    $$('#admin-content .dash-agenda__list .is-extra').forEach(item => { item.hidden = !open; });
    button.setAttribute('aria-expanded', String(open)); button.firstChild.textContent = open ? 'Ver menos' : `Ver ${agenda.length - AGENDA_VISIBLE} más`;
  });
  $('#admin-content [data-refresh]').addEventListener('click', async event => { setButtonLoading(event.currentTarget, true, 'Actualizando…'); await ctx.refreshProducts(); await renderDashboard(); });
  bindBirthdayCards($('#admin-content'), customers || [], renderDashboard);
}

// --- Clientes ---------------------------------------------------------------------
function birthdayCard(customer, info) {
  const when = info.days === 0 ? 'Hoy' : `En ${info.days} día${info.days === 1 ? '' : 's'}`;
  const contact = contactThisYear(customer);
  return `<article class="crm-card" data-customer="${customer.id}"><div><strong>${escapeHtml(customer.full_name)}</strong><span>${when} · cumple ${info.turning} años · ${dateText(info.next)}</span><small>${contact ? `Contacto ${new Date().getFullYear()}: ${escapeHtml(CONTACT_STATUS[contact.status])}` : 'Sin contacto registrado este año'}${marketingAllowed(customer) ? '' : ' · sin autorización promocional'}</small></div><div class="admin-row-actions"><button class="small-btn" data-open-customer type="button">Ficha</button>${customerContactButtons(customer, true)}</div></article>`;
}

function customerContactButtons(customer, birthday = false) {
  const digits = waDigits(customer);
  if (!digits) return '';
  const canGreet = birthday && marketingAllowed(customer) && !doNotContact(customer);
  return `<a class="small-btn" href="tel:+${digits}">Llamar</a>${birthday ? (canGreet ? '<button class="small-btn small-btn--primary" data-greet type="button">Felicitar</button>' : `<span class="status-pill">${doNotContact(customer) ? 'No contactar' : 'Sin autorización'}</span>`) : `<a class="small-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`)}" target="_blank" rel="noopener">WhatsApp</a>`}`;
}

function bindBirthdayCards(root, customers, refresh) {
  root.querySelectorAll('[data-customer]').forEach(card => {
    const customer = customers.find(item => item.id === card.dataset.customer);
    card.querySelector('[data-open-customer]')?.addEventListener('click', event => openCustomerProfile(customer, refresh, event.currentTarget));
    card.querySelector('[data-greet]')?.addEventListener('click', event => openBirthdayGreeting(customer, refresh, event.currentTarget));
    card.querySelector('[data-analyze-customer]')?.addEventListener('click', () => ctx.navigateTo('customer', { id: customer.id }));
  });
}

async function openBirthdayGreeting(customer, refresh, trigger) {
  const config = await withLoading(settings, { title: 'Preparando el saludo', steps: ['Cargando la configuración del negocio…'], trigger });
  if (!config) return;
  const contact = contactThisYear(customer);
  if (contact && ['contactado', 'obsequio_ofrecido', 'completado'].includes(contact.status)) {
    const again = await confirmAction(`Este año ya registraste “${CONTACT_STATUS[contact.status]}” para ${customer.full_name}. ¿Quieres abrir WhatsApp de nuevo?`, 'Felicitación ya registrada', { confirmLabel: 'Abrir de nuevo', tone: 'primary', trigger });
    if (!again) return;
  }
  const template = config.birthday_message || `Hola {nombre}, te deseamos un feliz cumpleaños de parte de ${businessName()}.`;
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">Revisa el mensaje. WhatsApp se abrirá con el texto prellenado y tú decides si lo envías. Abrir el chat no cuenta como mensaje enviado.</p><label>Mensaje<textarea name="message" rows="4" maxlength="700" required>${escapeHtml(template.replaceAll('{nombre}', firstName(customer.full_name)))}</textarea></label><div class="form-actions"><button class="btn btn--primary" type="submit">Abrir WhatsApp</button></div><div class="greeting-after" hidden><p>¿Enviaste el mensaje? Registra el estado para evitar felicitaciones duplicadas.</p><div class="admin-row-actions"><button class="small-btn small-btn--primary" data-mark="contactado" type="button">Marcar contactado</button><button class="small-btn" data-mark="obsequio_ofrecido" type="button">Obsequio ofrecido</button><button class="small-btn" data-close type="button">Aún no</button></div></div>`;
  const modal = openModal({ title: `Felicitar a ${customer.full_name}`, content: form, trigger });
  form.addEventListener('submit', event => {
    event.preventDefault();
    window.open(waLink(waDigits(customer), form.elements.message.value.trim()), '_blank', 'noopener');
    form.querySelector('.greeting-after').hidden = false;
  });
  form.querySelector('[data-close]').addEventListener('click', () => modal.close());
  form.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', async () => {
    setButtonLoading(button, true, 'Guardando…');
    try {
      await saveBirthdayContact({ customer_id: customer.id, contact_year: Number(bogotaTodayIso().slice(0, 4)), status: button.dataset.mark, contacted_at: new Date().toISOString() }, contact?.id || null);
      toast('Estado de cumpleaños registrado'); modal.close(); await refresh();
    } catch (error) { toast(requestError(error, 'No pudimos guardar el estado.'), 'error'); setButtonLoading(button, false); }
  }));
}

// --- Clientes: valor comercial, pendientes, cumpleaños y siguiente paso ----------------
// Compras = ventas confirmadas no canceladas, valoradas al neto conservado (descuenta
// devoluciones, sin entrega), igual que el análisis. Si los documentos no cargan, la
// lista sigue funcionando y solo se ocultan los indicadores comerciales.
const CUSTOMER_VIEWS = {
  all: { label: 'Todos' },
  buyers: { label: 'Compradores', match: ({ stats }) => stats.purchases > 0 },
  repeat: { label: 'Recurrentes', match: ({ stats }) => stats.purchases >= 2 },
  prospects: { label: 'Sin compras', match: ({ stats }) => stats.purchases === 0 },
  pending: { label: 'Con pendientes', match: ({ stats }) => stats.pendingCount > 0 },
  inactive: { label: 'Inactivos +90 días', match: ({ stats }) => stats.purchases > 0 && stats.daysSince > 90 },
  today: { label: 'Cumpleaños hoy', match: ({ info }) => info?.days === 0 },
  week: { label: 'Próximos 7 días', match: ({ info }) => info && info.days <= 7 },
  month: { label: 'Este mes', match: ({ info }) => info?.inCurrentMonth },
  archived: { label: 'Archivados' }
};
const CUSTOMER_SORTS = { activity: 'Actividad reciente', spent: 'Mayor compra total', purchases: 'Más compras', name: 'Nombre A–Z', newest: 'Clientes nuevos' };
const AVATAR_TONES = ['#a47b28', '#2f6f9f', '#0c7740', '#8a3b12', '#5b3d86', '#1d7a6e', '#9a3b5a'];
const avatarTone = text => AVATAR_TONES[[...String(text)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR_TONES.length];
const daysAgo = iso => iso ? Math.round((new Date(`${bogotaTodayIso()}T12:00:00`) - new Date(`${iso}T12:00:00`)) / 86400000) : null;

function customerStats(customers, sales, orders, quotes) {
  const stats = new Map(customers.map(customer => [customer.id, { purchases: 0, spent: 0, lastPurchase: null, lastActivity: customer.updated_at || customer.created_at, openOrders: 0, openQuotes: 0, toCollect: 0, pendingCount: 0, daysSince: null }]));
  const touch = (entry, date) => { if (date && (!entry.lastActivity || date > entry.lastActivity)) entry.lastActivity = date; };
  sales.forEach(sale => {
    const entry = stats.get(sale.customer_id); if (!entry) return;
    touch(entry, sale.created_at);
    if (isPurchase(sale)) {
      entry.purchases += 1; entry.spent += saleEconomics(sale).productsKeptCents / 100;
      const day = purchaseDate(sale); if (!entry.lastPurchase || day > entry.lastPurchase) entry.lastPurchase = day;
    }
    if (['confirmada', 'entregada'].includes(sale.status)) entry.toCollect += Number(sale.total || 0);
  });
  orders.forEach(order => { const entry = stats.get(order.customer_id); if (!entry) return; touch(entry, order.created_at); if (['pendiente', 'contactado'].includes(order.status) && !order.sales?.length) entry.openOrders += 1; });
  quotes.forEach(quote => { const entry = stats.get(quote.customer_id); if (!entry) return; touch(entry, quote.created_at); if (OPEN_QUOTE.includes(quote.status) && !isQuoteExpired(quote)) entry.openQuotes += 1; });
  stats.forEach(entry => { entry.daysSince = daysAgo(entry.lastPurchase); entry.pendingCount = entry.openOrders + entry.openQuotes + (entry.toCollect > 0 ? 1 : 0); });
  return stats;
}

// Etiqueta simple y explicable a partir de las compras observadas.
function customerSegment(stats, topSpend, customer) {
  if (!stats.purchases) return daysAgo(bogotaDay(customer.created_at)) <= 30 ? ['Nuevo', 'info'] : ['Prospecto', 'muted'];
  if (stats.daysSince > 90) return ['Inactivo', 'danger'];
  if (topSpend && stats.spent >= topSpend) return ['Top cliente', 'gold'];
  if (stats.purchases >= 2) return ['Recurrente', 'success'];
  return ['Comprador', 'success'];
}

function customersKpisMarkup(rows, docsLoaded) {
  const month = bogotaTodayIso().slice(0, 7);
  const newThisMonth = rows.filter(({ customer }) => bogotaDay(customer.created_at).startsWith(month)).length;
  const buyers = rows.filter(({ stats }) => stats.purchases > 0);
  const recent = buyers.filter(({ stats }) => stats.daysSince <= 90);
  const spent = buyers.reduce((sum, { stats }) => sum + stats.spent, 0);
  const week = rows.filter(CUSTOMER_VIEWS.week.match);
  const pending = rows.filter(CUSTOMER_VIEWS.pending.match);
  return `<section class="sales-kpis" aria-label="Resumen de clientes">
    ${kpiTileMarkup({ tone: 'hero', iconName: 'user', label: 'Clientes activos', value: rows.length, detail: `${newThisMonth ? `+${newThisMonth} este mes · ` : ''}${docsLoaded ? `${buyers.length} ya compraron` : 'historial no disponible'}` })}
    ${docsLoaded ? kpiTileMarkup({ view: 'buyers', tone: 'success', iconName: 'chart', label: 'Valor de clientes', value: formatMoney(Math.round(spent)), detail: buyers.length ? `promedio ${formatMoney(Math.round(spent / buyers.length))} · ${recent.length} activos en 90 días` : 'Aún no hay compras confirmadas' }) : ''}
    ${docsLoaded ? kpiTileMarkup({ view: 'pending', tone: 'info', iconName: 'clock', label: 'Con pendientes', value: pending.length, detail: pending.length ? 'Pedidos, cotizaciones o cobros abiertos' : 'Nada abierto' }) : ''}
    ${kpiTileMarkup({ view: 'week', tone: 'warning', iconName: 'star', label: 'Cumpleaños 7 días', value: week.length, detail: week.length ? `${rows.filter(CUSTOMER_VIEWS.today.match).length} hoy · revisa la autorización antes de felicitar` : 'Ninguno esta semana' })}
  </section>`;
}

function customerRowMarkup({ customer, info, stats, segment }, { birthdayView, docsLoaded, menuUp }) {
  const digits = waDigits(customer); const allowed = marketingAllowed(customer) && !doNotContact(customer);
  const canGreet = birthdayView && digits && allowed && info;
  const contact = [customer.phone_original, customer.city].filter(Boolean).map(escapeHtml).join(' · ');
  const birthday = info && info.days <= 7 ? `<span class="customer-badge customer-badge--birthday">${icon('star', { size: 12 })}${info.days === 0 ? `Cumple hoy · ${info.turning} años` : `Cumple en ${info.days} día${info.days === 1 ? '' : 's'}`}</span>` : '';
  const pendings = docsLoaded ? [stats.openOrders && `${plural(stats.openOrders, 'pedido')} abierto${stats.openOrders === 1 ? '' : 's'}`, stats.openQuotes && plural(stats.openQuotes, 'cotización abierta', 'cotizaciones abiertas'), stats.toCollect && `${formatMoney(stats.toCollect)} por cobrar`].filter(Boolean) : [];
  const last = stats.lastPurchase ? (stats.daysSince === 0 ? 'Compró hoy' : `Última compra ${relativeDays(stats.daysSince).toLowerCase()}`) : 'Sin compras';
  const primary = canGreet ? `<button class="small-btn small-btn--primary sale-row__primary" data-greet type="button">${icon('star', { size: 16 })}<span>Felicitar</span></button>` : `<button class="small-btn small-btn--primary sale-row__primary" data-open-customer type="button">${icon('user', { size: 16 })}<span>Ver ficha</span></button>`;
  const menu = [
    canGreet && `<button data-open-customer type="button">${icon('user', { size: 16 })}<span>Ver ficha</span></button>`,
    `<button data-analyze-customer type="button">${icon('sparkles', { size: 16 })}<span>Análisis completo</span></button>`,
    `<button data-edit-customer type="button">${icon('pencil', { size: 16 })}<span>Editar datos</span></button>`
  ].filter(Boolean).join('');
  return `<article class="customer-row" data-customer="${customer.id}" data-segment="${segment[1]}">
    <span class="customer-row__avatar" style="--tone:${avatarTone(customer.full_name)}" aria-hidden="true">${escapeHtml(initials(customer.full_name))}</span>
    <div class="customer-row__main">
      <div class="sale-row__title"><strong>${escapeHtml(customer.full_name)}</strong>${docsLoaded ? `<span class="customer-badge customer-badge--${segment[1]}">${segment[0]}</span>` : ''}${customer.archived_at ? '<span class="status-pill status-pill--muted">Archivado</span>' : ''}</div>
      <p class="customer-row__contact">${contact || 'Sin datos de contacto'}</p>
      <p class="customer-row__tags">${birthday}${allowed ? `<span class="customer-badge customer-badge--ok">${icon('check', { size: 12 })}Acepta promociones</span>` : doNotContact(customer) ? '<span class="customer-badge customer-badge--danger">No contactar</span>' : ''}<span class="customer-row__source">${icon(SOURCE_ICON[customer.source] || 'store', { size: 12 })}${escapeHtml(SOURCES[customer.source] || customer.source || 'Sin origen')}${info && !birthday ? ` · ${info.age} años` : ''}</span></p>
    </div>
    ${docsLoaded ? `<div class="customer-row__value">${stats.purchases ? `<strong>${formatMoney(Math.round(stats.spent))}</strong><small>${plural(stats.purchases, 'compra')}</small><span class="${stats.daysSince > 90 ? 'is-late' : ''}">${last}</span>` : '<small>Aún no compra</small>'}</div>
    <div class="customer-row__pending">${pendings.length ? pendings.map(text => `<span>${text}</span>`).join('') : '<small>Sin pendientes</small>'}</div>` : ''}
    <div class="sale-row__actions customer-row__actions">${digits ? `<a class="icon-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`)}" target="_blank" rel="noopener" aria-label="WhatsApp a ${escapeHtml(customer.full_name)}" title="WhatsApp">${icon('whatsapp', { size: 18 })}</a><a class="icon-btn" href="tel:+${digits}" aria-label="Llamar a ${escapeHtml(customer.full_name)}" title="Llamar">${icon('phone', { size: 18 })}</a>` : ''}${primary}<details class="action-menu sale-menu ${menuUp ? 'action-menu--up' : ''}"><summary aria-label="Más acciones para ${escapeHtml(customer.full_name)}" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${menu}</div></details></div>
  </article>`;
}

export async function renderCustomers() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', view: params.get('view') || 'all', sort: params.get('sort') || 'activity', page: Number(params.get('page')) || 1 };
  if (!CUSTOMER_VIEWS[state.view]) state.view = 'all';
  if (!CUSTOMER_SORTS[state.sort]) state.sort = 'activity';
  const [customerResult, salesResult, ordersResult, quotesResult] = await Promise.allSettled([getCustomers(), getSales(), getOrders(), getQuotes()]);
  if (customerResult.status === 'rejected') throw customerResult.reason;
  const docsLoaded = [salesResult, ordersResult, quotesResult].every(result => result.status === 'fulfilled');
  const docs = docsLoaded ? [salesResult.value, ordersResult.value, quotesResult.value] : [[], [], []];
  await settings();
  const build = list => {
    const stats = customerStats(list, ...docs);
    const spends = [...stats.values()].map(entry => entry.spent).filter(value => value > 0).sort((a, b) => b - a);
    const topSpend = spends.length >= 5 ? spends[Math.max(0, Math.ceil(spends.length * 0.1) - 1)] : null;
    return list.map(customer => { const entry = stats.get(customer.id); return { customer, info: birthdayInfo(customer.birth_date), stats: entry, segment: customerSegment(entry, topSpend, customer) }; });
  };
  const activeRows = build(customerResult.value);
  let archivedRows = null;
  let rows = activeRows; let customers = activeRows.map(row => row.customer);
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('CRM privado', 'Clientes', 'Quién te compra, cuánto y qué tiene pendiente. Quien nació el 29 de febrero celebra el 28 en años no bisiestos.', '<button id="new-customer" class="btn btn--primary" type="button">+ Nuevo cliente</button>')
    + customersKpisMarkup(activeRows, docsLoaded)
    + `<section class="admin-panel sales-panel">
      ${docsLoaded ? '' : '<p class="sale-action__warn">No pudimos cargar ventas, pedidos o cotizaciones: se muestran los datos de contacto sin indicadores comerciales.</p>'}
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar nombre, teléfono, ciudad o identificación" aria-label="Buscar clientes"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar clientes">${Object.entries(CUSTOMER_SORTS).filter(([value]) => docsLoaded || !['spent', 'purchases'].includes(value)).map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar clientes">${Object.entries(CUSTOMER_VIEWS).filter(([value, view]) => docsLoaded || !view.match || ['today', 'week', 'month'].includes(value)).map(([value, view]) => `<button class="sales-tab ${state.view === value ? 'active' : ''}" data-view="${value}" type="button" aria-pressed="${state.view === value}"><span>${view.label}</span>${view.match ? `<b>${activeRows.filter(view.match).length}</b>` : value === 'all' ? `<b>${activeRows.length}</b>` : ''}</button>`).join('')}</div>
      <p class="results-meta" data-results-meta aria-live="polite"></p>
      <div class="sales-list" data-list></div><div data-pagination></div>
    </section>`;
  const refresh = () => renderCustomers();
  const syncTabs = () => root.querySelectorAll('.sales-tabs [data-view]').forEach(tab => { const active = tab.dataset.view === state.view; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  const render = async () => {
    syncUrl('customers', { ...state, view: state.view === 'all' ? '' : state.view, sort: state.sort === 'activity' ? '' : state.sort });
    if (state.view === 'archived') archivedRows ||= build(await getCustomers({ archived: true }));
    rows = state.view === 'archived' ? archivedRows : activeRows; customers = rows.map(row => row.customer);
    const term = normalizeText(state.q);
    const view = CUSTOMER_VIEWS[state.view];
    let visible = rows.filter(row => (!view.match || view.match(row)) && (!term || normalizeText(`${row.customer.full_name} ${row.customer.phone_original} ${row.customer.phone_normalized} ${row.customer.city || ''} ${row.customer.identification || ''}`).includes(term)));
    const sorters = {
      activity: (a, b) => String(b.stats.lastActivity || '').localeCompare(String(a.stats.lastActivity || '')),
      spent: (a, b) => b.stats.spent - a.stats.spent, purchases: (a, b) => b.stats.purchases - a.stats.purchases || b.stats.spent - a.stats.spent,
      name: (a, b) => a.customer.full_name.localeCompare(b.customer.full_name, 'es'), newest: (a, b) => String(b.customer.created_at).localeCompare(String(a.customer.created_at))
    };
    visible.sort(state.view === 'week' ? (a, b) => a.info.days - b.info.days : state.view === 'month' ? (a, b) => a.info.daysFromThisYear - b.info.daysFromThisYear : sorters[state.sort]);
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').innerHTML = `<span>${plural(visible.length, 'cliente')}${docsLoaded ? ` · ${formatMoney(Math.round(visible.reduce((sum, row) => sum + row.stats.spent, 0)))} comprados` : ''}</span>${state.q || state.view !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { state.q = ''; state.view = 'all'; state.page = 1; root.querySelector('[data-search]').value = ''; syncTabs(); render(); });
    const birthdayView = ['today', 'week', 'month'].includes(state.view);
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map((row, position) => customerRowMarkup(row, { birthdayView, docsLoaded, menuUp: position >= pageItems.length - 2 && pageItems.length > 3 })).join('') : emptyMarkup(rows.length ? 'Sin clientes en esta vista' : 'Sin clientes todavía', rows.length ? 'Prueba con otra búsqueda o vista.' : 'Los pedidos de la tienda y las altas manuales aparecerán aquí.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    const list = root.querySelector('[data-list]');
    bindBirthdayCards(list, customers, refresh);
    list.querySelectorAll('[data-customer]').forEach(card => {
      const customer = customers.find(item => item.id === card.dataset.customer);
      card.querySelector('[data-edit-customer]')?.addEventListener('click', event => openCustomerForm(customer, refresh, event.currentTarget));
      // Toda la tarjeta abre la ficha, salvo botones, enlaces y el menú.
      card.addEventListener('click', event => { if (!event.target.closest('button, a, details, summary')) openCustomerProfile(customer, refresh, card); });
    });
  };
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.page = 1; render(); }, 250));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
  root.querySelectorAll('.sales-tabs [data-view]').forEach(tab => tab.addEventListener('click', () => { state.view = tab.dataset.view; state.page = 1; syncTabs(); render(); }));
  root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => {
    state.view = tile.dataset.kpiView; state.page = 1; syncTabs(); render();
    root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#new-customer').addEventListener('click', event => openCustomerForm(null, refresh, event.currentTarget));
  await render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=customers`); openCustomerForm(null, refresh); }
}

const CUSTOMER_SOURCE_OPTIONS = [['manual', 'Registro directo', 'pencil'], ['WhatsApp', 'Escribió por chat', 'whatsapp'], ['presencial', 'Vino al local', 'store'], ['tienda', 'Compró en línea', 'bag']];
const phoneDigits = value => String(value || '').replace(/\D/g, '');
// Últimos 10 dígitos: compara 300 123 4567 con +57 300 123 4567 sin depender del formato.
const phoneKey = value => phoneDigits(value).slice(-10);
const phonePreview = value => {
  const digits = phoneDigits(value);
  const local = digits.length === 12 && digits.startsWith('57') ? digits.slice(2) : digits;
  return local.length === 10 && local.startsWith('3') ? `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : `+${digits}`;
};

export async function openCustomerForm(customer, onSaved, trigger = null) {
  const config = await withLoading(settings, { title: customer ? 'Abriendo los datos del cliente' : 'Preparando nuevo cliente', steps: ['Cargando la configuración de privacidad…'], trigger });
  if (!config) return;
  const today = bogotaTodayIso();
  const value = key => escapeHtml(customer?.[key] || '');
  const currentSource = customer?.source || 'manual';
  const sources = CUSTOMER_SOURCE_OPTIONS.some(([key]) => key === currentSource) ? CUSTOMER_SOURCE_OPTIONS : [...CUSTOMER_SOURCE_OPTIONS, [currentSource, 'Origen actual', 'info']];
  const consentVersion = config.marketing_consent_version;
  const form = document.createElement('form');
  form.className = 'admin-form flow-form customer-form';
  form.noValidate = true;
  const field = (name, label, input, { hint = '', optional = false, full = false, iconName = '' } = {}) => `<div class="cf-field${full ? ' cf-field--full' : ''}" data-field="${name}"><label for="cf-${name}">${label}${optional ? ' <small>Opcional</small>' : ' <b class="cf-req" aria-hidden="true">*</b>'}</label><span class="cf-control${iconName ? ' cf-control--icon' : ''}">${iconName ? icon(iconName, { size: 18 }) : ''}${input}</span><small class="cf-hint" data-hint="${name}">${hint}</small><small class="cf-error" data-field-error="${name}" hidden></small></div>`;
  const step = (number, key, title, hint, body, badge) => `<section class="flow-step" data-step="${key}"><header class="flow-step__head"><span class="flow-step__num" aria-hidden="true"><b>${number}</b>${icon('check', { size: 15 })}</span><div><h3>${title}</h3><p>${hint}</p></div>${badge}</header>${body}</section>`;
  form.innerHTML = `<div class="flow-form__body form-grid">
    <div class="flow-form__main">
      ${step(1, 'contact', 'Datos de contacto', 'Con el nombre y el teléfono ya puedes registrar ventas, pedidos y cotizaciones.', `<div class="cf-grid">
        ${field('full_name', 'Nombre completo', `<input id="cf-full_name" name="full_name" required maxlength="120" autocomplete="off" placeholder="Ej. María Fernanda Gómez" value="${value('full_name')}">`, { iconName: 'user' })}
        ${field('phone_original', 'Teléfono / WhatsApp', `<input id="cf-phone_original" name="phone_original" required inputmode="tel" maxlength="30" autocomplete="off" placeholder="300 123 4567 o +57 300 123 4567" value="${value('phone_original')}">`, { iconName: 'whatsapp', hint: 'Celular colombiano o número internacional con indicativo.' })}
      </div><div class="cf-duplicate" data-duplicate role="status" hidden></div>`, '<span class="flow-step__state" data-state="contact">Obligatorio</span>')}
      ${step(2, 'profile', 'Perfil del cliente', 'Datos opcionales que mejoran el seguimiento, las entregas y los saludos de cumpleaños.', `<div class="cf-grid">
        ${field('city', 'Ciudad', `<input id="cf-city" name="city" maxlength="80" autocomplete="off" placeholder="Ej. Valledupar" value="${value('city')}">`, { optional: true, iconName: 'pin' })}
        ${field('birth_date', 'Fecha de nacimiento', `<input id="cf-birth_date" name="birth_date" type="date" min="1900-01-01" max="${today}" value="${value('birth_date')}">`, { optional: true, hint: 'Activa el recordatorio de cumpleaños.' })}
        ${field('address', 'Dirección habitual', `<input id="cf-address" name="address" maxlength="250" autocomplete="off" placeholder="Barrio, calle y número" value="${value('address')}">`, { optional: true, full: true, iconName: 'navigation' })}
        ${field('identification', 'Documento de identificación', `<input id="cf-identification" name="identification" maxlength="40" autocomplete="off" placeholder="Cédula o NIT" value="${value('identification')}">`, { optional: true, iconName: 'shield', hint: 'Privado: solo lo ve el equipo del panel.' })}
      </div>`, '<span class="flow-step__state flow-step__state--soft" data-state="profile">Opcional</span>')}
    </div>
    <aside class="flow-form__aside">
      <section class="cf-preview" aria-label="Vista previa de la ficha">
        <header><span>Vista previa</span><b data-preview-percent>0 %</b></header>
        <div class="cf-preview__id"><span class="cf-preview__avatar" data-preview-avatar>?</span><div><strong data-preview-name>Nuevo cliente</strong><small data-preview-phone>Sin teléfono</small></div></div>
        <ul class="cf-preview__facts"><li data-preview-city>${icon('pin', { size: 15 })}<span></span></li><li data-preview-birth>${icon('star', { size: 15 })}<span></span></li><li data-preview-source>${icon('info', { size: 15 })}<span></span></li><li data-preview-consent>${icon('mail', { size: 15 })}<span></span></li></ul>
        <div class="cf-meter"><span class="cf-meter__track"><span data-preview-meter></span></span><small data-preview-missing></small></div>
      </section>
      ${step(3, 'source', 'Origen', '¿Cómo llegó este cliente?', `<fieldset class="flow-choice"><legend class="sr-only">Origen del cliente</legend><div class="flow-choice__grid cf-sources">${sources.map(([key, hint, iconName]) => `<label class="flow-choice__opt"><input type="radio" name="source" value="${escapeHtml(key)}" ${key === currentSource ? 'checked' : ''}><span class="flow-choice__card">${icon(iconName, { size: 20 })}<strong>${escapeHtml(SOURCES[key] || key)}</strong><small>${hint}</small></span></label>`).join('')}</div></fieldset>`, '')}
      <label class="flow-switch"><input name="marketing_consent" type="checkbox" role="switch" ${customer && marketingAllowed(customer) ? 'checked' : ''}><span class="flow-switch__switch" aria-hidden="true"></span><span class="flow-switch__text"><strong>Autorizó contacto promocional</strong><small>Felicitaciones de cumpleaños, ofertas y promociones. ${consentVersion ? `Texto aceptado: versión ${escapeHtml(consentVersion)}.` : 'El texto de autorización está pendiente en Configuración.'}</small></span></label>
      <details class="flow-notes" ${customer?.notes ? 'open' : ''}><summary>${icon('pencil', { size: 16 })}<span>Notas internas</span><small data-notes-state>${customer?.notes ? 'Con información' : 'Opcional'}</small>${icon('chevronDown', { size: 16 })}</summary><label class="flow-notes__body"><span class="sr-only">Notas internas</span><textarea name="notes" rows="3" placeholder="Preferencias, horarios de contacto, referencias…">${escapeHtml(customer?.notes || '')}</textarea></label></details>
    </aside>
  </div>
  <div class="flow-form__footer">
    <p class="product-form-error flow-form__error" data-error role="alert" tabindex="-1" hidden></p>
    <ul class="flow-form__ready" aria-label="Datos requeridos"><li data-ready="full_name">${icon('check', { size: 13 })}Nombre</li><li data-ready="phone_original">${icon('check', { size: 13 })}Teléfono</li></ul>
    <div class="flow-form__actions"><button class="btn btn--ghost" data-cancel type="button">Cancelar</button><button class="btn btn--primary" type="submit">${customer ? 'Guardar cambios' : 'Crear cliente'}</button></div>
  </div>`;

  const el = name => form.elements[name];
  const touched = new Set();
  let others = [];
  // La búsqueda de duplicados no bloquea la apertura: si la lista no llega, simplemente no avisa.
  getCustomers().then(list => { others = list.filter(item => item.id !== customer?.id && !item.archived_at); sync(); }).catch(() => {});
  const problems = () => ({
    full_name: String(el('full_name').value).trim().length < 2 ? 'Escribe el nombre completo (mínimo 2 letras).' : '',
    phone_original: phoneDigits(el('phone_original').value).length < 8 ? 'Escribe un teléfono válido (mínimo 8 dígitos).' : '',
    birth_date: el('birth_date').value && !isValidBirthDate(el('birth_date').value, today) ? 'La fecha no puede ser futura ni anterior a 1900.' : ''
  });
  const showFieldErrors = (all = false) => Object.entries(problems()).forEach(([name, message]) => {
    const visible = Boolean(message) && (all || touched.has(name));
    const error = form.querySelector(`[data-field-error="${name}"]`); error.textContent = visible ? message : ''; error.hidden = !visible;
    el(name).setAttribute('aria-invalid', String(visible)); form.querySelector(`[data-field="${name}"]`).classList.toggle('has-error', visible);
  });
  const sync = () => {
    const name = String(el('full_name').value).trim(); const phone = String(el('phone_original').value).trim(); const issues = problems();
    const ready = { full_name: !issues.full_name, phone_original: !issues.phone_original };
    Object.entries(ready).forEach(([key, done]) => form.querySelector(`[data-ready="${key}"]`).classList.toggle('is-done', done));
    const contactDone = ready.full_name && ready.phone_original;
    form.querySelector('[data-step="contact"]').classList.toggle('is-done', contactDone);
    form.querySelector('[data-state="contact"]').textContent = contactDone ? 'Listo' : 'Obligatorio';
    // Teléfono: formato con el que se guardará y aviso de ficha duplicada.
    form.querySelector('[data-hint="phone_original"]').textContent = ready.phone_original ? `Se contactará por WhatsApp al ${phonePreview(phone)}.` : 'Celular colombiano o número internacional con indicativo.';
    const key = phoneKey(phone); const duplicate = key.length >= 8 ? others.find(item => phoneKey(item.phone_normalized || item.phone_original) === key) : null;
    const duplicateBox = form.querySelector('[data-duplicate]'); duplicateBox.hidden = !duplicate;
    duplicateBox.innerHTML = duplicate ? `${icon('alert', { size: 18 })}<div><strong>Este teléfono ya está registrado</strong><span>${escapeHtml(duplicate.full_name)}${duplicate.city ? ` · ${escapeHtml(duplicate.city)}` : ''}. Revisa que no estés creando una ficha duplicada.</span></div>` : '';
    // Cumpleaños: edad y días que faltan.
    const birth = el('birth_date').value; const info = !issues.birth_date && birth ? birthdayInfo(birth, today) : null;
    const birthText = info ? `${info.age} años · ${info.days === 0 ? '¡cumple hoy!' : `cumple ${info.turning} en ${plural(info.days, 'día', 'días')}`}` : '';
    form.querySelector('[data-hint="birth_date"]').textContent = info ? birthText : 'Activa el recordatorio de cumpleaños.';
    const optional = ['city', 'birth_date', 'address', 'identification'];
    const filled = optional.filter(item => String(el(item).value).trim()).length;
    form.querySelector('[data-step="profile"]').classList.toggle('is-done', filled === optional.length);
    form.querySelector('[data-state="profile"]').textContent = filled ? `${filled} de ${optional.length}` : 'Opcional';
    // Vista previa y completitud de la ficha.
    const percent = Math.round(((ready.full_name ? 1 : 0) + (ready.phone_original ? 1 : 0) + filled) / (optional.length + 2) * 100);
    form.querySelector('[data-preview-avatar]').textContent = name ? initials(name) : '?';
    form.querySelector('[data-preview-name]').textContent = name || (customer ? 'Cliente' : 'Nuevo cliente');
    form.querySelector('[data-preview-phone]').textContent = ready.phone_original ? phonePreview(phone) : 'Sin teléfono';
    const fact = (key, text, empty) => { const item = form.querySelector(`[data-preview-${key}]`); item.querySelector('span').textContent = text || empty; item.classList.toggle('is-empty', !text); };
    fact('city', String(el('city').value).trim(), 'Ciudad sin registrar');
    fact('birth', info ? `Cumpleaños ${new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${birth}T12:00:00Z`))} · ${info.age} años` : '', 'Cumpleaños sin registrar');
    fact('source', `Origen: ${SOURCES[form.querySelector('[name="source"]:checked')?.value] || 'Manual'}`, '');
    fact('consent', el('marketing_consent').checked ? 'Acepta contacto promocional' : '', 'Sin autorización promocional');
    form.querySelector('[data-preview-percent]').textContent = `${percent} %`;
    form.querySelector('[data-preview-meter]').style.width = `${percent}%`;
    const labels = { city: 'ciudad', birth_date: 'cumpleaños', address: 'dirección', identification: 'documento' };
    const missing = optional.filter(item => !String(el(item).value).trim()).map(item => labels[item]);
    form.querySelector('[data-preview-missing]').textContent = percent === 100 ? 'Ficha completa.' : missing.length ? `Puedes agregar: ${missing.join(', ')}.` : 'Completa los datos de contacto.';
    if (touched.size) showFieldErrors();
    // El aviso de validación del pie desaparece en cuanto los datos quedan correctos.
    const footerError = form.querySelector('[data-error]');
    if (footerError.dataset.kind === 'validation' && !Object.values(issues).some(Boolean)) footerError.hidden = true;
  };
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('focusout', event => { if (event.target.name in problems()) { touched.add(event.target.name); showFieldErrors(); } });
  el('notes').addEventListener('input', () => { form.querySelector('[data-notes-state]').textContent = el('notes').value.trim() ? 'Con información' : 'Opcional'; });
  sync();

  const signature = () => JSON.stringify(Object.fromEntries(new FormData(form)));
  const guard = guardUnsaved(signature);
  const modal = openModal({ title: customer ? 'Editar cliente' : 'Nuevo cliente', description: customer ? `Actualiza la ficha de ${customer.full_name}.` : 'Crea la ficha en segundos: solo el nombre y el teléfono son obligatorios.', headerIcon: icon('user', { size: 22 }), content: form, trigger, className: 'modal--wide modal--flow modal--customer', initialFocus: '#cf-full_name', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  form.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(form);
    const error = form.querySelector('[data-error]'); error.hidden = true;
    const birth = data.get('birth_date');
    const issues = problems(); const firstInvalid = Object.keys(issues).find(name => issues[name]);
    if (firstInvalid) {
      Object.keys(issues).forEach(name => touched.add(name)); showFieldErrors(true);
      error.textContent = issues[firstInvalid]; error.dataset.kind = 'validation'; error.hidden = false;
      el(firstInvalid).focus(); el(firstInvalid).scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
    }
    const button = event.submitter || form.querySelector('[type="submit"]');
    saving = true; modal.setDismissible(false); setButtonLoading(button, true, 'Guardando…');
    try {
      const saved = await saveCustomer({ full_name: data.get('full_name'), phone_original: data.get('phone_original'), city: data.get('city'), address: data.get('address'), birth_date: birth || null, identification: data.get('identification'), source: data.get('source'), notes: String(data.get('notes') || '').trim() || null }, customer?.id);
      const consent = data.has('marketing_consent');
      if (consent !== Boolean(customer && marketingAllowed(customer)) && (consent || customer)) await recordConsent(saved.id, 'marketing_birthday', consent, config.marketing_consent_version, 'admin');
      toast(customer ? 'Cliente actualizado' : 'Cliente creado'); modal.close(true); await onSaved?.(saved);
    } catch (saveError) {
      saving = false; modal.setDismissible(true); setButtonLoading(button, false);
      error.textContent = requestError(saveError, 'No pudimos guardar el cliente.'); error.dataset.kind = 'save'; error.hidden = false; error.focus();
    }
  });
}

// --- Pantalla de carga dentro de un modal ----------------------------------------
// El modal se abre al instante y muestra el avance mientras llegan los datos, para que
// nunca parezca que el panel se congeló.
const LOADING_STEPS = {
  analysis: ['Cargando compras, cotizaciones y pedidos…', 'Calculando ticket promedio y frecuencia de compra…', 'Identificando categorías, marcas y tallas favoritas…', 'Buscando productos para recomendarle…'],
  profile: ['Cargando el historial del cliente…', 'Organizando compras, cotizaciones y pedidos…', 'Calculando sus indicadores…']
};

function loadingMarkup(title, steps, variant) {
  const blocks = (count, className) => `<span class="skeleton-block ${className}"></span>`.repeat(count);
  const skeleton = variant === 'analysis'
    ? `${blocks(1, 'ls-row')}<div class="ls-grid ls-grid--kpi">${blocks(6, 'ls-kpi')}</div><div class="ls-grid ls-grid--split">${blocks(2, 'ls-tall')}</div><div class="ls-grid ls-grid--three">${blocks(3, 'ls-mid')}</div>`
    : `${blocks(1, 'ls-chips')}<div class="ls-grid ls-grid--kpi">${blocks(6, 'ls-kpi')}</div>${blocks(1, 'ls-tabs')}<div class="ls-grid ls-grid--split">${blocks(2, 'ls-tall')}</div>`;
  return `<div class="loading-screen" role="status" aria-live="polite"><div class="loading-screen__head"><span class="loading-screen__spinner" aria-hidden="true"></span><div><strong>${escapeHtml(title)}</strong><p data-loading-step>${escapeHtml(steps[0])}</p></div></div><div class="loading-screen__bar" aria-hidden="true"><span></span></div><div class="loading-skeleton" aria-hidden="true">${skeleton}</div></div>`;
}

// Muestra la carga en `root` y avanza los mensajes; devuelve la función que la detiene.
function showLoading(root, title, variant) {
  const steps = LOADING_STEPS[variant];
  root.innerHTML = loadingMarkup(title, steps, variant);
  let step = 0;
  const timer = setInterval(() => {
    const label = root.querySelector('[data-loading-step]');
    if (!label || !root.isConnected) { clearInterval(timer); return; }
    step = Math.min(step + 1, steps.length - 1);
    label.textContent = steps[step];
  }, 900);
  return () => clearInterval(timer);
}

function showLoadError(root, title, message, retry) {
  root.innerHTML = `<div class="loading-screen loading-screen--error" role="alert"><span class="loading-screen__icon" aria-hidden="true">${icon('alert', { size: 26 })}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p><button class="btn btn--primary" data-retry type="button">Reintentar</button></div>`;
  root.querySelector('[data-retry]').addEventListener('click', retry);
}

// Deja pintar la pantalla de carga antes de los cálculos síncronos.
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));

// --- Ficha 360 del cliente --------------------------------------------------------
const kpiTile = (label, value, detail = '', tone = '') => `<article class="kpi-tile${tone ? ` kpi-tile--${tone}` : ''}"><small>${label}</small><strong>${value}</strong>${detail ? `<span>${detail}</span>` : ''}</article>`;

function insightsMarkup(list) {
  return list.length ? `<ul class="insight-list">${list.map(item => `<li class="insight insight--${item.tone}"><span aria-hidden="true">${icon(item.tone === 'warning' || item.tone === 'danger' ? 'alert' : item.tone === 'success' ? 'checkCircle' : 'info', { size: 16 })}</span><p>${item.text}</p></li>`).join('')}</ul>` : '<p class="history-empty">Cuando el cliente cotice o compre, aquí verás sus patrones de compra.</p>';
}

function categoryRows(list) {
  return list.map(item => ({ label: item.name, detail: [item.parent, plural(item.units, 'unidad', 'unidades')].filter(Boolean).join(' · '), value: item.amount, display: percent(item.share), tip: `${item.name}: ${formatMoney(item.amount)} · ${plural(item.units, 'unidad', 'unidades')} · ${percent(item.share)}` }));
}

function preferencesMarkup(groups) {
  if (!groups.length) return '';
  return `<div class="pref-groups">${groups.slice(0, 3).map(group => `<div class="pref-group"><small>${escapeHtml(group.name)}</small><div>${group.values.slice(0, 5).map(item => `<span class="pref-chip">${escapeHtml(item.value)}<b>${item.units}</b></span>`).join('')}</div></div>`).join('')}</div>`;
}

function productMiniList(rows, empty, { right = row => `<strong>${formatMoney(row.amount)}</strong><small>${plural(row.units, 'unidad', 'unidades')}</small>`, detail = row => [row.category, row.brand !== 'Sin marca' ? row.brand : ''].filter(Boolean).join(' · ') } = {}) {
  if (!rows.length) return `<p class="history-empty">${escapeHtml(empty)}</p>`;
  return `<ul class="mini-products">${rows.map(row => `<li><img src="${escapeHtml(row.image)}" alt="" loading="lazy" decoding="async"><span class="mini-products__main"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(detail(row))}</small></span><span class="mini-products__end">${right(row)}</span></li>`).join('')}</ul>`;
}

function timelineMarkup(entries) {
  if (!entries.length) return '<p class="history-empty">Sin actividad registrada.</p>';
  return `<ol class="timeline">${entries.map(({ kind, doc, date }) => `<li><button type="button" data-doc-open data-kind="${kind}" data-id="${doc.id}"><span class="timeline__dot timeline__dot--${kind}" aria-hidden="true"></span><span class="timeline__main"><strong>${KIND_LABEL[kind]} ${escapeHtml(doc[DOC_NUMBER[kind]])}</strong><small>${dateText(date)} · ${escapeHtml(itemsPreview(docItems(kind, doc)))}</small></span><span class="timeline__end"><b>${formatMoney(doc.total)}</b>${pill(doc.status, KIND_STATUS[kind])}</span></button></li>`).join('')}</ol>`;
}

function docCardMarkup(kind, doc) {
  const items = docItems(kind, doc); const index = lineIndex();
  const returned = kind === 'sale' ? returnedBySaleItem(doc) : new Map();
  const thumbs = items.slice(0, 3).map(item => describeLine(item, index).image);
  const search = normalizeText(`${doc[DOC_NUMBER[kind]]} ${items.map(item => `${item.product_name} ${item.sku || ''} ${optionText(item.option_snapshot)}`).join(' ')}`);
  const extra = kind === 'quote' ? (isQuoteExpired(doc) ? 'vigencia vencida' : doc.valid_until ? `válida hasta ${dateText(doc.valid_until)}` : '') : kind === 'sale' ? (doc.payment_method ? `pago: ${doc.payment_method}` : '') : (SOURCES[doc.source] || doc.source || '');
  const note = kind === 'sale' && !CONFIRMED_SALE.includes(doc.status) ? '<small class="doc-card__note">No suma a compras</small>' : '';
  return `<details class="doc-card" data-kind="${kind}" data-id="${doc.id}" data-search="${escapeHtml(search)}"><summary><span class="doc-card__thumbs" aria-hidden="true">${thumbs.map(src => `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`).join('')}${items.length > 3 ? `<b>+${items.length - 3}</b>` : ''}</span><span class="doc-card__main"><span class="doc-card__title"><strong>${escapeHtml(doc[DOC_NUMBER[kind]])}</strong>${pill(doc.status, KIND_STATUS[kind])}${note}</span><small>${dateText(docDate(kind, doc))} · ${plural(items.length, 'producto')} · ${plural(docUnits(items), 'unidad', 'unidades')}${extra ? ` · ${escapeHtml(extra)}` : ''}</small><span class="doc-card__preview">${escapeHtml(itemsPreview(items, 3))}</span></span><span class="doc-card__amount">${formatMoney(doc.total)}</span><span class="doc-card__chevron" aria-hidden="true">${icon('chevronDown', { size: 18 })}</span></summary><div class="doc-card__body">${docLinesMarkup(items, { returned, doc })}<div class="doc-card__foot">${docTotalsMarkup(doc, items)}<div class="doc-card__actions"><button class="small-btn small-btn--primary" data-doc-open type="button">Ver detalle completo</button>${kind !== 'order' ? '<button class="small-btn" data-doc-pdf type="button">Descargar PDF</button>' : ''}</div></div></div></details>`;
}

function productTableMarkup(rows, { showBought = false } = {}) {
  if (!rows.length) return '<p class="history-empty">Sin productos en este periodo.</p>';
  return `<div class="product-table" role="table" aria-label="Productos"><div class="product-table__head" role="row"><span role="columnheader">Producto</span><span role="columnheader">Unidades</span><span role="columnheader">Veces</span><span role="columnheader">Última vez</span><span role="columnheader">Importe</span></div>${rows.map(row => `<div class="product-table__row" role="row" data-search="${escapeHtml(normalizeText(`${row.name} ${row.category} ${row.brand} ${row.search}`))}"><span class="product-table__product" role="cell"><img src="${escapeHtml(row.image)}" alt="" loading="lazy" decoding="async"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml([row.category, row.brand !== 'Sin marca' ? row.brand : ''].filter(Boolean).join(' · '))}</small>${row.variants.length ? `<span class="product-table__variants">${row.variants.slice(0, 4).map(([value, units]) => `<span class="pref-chip">${escapeHtml(value)}<b>${units}</b></span>`).join('')}</span>` : ''}${showBought ? `<span class="tag ${row.bought ? 'tag--success' : 'tag--warning'}">${row.bought ? 'Ya lo compró' : 'No lo ha comprado'}</span>` : ''}</span></span><span role="cell" data-label="Unidades">${row.units}</span><span role="cell" data-label="Veces">${row.times}</span><span role="cell" data-label="Última vez">${dateText(row.lastDate)}</span><strong role="cell" data-label="Importe">${formatMoney(row.amount)}</strong></div>`).join('')}</div>`;
}

function docsPanelMarkup(kind, docs, data) {
  if (!docs.length) return emptyMarkup(`Sin ${kind === 'sale' ? 'ventas' : kind === 'quote' ? 'cotizaciones' : 'pedidos'} todavía`, kind === 'order' ? 'Los pedidos de la tienda o registrados a mano aparecerán aquí.' : 'Cuando se registren aparecerán aquí con el detalle de cada producto.');
  const groupable = kind !== 'order';
  const rows = kind === 'sale' ? groupByProduct(data.purchaseLines) : kind === 'quote' ? groupByProduct(data.quoteLines, data.bought) : [];
  return `<div class="docs-toolbar">${groupable ? `<div class="segmented" role="group" aria-label="Vista"><button type="button" data-view="docs" aria-pressed="true">Por documento</button><button type="button" data-view="products" aria-pressed="false">Por producto</button></div>` : ''}<div class="admin-search-wrap"><input class="admin-search" type="search" data-doc-search placeholder="Buscar producto, referencia o número" aria-label="Buscar en ${kind === 'sale' ? 'ventas' : kind === 'quote' ? 'cotizaciones' : 'pedidos'}"></div></div><div class="doc-cards" data-view-panel="docs">${docs.map(doc => docCardMarkup(kind, doc)).join('')}</div>${groupable ? `<div data-view-panel="products" hidden>${kind === 'sale' ? '<p class="panel-note">Solo ventas confirmadas, netas de devoluciones.</p>' : ''}${productTableMarkup(rows, { showBought: kind === 'quote' })}</div>` : ''}<p class="history-empty" data-search-empty hidden>Sin coincidencias para esa búsqueda.</p>`;
}

function bindDocsPanels(root) {
  root.querySelectorAll('[data-panel]').forEach(panel => {
    const search = panel.querySelector('[data-doc-search]'); if (!search) return;
    const apply = () => {
      const term = normalizeText(search.value.trim());
      const visible = [...panel.querySelectorAll('[data-view-panel]')].find(view => !view.hidden);
      let shown = 0;
      visible?.querySelectorAll('[data-search]').forEach(row => { const match = !term || row.dataset.search.includes(term); row.hidden = !match; if (match) shown += 1; });
      panel.querySelector('[data-search-empty]').hidden = shown > 0 || !term;
    };
    search.addEventListener('input', debounce(apply, 150));
    panel.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
      panel.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      panel.querySelectorAll('[data-view-panel]').forEach(view => { view.hidden = view.dataset.viewPanel !== button.dataset.view; });
      apply();
    }));
  });
}

function bindTabs(root) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const select = tab => {
    tabs.forEach(item => { const active = item === tab; item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; root.querySelector(`#${item.getAttribute('aria-controls')}`).hidden = !active; });
  };
  tabs.forEach((tab, position) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? tabs[(position + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(position - 1 + tabs.length) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
      if (next) { event.preventDefault(); select(next); next.focus(); }
    });
  });
  return { select: key => { const tab = tabs.find(item => item.dataset.tab === key); if (tab) select(tab); } };
}

async function openCustomerProfile(customer, refresh, trigger = null) {
  const wrapper = document.createElement('div');
  wrapper.className = 'customer-profile';
  const modal = openModal({ title: customer.full_name, content: wrapper, trigger, className: 'modal--wide modal--profile', headerIcon: `<span class="avatar">${escapeHtml(initials(customer.full_name))}</span>` });
  const subtitle = document.createElement('p');
  subtitle.className = 'modal__subtitle';
  subtitle.textContent = [customer.phone_original, SOURCES[customer.source] || customer.source, customer.created_at ? `cliente desde ${dateText(customer.created_at)}` : ''].filter(Boolean).join(' · ');
  modal.element.querySelector('.modal__title h2').after(subtitle);
  const stopLoading = showLoading(wrapper, `Abriendo la ficha de ${firstName(customer.full_name)}…`, 'profile');
  let record; let config;
  try { [record, config] = await Promise.all([getCustomerHistory(customer.id), settings()]); await nextFrame(); }
  catch (error) {
    stopLoading();
    if (wrapper.isConnected) showLoadError(wrapper, 'No pudimos cargar la ficha', requestError(error, 'Revisa la conexión e intenta de nuevo.'), () => { modal.close(true); openCustomerProfile(customer, refresh, trigger); });
    return;
  }
  stopLoading();
  if (!wrapper.isConnected) return;
  const asOf = bogotaTodayIso();
  const data = analyzeCustomer(record, insightOptions({ asOf, coverage: record.coverage, buyingContext: customer.buying_context }));
  const m = data.metrics;
  const info = birthdayInfo(customer.birth_date);
  const contact = contactThisYear(customer);
  const consents = (customer.customer_consents || []).slice().sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  const allowed = marketingAllowed(customer); const digits = waDigits(customer);
  const uid = crypto.randomUUID().slice(0, 8);
  const tabs = [['summary', 'Resumen'], ['sale', 'Compras', record.sales.length], ['quote', 'Cotizaciones', record.quotes.length], ['order', 'Pedidos', record.orders.length], ['data', 'Datos']];
  const birthdayText = info ? (info.days === 0 ? 'Cumple hoy' : info.days <= 30 ? `Cumple en ${plural(info.days, 'día')}` : `Cumple el ${dateText(info.next)}`) : '';
  const interest = !data.categories.length && data.interestCategories.length;
  const panel = (key, content, first = false) => `<section class="profile-panel" role="tabpanel" id="cp-panel-${key}-${uid}" aria-labelledby="cp-tab-${key}-${uid}" data-panel="${key}" ${first ? '' : 'hidden'}>${content}</section>`;
  const dx = diagnoseCustomer(data, { allowed, digits, birthday: info });
  const money = cents => (cents == null ? '—' : formatMoney(fromCents(cents)));
  const funnel = m.funnel.toConfirmedSale;
  wrapper.innerHTML = `${record.coverage && !record.coverage.complete ? `<p class="doc-alert doc-alert--warning" role="status">No se pudo cargar todo el historial (${escapeHtml([...record.coverage.errors, ...record.coverage.truncated].join(', '))}). Los indicadores son parciales.</p>` : ''}<section class="profile-hero">
      <div class="profile-hero__chips"><span class="status-pill status-pill--${dx.segment.tone}" title="${escapeHtml(dx.segment.text)}">${escapeHtml(dx.segment.label)}</span><span class="meta-chip ${allowed ? 'meta-chip--ok' : ''}">${icon(allowed ? 'check' : 'x', { size: 14 })}${allowed ? 'Acepta promociones' : 'Sin autorización promocional'}</span>${customer.city ? `<span class="meta-chip">${icon('pin', { size: 14 })}${escapeHtml(customer.city)}</span>` : ''}${info ? `<span class="meta-chip ${info.days <= 7 ? 'meta-chip--warn' : ''}">${icon('star', { size: 14 })}${birthdayText} · ${info.age} años</span>` : ''}${customer.archived_at ? '<span class="status-pill status-pill--danger">Archivado</span>' : ''}</div>
      <div class="profile-hero__actions">${digits ? `<a class="small-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}<span>WhatsApp</span></a><a class="small-btn" href="tel:+${digits}">${icon('phone', { size: 16 })}<span>Llamar</span></a>` : ''}<button class="small-btn" data-edit type="button">${icon('pencil', { size: 16 })}<span>Editar</span></button><button class="small-btn small-btn--primary" data-analyze type="button">${icon('chart', { size: 16 })}<span>Analizar cliente</span></button><details class="action-menu action-menu--right"><summary aria-label="Más acciones">${icon('more', { size: 18 })}</summary><div class="action-menu__popover"><button data-merge type="button">Fusionar duplicado</button>${customer.archived_at ? '<button data-restore type="button">Restaurar cliente</button>' : '<button data-archive class="is-danger" type="button">Archivar cliente</button>'}</div></details></div>
    </section>
    <section class="kpi-strip" aria-label="Indicadores del cliente">
      ${kpiTile('Compras conservadas', money(m.productsKeptCents), `${plural(m.positiveOperations, 'compra', 'compras')}${m.cohortReturnedCents ? ` · devuelto ${money(m.cohortReturnedCents)}` : ''}`, m.positiveOperations ? 'accent' : '')}
      ${kpiTile('Ticket promedio', money(m.avgTicketCents), m.avgTicketCents != null ? 'Sobre compras con neto positivo' : 'Sin compras conservadas')}
      ${kpiTile('Última compra', relativeDays(m.daysSinceLast), m.lastPurchase ? dateText(m.lastPurchase) : 'Sin compras conservadas', m.daysSinceLast > 120 ? 'warning' : '')}
      ${kpiTile('Ocasiones de compra', String(m.cadence.occasions), m.cadence.medianGap ? `Mediana entre compras: ${Math.round(m.cadence.medianGap)} días` : 'Aún sin intervalo calculable')}
      ${kpiTile('Cotizaciones con resultado', funnel.den ? `${funnel.num} de ${funnel.den}` : '—', funnel.den ? 'terminaron en venta confirmada vigente' : 'Sin cotizaciones enviadas')}
      ${kpiTile('Pendiente hoy', String(data.opportunities.length), dx.stage.label, data.opportunities.length ? 'warning' : '')}
    </section>
    <div class="profile-tabs" role="tablist" aria-label="Secciones de la ficha">${tabs.map(([key, label, count], position) => `<button role="tab" type="button" id="cp-tab-${key}-${uid}" aria-controls="cp-panel-${key}-${uid}" aria-selected="${position === 0}" tabindex="${position === 0 ? 0 : -1}" data-tab="${key}">${label}${count != null ? `<span>${count}</span>` : ''}</button>`).join('')}</div>
    ${panel('summary', `<div class="card-grid">
      <article class="panel-card"><header><h3>Lo que más compra</h3><p>${data.categories.length ? 'Participación de cada categoría en lo conservado' : interest ? 'Según lo que pidió o cotizó (aún sin compras)' : 'Categorías de sus compras'}</p></header>${barList(categoryRows(data.categories.length ? data.categories : data.interestCategories), { limit: 5, empty: 'Cuando compre o pida productos verás aquí sus categorías.' })}${preferencesMarkup(data.preferences)}</article>
      <article class="panel-card"><header><h3>Productos favoritos</h3><p>Los que más ha conservado</p></header>${productMiniList(data.topProducts.slice(0, 5), data.opportunities.length ? 'Aún no compra; revisa lo que pidió o cotizó.' : 'Aún no ha comprado productos.')}</article>
      <article class="panel-card"><header><h3>Hallazgos</h3><p>${escapeHtml(dx.headline)}</p></header>${insightsMarkup(data.insights.slice(0, 5))}<button class="link-btn" data-analyze type="button">Ver análisis completo →</button></article>
      <article class="panel-card"><header><h3>Actividad reciente</h3><p>Últimos documentos; toca uno para ver su detalle</p></header>${timelineMarkup(data.timeline.filter(entry => entry.kind !== 'return').slice(0, 6))}</article>
    </div>`, true)}
    ${panel('sale', docsPanelMarkup('sale', record.sales, data))}
    ${panel('quote', docsPanelMarkup('quote', record.quotes, data))}
    ${panel('order', docsPanelMarkup('order', record.orders, data))}
    ${panel('data', `<div class="card-grid">
      <article class="panel-card"><header><h3>Datos de contacto</h3></header><dl class="detail-grid detail-grid--compact"><div><dt>Teléfono</dt><dd>${escapeHtml(customer.phone_original)} <small>${escapeHtml(customer.phone_normalized)}</small></dd></div><div><dt>Ciudad</dt><dd>${escapeHtml(customer.city || '—')}</dd></div><div class="detail-grid__full"><dt>Dirección habitual</dt><dd>${escapeHtml(customer.address || '—')}</dd></div><div><dt>Identificación</dt><dd>${escapeHtml(customer.identification || '—')}</dd></div><div><dt>Edad</dt><dd>${info ? `${info.age} años · cumple ${dateText(info.next)}` : 'Sin fecha de nacimiento'}</dd></div><div><dt>Origen</dt><dd>${escapeHtml(SOURCES[customer.source] || customer.source)}</dd></div><div><dt>Cliente desde</dt><dd>${dateText(customer.created_at)}</dd></div></dl></article>
      <article class="panel-card"><header><h3>Notas internas</h3><p>Solo visibles en el panel</p></header>${customer.notes ? `<p class="profile-notes">${escapeHtml(customer.notes).replace(/\n/g, '<br>')}</p>` : '<p class="history-empty">Sin notas. Usa Editar para agregarlas.</p>'}</article>
      <article class="panel-card"><header><h3>Autorizaciones</h3><p>Promocional y felicitaciones: <strong>${allowed ? 'autorizado' : 'no autorizado'}</strong></p></header>${consents.length ? `<ul class="history-list">${consents.slice(0, 6).map(item => `<li><span>${item.purpose === 'marketing_birthday' ? 'Promocional' : 'Gestión de pedidos'} · ${item.granted ? 'otorgada' : 'retirada'}${item.withdrawn_at ? ' (retirada)' : ''}</span><small>v. ${escapeHtml(item.text_version)} · ${escapeHtml(item.source)} · ${dateTimeText(item.recorded_at)}</small></li>`).join('')}</ul>` : '<p class="history-empty">Sin registros de autorización.</p>'}${allowed ? '<button class="small-btn" data-withdraw type="button">Registrar retiro de autorización</button>' : ''}</article>
      ${customer.birth_date ? `<article class="panel-card"><header><h3>Cumpleaños ${bogotaTodayIso().slice(0, 4)}</h3><p>${birthdayText}</p></header><form class="birthday-status-form" data-birthday-form><label>Estado<select name="status">${Object.entries(CONTACT_STATUS).map(([value, label]) => `<option value="${value}" ${(contact?.status || 'pendiente') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Nota<input name="note" maxlength="300" value="${escapeHtml(contact?.note || '')}"></label><button class="small-btn small-btn--primary" type="submit">Guardar estado</button></form>${contact?.contacted_at ? `<small class="panel-note">Última actualización: ${dateTimeText(contact.contacted_at)}</small>` : ''}</article>` : ''}
    </div><p class="form-help">Archivar oculta la ficha de las listas y de los cumpleaños sin borrar pedidos, cotizaciones ni ventas emitidas, que deben conservarse.</p>`)}`;
  const after = async () => { modal.close(true); invalidateCrmSettings(); await refresh(); };
  bindTabs(wrapper); bindDocsPanels(wrapper); bindChartTooltips(wrapper);
  const findDoc = (kind, id) => record[`${kind}s`].find(doc => doc.id === id);
  wrapper.addEventListener('click', async event => {
    const open = event.target.closest('[data-doc-open]');
    if (open) { const host = open.closest('[data-kind]'); openDocument(host.dataset.kind, findDoc(host.dataset.kind, host.dataset.id), after, open, { fromProfile: true }); return; }
    const pdf = event.target.closest('[data-doc-pdf]');
    if (pdf) { const host = pdf.closest('[data-kind]'); downloadDocument(host.dataset.kind, findDoc(host.dataset.kind, host.dataset.id), await settings(), pdf); }
  });
  wrapper.querySelectorAll('[data-analyze]').forEach(button => button.addEventListener('click', () => { modal.close(true); ctx.navigateTo('customer', { id: customer.id }); }));
  wrapper.querySelector('[data-edit]').addEventListener('click', event => openCustomerForm(customer, after, event.currentTarget));
  wrapper.querySelector('[data-archive]')?.addEventListener('click', async event => {
    if (!await confirmAction('La ficha dejará de aparecer en listas y cumpleaños. Sus documentos se conservan.', 'Archivar cliente', { confirmLabel: 'Archivar', trigger: event.currentTarget })) return;
    try { await saveCustomer({ archived_at: new Date().toISOString() }, customer.id); toast('Cliente archivado'); await after(); } catch (error) { toast(requestError(error, 'No pudimos archivar.'), 'error'); }
  });
  wrapper.querySelector('[data-restore]')?.addEventListener('click', async () => {
    try { await saveCustomer({ archived_at: null }, customer.id); toast('Cliente restaurado'); await after(); } catch (error) { toast(requestError(error, 'No pudimos restaurar.'), 'error'); }
  });
  wrapper.querySelector('[data-withdraw]')?.addEventListener('click', async event => {
    if (!await confirmAction('Se registrará que el cliente retiró la autorización promocional. No se le mostrarán accesos de felicitación.', 'Retirar autorización', { confirmLabel: 'Registrar retiro', trigger: event.currentTarget })) return;
    try { await recordConsent(customer.id, 'marketing_birthday', false, config.marketing_consent_version, 'admin'); toast('Retiro registrado'); await after(); } catch (error) { toast(requestError(error, 'No pudimos registrar el retiro.'), 'error'); }
  });
  wrapper.querySelector('[data-birthday-form]')?.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget); const button = event.submitter;
    setButtonLoading(button, true, 'Guardando…');
    try {
      await saveBirthdayContact({ customer_id: customer.id, contact_year: Number(bogotaTodayIso().slice(0, 4)), status: formData.get('status'), note: String(formData.get('note') || '').trim() || null, contacted_at: new Date().toISOString() }, contact?.id || null);
      toast('Estado de cumpleaños guardado'); await after();
    } catch (error) { toast(requestError(error, 'No pudimos guardar el estado.'), 'error'); setButtonLoading(button, false); }
  });
  wrapper.querySelector('[data-merge]').addEventListener('click', event => openMergeForm(customer, after, event.currentTarget));
}

async function openMergeForm(customer, after, trigger) {
  const all = await withLoading(getCustomers, { title: 'Buscando fichas duplicadas', steps: ['Cargando la lista de clientes…'], trigger });
  if (!all) return;
  const candidates = all.filter(item => item.id !== customer.id);
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">Elige la ficha duplicada. Sus pedidos, cotizaciones, ventas y autorizaciones pasarán a <strong>${escapeHtml(customer.full_name)}</strong>; los campos vacíos se completan con los del duplicado y el duplicado queda archivado. No se borra ningún documento.</p><div class="form-grid">${customerPickerMarkup(candidates, '', { allowCreate: false })}</div><div class="form-actions"><button class="btn btn--primary" type="submit">Revisar fusión</button></div>`;
  const modal = openModal({ title: 'Fusionar clientes duplicados', content: form, trigger });
  bindCustomerPicker(form, candidates, { allowCreate: false });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const duplicate = candidates.find(item => item.id === form.elements.customer_id.value);
    if (!duplicate) { toast('Selecciona la ficha duplicada.', 'error'); return; }
    if (!await confirmAction(`Se conservará ${customer.full_name} (${customer.phone_original}) y se archivará ${duplicate.full_name} (${duplicate.phone_original}). Esta acción no se deshace automáticamente.`, 'Confirmar fusión', { confirmLabel: 'Fusionar', trigger: event.submitter })) return;
    const button = event.submitter; setButtonLoading(button, true, 'Fusionando…');
    try { await mergeCustomers(customer.id, duplicate.id); toast('Clientes fusionados'); modal.close(true); await after(); }
    catch (error) { toast(requestError(error, 'No pudimos fusionar los clientes.'), 'error'); setButtonLoading(button, false); }
  });
}

// --- Pedidos ----------------------------------------------------------------------
// --- Pedidos: atención, espera y paso a venta -------------------------------------------
// Un pedido abierto es pendiente o contactado y sin venta. La espera se mide desde que se
// registró; pasadas 24 h se marca para atenderlo primero.
const hasSale = order => Boolean(order.sales?.length);
const isOrderOpen = order => ['pendiente', 'contactado'].includes(order.status) && !hasSale(order);
const hoursSince = iso => Math.max(0, (Date.now() - new Date(iso).getTime()) / 3600000);
const waitText = hours => hours < 1 ? 'hace minutos' : hours < 24 ? `hace ${Math.floor(hours)} h` : `hace ${plural(Math.floor(hours / 24), 'día')}`;
const ORDER_VIEWS = {
  all: { label: 'Todos', match: () => true },
  open: { label: 'Por atender', match: isOrderOpen },
  pendiente: { label: 'Sin contactar', match: order => order.status === 'pendiente' && !hasSale(order) },
  contactado: { label: 'Contactados', match: order => order.status === 'contactado' && !hasSale(order) },
  confirmado: { label: 'Listos para venta', match: order => order.status === 'confirmado' && !hasSale(order) },
  converted: { label: 'Convertidos en venta', match: hasSale },
  cancelado: { label: 'Cancelados', match: order => order.status === 'cancelado' },
  abandonado: { label: 'Abandonados', match: order => order.status === 'abandonado' }
};
const ORDER_SORTS = { recent: 'Más recientes', waiting: 'Más tiempo esperando', high: 'Mayor valor', low: 'Menor valor' };

function ordersKpisMarkup(orders) {
  const sum = list => list.reduce((total, order) => total + Number(order.total || 0), 0);
  const open = orders.filter(isOrderOpen); const fresh = orders.filter(ORDER_VIEWS.pendiente.match); const ready = orders.filter(ORDER_VIEWS.confirmado.match);
  const oldest = fresh.reduce((max, order) => Math.max(max, hoursSince(order.created_at)), 0);
  const late = open.filter(order => hoursSince(order.created_at) >= 24).length;
  const converted = orders.filter(hasSale); const closed = converted.length + orders.filter(order => ['cancelado', 'abandonado'].includes(order.status) && !hasSale(order)).length;
  const rate = closed ? Math.round((converted.length / closed) * 100) : null;
  return `<section class="sales-kpis" aria-label="Resumen de pedidos">
    ${kpiTileMarkup({ tone: 'hero', iconName: 'bag', label: 'Por atender', value: formatMoney(sum(open)), detail: `${plural(open.length, 'solicitud abierta', 'solicitudes abiertas')}${late ? ` · <b class="is-down">${late} con +24 h</b>` : ''}` })}
    ${kpiTileMarkup({ view: 'pendiente', tone: 'warning', iconName: 'chat', label: 'Sin contactar', value: fresh.length, detail: fresh.length ? `La más antigua llegó ${waitText(oldest)}` : 'Todos contactados' })}
    ${kpiTileMarkup({ view: 'confirmado', tone: 'info', iconName: 'checkCircle', label: 'Listos para venta', value: ready.length, detail: ready.length ? `${formatMoney(sum(ready))} confirmados sin venta` : 'Nada por convertir' })}
    ${kpiTileMarkup({ view: 'converted', tone: 'success', iconName: 'chart', label: 'Conversión', value: rate == null ? '—' : `${rate} %`, detail: closed ? `${converted.length} de ${plural(closed, 'cerrado', 'cerrados')} terminaron en venta` : 'Aún no hay pedidos cerrados' })}
  </section>`;
}

function orderProgressMarkup(order) {
  if (['cancelado', 'abandonado'].includes(order.status) && !hasSale(order)) return `<div class="sale-progress sale-progress--closed">${icon('x', { size: 14 })}<span>${order.status === 'cancelado' ? 'Pedido cancelado' : 'Pedido abandonado'}</span></div>`;
  const reached = hasSale(order) ? 4 : { pendiente: 1, contactado: 2, confirmado: 3 }[order.status] || 1;
  return `<ol class="sale-progress" aria-label="Avance: ${reached} de 4">${['Recibido', 'Contactado', 'Confirmado', 'Venta'].map((label, position) => `<li class="${position < reached ? 'is-done' : ''}"><span></span><small>${label}</small></li>`).join('')}</ol>`;
}

function orderWaitMarkup(order) {
  if (hasSale(order)) return `<span class="validity validity--done">${icon('checkCircle', { size: 13 })}Venta ${escapeHtml(order.sales[0].sale_number)}</span>`;
  if (!isOrderOpen(order)) return '';
  const hours = hoursSince(order.created_at);
  return `<span class="validity ${hours >= 72 ? 'validity--bad' : hours >= 24 ? 'validity--soon' : 'validity--ok'}">${icon('clock', { size: 13 })}${order.status === 'pendiente' ? 'Sin contactar' : 'Contactado'} · llegó ${waitText(hours)}</span>`;
}

// Acción principal según la etapa; el resto va al menú (cada data-* aparece una vez).
function orderRowActions(order, menuUp) {
  const digits = waDigits(order.customers); const sale = order.sales?.[0];
  const message = `Hola ${firstName(order.customers?.full_name)}, te escribimos de ${businessName()} sobre tu pedido ${order.order_number}.`;
  const canConvert = !sale && !['cancelado', 'abandonado'].includes(order.status);
  let primary;
  if (sale) primary = `<button class="small-btn sale-row__primary" data-go-sale type="button">${icon('arrowRight', { size: 16 })}<span>Ver venta</span></button>`;
  else if (order.status === 'pendiente' && digits) primary = `<a class="small-btn small-btn--primary sale-row__primary" data-contact-order href="${waLink(digits, message)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}<span>Contactar</span></a>`;
  else if (order.status === 'contactado') primary = `<button class="small-btn small-btn--primary sale-row__primary" data-set-order-status="confirmado" type="button">${icon('checkCircle', { size: 16 })}<span>Marcar confirmado</span></button>`;
  else if (canConvert) primary = `<button class="small-btn small-btn--primary sale-row__primary" data-to-sale type="button">${icon('arrowRight', { size: 16 })}<span>Convertir a venta</span></button>`;
  else primary = `<button class="small-btn sale-row__primary" data-open-order type="button">${icon('external', { size: 16 })}<span>Revisar</span></button>`;
  const used = attr => primary.includes(attr);
  const item = (attr, label, iconName, tone = '') => `<button class="${tone}" ${attr} type="button">${icon(iconName, { size: 16 })}<span>${label}</span></button>`;
  const statuses = sale ? [] : [['contactado', 'Marcar contactado', 'chat'], ['confirmado', 'Marcar confirmado', 'checkCircle'], ['cancelado', 'Marcar cancelado', 'x'], ['abandonado', 'Marcar abandonado', 'clock']]
    .filter(([value]) => value !== order.status && !used(`data-set-order-status="${value}"`));
  const menu = [
    !used('data-open-order') && item('data-open-order', 'Revisar pedido', 'external'),
    canConvert && !used('data-to-sale') && item('data-to-sale', 'Convertir a venta', 'arrowRight'),
    digits && !used('data-contact-order') && `<a href="${waLink(digits, message)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}<span>WhatsApp</span></a>`,
    digits && `<a href="tel:+${digits}">${icon('phone', { size: 16 })}<span>Llamar</span></a>`
  ].filter(Boolean).join('');
  return `<div class="sale-row__actions">${primary}<details class="action-menu sale-menu ${menuUp ? 'action-menu--up' : ''}"><summary aria-label="Más acciones para ${escapeHtml(order.order_number)}" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${menu}${statuses.length ? `<p class="action-menu__label">Cambiar estado</p>${statuses.map(([value, label, iconName]) => item(`data-set-order-status="${value}"`, label, iconName, value === 'cancelado' ? 'is-danger' : '')).join('')}` : ''}</div></details></div>`;
}

function orderRowMarkup(order, index, menuUp) {
  const items = docItems('order', order); const customer = order.customers || {};
  const thumbs = items.slice(0, 2).map(item => `<img src="${escapeHtml(describeLine(item, index).image)}" alt="" loading="lazy" decoding="async">`).join('');
  const conflicts = Object.keys(order.customer_conflicts || {}).length; const discount = Number(order.discount_total) || 0;
  const delivery = [order.delivery_name, order.shipping_city].filter(Boolean).map(escapeHtml).join(' · ');
  const status = hasSale(order) ? 'converted' : order.status;
  return `<article class="sale-row order-row" data-order="${order.id}" data-status="${status}">
    <span class="sale-row__thumbs" aria-hidden="true">${thumbs || `<b>${icon('bag', { size: 18 })}</b>`}${items.length > 2 ? `<b>+${items.length - 2}</b>` : ''}</span>
    <div class="sale-row__main">
      <div class="sale-row__title"><strong>${escapeHtml(order.order_number)}</strong>${pill(order.status, ORDER_STATUS)}${order.coupon_code ? `<span class="customer-badge customer-badge--gold">${icon('percent', { size: 12 })}${escapeHtml(order.coupon_code)}</span>` : ''}${conflicts ? `<span class="customer-badge customer-badge--danger" title="Los datos del pedido no coinciden con la ficha">${icon('alert', { size: 12 })}Revisar datos</span>` : ''}</div>
      <p class="sale-row__customer"><span class="sale-row__avatar" aria-hidden="true">${escapeHtml(initials(customer.full_name || 'C'))}</span><span>${escapeHtml(customer.full_name || 'Cliente')}</span>${customer.phone_original ? `<small class="order-row__phone">${escapeHtml(customer.phone_original)}</small>` : ''}</p>
      <p class="sale-row__items">${escapeHtml(itemsPreview(items, 2))}</p>
    </div>
    <div class="sale-row__flow">${orderProgressMarkup(order)}<div class="quote-row__meta">${orderWaitMarkup(order)}<small class="sale-row__meta">${icon(SOURCE_ICON[order.source] || 'store', { size: 13 })}${escapeHtml(SOURCES[order.source] || order.source)} · ${escapeHtml(dateTimeText(order.created_at))}${order.source === 'tienda' ? (order.whatsapp_opened_at ? ' · WhatsApp preparado' : ' · WhatsApp no abierto') : ''}</small></div></div>
    <div class="sale-row__amount"><strong>${formatMoney(order.total)}</strong>${discount ? `<small class="quote-row__discount">${icon('percent', { size: 13 })}Ahorro ${formatMoney(discount)}</small>` : ''}<small>${icon('truck', { size: 13 })}${delivery || 'Entrega sin definir'}</small><span>${escapeHtml(order.payment_name || 'Pago sin definir')} · ${plural(docUnits(items), 'unidad', 'unidades')}</span></div>
    ${orderRowActions(order, menuUp)}
  </article>`;
}

export async function renderOrders() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'all', sort: params.get('sort') || 'recent', page: Number(params.get('page')) || 1 };
  if (!ORDER_VIEWS[state.status]) state.status = 'all';
  if (!ORDER_SORTS[state.sort]) state.sort = 'recent';
  const orders = await getOrders();
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Solicitudes', 'Pedidos', 'Contacta, confirma y convierte cada solicitud en venta. Un pedido no descuenta inventario, y abrir WhatsApp no prueba que el cliente envió el mensaje.', '<button id="new-order" class="btn btn--primary" type="button">+ Registrar pedido</button>')
    + ordersKpisMarkup(orders)
    + `<section class="admin-panel sales-panel">
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar número, cliente, teléfono, producto o cupón" aria-label="Buscar pedidos"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar pedidos">${Object.entries(ORDER_SORTS).map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar pedidos">${Object.entries(ORDER_VIEWS).map(([value, view]) => `<button class="sales-tab ${state.status === value ? 'active' : ''}" data-status="${value}" type="button" aria-pressed="${state.status === value}"><span>${view.label}</span><b>${orders.filter(view.match).length}</b></button>`).join('')}</div>
      <p class="results-meta" data-results-meta aria-live="polite"></p>
      <div class="sales-list" data-list></div><div data-pagination></div>
    </section>`;
  const refresh = () => renderOrders();
  const index = lineIndex();
  const syncTabs = () => root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => { const active = tab.dataset.status === state.status; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  const render = () => {
    syncUrl('orders', { ...state, sort: state.sort === 'recent' ? '' : state.sort });
    const term = normalizeText(state.q);
    const visible = orders.filter(order => ORDER_VIEWS[state.status].match(order) && (!term || normalizeText(`${order.order_number} ${order.customers?.full_name || ''} ${order.customers?.phone_original || ''} ${order.customers?.phone_normalized || ''} ${order.coupon_code || ''} ${docItems('order', order).map(item => item.product_name).join(' ')}`).includes(term)));
    const byDate = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    const byWait = (a, b) => Number(isOrderOpen(b)) - Number(isOrderOpen(a)) || byDate(b, a);
    visible.sort({ recent: byDate, waiting: byWait, high: (a, b) => Number(b.total) - Number(a.total), low: (a, b) => Number(a.total) - Number(b.total) }[state.sort]);
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').innerHTML = `<span>${plural(visible.length, 'pedido')} · ${formatMoney(visible.reduce((sum, order) => sum + Number(order.total || 0), 0))}</span>${state.q || state.status !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { state.q = ''; state.status = 'all'; state.page = 1; root.querySelector('[data-search]').value = ''; syncTabs(); render(); });
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map((order, position) => orderRowMarkup(order, index, position >= pageItems.length - 2 && pageItems.length > 3)).join('') : emptyMarkup(orders.length ? 'Sin pedidos en esta vista' : 'Sin pedidos todavía', orders.length ? 'Prueba con otra búsqueda o vista.' : 'Las solicitudes registradas por el checkout o manualmente aparecerán aquí.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-order]').forEach(card => bindOrderRow(card, orders.find(item => item.id === card.dataset.order), refresh));
  };
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.page = 1; render(); }, 250));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
  root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => tab.addEventListener('click', () => { state.status = tab.dataset.status; state.page = 1; syncTabs(); render(); }));
  root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => {
    state.status = tile.dataset.kpiView; state.page = 1; syncTabs(); render();
    root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#new-order').addEventListener('click', event => openOrderForm(refresh, event.currentTarget));
  render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=orders`); openOrderForm(refresh); }
}

function bindOrderRow(card, order, refresh) {
  card.querySelectorAll('[data-open-order]').forEach(button => button.addEventListener('click', event => openOrderDetail(order, refresh, event.currentTarget)));
  card.querySelector('[data-go-sale]')?.addEventListener('click', () => ctx.navigateTo('sales', { q: order.sales[0].sale_number }));
  card.querySelectorAll('[data-set-order-status]').forEach(button => button.addEventListener('click', async () => {
    const value = button.dataset.setOrderStatus;
    button.closest('details')?.removeAttribute('open');
    if (value === 'cancelado' && !await confirmAction(`¿Marcar ${order.order_number} como cancelado? Si tenía un cupón reservado, se libera.`, 'Cancelar pedido', { confirmLabel: 'Marcar cancelado', trigger: button })) return;
    setButtonLoading(button, true, 'Guardando…');
    try { await updateOrder(order.id, { status: value }); toast(`${order.order_number}: ${ORDER_STATUS[value].toLowerCase()}`); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar el pedido.'), 'error'); setButtonLoading(button, false); }
  }));
  card.querySelectorAll('[data-to-sale]').forEach(button => button.addEventListener('click', async () => {
    button.closest('details')?.removeAttribute('open');
    if (!await confirmAction(`Se creará una venta en estado solicitud con los importes de ${order.order_number}. El inventario se descuenta solo al confirmar la venta.`, 'Convertir a venta', { confirmLabel: 'Crear venta', tone: 'primary', trigger: button })) return;
    setButtonLoading(button, true, 'Revisando…');
    try {
      const sale = await runWithReview(accept => createSaleFromOrder(order.id, accept), button, 'Crear venta con importes del pedido');
      if (!sale) { setButtonLoading(button, false); return; }
      toast(`Venta ${sale.sale_number} creada. Confírmala para descontar inventario.`); ctx.navigateTo('sales', { q: sale.sale_number });
    } catch (error) { toast(requestError(error, 'No pudimos crear la venta.'), 'error'); setButtonLoading(button, false); }
  }));
  // Toda la tarjeta abre el detalle, salvo botones, enlaces y el menú.
  card.addEventListener('click', event => { if (!event.target.closest('button, a, details, summary')) openOrderDetail(order, refresh, card); });
}

const CONFLICT_LABELS = { full_name: 'Nombre', city: 'Ciudad', address: 'Dirección', birth_date: 'Fecha de nacimiento', cliente_archivado: 'Cliente archivado', telefono_de_ficha_fusionada: 'Teléfono de ficha fusionada' };

// Avance del pedido: recibido → contactado → confirmado → venta. Cancelado/abandonado cierran el flujo.
const ORDER_FLOW = [['pendiente', 'Recibido', 'bag'], ['contactado', 'Contactado', 'chat'], ['confirmado', 'Confirmado', 'checkCircle'], ['venta', 'En venta', 'wallet']];
const ORDER_STATUS_HINT = { pendiente: 'Aún nadie lo atiende', contactado: 'Ya hablaste con el cliente', confirmado: 'El cliente confirmó la compra', cancelado: 'El cliente desistió', abandonado: 'Sin respuesta del cliente' };

function orderFlowMarkup(order) {
  const closed = ['cancelado', 'abandonado'].includes(order.status);
  const reached = order.sales?.length ? ORDER_FLOW.length : Math.max(0, ORDER_FLOW.findIndex(([key]) => key === order.status));
  const steps = closed ? [...ORDER_FLOW.slice(0, 1), [order.status, ORDER_STATUS[order.status], 'x']] : ORDER_FLOW;
  return `<ol class="od-progress${closed ? ' od-progress--closed' : ''}" aria-label="Avance del pedido">${steps.map(([key, label, iconName], index) => {
    const state = closed ? (index === 0 ? 'done' : 'closed') : index < reached ? 'done' : index === reached ? 'current' : 'todo';
    return `<li class="is-${state}" ${state === 'current' || state === 'closed' ? 'aria-current="step"' : ''}><span class="od-progress__dot" aria-hidden="true">${icon(state === 'done' ? 'check' : iconName, { size: 14 })}</span><span class="od-progress__label">${escapeHtml(label)}</span></li>`;
  }).join('')}</ol>`;
}

function openOrderDetail(order, refresh, trigger, { fromProfile = false } = {}) {
  const customer = order.customers || {};
  const conflicts = Object.entries(order.customer_conflicts || {});
  const items = docItems('order', order);
  const sale = order.sales?.[0] || null;
  const phone = waDigits(customer);
  const editable = ['full_name', 'city', 'address', 'birth_date'];
  const activity = [
    [order.created_at, 'bag', 'Pedido registrado', SOURCES[order.source] || order.source],
    [order.legal_accepted_at, 'shield', 'Aceptó Términos y Política', `Términos ${order.terms_version || '—'} · Política ${order.data_policy_version || '—'}`],
    [order.whatsapp_opened_at, 'whatsapp', 'WhatsApp preparado', 'Abrir WhatsApp no confirma que el mensaje se envió'],
    [order.updated_at && order.updated_at !== order.created_at ? order.updated_at : null, 'clock', 'Última actualización', ORDER_STATUS[order.status] || order.status]
  ].filter(([when]) => when).sort((a, b) => new Date(a[0]) - new Date(b[0]));
  const form = document.createElement('form');
  form.className = 'admin-form flow-form order-detail';
  form.noValidate = true;
  form.innerHTML = `<div class="flow-form__body od-body">
    <section class="od-hero">
      <div class="od-hero__top">
        <div class="od-hero__id"><span class="od-hero__kicker">${icon(order.source === 'tienda' ? 'store' : order.source === 'WhatsApp' ? 'whatsapp' : 'pencil', { size: 14 })}Pedido · ${escapeHtml(SOURCES[order.source] || order.source)}</span><div class="od-hero__pills">${pill(order.status, ORDER_STATUS)}${sale ? `<span class="status-pill status-pill--success">Venta ${escapeHtml(sale.sale_number)}</span>` : ''}</div><p>Registrado ${dateTimeText(order.created_at)}</p></div>
        <div class="od-hero__amount"><small>Total del pedido</small><strong>${formatMoney(order.total)}</strong><span>${plural(items.length, 'producto')} · ${plural(docUnits(items), 'unidad', 'unidades')}</span></div>
      </div>
      ${orderFlowMarkup(order)}
    </section>
    ${conflicts.length ? `<section class="notice-box od-conflicts"><div class="od-conflicts__head">${icon('alert', { size: 20 })}<div><h3>Datos distintos a la ficha del cliente</h3><p>El cliente escribió datos diferentes a los de su ficha. El teléfono no verifica identidad: revisa antes de aplicar.</p></div></div><ul>${conflicts.map(([key, value]) => `<li><div><small>${escapeHtml(CONFLICT_LABELS[key] || key)}</small><strong>${escapeHtml(String(value))}</strong>${editable.includes(key) ? `<span>En la ficha: ${escapeHtml(String(customer[key] ?? '—'))}</span>` : ''}</div>${editable.includes(key) ? `<button class="small-btn" data-apply="${key}" type="button">Aplicar a la ficha</button>` : ''}</li>`).join('')}</ul></section>` : ''}
    <div class="od-layout">
      <div class="od-main">
        <section class="doc-section od-products"><header><h3>${icon('package', { size: 18 })}Productos solicitados</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items, { doc: order })}${docTotalsMarkup(order, items)}${couponDetailMarkup(order)}</section>
        ${order.notes ? `<section class="od-note">${icon('chat', { size: 18 })}<div><small>Observaciones del cliente</small><p>${escapeHtml(order.notes)}</p></div></section>` : ''}
        <section class="od-manage" aria-labelledby="od-manage-title">
          <header><h3 id="od-manage-title">${icon('sliders', { size: 18 })}Gestionar pedido</h3><span class="od-manage__state" data-dirty-state>Sin cambios</span></header>
          <fieldset class="od-status"><legend>Estado del pedido</legend><div class="od-status__grid">${Object.entries(ORDER_STATUS).map(([value, label]) => `<label class="od-status__opt od-status__opt--${value}"><input type="radio" name="status" value="${value}" ${order.status === value ? 'checked' : ''}><span><i aria-hidden="true"></i><strong>${label}</strong><small>${ORDER_STATUS_HINT[value] || ''}</small></span></label>`).join('')}</div></fieldset>
          <label class="od-notes">Notas internas <small>Solo las ve el equipo</small><textarea name="admin_notes" rows="3" placeholder="Ej. llamó a las 3 p. m., confirma mañana…">${escapeHtml(order.admin_notes || '')}</textarea></label>
        </section>
      </div>
      <aside class="od-aside">
        <section class="od-card od-customer">
          <div class="od-customer__id"><span class="od-customer__avatar" aria-hidden="true">${escapeHtml(initials(customer.full_name))}</span><div><small>Cliente</small><strong>${escapeHtml(customer.full_name || '—')}</strong>${customer.phone_original ? `<span>${escapeHtml(customer.phone_original)}</span>` : ''}${customer.city ? `<span>${escapeHtml(customer.city)}</span>` : ''}</div></div>
          <div class="od-customer__actions">${phone ? `<a class="small-btn od-wa" href="${waLink(phone, `Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()} sobre tu pedido ${order.order_number}.`)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}WhatsApp</a>` : ''}${customerLink(order.customer_id, fromProfile).replace('class="link-btn"', 'class="small-btn"').replace('Ver ficha y análisis →', `${icon('user', { size: 16 })}Ver ficha`)}</div>
        </section>
        <section class="od-card">
          <h3>Entrega y pago</h3>
          <dl class="od-facts">
            <div><dt>${icon('truck', { size: 16 })}Entrega</dt><dd><strong>${escapeHtml(order.delivery_name || 'Sin definir')}</strong>${order.shipping_city || order.shipping_address ? `<span>${escapeHtml([order.shipping_address, order.shipping_city].filter(Boolean).join(', '))}</span>` : ''}<span>Costo: ${Number(order.delivery_cost) ? formatMoney(order.delivery_cost) : 'sin costo'}</span></dd></div>
            <div><dt>${icon('wallet', { size: 16 })}Pago preferido</dt><dd><strong>${escapeHtml(order.payment_name || 'Sin definir')}</strong></dd></div>
            <div><dt>${icon('shield', { size: 16 })}Aceptación legal</dt><dd>${order.legal_accepted_at ? `<strong class="od-ok">Aceptó Términos y Política</strong><span>${dateTimeText(order.legal_accepted_at)}</span>` : `<strong>${order.source === 'tienda' ? 'Sin aceptación registrada' : 'Registrado por el panel'}</strong><span>${order.source === 'tienda' ? 'Pedido anterior a la aceptación obligatoria' : 'Confirma la aceptación por el canal de contacto'}</span>`}</dd></div>
          </dl>
        </section>
        <section class="od-card">
          <h3>Actividad</h3>
          <ol class="od-timeline">${activity.map(([when, iconName, title, detail]) => `<li><span class="od-timeline__dot" aria-hidden="true">${icon(iconName, { size: 13 })}</span><div><strong>${escapeHtml(title)}</strong><small>${dateTimeText(when)}${detail ? ` · ${escapeHtml(detail)}` : ''}</small></div></li>`).join('')}${sale ? `<li class="is-sale"><span class="od-timeline__dot" aria-hidden="true">${icon('wallet', { size: 13 })}</span><div><strong>Convertido en venta ${escapeHtml(sale.sale_number)}</strong><small>Estado de la venta: ${escapeHtml(SALE_STATUS[sale.status] || sale.status || '—')}</small></div></li>` : ''}</ol>
        </section>
      </aside>
    </div>
  </div>
  <div class="flow-form__footer od-footer">
    <p class="od-footer__hint" data-footer-hint>${sale ? `Este pedido ya se convirtió en la venta <b>${escapeHtml(sale.sale_number)}</b>.` : 'Cuando el cliente confirme, conviértelo en venta para cobrar y descontar inventario.'}</p>
    <div class="flow-form__actions od-actions">
      <button class="btn btn--ghost" type="submit" data-save disabled>${icon('check', { size: 18 })}<span>Guardar cambios</span></button>
      ${sale ? `<button class="btn btn--primary" data-go-sale type="button"><span>Ver venta ${escapeHtml(sale.sale_number)}</span>${icon('arrowRight', { size: 18 })}</button>` : `<button class="btn btn--primary" data-to-sale type="button"><span>Convertir a venta</span>${icon('arrowRight', { size: 18 })}</button>`}
    </div>
  </div>`;
  const initial = { status: order.status, notes: order.admin_notes || '' };
  const current = () => ({ status: form.querySelector('[name="status"]:checked')?.value || order.status, notes: form.elements.admin_notes.value.trim() });
  const dirty = () => { const now = current(); return now.status !== initial.status || now.notes !== initial.notes.trim(); };
  const syncDirty = () => {
    const changed = dirty(); form.querySelector('[data-save]').disabled = !changed;
    const state = form.querySelector('[data-dirty-state]'); state.textContent = changed ? 'Cambios sin guardar' : 'Sin cambios'; state.classList.toggle('is-dirty', changed);
  };
  form.addEventListener('input', syncDirty); form.addEventListener('change', syncDirty);
  const modal = openModal({ title: `Pedido ${order.order_number}`, description: `${customer.full_name || 'Cliente'} · ${SOURCES[order.source] || order.source} · ${dateTimeText(order.created_at)}`, headerIcon: icon('bag', { size: 22 }), content: form, trigger, className: 'modal--wide modal--flow modal--order-detail', closeOnBackdrop: false, beforeClose: async () => !dirty() || confirmAction('Cambiaste el estado o las notas y no los has guardado.', 'Descartar cambios', { confirmLabel: 'Descartar cambios', cancelLabel: 'Seguir editando' }) });
  bindCustomerLinks(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!dirty()) return;
    const button = form.querySelector('[data-save]'); const now = current();
    setButtonLoading(button, true, 'Guardando…');
    try { await updateOrder(order.id, { status: now.status, admin_notes: now.notes || null }); toast('Pedido actualizado'); modal.close(true); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar el pedido.'), 'error'); setButtonLoading(button, false); }
  });
  form.querySelectorAll('[data-apply]').forEach(button => button.addEventListener('click', async () => {
    const key = button.dataset.apply;
    setButtonLoading(button, true, 'Aplicando…');
    try { await saveCustomer({ [key]: order.customer_conflicts[key] }, order.customer_id); toast('Ficha actualizada'); button.replaceWith(Object.assign(document.createElement('span'), { className: 'od-applied', textContent: '✓ Aplicado' })); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar la ficha.'), 'error'); setButtonLoading(button, false); }
  }));
  form.querySelector('[data-go-sale]')?.addEventListener('click', () => { modal.close(true); ctx.navigateTo('sales', { q: sale.sale_number }); });
  form.querySelector('[data-to-sale]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    setButtonLoading(button, true, 'Revisando…');
    try {
      const created = await runWithReview(accept => createSaleFromOrder(order.id, accept), button, 'Crear venta con importes del pedido');
      if (!created) { setButtonLoading(button, false); return; }
      toast(`Venta ${created.sale_number} creada. Confírmala para descontar inventario.`); modal.close(true); ctx.navigateTo('sales', { q: created.sale_number });
    } catch (error) { toast(requestError(error, 'No pudimos crear la venta.'), 'error'); setButtonLoading(button, false); }
  });
}

const ORDER_SOURCES = [['WhatsApp', 'WhatsApp', 'Por chat', 'whatsapp'], ['presencial', 'Presencial', 'En el local', 'store'], ['manual', 'Manual', 'Otro canal', 'pencil']];

async function openOrderForm(refresh, trigger = null) {
  const loaded = await withLoading(() => Promise.all([getCustomers(), getDeliveryMethods({ all: true }), getPaymentMethods({ all: true })]), { title: 'Preparando nuevo pedido', steps: ['Cargando clientes…', 'Cargando métodos de entrega…', 'Cargando métodos de pago…'], trigger });
  if (!loaded) return;
  const [customers, allDeliveries, allPayments] = loaded;
  const deliveries = allDeliveries.filter(item => item.active !== false);
  const payments = allPayments.filter(item => item.active !== false);
  const deliveryById = new Map(deliveries.map(item => [item.id, item]));
  const costLabel = value => Number(value) > 0 ? formatMoney(Number(value)) : 'Sin costo';
  const step = (number, key, title, hint, body, extra = '') => `<section class="flow-step" data-step="${key}"><header class="flow-step__head"><span class="flow-step__num" aria-hidden="true"><b>${number}</b>${icon('check', { size: 15 })}</span><div><h3>${title}</h3><p>${hint}</p></div>${extra}</header>${body}</section>`;
  const form = document.createElement('form');
  form.className = 'admin-form flow-form order-form';
  form.noValidate = true;
  form.innerHTML = `<div class="flow-form__body form-grid">
    <div class="flow-form__main">
      ${step(1, 'customer', 'Cliente', 'Busca por nombre, teléfono o documento, o créalo en un clic.', customerPickerMarkup(customers), '<span class="flow-step__state" data-state="customer">Pendiente</span>')}
      ${step(2, 'lines', 'Productos', 'Se usan los precios vigentes del catálogo.<span class="flow-hint-keys"> · ↑ ↓ y Enter para agregar rápido</span>', lineEditorMarkup(), '<span class="flow-step__state" data-state="lines">Pendiente</span>')}
      ${step(3, 'delivery', 'Entrega', 'Elige cómo recibirá el pedido; el costo se completa solo y puedes ajustarlo.', `
        <fieldset class="flow-choice"><legend class="sr-only">Método de entrega</legend><div class="flow-choice__grid of-deliveries">
          <label class="flow-choice__opt"><input type="radio" name="delivery_method_id" value="" checked><span class="flow-choice__card">${icon('clock', { size: 20 })}<strong>Sin definir</strong><small>Se acuerda después</small></span></label>
          ${deliveries.map(item => `<label class="flow-choice__opt"><input type="radio" name="delivery_method_id" value="${item.id}"><span class="flow-choice__card">${icon(item.requires_address ? 'truck' : 'store', { size: 20 })}<strong>${escapeHtml(item.name)}</strong><small>${costLabel(item.base_cost)}${item.requires_address ? ' · con dirección' : item.requires_city ? ' · con ciudad' : ''}</small></span></label>`).join('')}
        </div></fieldset>
        <div class="of-shipping">
          <label class="flow-money">Costo de entrega <small data-cost-hint>COP</small><span class="flow-money__field"><b aria-hidden="true">$</b><input name="delivery_cost" data-money type="text" inputmode="decimal" value="0"></span></label>
          <div class="of-address" data-address>
            <p class="of-address__note" data-address-note></p>
            <div class="of-address__grid">
              <label>Ciudad de envío <small data-req="city">Opcional</small><span class="cf-control cf-control--icon">${icon('pin', { size: 18 })}<input name="city" maxlength="80" autocomplete="off" placeholder="Ej. Valledupar"></span></label>
              <label class="of-address__wide">Dirección de envío <small data-req="address">Opcional</small><span class="cf-control cf-control--icon">${icon('navigation', { size: 18 })}<input name="address" maxlength="250" autocomplete="off" placeholder="Barrio, calle y número"></span></label>
            </div>
          </div>
        </div>`, '<span class="flow-step__state flow-step__state--soft" data-state="delivery">Sin definir</span>')}
    </div>
    <aside class="flow-form__aside">
      ${step(4, 'details', 'Origen y pago', 'Por dónde llegó el pedido y cómo prefiere pagar el cliente.', `
        <fieldset class="flow-choice"><legend>Origen del pedido</legend><div class="flow-choice__grid">${ORDER_SOURCES.map(([value, label, hint, iconName], index) => `<label class="flow-choice__opt"><input type="radio" name="source" value="${value}" ${index === 0 ? 'checked' : ''}><span class="flow-choice__card">${icon(iconName, { size: 20 })}<strong>${label}</strong><small>${hint}</small></span></label>`).join('')}</div></fieldset>
        <fieldset class="flow-pay of-pay"><legend>Pago preferido <small>Opcional</small></legend><div class="flow-pay__chips">
          <label class="of-pay__opt"><input type="radio" name="payment_method_id" value="" checked><span class="flow-chip">Sin definir</span></label>
          ${payments.map(item => `<label class="of-pay__opt"><input type="radio" name="payment_method_id" value="${item.id}"><span class="flow-chip">${escapeHtml(item.name)}</span></label>`).join('')}
        </div></fieldset>
        <details class="flow-notes"><summary>${icon('pencil', { size: 16 })}<span>Observaciones</span><small data-notes-state>Opcional</small>${icon('chevronDown', { size: 16 })}</summary><label class="flow-notes__body"><span class="sr-only">Observaciones</span><textarea name="notes" rows="3" placeholder="Ej. llamar antes de entregar, horario preferido…"></textarea></label></details>`)}
      <section class="flow-summary" aria-label="Resumen del pedido">
        <header><span>Resumen</span><b data-sum-units>Sin productos</b></header>
        <dl><div><dt>Subtotal</dt><dd data-sum-gross>${formatMoney(0)}</dd></div><div><dt>Entrega</dt><dd data-sum-delivery>Sin costo</dd></div></dl>
        <div class="flow-summary__total"><span>Total</span><strong data-sum-total>${formatMoney(0)}</strong></div>
        <p class="flow-summary__mode">${icon('info', { size: 15 })}<span>Se registra como pedido <b>contactado</b>. No descuenta inventario: luego podrás convertirlo en venta.</span></p>
      </section>
    </aside>
  </div>
  <div class="flow-form__footer">
    <p class="product-form-error flow-form__error" data-error role="alert" tabindex="-1" hidden></p>
    <ul class="flow-form__ready" aria-label="Datos requeridos"><li data-ready="customer">${icon('check', { size: 13 })}Cliente</li><li data-ready="lines">${icon('check', { size: 13 })}Productos</li><li data-ready="delivery" hidden>${icon('check', { size: 13 })}Dirección</li></ul>
    <div class="flow-form__total"><small>Total del pedido</small><strong data-footer-total>${formatMoney(0)}</strong></div>
    <div class="flow-form__actions"><button class="btn btn--ghost" data-cancel type="button">Cancelar</button><button class="btn btn--primary" type="submit">Registrar pedido</button></div>
  </div>`;

  const el = name => form.elements[name];
  const selectedDelivery = () => deliveryById.get(form.querySelector('[name="delivery_method_id"]:checked')?.value || '') || null;
  const needs = () => { const method = selectedDelivery(); return { city: Boolean(method?.requires_city || method?.requires_address), address: Boolean(method?.requires_address) }; };
  const addressUsed = () => { const method = selectedDelivery(); return !method || method.requires_city || method.requires_address; };
  const addressProblem = () => { const need = needs(); return need.city && !String(el('city').value).trim() ? `Escribe la ciudad de envío (la requiere ${selectedDelivery().name}).` : need.address && !String(el('address').value).trim() ? `Escribe la dirección de envío (la requiere ${selectedDelivery().name}).` : ''; };
  let editor = null;
  let addressFromProfile = false;
  const sync = totals => {
    if (totals) {
      form.querySelector('[data-sum-gross]').textContent = formatMoney(totals.gross);
      form.querySelector('[data-sum-delivery]').textContent = totals.delivery ? formatMoney(totals.delivery) : 'Sin costo';
      form.querySelector('[data-sum-total]').textContent = formatMoney(totals.total);
      form.querySelector('[data-footer-total]').textContent = formatMoney(totals.total);
    }
    const items = editor?.items() || []; const units = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    form.querySelector('[data-sum-units]').textContent = items.length ? `${plural(items.length, 'producto', 'productos')} · ${plural(units, 'unidad', 'unidades')}` : 'Sin productos';
    const method = selectedDelivery(); const need = needs(); const used = addressUsed();
    const ready = { customer: Boolean(el('customer_id').value), lines: items.length > 0, delivery: !addressProblem() };
    ['customer', 'lines'].forEach(key => {
      form.querySelector(`[data-step="${key}"]`).classList.toggle('is-done', ready[key]);
      form.querySelector(`[data-state="${key}"]`).textContent = ready[key] ? (key === 'lines' ? plural(items.length, 'producto', 'productos') : 'Listo') : 'Pendiente';
    });
    Object.entries(ready).forEach(([key, done]) => form.querySelector(`[data-ready="${key}"]`).classList.toggle('is-done', done));
    form.querySelector('[data-ready="delivery"]').hidden = !(need.city || need.address);
    form.querySelector('[data-step="delivery"]').classList.toggle('is-done', Boolean(method) && ready.delivery);
    const deliveryState = form.querySelector('[data-state="delivery"]');
    deliveryState.textContent = method ? (ready.delivery ? method.name : 'Falta dirección') : 'Sin definir';
    deliveryState.classList.toggle('flow-step__state--soft', !method);
    form.querySelector('[data-step="details"]').classList.toggle('is-done', ready.customer && ready.lines && ready.delivery);
    // Dirección: visible si el método la usa (o si aún no hay método); obligatoria según el método.
    const address = form.querySelector('[data-address]'); address.hidden = !used;
    [['city', need.city], ['address', need.address]].forEach(([key, required]) => { const tag = form.querySelector(`[data-req="${key}"]`); tag.textContent = required ? 'Obligatoria' : 'Opcional'; tag.classList.toggle('is-required', required); });
    form.querySelector('[data-address-note]').innerHTML = addressFromProfile ? `${icon('user', { size: 14 })}Tomada de la ficha del cliente; ajústala si este envío va a otro lugar.` : method ? '' : `${icon('info', { size: 14 })}Si ya conoces el destino, anótalo; si no, déjalo para después.`;
    form.querySelector('[data-address-note]').hidden = !form.querySelector('[data-address-note]').innerHTML;
    form.querySelector('[data-cost-hint]').textContent = method ? `COP · base de ${method.name}: ${costLabel(method.base_cost)}` : 'COP';
  };
  editor = mountLineEditor(form, { deliveryInput: el('delivery_cost'), onChange: totals => sync(totals) });
  bindCustomerPicker(form, customers);
  editor.total();
  // Al elegir cliente, se completa la dirección con su ficha si aún está vacía.
  el('customer_id').addEventListener('change', () => {
    const chosen = customers.find(item => item.id === el('customer_id').value);
    if (chosen && !el('city').value && !el('address').value && (chosen.city || chosen.address)) { el('city').value = chosen.city || ''; el('address').value = chosen.address || ''; addressFromProfile = true; }
    sync();
  });
  ['city', 'address'].forEach(name => el(name).addEventListener('input', () => { addressFromProfile = false; sync(); }));
  form.querySelectorAll('[name="delivery_method_id"]').forEach(input => input.addEventListener('change', () => {
    el('delivery_cost').value = editableMoney(Number(selectedDelivery()?.base_cost || 0)); el('delivery_cost').dispatchEvent(new Event('input'));
    sync(); if (addressProblem()) setTimeout(() => (needs().city && !el('city').value ? el('city') : el('address')).focus(), 50);
  }));
  form.querySelectorAll('[name="source"],[name="payment_method_id"]').forEach(input => input.addEventListener('change', () => sync()));
  el('notes').addEventListener('input', () => { form.querySelector('[data-notes-state]').textContent = el('notes').value.trim() ? 'Con información' : 'Opcional'; });
  sync();

  const guard = guardUnsaved(() => JSON.stringify(Object.fromEntries(new FormData(form))) + editor.signature());
  const modal = openModal({ title: 'Registrar pedido', description: 'Pedido recibido por WhatsApp o en persona, con precios vigentes del catálogo.', headerIcon: icon('bag', { size: 22 }), content: form, trigger, className: 'modal--wide modal--flow modal--order', initialFocus: '[data-customer-search]', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  form.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  const requestKey = crypto.randomUUID();
  let saving = false;
  const showError = (message, target = null) => {
    const error = form.querySelector('[data-error]'); error.textContent = message; error.hidden = false; error.dataset.kind = target ? 'validation' : 'save';
    (target || error).focus({ preventScroll: !target }); target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  // Un aviso de validación se retira en cuanto el usuario corrige algo; los errores del servidor se quedan.
  const clearValidation = () => { const error = form.querySelector('[data-error]'); if (error.dataset.kind === 'validation') error.hidden = true; };
  form.addEventListener('input', clearValidation); form.addEventListener('change', clearValidation);
  form.addEventListener('click', event => { if (event.target.closest('[data-line-option],[data-customer-option],[data-remove-line]')) clearValidation(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    form.querySelector('[data-error]').hidden = true; const data = new FormData(form);
    const delivery = parseMoneyInput(data.get('delivery_cost'));
    if (!data.get('customer_id')) { showError('Selecciona o crea el cliente.', form.querySelector('[data-customer-search]')); return; }
    const lineProblem = editor.validate();
    if (lineProblem) { showError(lineProblem, form.querySelector('[data-line-search]')); return; }
    if (delivery == null) { showError('Revisa el costo de entrega.', el('delivery_cost')); return; }
    const shipping = addressProblem();
    if (shipping) { showError(shipping, needs().city && !String(el('city').value).trim() ? el('city') : el('address')); return; }
    const button = event.submitter || form.querySelector('[type="submit"]'); saving = true; modal.setDismissible(false); setButtonLoading(button, true, 'Registrando…');
    const used = addressUsed();
    try {
      const order = await createAdminOrder({ customer_id: data.get('customer_id'), source: data.get('source'), delivery_method_id: data.get('delivery_method_id'), payment_method_id: data.get('payment_method_id'), delivery_cost: delivery, city: used ? data.get('city') : '', address: used ? data.get('address') : '', notes: data.get('notes'), items: editor.items(), request_key: requestKey });
      toast(`Pedido ${order.order_number} registrado`); modal.close(true); await refresh();
    } catch (saveError) { saving = false; modal.setDismissible(true); setButtonLoading(button, false); showError(requestError(saveError, 'No pudimos registrar el pedido.')); }
  });
}

// --- Cotizaciones -----------------------------------------------------------------
async function downloadDocument(kind, doc, config, button) {
  setButtonLoading(button, true, 'Generando…');
  try {
    const filename = await downloadCommercialDocument({ kind, doc, settings: config });
    toast(`${filename} descargado`);
  } catch (error) { toast(requestError(error, 'No pudimos generar el PDF.'), 'error'); }
  finally { setButtonLoading(button, false); }
}

async function printDocument(kind, doc, config, button) {
  setButtonLoading(button, true, 'Preparando…');
  try { await printCommercialDocument({ kind, doc, settings: config }); }
  catch (error) { toast(requestError(error, 'No pudimos preparar la impresión.'), 'error'); }
  finally { setButtonLoading(button, false); }
}

// --- Cotizaciones: embudo, vigencia y siguiente paso -----------------------------------
// "Abiertas" excluye las de vigencia vencida (siguen editables, pero ya no son negociables
// sin renovarlas). Los estados sueltos llegan por URL (?status=enviada) y se respetan.
const daysUntil = iso => Math.round((new Date(`${iso}T12:00:00`) - new Date(`${bogotaTodayIso()}T12:00:00`)) / 86400000);
const isQuoteOpen = quote => OPEN_QUOTE.includes(quote.status) && !isQuoteExpired(quote);
const expiresSoon = quote => isQuoteOpen(quote) && quote.valid_until && daysUntil(quote.valid_until) <= 3;
const QUOTE_VIEWS = {
  open: { label: 'Abiertas', match: isQuoteOpen },
  borrador: { label: 'Por enviar', match: quote => quote.status === 'borrador' && !isQuoteExpired(quote) },
  enviada: { label: 'Enviadas', match: quote => quote.status === 'enviada' && !isQuoteExpired(quote) },
  aceptada: { label: 'Aceptadas', match: quote => quote.status === 'aceptada' && !isQuoteExpired(quote) },
  expiring: { label: 'Vencen pronto', match: expiresSoon },
  vencida: { label: 'Vencidas', match: quote => quote.status === 'vencida' || isQuoteExpired(quote) },
  convertida: { label: 'Convertidas', match: quote => quote.status === 'convertida' },
  rechazada: { label: 'Rechazadas', match: quote => quote.status === 'rechazada' },
  all: { label: 'Todas', match: () => true }
};
const QUOTE_SORTS = { recent: 'Más recientes', expiring: 'Vencen primero', high: 'Mayor valor', low: 'Menor valor' };

function quotesKpisMarkup(quotes) {
  const sum = list => list.reduce((total, quote) => total + Number(quote.total || 0), 0);
  const open = quotes.filter(isQuoteOpen); const drafts = quotes.filter(QUOTE_VIEWS.borrador.match); const soon = quotes.filter(expiresSoon);
  const converted = quotes.filter(quote => quote.status === 'convertida');
  const decided = converted.length + quotes.filter(quote => ['rechazada', 'vencida'].includes(quote.status) || isQuoteExpired(quote)).length;
  const rate = decided ? Math.round((converted.length / decided) * 100) : null;
  return `<section class="sales-kpis" aria-label="Resumen de cotizaciones">
    ${kpiTileMarkup({ tone: 'hero', iconName: 'layers', label: 'En negociación', value: formatMoney(sum(open)), detail: `${plural(open.length, 'cotización abierta', 'cotizaciones abiertas')}${open.length ? ` · ticket promedio ${formatMoney(Math.round(sum(open) / open.length))}` : ''}` })}
    ${kpiTileMarkup({ view: 'borrador', tone: 'warning', iconName: 'pencil', label: 'Por enviar', value: drafts.length, detail: drafts.length ? `${formatMoney(sum(drafts))} en borradores` : 'Todo enviado' })}
    ${kpiTileMarkup({ view: 'expiring', tone: 'danger', iconName: 'clock', label: 'Vencen pronto', value: soon.length, detail: soon.length ? `${formatMoney(sum(soon))} en los próximos 3 días` : 'Ninguna vence en 3 días' })}
    ${kpiTileMarkup({ view: 'convertida', tone: 'success', iconName: 'checkCircle', label: 'Conversión', value: rate == null ? '—' : `${rate} %`, detail: decided ? `${converted.length} de ${plural(decided, 'cerrada', 'cerradas')} · ${formatMoney(sum(converted))} vendidos` : 'Aún no hay cotizaciones cerradas' })}
  </section>`;
}

function quoteValidityMarkup(quote) {
  if (quote.status === 'convertida') return `<span class="validity validity--done">${icon('checkCircle', { size: 13 })}Convertida en venta</span>`;
  if (quote.status === 'rechazada') return `<span class="validity validity--bad">${icon('x', { size: 13 })}Rechazada por el cliente</span>`;
  if (!quote.valid_until) return `<span class="validity">${icon('clock', { size: 13 })}Sin vigencia definida</span>`;
  const days = daysUntil(quote.valid_until);
  if (days < 0 || quote.status === 'vencida') return `<span class="validity validity--bad">${icon('clock', { size: 13 })}Venció ${days < 0 ? (days === -1 ? 'ayer' : `hace ${-days} días`) : dateText(quote.valid_until)}</span>`;
  const label = days === 0 ? 'Vence hoy' : days === 1 ? 'Vence mañana' : `Vence en ${days} días`;
  return `<span class="validity ${days <= 3 ? 'validity--soon' : 'validity--ok'}" title="Válida hasta ${escapeHtml(dateText(quote.valid_until))}">${icon('clock', { size: 13 })}${label}<small>· ${escapeHtml(dateText(quote.valid_until))}</small></span>`;
}

function quoteProgressMarkup(quote) {
  if (['rechazada', 'vencida'].includes(quote.status)) return '';
  const reached = { borrador: 1, enviada: 2, aceptada: 3, convertida: 4 }[quote.status] || 1;
  const steps = [['Borrador', quote.created_at], ['Enviada', quote.sent_at], ['Aceptada', null], ['Venta', null]];
  return `<ol class="sale-progress" aria-label="Avance: ${reached} de 4">${steps.map(([label, date], position) => `<li class="${position < reached ? 'is-done' : ''}" title="${label}${date ? ` · ${dateTimeText(date)}` : ''}"><span></span><small>${label}</small></li>`).join('')}</ol>`;
}

// Acción principal según la etapa; el resto va al menú (cada data-* aparece una vez).
function quoteRowActions(quote, menuUp) {
  const editable = ['borrador', 'enviada'].includes(quote.status); const expired = isQuoteExpired(quote);
  const canSend = Boolean(waDigits(quote.customers)); const canConvert = OPEN_QUOTE.includes(quote.status);
  let primary;
  if (expired && editable) primary = ['data-edit-quote', 'Renovar vigencia', 'history', true];
  else if (quote.status === 'borrador') primary = canSend ? ['data-send-quote', 'Enviar por WhatsApp', 'whatsapp', true] : ['data-edit-quote', 'Editar', 'pencil', false];
  else if (canConvert) primary = ['data-quote-sale', 'Convertir a venta', 'arrowRight', true];
  else primary = ['data-view-quote', 'Ver detalle', 'external', false];
  const statusTargets = quote.status === 'convertida' ? [] : [['enviada', 'Marcar enviada', 'chat'], ['aceptada', 'Marcar aceptada', 'checkCircle'], ['rechazada', 'Marcar rechazada', 'x'], ['vencida', 'Marcar vencida', 'clock']].filter(([value]) => value !== quote.status);
  const menu = [
    ['data-view-quote', 'Ver detalle', 'external'], editable && ['data-edit-quote', 'Editar', 'pencil'],
    ['data-download-quote', 'Descargar PDF', 'download'], ['data-print-quote', 'Imprimir', 'printer'], canSend && ['data-send-quote', 'Enviar por WhatsApp', 'whatsapp'],
    canConvert && ['data-quote-sale', 'Convertir a venta', 'arrowRight']
  ].filter(entry => entry && entry[0] !== primary[0]);
  const status = statusTargets.map(([value, label, iconName]) => `<button data-set-quote-status="${value}" type="button">${icon(iconName, { size: 16 })}<span>${label}</span></button>`).join('');
  const remove = quote.status !== 'convertida' && !quote.converted_sale_id ? `<button class="is-danger" data-delete-quote type="button">${icon('trash', { size: 16 })}<span>Eliminar</span></button>` : '';
  return `<div class="sale-row__actions"><button class="small-btn ${primary[3] ? 'small-btn--primary' : ''} sale-row__primary" ${primary[0]} type="button">${icon(primary[2], { size: 16 })}<span>${primary[1]}</span></button><details class="action-menu sale-menu ${menuUp ? 'action-menu--up' : ''}"><summary aria-label="Más acciones para ${escapeHtml(quote.quote_number)}" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${menu.map(([attr, label, iconName]) => `<button ${attr} type="button">${icon(iconName, { size: 16 })}<span>${label}</span></button>`).join('')}${status ? `<p class="action-menu__label">Cambiar estado</p>${status}` : ''}${remove}</div></details></div>`;
}

function quoteRowMarkup(quote, index, menuUp) {
  const items = docItems('quote', quote);
  const name = quote.customer_snapshot?.full_name || quote.customers?.full_name || 'Cliente';
  const thumbs = items.slice(0, 2).map(item => `<img src="${escapeHtml(describeLine(item, index).image)}" alt="" loading="lazy" decoding="async">`).join('');
  const expired = isQuoteExpired(quote); const discount = Number(quote.discount_total) || 0;
  return `<article class="sale-row quote-row" data-quote="${quote.id}" data-status="${expired ? 'vencida' : quote.status}">
    <span class="sale-row__thumbs" aria-hidden="true">${thumbs || `<b>${icon('layers', { size: 18 })}</b>`}${items.length > 2 ? `<b>+${items.length - 2}</b>` : ''}</span>
    <div class="sale-row__main">
      <div class="sale-row__title"><strong>${escapeHtml(quote.quote_number)}</strong>${pill(quote.status, QUOTE_STATUS)}${expired ? '<span class="status-pill status-pill--danger">Vigencia vencida</span>' : ''}</div>
      <p class="sale-row__customer"><span class="sale-row__avatar" aria-hidden="true">${escapeHtml(initials(name))}</span><span>${escapeHtml(name)}</span></p>
      <p class="sale-row__items">${escapeHtml(itemsPreview(items, 2))}</p>
    </div>
    <div class="sale-row__flow">${quoteProgressMarkup(quote)}<div class="quote-row__meta">${quoteValidityMarkup(quote)}<small class="sale-row__meta">${icon('pencil', { size: 13 })}Creada ${escapeHtml(dateText(quote.created_at))}${quote.sent_at ? ` · enviada ${escapeHtml(dateText(quote.sent_at))}` : ''}</small></div></div>
    <div class="sale-row__amount"><strong>${formatMoney(quote.total)}</strong>${discount ? `<small class="quote-row__discount">${icon('percent', { size: 13 })}Descuento ${formatMoney(discount)}</small>` : ''}<span>${plural(items.length, 'línea')} · ${plural(docUnits(items), 'unidad', 'unidades')}</span></div>
    ${quoteRowActions(quote, menuUp)}
  </article>`;
}

export async function renderQuotes() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'open', sort: params.get('sort') || 'recent', page: Number(params.get('page')) || 1 };
  if (!QUOTE_SORTS[state.sort]) state.sort = 'recent';
  if (!QUOTE_VIEWS[state.status]) state.status = 'open';
  const quotes = await getQuotes();
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Documentos', 'Cotizaciones', 'Prepara, envía y cierra propuestas. Las cotizaciones no reservan ni descuentan inventario; al convertirlas se crea una venta en solicitud.', '<button id="new-quote" class="btn btn--primary" type="button">+ Nueva cotización</button>')
    + quotesKpisMarkup(quotes)
    + `<section class="admin-panel sales-panel">
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar número, cliente, teléfono o producto" aria-label="Buscar cotizaciones"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar cotizaciones">${Object.entries(QUOTE_SORTS).map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar cotizaciones">${Object.entries(QUOTE_VIEWS).map(([value, view]) => `<button class="sales-tab ${state.status === value ? 'active' : ''}" data-status="${value}" type="button" aria-pressed="${state.status === value}"><span>${view.label}</span><b>${quotes.filter(view.match).length}</b></button>`).join('')}</div>
      <p class="results-meta" data-results-meta aria-live="polite"></p>
      <div class="sales-list" data-list></div><div data-pagination></div>
    </section>`;
  const refresh = () => renderQuotes();
  const index = lineIndex();
  const syncTabs = () => root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => { const active = tab.dataset.status === state.status; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  const render = () => {
    syncUrl('quotes', { ...state, status: state.status === 'open' ? '' : state.status, sort: state.sort === 'recent' ? '' : state.sort });
    const term = normalizeText(state.q);
    const visible = quotes.filter(quote => QUOTE_VIEWS[state.status].match(quote) && (!term || normalizeText(`${quote.quote_number} ${quote.customers?.full_name || ''} ${quote.customer_snapshot?.full_name || ''} ${quote.customers?.phone_original || ''} ${docItems('quote', quote).map(item => item.product_name).join(' ')}`).includes(term)));
    const byDate = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    const byExpiry = (a, b) => (a.valid_until || '9999-12-31').localeCompare(b.valid_until || '9999-12-31') || byDate(a, b);
    visible.sort({ recent: byDate, expiring: byExpiry, high: (a, b) => Number(b.total) - Number(a.total), low: (a, b) => Number(a.total) - Number(b.total) }[state.sort]);
    const { pageItems, pages } = paginate(visible, state);
    const total = visible.reduce((sum, quote) => sum + Number(quote.total || 0), 0);
    root.querySelector('[data-results-meta]').innerHTML = `<span>${plural(visible.length, 'cotización', 'cotizaciones')} · ${formatMoney(total)}</span>${state.q || state.status !== 'open' ? '<button data-clear type="button">Ver abiertas</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { state.q = ''; state.status = 'open'; state.page = 1; root.querySelector('[data-search]').value = ''; syncTabs(); render(); });
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map((quote, position) => quoteRowMarkup(quote, index, position >= pageItems.length - 2 && pageItems.length > 3)).join('') : emptyMarkup(quotes.length ? 'Sin cotizaciones en esta vista' : 'Sin cotizaciones todavía', quotes.length ? 'Prueba con otra búsqueda o vista.' : 'Crea la primera cuando tengas un cliente y productos.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-quote]').forEach(card => {
      const quote = quotes.find(item => item.id === card.dataset.quote);
      card.querySelector('[data-view-quote]').addEventListener('click', event => openQuoteDetail(quote, refresh, event.currentTarget));
      bindQuoteActions(card, quote, refresh);
      // Toda la tarjeta abre el detalle, salvo botones, enlaces y el menú.
      card.addEventListener('click', event => { if (!event.target.closest('button, a, details, summary, select')) openQuoteDetail(quote, refresh, card); });
    });
  };
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.page = 1; render(); }, 250));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
  root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => tab.addEventListener('click', () => { state.status = tab.dataset.status; state.page = 1; syncTabs(); render(); }));
  root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => {
    state.status = tile.dataset.kpiView; state.page = 1; syncTabs(); render();
    root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#new-quote').addEventListener('click', event => openQuoteForm(null, refresh, event.currentTarget));
  render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=quotes`); openQuoteForm(null, refresh); }
}

function quoteActionButtons(quote, { detail = false } = {}) {
  return `${['borrador', 'enviada'].includes(quote.status) ? '<button class="small-btn" data-edit-quote type="button">Editar</button>' : ''}<button class="small-btn" data-download-quote type="button">Descargar PDF</button><button class="small-btn" data-print-quote type="button">Imprimir</button>${waDigits(quote.customers) ? '<button class="small-btn" data-send-quote type="button">WhatsApp</button>' : ''}${quote.status !== 'convertida' ? `<select data-quote-status aria-label="Estado de ${escapeHtml(quote.quote_number)}">${['borrador', 'enviada', 'aceptada', 'rechazada', 'vencida'].map(value => `<option value="${value}" ${quote.status === value ? 'selected' : ''}>${detail ? `Estado: ${QUOTE_STATUS[value]}` : QUOTE_STATUS[value]}</option>`).join('')}</select>` : ''}${OPEN_QUOTE.includes(quote.status) ? '<button class="small-btn small-btn--primary" data-quote-sale type="button">Convertir a venta</button>' : ''}${quote.status !== 'convertida' && !quote.converted_sale_id ? '<button class="small-btn small-btn--danger" data-delete-quote type="button">Eliminar</button>' : ''}`;
}

// onLeave: se ejecuta antes de navegar a Ventas (por ejemplo, para cerrar el detalle).
function bindQuoteActions(root, quote, refresh, { onLeave = () => {} } = {}) {
  root.querySelector('[data-edit-quote]')?.addEventListener('click', event => openQuoteForm(quote, refresh, event.currentTarget));
  root.querySelector('[data-download-quote]')?.addEventListener('click', async event => downloadDocument('quote', quote, await settings(), event.currentTarget));
  root.querySelector('[data-print-quote]')?.addEventListener('click', async event => printDocument('quote', quote, await settings(), event.currentTarget));
  root.querySelector('[data-send-quote]')?.addEventListener('click', event => sendQuoteWhatsapp(quote, refresh, event.currentTarget));
  root.querySelector('[data-quote-status]')?.addEventListener('change', async event => {
    const select = event.currentTarget; select.disabled = true;
    try { await setQuoteStatus(quote.id, select.value); toast('Estado actualizado'); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos cambiar el estado.'), 'error'); select.value = quote.status; select.disabled = false; }
  });
  root.querySelectorAll('[data-set-quote-status]').forEach(button => button.addEventListener('click', async () => {
    const value = button.dataset.setQuoteStatus;
    button.closest('details')?.removeAttribute('open');
    try { await setQuoteStatus(quote.id, value); toast(`${quote.quote_number}: ${QUOTE_STATUS[value].toLowerCase()}`); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos cambiar el estado.'), 'error'); }
  }));
  root.querySelector('[data-quote-sale]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!await confirmAction(`Se creará una venta en estado solicitud con los importes de ${quote.quote_number}. El inventario se descuenta solo al confirmar la venta.`, 'Convertir a venta', { confirmLabel: 'Convertir', tone: 'primary', trigger: button })) return;
    setButtonLoading(button, true, 'Revisando…');
    try {
      const sale = await runWithReview(accept => convertQuoteToSale(quote.id, accept), button, 'Respetar importes pactados');
      if (!sale) { setButtonLoading(button, false); return; }
      toast(`Venta ${sale.sale_number} creada`); onLeave(); ctx.navigateTo('sales', { q: sale.sale_number });
    } catch (error) { toast(requestError(error, 'No pudimos convertir la cotización.'), 'error'); setButtonLoading(button, false); }
  });
  root.querySelector('[data-delete-quote]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!await confirmAction(`¿Eliminar la cotización ${quote.quote_number}? Esta acción no se puede deshacer.`, 'Eliminar cotización', { confirmLabel: 'Eliminar', trigger: button })) return;
    setButtonLoading(button, true, 'Eliminando…');
    try { await deleteAdminQuote(quote.id); toast(`Cotización ${quote.quote_number} eliminada`); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos eliminar la cotización.'), 'error'); setButtonLoading(button, false); }
  });
}

function openQuoteDetail(quote, refresh, trigger, { fromProfile = false } = {}) {
  const customer = quote.customers || {}; const snapshot = quote.customer_snapshot || {};
  const items = docItems('quote', quote);
  const daysLeft = quote.valid_until ? daysBetween(bogotaTodayIso(), quote.valid_until) : null;
  const validity = daysLeft == null ? 'Define una fecha al editar' : quote.status === 'convertida' ? 'Ya se convirtió en venta' : daysLeft < 0 ? `Venció hace ${plural(-daysLeft, 'día')}` : daysLeft === 0 ? 'Vence hoy' : `Quedan ${plural(daysLeft, 'día')}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-detail';
  wrapper.innerHTML = `${docHeroMarkup({ kicker: 'Cotización', status: `${pill(quote.status, QUOTE_STATUS)}${isQuoteExpired(quote) ? ' <span class="status-pill status-pill--muted">Vigencia vencida</span>' : ''}`, meta: [`Creada ${dateTimeText(quote.created_at)}`], total: quote.total, items })}
    <div class="info-cards">
      ${infoCard('user', 'Cliente', customerCardBody(customer.full_name || snapshot.full_name, customer.phone_original || snapshot.phone, customer.city || snapshot.city), customerLink(quote.customer_id, fromProfile))}
      ${infoCard('clock', 'Vigencia', `<p><strong>${quote.valid_until ? dateText(quote.valid_until) : 'Sin definir'}</strong><span>${validity}</span></p>`)}
      ${infoCard('truck', 'Entrega', `<p><strong>${formatMoney(quote.delivery_cost)}</strong><span>Incluida en el total cotizado</span></p>`)}
    </div>
    ${quote.notes ? `<div class="doc-note"><small>Observaciones</small><p>${escapeHtml(quote.notes)}</p></div>` : ''}
    <section class="doc-section"><header><h3>Productos cotizados</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items, { doc: quote })}${docTotalsMarkup(quote, items)}</section>
    ${quote.terms_snapshot ? `<details class="doc-terms"><summary>Condiciones comerciales</summary><p>${escapeHtml(quote.terms_snapshot).replace(/\n/g, '<br>')}</p></details>` : ''}
    <div class="doc-actions">${quoteActionButtons(quote, { detail: true })}</div>`;
  const modal = openModal({ title: `Cotización ${quote.quote_number}`, content: wrapper, trigger, className: 'modal--wide modal--doc' });
  bindCustomerLinks(wrapper);
  bindQuoteActions(wrapper, quote, async () => { modal.close(true); await refresh(); }, { onLeave: () => modal.close(true) });
}

async function sendQuoteWhatsapp(quote, refresh, trigger) {
  const customer = quote.customers;
  const text = `Hola ${firstName(customer.full_name)}, te compartimos la cotización ${quote.quote_number} de ${businessName()} por ${formatMoney(quote.total)}${quote.valid_until ? `, válida hasta ${dateText(quote.valid_until)}` : ''}. Te adjuntamos el PDF por este chat.`;
  window.open(waLink(waDigits(customer), text), '_blank', 'noopener');
  if (quote.status !== 'borrador') return;
  const sent = await confirmAction('Descarga el PDF y adjúntalo en el chat. ¿Ya enviaste la cotización? Abrir WhatsApp no la marca como enviada.', 'Marcar como enviada', { confirmLabel: 'Sí, marcar enviada', cancelLabel: 'Todavía no', tone: 'primary', trigger });
  if (!sent) return;
  try { await setQuoteStatus(quote.id, 'enviada'); toast('Cotización marcada como enviada'); await refresh(); } catch (error) { toast(requestError(error, 'No pudimos cambiar el estado.'), 'error'); }
}

async function openQuoteForm(quote, refresh, trigger = null) {
  const loaded = await withLoading(() => Promise.all([getCustomers(), settings()]), { title: quote ? `Abriendo ${quote.quote_number}` : 'Preparando nueva cotización', steps: ['Cargando clientes…', 'Cargando condiciones comerciales…', 'Preparando el catálogo de productos…'], trigger });
  if (!loaded) return;
  const [customers, config] = loaded;
  const configuredDays = configuredValidityDays(config.quote_terms); const today = bogotaTodayIso();
  const validUntil = quote?.valid_until || (!quote && configuredDays ? addIsoDays(today, configuredDays) : '');
  const initialTerms = quote ? (quote.terms_snapshot ?? '') : (config.quote_terms || '');
  const form = document.createElement('form');
  form.className = 'admin-form quote-form';
  form.innerHTML = `<div class="form-grid">${customerPickerMarkup(customers, quote?.customer_id || '')}${lineEditorMarkup()}<div class="quote-meta form-grid__full"><label>Costo de entrega (COP)<input name="delivery_cost" data-money type="text" inputmode="decimal" value="${editableMoney(Number(quote?.delivery_cost || 0))}"></label><label>Válida hasta<input name="valid_until" type="date" min="${today}" value="${escapeHtml(validUntil)}"></label></div><details class="quote-more form-grid__full" ${quote?.notes ? 'open' : ''}><summary><span>Observaciones y condiciones</span><small>${initialTerms || quote?.notes ? 'Con información' : 'Sin información'}</small></summary><div class="quote-more__body"><label>Observaciones <small>Opcional</small><textarea name="notes" rows="2">${escapeHtml(quote?.notes || '')}</textarea></label><label>Condiciones comerciales <small>${config.quote_terms ? 'Precargadas desde Configuración; puedes ajustarlas' : 'Pendientes en Configuración'}</small><textarea name="terms" rows="3">${escapeHtml(initialTerms)}</textarea></label></div></details></div><p class="product-form-error quote-form__error" data-error role="alert" tabindex="-1" hidden></p><div class="quote-form__footer"><div class="quote-form__total"><small>Total de la cotización</small><strong data-quote-total>${formatMoney(quote?.total || 0)}</strong></div><div class="quote-form__actions">${quote ? '<button class="btn btn--ghost" data-download-current type="button">Descargar PDF</button><button class="btn btn--ghost" data-print-current type="button">Imprimir</button>' : ''}<button class="btn btn--primary" type="submit">${quote ? 'Guardar cambios' : 'Crear borrador'}</button></div></div>`;
  const totalOutput = form.querySelector('[data-quote-total]');
  const editor = mountLineEditor(form, { customPrice: true, discount: true, initial: quote?.quote_items || [], deliveryInput: form.elements.delivery_cost, onChange: totals => { totalOutput.textContent = formatMoney(totals.total); } });
  bindCustomerPicker(form, customers);
  let termsManuallyEdited = Boolean(quote);
  form.elements.terms.addEventListener('input', () => { termsManuallyEdited = true; });
  form.elements.valid_until.addEventListener('change', () => {
    if (termsManuallyEdited || !configuredDays || !form.elements.valid_until.value) return;
    const days = Math.max(1, Math.round((new Date(`${form.elements.valid_until.value}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000));
    form.elements.terms.value = String(config.quote_terms || '').replace(/(v[aá]lida?\s+por\s+)\d{1,3}(\s+d[ií]as?)/i, `$1${days}$2`);
  });
  const guard = guardUnsaved(() => JSON.stringify(Object.fromEntries(new FormData(form))) + editor.signature());
  const modal = openModal({ title: quote ? `Editar ${quote.quote_number}` : 'Nueva cotización', content: form, trigger, className: 'modal--wide modal--quote', initialFocus: quote?.customer_id ? '[data-line-search]' : '[data-customer-search]', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  form.querySelector('[data-download-current]')?.addEventListener('click', event => downloadDocument('quote', quote, config, event.currentTarget));
  form.querySelector('[data-print-current]')?.addEventListener('click', event => printDocument('quote', quote, config, event.currentTarget));
  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const error = form.querySelector('[data-error]'); const data = new FormData(form);
    const problem = !data.get('customer_id') ? 'Selecciona o crea el cliente.' : editor.validate();
    if (problem) { error.textContent = problem; error.hidden = false; error.focus(); return; }
    const delivery = parseMoneyInput(data.get('delivery_cost'));
    if (delivery == null) { error.textContent = 'Revisa el costo de entrega.'; error.hidden = false; error.focus(); return; }
    const button = event.submitter; saving = true; error.hidden = true; modal.setDismissible(false); setButtonLoading(button, true, 'Guardando…');
    try {
      const saved = await saveAdminQuote(quote?.id || null, { customer_id: data.get('customer_id'), valid_until: data.get('valid_until'), delivery_cost: delivery, notes: data.get('notes'), terms: data.get('terms'), items: editor.items() });
      toast(`Cotización ${saved.quote_number} guardada`); modal.close(true); await refresh();
    } catch (saveError) { error.textContent = requestError(saveError, 'No pudimos guardar la cotización. Tus datos siguen aquí.'); error.hidden = false; error.focus(); saving = false; modal.setDismissible(true); setButtonLoading(button, false); }
  });
}

// --- Ventas -----------------------------------------------------------------------
// --- Ventas y comprobantes: indicadores, vistas de trabajo y lista por día ------------
// Las vistas agrupan estados por lo que falta hacer (confirmar, cobrar, entregar). Los
// estados sueltos (?status=pagada) y "confirmed" se siguen aceptando desde enlaces.
const SALE_VIEWS = {
  all: { label: 'Todas', match: () => true },
  to_confirm: { label: 'Por confirmar', match: sale => sale.status === 'solicitud' },
  to_collect: { label: 'Por cobrar', match: sale => ['confirmada', 'entregada'].includes(sale.status) },
  to_deliver: { label: 'Por entregar', match: sale => ['confirmada', 'pagada'].includes(sale.status) },
  pagada: { label: 'Pagadas', match: sale => sale.status === 'pagada' },
  entregada: { label: 'Entregadas', match: sale => sale.status === 'entregada' },
  closed: { label: 'Canceladas y devueltas', match: sale => ['cancelada', 'devuelta'].includes(sale.status) }
};
const SALE_SORTS = { recent: 'Más recientes', oldest: 'Más antiguas', high: 'Mayor valor', low: 'Menor valor' };
const SOURCE_ICON = { pedido: 'store', tienda: 'store', cotizacion: 'layers', WhatsApp: 'whatsapp', presencial: 'user', manual: 'pencil' };
const bogotaDay = value => new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const saleViewMatch = (view, sale) => SALE_VIEWS[view] ? SALE_VIEWS[view].match(sale) : view === 'confirmed' ? CONFIRMED_SALE.includes(sale.status) : sale.status === view;

// Tarjeta de indicador; con `view` es un botón que filtra la lista.
function kpiTileMarkup({ view = '', tone, iconName, label, value, detail }) {
  return `<${view ? `button type="button" data-kpi-view="${view}"` : 'div'} class="sales-kpi sales-kpi--${tone}"><span class="sales-kpi__icon" aria-hidden="true">${icon(iconName, { size: 20 })}</span><span class="sales-kpi__label">${label}</span><strong class="sales-kpi__value">${value}</strong><small class="sales-kpi__detail">${detail}</small>${view ? `<span class="sales-kpi__go" aria-hidden="true">${icon('arrowRight', { size: 16 })}</span>` : ''}</${view ? 'button' : 'div'}>`;
}

function salesKpisMarkup(sales) {
  const today = bogotaTodayIso(); const month = today.slice(0, 7);
  const prev = (() => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
  const sold = key => sales.filter(sale => CONFIRMED_SALE.includes(sale.status) && bogotaDay(saleDate(sale)).startsWith(key));
  const sum = list => list.reduce((total, sale) => total + Number(sale.total || 0), 0);
  const current = sold(month); const before = sum(sold(prev)); const now = sum(current);
  const delta = before > 0 ? Math.round(((now - before) / before) * 100) : null;
  const pick = view => sales.filter(SALE_VIEWS[view].match);
  const tile = kpiTileMarkup;
  const collect = pick('to_collect'); const confirm = pick('to_confirm'); const deliver = pick('to_deliver');
  return `<section class="sales-kpis" aria-label="Resumen de ventas">
    ${tile({ tone: 'hero', iconName: 'chart', label: 'Vendido este mes', value: formatMoney(now), detail: `${plural(current.length, 'venta confirmada', 'ventas confirmadas')}${delta == null ? '' : ` · <b class="${delta >= 0 ? 'is-up' : 'is-down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} %</b> vs mes anterior`}` })}
    ${tile({ view: 'to_confirm', tone: 'warning', iconName: 'package', label: 'Por confirmar', value: confirm.length, detail: confirm.length ? `${formatMoney(sum(confirm))} sin descontar inventario` : 'Nada pendiente' })}
    ${tile({ view: 'to_collect', tone: 'info', iconName: 'wallet', label: 'Por cobrar', value: formatMoney(sum(collect)), detail: plural(collect.length, 'venta sin pago registrado', 'ventas sin pago registrado') })}
    ${tile({ view: 'to_deliver', tone: 'success', iconName: 'truck', label: 'Por entregar', value: deliver.length, detail: deliver.length ? `${plural(docUnits(deliver.flatMap(sale => docItems('sale', sale))), 'unidad', 'unidades')} por despachar` : 'Todo entregado' })}
  </section>`;
}

function saleProgressMarkup(sale) {
  if (['cancelada', 'devuelta'].includes(sale.status)) return `<div class="sale-progress sale-progress--closed">${icon('x', { size: 14 })}<span>${sale.status === 'cancelada' ? `Cancelada ${sale.cancelled_at ? dateText(sale.cancelled_at) : ''}` : 'Devuelta en su totalidad'}</span></div>`;
  const steps = [['Solicitud', sale.created_at], ['Confirmada', sale.confirmed_at], ['Pagada', sale.paid_at], ['Entregada', sale.delivered_at]];
  const done = steps.filter(([, date]) => date).length;
  return `<ol class="sale-progress" aria-label="Avance: ${done} de 4">${steps.map(([label, date]) => `<li class="${date ? 'is-done' : ''}" title="${label}${date ? ` · ${dateTimeText(date)}` : ' · pendiente'}"><span></span><small>${label}</small></li>`).join('')}</ol>`;
}

// Acción principal según lo que falta; el resto va al menú (cada data-* aparece una vez).
function saleRowActions(sale, menuUp) {
  const actions = [];
  if (sale.status === 'solicitud') actions.push(['data-confirm-sale', 'Confirmar y descontar', 'package']);
  if (['confirmada', 'entregada'].includes(sale.status)) actions.push(['data-paid', 'Marcar pagada', 'wallet']);
  if (['confirmada', 'pagada'].includes(sale.status)) actions.push(['data-delivered', 'Marcar entregada', 'truck']);
  const [primary, ...rest] = actions;
  const menu = [
    ...(primary ? [['data-view-sale', 'Ver detalle', 'external']] : []), ...rest,
    ['data-download-sale', 'Descargar PDF', 'download'], ['data-print-sale', 'Imprimir', 'printer'],
    ...(CONFIRMED_SALE.includes(sale.status) ? [['data-return', 'Registrar devolución', 'returns']] : []),
    ...(!['cancelada', 'devuelta'].includes(sale.status) && !sale.sale_returns?.length ? [['data-cancel-sale', 'Cancelar venta', 'x', 'is-danger']] : [])
  ];
  const main = primary || ['data-view-sale', 'Ver detalle', 'external'];
  return `<div class="sale-row__actions"><button class="small-btn ${primary ? 'small-btn--primary' : ''} sale-row__primary" ${main[0]} type="button">${icon(main[2], { size: 16 })}<span>${main[1]}</span></button><details class="action-menu sale-menu ${menuUp ? 'action-menu--up' : ''}"><summary aria-label="Más acciones para ${escapeHtml(sale.sale_number)}" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${menu.map(([attr, label, iconName, tone = '']) => `<button class="${tone}" ${attr} type="button">${icon(iconName, { size: 16 })}<span>${label}</span></button>`).join('')}</div></details></div>`;
}

function saleRowMarkup(sale, index, menuUp) {
  const items = docItems('sale', sale);
  const name = sale.customer_snapshot?.full_name || sale.customers?.full_name || 'Cliente';
  const thumbs = items.slice(0, 2).map(item => `<img src="${escapeHtml(describeLine(item, index).image)}" alt="" loading="lazy" decoding="async">`).join('');
  const returns = sale.sale_returns?.length || 0;
  return `<article class="sale-row" data-sale="${sale.id}" data-status="${sale.status}">
    <span class="sale-row__thumbs" aria-hidden="true">${thumbs || `<b>${icon('package', { size: 18 })}</b>`}${items.length > 2 ? `<b>+${items.length - 2}</b>` : ''}</span>
    <div class="sale-row__main">
      <div class="sale-row__title"><strong>${escapeHtml(sale.sale_number)}</strong>${pill(sale.status, SALE_STATUS)}${returns ? `<span class="tag tag--danger">${plural(returns, 'devolución', 'devoluciones')}</span>` : ''}</div>
      <p class="sale-row__customer"><span class="sale-row__avatar" aria-hidden="true">${escapeHtml(initials(name))}</span><span>${escapeHtml(name)}</span></p>
      <p class="sale-row__items">${escapeHtml(itemsPreview(items, 2))}</p>
    </div>
    <div class="sale-row__flow">${saleProgressMarkup(sale)}<small class="sale-row__meta">${icon(SOURCE_ICON[sale.source] || 'store', { size: 13 })}${escapeHtml(SOURCES[sale.source] || sale.source)} · ${escapeHtml(dateTimeText(sale.created_at))}</small></div>
    <div class="sale-row__amount"><strong>${formatMoney(sale.total)}</strong><small>${sale.payment_method ? `${icon('wallet', { size: 13 })}${escapeHtml(sale.payment_method)}` : 'Pago sin definir'}</small><span>${plural(docUnits(items), 'unidad', 'unidades')}</span></div>
    ${saleRowActions(sale, menuUp)}
  </article>`;
}

export async function renderSales() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'all', sort: params.get('sort') || 'recent', page: Number(params.get('page')) || 1 };
  if (!SALE_SORTS[state.sort]) state.sort = 'recent';
  const [sales, config] = await Promise.all([getSales(), settings()]);
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Ventas', 'Ventas y comprobantes', 'Confirma, cobra y entrega cada venta. El inventario se descuenta una sola vez al confirmar; los pagos se registran según lo declarado.', '<button id="new-sale" class="btn btn--primary" type="button">+ Venta manual</button>')
    + salesKpisMarkup(sales)
    + `<section class="admin-panel sales-panel">
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar número, cliente, teléfono o producto" aria-label="Buscar ventas"></div>
        <label class="sales-sort"><span>Ordenar</span><select data-sort aria-label="Ordenar ventas">${Object.entries(SALE_SORTS).map(([value, label]) => `<option value="${value}" ${state.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar ventas">${Object.entries(SALE_VIEWS).map(([value, view]) => `<button class="sales-tab ${state.status === value ? 'active' : ''}" data-status="${value}" type="button" aria-pressed="${state.status === value}"><span>${view.label}</span><b>${sales.filter(view.match).length}</b></button>`).join('')}${SALE_VIEWS[state.status] ? '' : `<button class="sales-tab active" data-status="${escapeHtml(state.status)}" type="button" aria-pressed="true"><span>${escapeHtml(state.status === 'confirmed' ? 'Confirmadas' : SALE_STATUS[state.status] || state.status)}</span><b>${sales.filter(sale => saleViewMatch(state.status, sale)).length}</b></button>`}</div>
      <p class="results-meta" data-results-meta aria-live="polite"></p>
      <div class="sales-list" data-list></div><div data-pagination></div>
    </section>`;
  const refresh = () => renderSales();
  const index = lineIndex();
  const render = () => {
    syncUrl('sales', { ...state, sort: state.sort === 'recent' ? '' : state.sort });
    const term = normalizeText(state.q);
    const visible = sales.filter(sale => saleViewMatch(state.status, sale) && (!term || normalizeText(`${sale.sale_number} ${sale.customers?.full_name || ''} ${sale.customer_snapshot?.full_name || ''} ${sale.customers?.phone_original || ''} ${docItems('sale', sale).map(item => item.product_name).join(' ')}`).includes(term)));
    const byDate = (a, b) => new Date(b.created_at) - new Date(a.created_at);
    visible.sort({ recent: byDate, oldest: (a, b) => byDate(b, a), high: (a, b) => Number(b.total) - Number(a.total), low: (a, b) => Number(a.total) - Number(b.total) }[state.sort]);
    const { pageItems, pages } = paginate(visible, state);
    const total = visible.reduce((sum, sale) => sum + Number(sale.total || 0), 0);
    root.querySelector('[data-results-meta]').innerHTML = `<span>${plural(visible.length, 'venta')} · ${formatMoney(total)}</span>${state.q || state.status !== 'all' ? '<button data-clear type="button">Limpiar filtros</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { state.q = ''; state.status = 'all'; state.page = 1; root.querySelector('[data-search]').value = ''; syncTabs(); render(); });
    const grouped = ['recent', 'oldest'].includes(state.sort);
    const today = bogotaTodayIso(); const yesterday = bogotaDay(Date.now() - 86400000);
    const dayLabel = day => day === today ? 'Hoy' : day === yesterday ? 'Ayer' : new Date(`${day}T12:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
    let html = ''; let lastDay = '';
    pageItems.forEach((sale, position) => {
      const day = bogotaDay(sale.created_at);
      if (grouped && day !== lastDay) {
        const same = pageItems.filter(other => bogotaDay(other.created_at) === day);
        html += `<h3 class="sales-day"><span>${escapeHtml(dayLabel(day))}</span><small>${plural(same.length, 'venta')} · ${formatMoney(same.reduce((sum, other) => sum + Number(other.total || 0), 0))}</small></h3>`;
        lastDay = day;
      }
      html += saleRowMarkup(sale, index, position >= pageItems.length - 2 && pageItems.length > 3);
    });
    root.querySelector('[data-list]').innerHTML = pageItems.length ? html : emptyMarkup(sales.length ? 'Sin ventas en esta vista' : 'Sin ventas todavía', sales.length ? 'Prueba con otra búsqueda o vista.' : 'Convierte un pedido o cotización, o registra una venta manual.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-sale]').forEach(card => {
      const sale = sales.find(item => item.id === card.dataset.sale);
      bindSaleCard(card, sale, config, refresh);
      // Toda la tarjeta abre el detalle, salvo botones, enlaces y el menú.
      card.addEventListener('click', event => { if (!event.target.closest('button, a, details, summary')) openSaleDetail(sale, refresh, card); });
    });
  };
  const syncTabs = () => root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => { const active = tab.dataset.status === state.status; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); state.page = 1; render(); }, 250));
  root.querySelector('[data-sort]').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
  root.querySelectorAll('.sales-tabs [data-status]').forEach(tab => tab.addEventListener('click', () => { state.status = tab.dataset.status; state.page = 1; syncTabs(); render(); }));
  root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => {
    state.status = tile.dataset.kpiView; state.page = 1; syncTabs(); render();
    root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('#new-sale').addEventListener('click', event => openManualSaleForm(refresh, event.currentTarget));
  render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=sales`); openManualSaleForm(refresh); }
}

function saleStateButtons(sale) {
  return `${sale.status === 'solicitud' ? '<button class="small-btn small-btn--primary" data-confirm-sale type="button">Confirmar y descontar</button>' : ''}${['confirmada', 'entregada'].includes(sale.status) ? '<button class="small-btn" data-paid type="button">Marcar pagada</button>' : ''}${['confirmada', 'pagada'].includes(sale.status) ? '<button class="small-btn" data-delivered type="button">Marcar entregada</button>' : ''}${CONFIRMED_SALE.includes(sale.status) ? '<button class="small-btn" data-return type="button">Devolución</button>' : ''}${!['cancelada', 'devuelta'].includes(sale.status) && !sale.sale_returns?.length ? '<button class="small-btn small-btn--danger" data-cancel-sale type="button">Cancelar</button>' : ''}`;
}

function bindSaleCard(card, sale, config, refresh) {
  card.querySelector('[data-download-sale]')?.addEventListener('click', event => downloadDocument('sale', sale, config, event.currentTarget));
  card.querySelector('[data-print-sale]')?.addEventListener('click', event => printDocument('sale', sale, config, event.currentTarget));
  card.querySelector('[data-view-sale]')?.addEventListener('click', event => openSaleDetail(sale, refresh, event.currentTarget));
  card.querySelector('[data-confirm-sale]')?.addEventListener('click', event => openConfirmSaleForm(sale, refresh, event.currentTarget));
  card.querySelector('[data-paid]')?.addEventListener('click', event => openPaidForm(sale, refresh, event.currentTarget));
  card.querySelector('[data-delivered]')?.addEventListener('click', async event => {
    const button = event.currentTarget; setButtonLoading(button, true, 'Guardando…');
    try { await setSaleStatus(sale.id, 'entregada'); toast('Venta marcada como entregada'); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar la venta.'), 'error'); setButtonLoading(button, false); }
  });
  card.querySelector('[data-return]')?.addEventListener('click', event => openReturnForm(sale, refresh, event.currentTarget));
  card.querySelector('[data-cancel-sale]')?.addEventListener('click', event => openCancelForm(sale, refresh, event.currentTarget));
}

async function openSaleDetail(sale, refresh, trigger, { fromProfile = false } = {}) {
  const config = await withLoading(settings, { title: `Abriendo ${sale.sale_number || 'la venta'}`, steps: ['Cargando los datos del comprobante…'], trigger });
  if (!config) return;
  const returned = returnedBySaleItem(sale);
  const items = docItems('sale', sale);
  const snapshot = sale.customer_snapshot || {}; const customer = sale.customers || {};
  const returnedUnits = [...returned.values()].reduce((sum, value) => sum + value, 0);
  const closed = ['cancelada', 'devuelta'].includes(sale.status);
  const steps = [['Solicitud', sale.created_at], ['Confirmada', sale.confirmed_at], ['Pagada', sale.paid_at], ['Entregada', sale.delivered_at]];
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-detail';
  wrapper.innerHTML = `${docHeroMarkup({ kicker: `Venta · ${SOURCES[sale.source] || sale.source}`, status: pill(sale.status, SALE_STATUS), meta: [`Creada ${dateTimeText(sale.created_at)}`, sale.stock_applied_at ? 'inventario descontado' : 'inventario sin descontar'], total: sale.total, items })}
    ${closed ? `<p class="doc-alert doc-alert--danger">${sale.status === 'cancelada' ? `Cancelada ${dateTimeText(sale.cancelled_at)}${sale.cancel_reason ? ` · ${escapeHtml(sale.cancel_reason)}` : ''}${sale.stock_restored_at ? ' · inventario restaurado' : ''}` : 'Venta devuelta en su totalidad.'}</p>` : `<ol class="doc-steps" aria-label="Avance de la venta">${steps.map(([label, date]) => `<li class="${date ? 'is-done' : ''}"><span aria-hidden="true">${date ? icon('check', { size: 14 }) : ''}</span><strong>${label}</strong><small>${date ? dateTimeText(date) : 'Pendiente'}</small></li>`).join('')}</ol>`}
    <div class="info-cards">
      ${infoCard('user', 'Cliente', customerCardBody(snapshot.full_name || customer.full_name, snapshot.phone || customer.phone_original, snapshot.city || customer.city), customerLink(sale.customer_id, fromProfile))}
      ${infoCard('wallet', 'Pago', `<p><strong>${escapeHtml(sale.payment_method || 'Sin registrar')}</strong><span>${sale.paid_at ? `Pagada ${dateTimeText(sale.paid_at)}` : 'Pago pendiente de registrar'}</span></p>`)}
      ${infoCard('returns', 'Devoluciones', `<p><strong>${returnedUnits ? plural(returnedUnits, 'unidad devuelta', 'unidades devueltas') : 'Sin devoluciones'}</strong><span>${returnedUnits ? 'El detalle aparece en cada producto' : 'Todas las unidades siguen vendidas'}</span></p>`)}
    </div>
    <section class="doc-section"><header><h3>Productos vendidos</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items, { returned, doc: sale })}${docTotalsMarkup(sale, items)}${couponDetailMarkup(sale)}</section>
    <div class="doc-actions"><button class="small-btn" data-download-sale type="button">Descargar PDF</button><button class="small-btn" data-print-sale type="button">Imprimir</button>${saleStateButtons(sale)}</div>
    <form class="admin-form doc-notes-form" data-notes-form><label>Observaciones <small>Se imprimen en el comprobante</small><textarea name="notes" rows="2">${escapeHtml(sale.notes || '')}</textarea></label><div class="form-actions"><button class="btn btn--ghost" type="submit">Guardar observaciones</button></div></form>`;
  const modal = openModal({ title: `Venta ${sale.sale_number}`, content: wrapper, trigger, className: 'modal--wide modal--doc' });
  const done = async () => { modal.close(true); await refresh(); };
  bindCustomerLinks(wrapper);
  bindSaleCard(wrapper, sale, config, done);
  wrapper.querySelector('[data-notes-form]').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; setButtonLoading(button, true, 'Guardando…');
    try { await updateSaleNotes(sale.id, String(new FormData(event.currentTarget).get('notes') || '').trim() || null); toast('Observaciones guardadas'); await done(); }
    catch (error) { toast(requestError(error, 'No pudimos guardar.'), 'error'); setButtonLoading(button, false); }
  });
}

async function paymentOptions() { return (await getPaymentMethods({ all: true })).map(item => item.name); }

// --- Acciones sobre una venta: pago, confirmación, cancelación y devolución ------------
// Misma estructura en todas: resumen de la venta, cuerpo propio, nota y botones al pie.
function saleTicketMarkup(sale) {
  const items = docItems('sale', sale); const index = lineIndex();
  const name = sale.customer_snapshot?.full_name || sale.customers?.full_name || 'Cliente';
  const thumbs = items.slice(0, 3).map(item => `<img src="${escapeHtml(describeLine(item, index).image)}" alt="" loading="lazy" decoding="async">`).join('');
  return `<div class="sale-ticket"><span class="sale-ticket__thumbs" aria-hidden="true">${thumbs}${items.length > 3 ? `<b>+${items.length - 3}</b>` : ''}</span><div class="sale-ticket__main"><small>${escapeHtml(sale.sale_number)} ${pill(sale.status, SALE_STATUS)}</small><strong>${escapeHtml(name)}</strong><span>${plural(items.length, 'producto')} · ${plural(docUnits(items), 'unidad', 'unidades')}</span></div><div class="sale-ticket__amount"><small>Total</small><strong>${formatMoney(sale.total)}</strong></div></div>`;
}

function saleActionModal({ sale, title, iconName, tone = 'primary', body, note = '', submitLabel, submitIcon = 'check', backLabel = 'Volver', trigger, closeOnBackdrop = true, onSubmit }) {
  const form = document.createElement('form');
  form.className = 'sale-action'; form.dataset.tone = tone;
  form.innerHTML = `${saleTicketMarkup(sale)}<div class="sale-action__body">${body}</div>${note ? `<p class="sale-action__note">${icon('info', { size: 16 })}<span>${note}</span></p>` : ''}<p class="sale-action__error" data-error role="alert" hidden></p><div class="sale-action__actions"><button class="btn btn--ghost" data-back type="button">${backLabel}</button><button class="btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}" type="submit">${icon(submitIcon, { size: 18 })}<span>${submitLabel}</span></button></div>`;
  const modal = openModal({ title, content: form, trigger, closeOnBackdrop, className: 'modal--action', headerIcon: `<span class="sale-action__badge" data-tone="${tone}">${icon(iconName, { size: 20 })}</span>` });
  const error = form.querySelector('[data-error]');
  const fail = message => { error.textContent = message; error.hidden = false; error.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  form.querySelector('[data-back]').addEventListener('click', () => modal.close());
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.hidden = true;
    await onSubmit({ form, button: form.querySelector('[type="submit"]'), modal, fail });
  });
  return { form, modal };
}

async function openPaidForm(sale, refresh, trigger) {
  const loaded = await withLoading(() => getPaymentMethods({ all: true }).catch(() => []), { title: 'Preparando registro de pago', steps: ['Cargando métodos de pago…'], trigger });
  if (!loaded) return;
  const methods = loaded.filter(method => method.active || method.name === sale.payment_method);
  const current = sale.payment_method || ''; const known = methods.some(method => method.name === current);
  const useOther = (current && !known) || !methods.length;
  const short = text => { const clean = String(text || '').replace(/\s+/g, ' ').trim(); return clean.length > 64 ? `${clean.slice(0, 62)}…` : clean; };
  const tile = (value, title, detail, visual, checked) => `<label class="pay-tile"><input type="radio" name="method" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}><span class="pay-tile__logo">${visual}</span><span class="pay-tile__text"><strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span><span class="pay-tile__check" aria-hidden="true">${icon('check', { size: 14 })}</span></label>`;
  const body = `<fieldset class="pay-methods"><legend>¿Cómo pagó el cliente?</legend><div class="pay-tiles">${methods.map(method => tile(method.name, method.name, short(method.instructions), method.logo_url ? `<img src="${escapeHtml(method.logo_url)}" alt="">` : icon('wallet', { size: 20 }), method.name === current)).join('')}${tile('__other', 'Otro método', 'Escríbelo tú', icon('pencil', { size: 20 }), useOther)}</div></fieldset><label class="sale-action__field" data-other ${useOther ? '' : 'hidden'}><span class="sale-action__label">Método de pago</span><input name="other" maxlength="80" value="${known ? '' : escapeHtml(current)}" placeholder="Ej.: Transferencia Bancolombia"></label><div class="pay-amount"><span>Valor registrado como pagado</span><strong>${formatMoney(sale.total)}</strong></div>`;
  const { form } = saleActionModal({
    sale, title: 'Registrar pago', iconName: 'wallet', tone: 'success', body, trigger, submitLabel: 'Marcar como pagada',
    note: 'Se registra según lo que confirmaste tú: la tienda no verifica transferencias ni pagos bancarios.',
    async onSubmit({ form: target, button, modal, fail }) {
      const choice = target.elements.method.value;
      const method = choice === '__other' ? target.elements.other.value.trim() : choice;
      if (!method) { fail(choice ? 'Escribe el método de pago.' : 'Elige cómo pagó el cliente.'); if (choice) target.elements.other.focus(); return; }
      setButtonLoading(button, true, 'Guardando…');
      try { await setSaleStatus(sale.id, 'pagada', method); toast(`Pago de ${sale.sale_number} registrado`); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos registrar el pago.')); setButtonLoading(button, false); }
    }
  });
  const other = form.querySelector('[data-other]');
  form.querySelectorAll('[name="method"]').forEach(input => input.addEventListener('change', () => {
    other.hidden = form.elements.method.value !== '__other';
    if (!other.hidden) form.elements.other.focus();
  }));
}

function openConfirmSaleForm(sale, refresh, trigger) {
  const items = docItems('sale', sale); const index = lineIndex();
  const rows = items.map(item => {
    const line = describeLine(item, index); const options = optionText(item.option_snapshot);
    const variant = (line.product?.product_variants || []).find(entry => entry.id === item.variant_id);
    const stock = variant ? Number(variant.stock) : null; const quantity = Number(item.quantity) || 0;
    const short = stock != null && stock < quantity;
    return { short, html: `<li class="inv-line ${short ? 'is-short' : ''}"><img src="${escapeHtml(line.image)}" alt="" loading="lazy" decoding="async"><span class="inv-line__main"><strong>${escapeHtml(line.name)}</strong>${options ? `<small>${escapeHtml(options)}</small>` : ''}</span><span class="inv-line__qty">−${quantity}</span><span class="inv-line__stock">${stock == null ? '<small>Stock sin datos</small>' : `<small>Stock</small><b>${stock}</b>${icon('arrowRight', { size: 13 })}<b class="${short ? 'is-bad' : ''}">${stock - quantity}</b>`}</span></li>` };
  });
  const missing = rows.filter(row => row.short).length;
  const body = `<div class="sale-action__title"><h3>Se descontará del inventario</h3><span>${plural(docUnits(items), 'unidad', 'unidades')}</span></div><ul class="inv-lines">${rows.map(row => row.html).join('')}</ul>${missing ? `<p class="sale-action__warn">${icon('alert', { size: 16 })}<span>${missing === 1 ? 'Una línea no tiene' : `${missing} líneas no tienen`} stock suficiente según el catálogo cargado. Si el servidor lo confirma, no se descontará nada.</span></p>` : ''}`;
  saleActionModal({
    sale, title: 'Confirmar venta', iconName: 'package', tone: 'primary', body, trigger, submitLabel: 'Confirmar y descontar',
    note: 'Se descuenta una sola vez. Si alguna línea no tiene stock, la venta no se confirma y el inventario no cambia.',
    async onSubmit({ button, modal, fail }) {
      setButtonLoading(button, true, 'Confirmando…');
      try {
        const confirmed = await runWithCouponReview(accept => confirmSale(sale.id, accept), button);
        if (!confirmed) { setButtonLoading(button, false); return; }
        await ctx.refreshProducts(); toast(`Venta ${sale.sale_number} confirmada e inventario actualizado`); modal.close(true); await refresh();
      } catch (error) { fail(requestError(error, 'No se pudo confirmar.')); setButtonLoading(button, false); }
    }
  });
}

function openCancelForm(sale, refresh, trigger) {
  const units = docUnits(docItems('sale', sale));
  const reasons = ['El cliente desistió', 'Pago no recibido', 'Sin stock', 'Error al registrar'];
  const body = `<ul class="impact-list"><li>${icon('package', { size: 16 })}<span>${sale.stock_applied_at ? `Se restaurarán <b>${plural(units, 'unidad', 'unidades')}</b> al inventario, una sola vez.` : 'Esta venta aún no descontó inventario: el stock no cambia.'}</span></li><li>${icon('history', { size: 16 })}<span>El comprobante se conserva con estado <b>cancelada</b> en tu historial.</span></li></ul><label class="sale-action__field"><span class="sale-action__label">Motivo <small>Opcional</small></span><textarea name="reason" rows="2" maxlength="300" placeholder="Por qué se cancela la venta"></textarea></label><div class="reason-chips" role="group" aria-label="Motivos frecuentes">${reasons.map(reason => `<button class="reason-chip" type="button" data-reason="${escapeHtml(reason)}">${escapeHtml(reason)}</button>`).join('')}</div>`;
  const { form } = saleActionModal({
    sale, title: 'Cancelar venta', iconName: 'alert', tone: 'danger', body, trigger, submitLabel: 'Cancelar venta', submitIcon: 'x', backLabel: 'No, volver',
    async onSubmit({ form: target, button, modal, fail }) {
      setButtonLoading(button, true, 'Cancelando…');
      try { await cancelSale(sale.id, target.elements.reason.value.trim() || null); await ctx.refreshProducts(); toast(`Venta ${sale.sale_number} cancelada`); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos cancelar la venta.')); setButtonLoading(button, false); }
    }
  });
  form.querySelectorAll('[data-reason]').forEach(chip => chip.addEventListener('click', () => {
    form.querySelectorAll('[data-reason]').forEach(other => other.classList.toggle('is-active', other === chip));
    form.elements.reason.value = chip.dataset.reason; form.elements.reason.focus();
  }));
}

function openReturnForm(sale, refresh, trigger) {
  const returned = returnedBySaleItem(sale); const index = lineIndex();
  const lines = docItems('sale', sale).map(item => ({ item, max: Number(item.quantity) - (returned.get(item.id) || 0), unit: Number(item.line_total) / Math.max(1, Number(item.quantity)) })).filter(line => line.max > 0);
  const requestKey = crypto.randomUUID();
  const picks = lines.map(({ item, max }) => {
    const line = describeLine(item, index);
    return `<li class="return-pick"><img src="${escapeHtml(line.image)}" alt="" loading="lazy" decoding="async"><span class="return-pick__main"><strong>${escapeHtml(line.name)}</strong><small>${escapeHtml([optionText(item.option_snapshot), `puede devolver ${max}`].filter(Boolean).join(' · '))}</small></span><span class="stepper"><button type="button" data-step="-1" aria-label="Quitar una unidad">${icon('minus', { size: 16 })}</button><input type="number" name="qty-${item.id}" min="0" max="${max}" step="1" value="0" inputmode="numeric" aria-label="Cantidad a devolver de ${escapeHtml(item.product_name)}"><button type="button" data-step="1" aria-label="Agregar una unidad">${icon('plus', { size: 16 })}</button></span></li>`;
  }).join('');
  const body = `<div class="sale-action__title"><h3>¿Qué devuelve el cliente?</h3><span data-return-count>0 unidades</span></div><ul class="return-picks">${picks}</ul>
    <fieldset class="choice-tiles"><legend>¿Las unidades vuelven al inventario?</legend><label class="choice-tile"><input type="radio" name="restock" value="yes"><span class="choice-tile__icon">${icon('undo', { size: 18 })}</span><strong>Sí, reintegrar</strong><small>Vuelven a estar disponibles para la venta</small></label><label class="choice-tile"><input type="radio" name="restock" value="no"><span class="choice-tile__icon">${icon('alert', { size: 18 })}</span><strong>No reintegrar</strong><small>Producto dañado u otro motivo</small></label></fieldset>
    <label class="sale-action__field"><span class="sale-action__label">Nota <small>Opcional</small></span><textarea name="note" rows="2" maxlength="300" placeholder="Estado del producto, acuerdo con el cliente…"></textarea></label>
    <div class="pay-amount"><span>Valor de lo devuelto</span><strong data-return-value>${formatMoney(0)}</strong></div>`;
  const { form } = saleActionModal({
    sale, title: 'Registrar devolución', iconName: 'returns', tone: 'primary', body, trigger, closeOnBackdrop: false, submitLabel: 'Registrar devolución', submitIcon: 'returns',
    note: 'El valor es de referencia (lo pagado por unidad). Registrar la devolución no hace reembolsos automáticos.',
    async onSubmit({ form: target, button, modal, fail }) {
      const selected = lines.map(({ item }) => ({ sale_item_id: item.id, quantity: Number(target.elements[`qty-${item.id}`].value) || 0 })).filter(line => line.quantity > 0);
      if (!selected.length) { fail('Indica al menos una unidad a devolver.'); return; }
      if (!target.elements.restock.value) { fail('Decide si las unidades vuelven al inventario.'); return; }
      setButtonLoading(button, true, 'Registrando…');
      try { await registerSaleReturn(sale.id, selected, target.elements.restock.value === 'yes', requestKey, target.elements.note.value.trim() || null); await ctx.refreshProducts(); toast('Devolución registrada'); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos registrar la devolución.')); setButtonLoading(button, false); }
    }
  });
  const update = () => {
    let units = 0; let value = 0;
    lines.forEach(({ item, max, unit }) => {
      const input = form.elements[`qty-${item.id}`]; const qty = Math.min(max, Math.max(0, Math.round(Number(input.value) || 0)));
      if (input.value !== '' && String(qty) !== input.value) input.value = qty;
      input.closest('.return-pick').classList.toggle('is-active', qty > 0);
      units += qty; value += unit * qty;
    });
    form.querySelector('[data-return-count]').textContent = plural(units, 'unidad', 'unidades');
    form.querySelector('[data-return-value]').textContent = formatMoney(Math.round(value));
  };
  form.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
    const input = button.parentElement.querySelector('input'); input.value = (Number(input.value) || 0) + Number(button.dataset.step); update();
  }));
  form.querySelectorAll('.return-pick input').forEach(input => input.addEventListener('input', update));
}

const SALE_SOURCES = [['presencial', 'Presencial', 'En el local', 'store'], ['WhatsApp', 'WhatsApp', 'Por chat', 'whatsapp'], ['manual', 'Manual', 'Otro canal', 'pencil']];

async function openManualSaleForm(refresh, trigger = null) {
  const loaded = await withLoading(() => Promise.all([getCustomers(), paymentOptions()]), { title: 'Preparando venta manual', steps: ['Cargando clientes…', 'Cargando métodos de pago…', 'Preparando el catálogo de productos…'], trigger });
  if (!loaded) return;
  const [customers, names] = loaded;
  const quickPayments = [...new Set(names.map(name => name.trim()).filter(Boolean))].slice(0, 6);
  const stockById = new Map(variantCatalog().map(entry => [entry.id, entry]));
  const form = document.createElement('form');
  form.className = 'admin-form flow-form';
  form.noValidate = true;
  const step = (number, key, title, hint, body, extra = '') => `<section class="flow-step" data-step="${key}"><header class="flow-step__head"><span class="flow-step__num" aria-hidden="true"><b>${number}</b>${icon('check', { size: 15 })}</span><div><h3>${title}</h3><p>${hint}</p></div>${extra}</header>${body}</section>`;
  form.innerHTML = `<div class="flow-form__body form-grid">
    <div class="flow-form__main">
      ${step(1, 'customer', 'Cliente', 'Busca por nombre, teléfono o documento, o créalo en un clic.', customerPickerMarkup(customers), '<span class="flow-step__state" data-state="customer">Pendiente</span>')}
      ${step(2, 'lines', 'Productos', 'Busca por nombre o referencia; luego ajusta cantidad, precio y descuento.<span class="flow-hint-keys"> · ↑ ↓ y Enter para agregar rápido</span>', lineEditorMarkup(), '<span class="flow-step__state" data-state="lines">Pendiente</span>')}
    </div>
    <aside class="flow-form__aside">
      ${step(3, 'details', 'Cobro y entrega', 'Cómo se cerró la venta y cómo pagó el cliente.', `
        <fieldset class="flow-choice"><legend>Origen de la venta</legend><div class="flow-choice__grid">${SALE_SOURCES.map(([value, label, hint, iconName], index) => `<label class="flow-choice__opt"><input type="radio" name="source" value="${value}" ${index === 0 ? 'checked' : ''}><span class="flow-choice__card">${icon(iconName, { size: 20 })}<strong>${label}</strong><small>${hint}</small></span></label>`).join('')}</div></fieldset>
        <div class="flow-pay"><label for="flow-payment-method">Método de pago <small>Declarado por el cliente</small></label>${quickPayments.length ? `<div class="flow-pay__chips" role="group" aria-label="Métodos de pago frecuentes">${quickPayments.map(name => `<button type="button" class="flow-chip" data-pay="${escapeHtml(name)}" aria-pressed="false">${escapeHtml(name)}</button>`).join('')}</div>` : ''}<input id="flow-payment-method" name="payment_method" list="manual-payment-options" maxlength="80" placeholder="${quickPayments.length ? 'U otro: escribe el método' : 'Ej. Efectivo, transferencia…'}" autocomplete="off"><datalist id="manual-payment-options">${names.map(name => `<option value="${escapeHtml(name)}">`).join('')}</datalist></div>
        <label class="flow-money">Costo de entrega <small>COP · 0 si retira en tienda</small><span class="flow-money__field"><b aria-hidden="true">$</b><input name="delivery_cost" data-money type="text" inputmode="decimal" value="0"></span></label>
        <details class="flow-notes"><summary>${icon('pencil', { size: 16 })}<span>Observaciones</span><small data-notes-state>Opcional</small>${icon('chevronDown', { size: 16 })}</summary><label class="flow-notes__body"><span class="sr-only">Observaciones</span><textarea name="notes" rows="3" maxlength="1000" placeholder="Ej. entrega el sábado, pagó la mitad por adelantado…"></textarea></label></details>`)}
      <label class="flow-switch"><input name="confirm_now" type="checkbox" role="switch"><span class="flow-switch__switch" aria-hidden="true"></span><span class="flow-switch__text"><strong>Confirmar y descontar inventario</strong><small>Actívalo si el cliente ya pagó o se llevó el producto. Si no, la venta queda como solicitud para confirmar después.</small></span></label>
      <div class="flow-switch__warn" data-stock-warning role="status" hidden></div>
      <section class="flow-summary" aria-label="Resumen de la venta">
        <header><span>Resumen</span><b data-sum-units>Sin productos</b></header>
        <dl><div><dt>Subtotal</dt><dd data-sum-gross>${formatMoney(0)}</dd></div><div data-sum-discount-row hidden><dt>Descuentos</dt><dd data-sum-discount></dd></div><div><dt>Entrega</dt><dd data-sum-delivery>${formatMoney(0)}</dd></div></dl>
        <div class="flow-summary__total"><span>Total</span><strong data-sum-total>${formatMoney(0)}</strong></div>
        <p class="flow-summary__mode" data-sum-mode></p>
      </section>
    </aside>
  </div>
  <div class="flow-form__footer">
    <p class="product-form-error flow-form__error" data-error role="alert" tabindex="-1" hidden></p>
    <ul class="flow-form__ready" aria-label="Datos requeridos"><li data-ready="customer">${icon('check', { size: 13 })}Cliente</li><li data-ready="lines">${icon('check', { size: 13 })}Productos</li></ul>
    <div class="flow-form__total"><small>Total a registrar</small><strong data-footer-total>${formatMoney(0)}</strong></div>
    <div class="flow-form__actions"><button class="btn btn--ghost" data-cancel type="button">Cancelar</button><button class="btn btn--primary" type="submit">Registrar venta</button></div>
  </div>`;
  const submit = form.querySelector('[type="submit"]'); const payment = form.elements.payment_method; const confirmNow = form.elements.confirm_now;
  // Avisa antes de confirmar si alguna variante no tiene unidades suficientes (el servidor lo valida igual).
  const stockShortages = () => {
    const wanted = new Map();
    editor?.items().forEach(item => wanted.set(item.variant_id, (wanted.get(item.variant_id) || 0) + item.quantity));
    return [...wanted].map(([id, quantity]) => ({ entry: stockById.get(id), quantity })).filter(({ entry, quantity }) => entry && quantity > entry.stock);
  };
  const sync = (totals = null) => {
    if (totals) {
      form.querySelector('[data-sum-gross]').textContent = formatMoney(totals.gross);
      form.querySelector('[data-sum-discount-row]').hidden = !totals.discount;
      form.querySelector('[data-sum-discount]').textContent = `− ${formatMoney(totals.discount)}`;
      form.querySelector('[data-sum-delivery]').textContent = totals.delivery ? formatMoney(totals.delivery) : 'Sin costo';
      form.querySelector('[data-sum-total]').textContent = formatMoney(totals.total);
      form.querySelector('[data-footer-total]').textContent = formatMoney(totals.total);
    }
    const items = editor?.items() || []; const units = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    form.querySelector('[data-sum-units]').textContent = items.length ? `${plural(items.length, 'producto', 'productos')} · ${plural(units, 'unidad', 'unidades')}` : 'Sin productos';
    const ready = { customer: Boolean(form.elements.customer_id.value), lines: items.length > 0 };
    Object.entries(ready).forEach(([key, done]) => {
      form.querySelector(`[data-step="${key}"]`).classList.toggle('is-done', done);
      const state = form.querySelector(`[data-state="${key}"]`); state.textContent = done ? (key === 'lines' ? plural(items.length, 'producto', 'productos') : 'Listo') : 'Pendiente';
      form.querySelector(`[data-ready="${key}"]`).classList.toggle('is-done', done);
    });
    form.querySelector('[data-step="details"]').classList.toggle('is-done', ready.customer && ready.lines);
    const confirming = confirmNow.checked; const short = confirming ? stockShortages() : [];
    submit.textContent = confirming ? 'Registrar y confirmar' : 'Registrar venta';
    form.querySelector('[data-sum-mode]').innerHTML = confirming ? `${icon('checkCircle', { size: 15 })}<span>Quedará <b>confirmada</b> y el inventario se descontará al guardar.</span>` : `${icon('clock', { size: 15 })}<span>Quedará como <b>solicitud</b>; el inventario no cambia hasta confirmarla.</span>`;
    const warning = form.querySelector('[data-stock-warning]'); warning.hidden = !short.length;
    warning.innerHTML = short.length ? `${icon('alert', { size: 16 })}<div><strong>Stock insuficiente para confirmar</strong><ul>${short.map(({ entry, quantity }) => `<li>${escapeHtml(entry.label)}: pides ${quantity}, hay ${entry.stock}</li>`).join('')}</ul><small>Puedes registrarla como solicitud y confirmarla cuando llegue el inventario.</small></div>` : '';
  };
  let editor = null;
  editor = mountLineEditor(form, { customPrice: true, discount: true, deliveryInput: form.elements.delivery_cost, onChange: totals => sync(totals) });
  bindCustomerPicker(form, customers);
  editor.total();
  form.elements.customer_id.addEventListener('change', () => sync());
  confirmNow.addEventListener('change', () => sync());
  const syncChips = () => form.querySelectorAll('[data-pay]').forEach(chip => chip.setAttribute('aria-pressed', String(normalizeText(chip.dataset.pay) === normalizeText(payment.value))));
  form.querySelector('.flow-pay__chips')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-pay]'); if (!chip) return;
    payment.value = chip.getAttribute('aria-pressed') === 'true' ? '' : chip.dataset.pay; syncChips();
  });
  payment.addEventListener('input', syncChips);
  form.elements.notes.addEventListener('input', () => { form.querySelector('[data-notes-state]').textContent = form.elements.notes.value.trim() ? 'Con información' : 'Opcional'; });
  const guard = guardUnsaved(() => JSON.stringify(Object.fromEntries(new FormData(form))) + editor.signature());
  const modal = openModal({ title: 'Venta manual', description: 'Registra una compra cerrada por WhatsApp o en persona.', headerIcon: icon('wallet', { size: 22 }), content: form, trigger, className: 'modal--wide modal--flow', initialFocus: '[data-customer-search]', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  form.querySelector('[data-cancel]').addEventListener('click', () => modal.close());
  let createdSale = null;
  let saving = false;
  const showError = (message, target = null) => {
    const error = form.querySelector('[data-error]'); error.textContent = message; error.hidden = false; error.dataset.kind = target ? 'validation' : 'save';
    (target || error).focus({ preventScroll: !target }); target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  // Un aviso de validación se retira en cuanto el usuario corrige algo; los errores del servidor se quedan.
  const clearValidation = () => { const error = form.querySelector('[data-error]'); if (error.dataset.kind === 'validation') error.hidden = true; };
  form.addEventListener('input', clearValidation); form.addEventListener('change', clearValidation);
  form.addEventListener('click', event => { if (event.target.closest('[data-line-option],[data-customer-option],[data-remove-line]')) clearValidation(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    form.querySelector('[data-error]').hidden = true; const data = new FormData(form);
    const delivery = parseMoneyInput(data.get('delivery_cost'));
    if (!data.get('customer_id')) { showError('Selecciona o crea el cliente.', form.querySelector('[data-customer-search]')); return; }
    const problem = delivery == null ? 'Revisa el costo de entrega.' : editor.validate();
    if (problem) { showError(problem, delivery == null ? form.elements.delivery_cost : form.querySelector('[data-line-search]')); return; }
    const button = event.submitter || submit; saving = true; modal.setDismissible(false); setButtonLoading(button, true, 'Registrando…');
    try {
      // Si la confirmación falla, un segundo clic no vuelve a crear la venta.
      createdSale ||= await createManualSale({ customer_id: data.get('customer_id'), source: data.get('source'), payment_method: data.get('payment_method'), delivery_cost: delivery, notes: data.get('notes'), items: editor.items() });
      if (data.has('confirm_now')) { await confirmSale(createdSale.id); await ctx.refreshProducts(); }
      toast(`Venta ${createdSale.sale_number} registrada${data.has('confirm_now') ? ' y confirmada' : ''}`); modal.close(true); await refresh();
    } catch (saveError) {
      saving = false; modal.setDismissible(true); setButtonLoading(button, false);
      showError(createdSale ? `La venta ${createdSale.sale_number} quedó registrada como solicitud, pero no se pudo confirmar: ${requestError(saveError, 'revisa el stock.')}` : requestError(saveError, 'No pudimos registrar la venta.'));
    }
  });
}

// --- Piezas compartidas con el análisis de cliente, tareas y cupones ---------------------
export { CONTACT_STATUS, kpiTileMarkup, KIND_LABEL, KIND_STATUS, ORDER_STATUS, QUOTE_STATUS, SALE_STATUS, bindTabs, birthdayCard, contactThisYear, dateText, dateTimeText, doNotContact, docItems, emptyMarkup, firstName, initials, insightOptions, kpiTile, marketingAllowed, nextFrame, openCustomerProfile, openDocument, paginate, paginationMarkup, bindPagination, pill, plural, productMiniList, productTableMarkup, relativeDays, requestError, settings as crmSettings, showLoadError, showLoading, waDigits, waLink, barList, categoryRows, columnChart, bindChartTooltips, rangeMeter, preferencesMarkup, insightsMarkup, timelineMarkup, docLinesMarkup, docTotalsMarkup, openBirthdayGreeting };
