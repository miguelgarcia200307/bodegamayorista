// Panel comercial: Resumen, Clientes (CRM y cumpleaños), Pedidos, Cotizaciones y
// Ventas/Comprobantes. Los importes, estados e inventario se modifican solo mediante
// funciones transaccionales de la base de datos; aquí solo se presentan y se solicitan.
import {
  cancelSale, confirmSale, convertQuoteToSale, createAdminOrder, deleteAdminQuote, createManualSale, createSaleFromOrder, getCustomerHistory,
  getCustomers, getDeliveryMethods, getOrders, getPaymentMethods, getQuotes, getSales, getSettings, mergeCustomers,
  recordConsent, registerSaleReturn, saveAdminQuote, saveBirthdayContact, saveCustomer, setQuoteStatus, setSaleStatus, updateOrder, updateSaleNotes
} from '../lib/api.js';
import { confirmAction, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { barList, bindChartTooltips, columnChart, rangeMeter } from '../components/mini-charts.js';
import { bindRecoPanel, recoPanelMarkup } from '../components/reco-panel.js';
import { diagnoseCustomer } from '../lib/customer-diagnosis.js';
import { $, $$, currentPrice, debounce, escapeHtml, formatMoney, normalizeText, setButtonLoading, slugify } from '../lib/helpers.js';
import { downloadCommercialDocument, printCommercialDocument } from '../lib/documents.js';
import { birthdayInfo, bogotaTodayIso, isValidBirthDate } from '../lib/crm-dates.js';
import { DOC_ITEMS, DOC_NUMBER, addDaysIso, analyzeCustomer, catalogIndex, customerRank, daysBetween, describeLine, groupByProduct, returnedBySaleItem, saleDate } from '../lib/customer-insights.js';

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

function docLinesMarkup(items, { returned = new Map() } = {}) {
  if (!items.length) return '<p class="history-empty">Este documento no tiene productos.</p>';
  const index = lineIndex();
  return `<ul class="doc-lines">${items.map(item => {
    const line = describeLine(item, index); const back = returned.get(item.id) || 0; const options = optionText(item.option_snapshot);
    const detail = [options, line.sku ? `Ref. ${line.sku}` : ''].filter(Boolean).join(' · ');
    return `<li class="doc-line"><img class="doc-line__thumb" src="${escapeHtml(line.image)}" alt="" loading="lazy" decoding="async"><div class="doc-line__main"><strong>${escapeHtml(line.name)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}<span class="doc-line__tags"><span class="tag">${escapeHtml(line.category)}</span>${line.brand !== 'Sin marca' ? `<span class="tag tag--soft">${escapeHtml(line.brand)}</span>` : ''}${back ? `<span class="tag tag--danger">Devueltas: ${back}</span>` : ''}</span></div><div class="doc-line__qty"><span>${Number(item.quantity)} × ${formatMoney(item.unit_price)}</span>${Number(item.discount) ? `<small>Desc. − ${formatMoney(item.discount)}</small>` : ''}</div><strong class="doc-line__total">${formatMoney(item.line_total)}</strong></li>`;
  }).join('')}</ul>`;
}

function docTotalsMarkup(doc) {
  const rows = [['Subtotal', formatMoney(doc.subtotal)], Number(doc.discount_total) ? ['Descuentos', `− ${formatMoney(doc.discount_total)}`] : null, ['Entrega', formatMoney(doc.delivery_cost)]].filter(Boolean);
  return `<dl class="doc-sum">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}<div class="doc-sum__total"><dt>Total</dt><dd>${formatMoney(doc.total)}</dd></div></dl>`;
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
      const customer = (await getCustomers()).find(item => item.id === id) || (await getCustomers({ archived: true })).find(item => item.id === id);
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
export async function renderDashboard() {
  const [orders, customers, quotes, sales, config, payments, deliveries] = await Promise.all([getOrders(), getCustomers(), getQuotes(), getSales(), settings(), getPaymentMethods({ all: true }), getDeliveryMethods({ all: true })]);
  const monthPrefix = bogotaTodayIso().slice(0, 7);
  const pending = orders.filter(item => item.status === 'pendiente').length;
  const openQuotes = quotes.filter(item => OPEN_QUOTE.includes(item.status) && !isQuoteExpired(item)).length;
  const monthSales = sales.filter(item => CONFIRMED_SALE.includes(item.status) && (item.confirmed_at || item.created_at) && new Date(item.confirmed_at || item.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).startsWith(monthPrefix));
  const monthTotal = monthSales.reduce((sum, item) => sum + Number(item.total), 0);
  const birthdays = customers.map(customer => ({ customer, info: birthdayInfo(customer.birth_date) })).filter(item => item.info && item.info.days <= 7).sort((a, b) => a.info.days - b.info.days);
  const today = birthdays.filter(item => item.info.days === 0).length;
  const low = ctx.getProducts().filter(ctx.isProductLow).length;
  const missing = [
    !config.whatsapp && 'WhatsApp del negocio (el checkout está bloqueado)',
    !deliveries.some(item => item.active) && 'Al menos un método de entrega activo',
    !payments.some(item => item.active) && 'Al menos un método de pago activo',
    !config.logo_url && 'Logo oficial para documentos',
    !(config.address && config.city) && 'Dirección y ciudad del negocio',
    !(config.data_policy_text && config.data_policy_version) && 'Texto y versión de tratamiento de datos',
    !config.sale_terms && 'Condiciones del comprobante', !config.warranty_text && 'Política de garantía', !config.quote_terms && 'Condiciones de cotización'
  ].filter(Boolean);
  const card = (label, value, section, params, tone, action) => `<button class="stat-card ${tone ? `stat-card--${tone}` : ''}" data-go="${section}" data-params='${escapeHtml(JSON.stringify(params))}' type="button"><span>${label}</span><strong>${value}</strong><small>${action} →</small></button>`;
  $('#admin-content').innerHTML = ctx.heading('Panel administrador', 'Resumen', 'Datos reales de la tienda. Cero significa que aún no hay registros.')
    + (missing.length ? `<section class="admin-panel setup-panel" role="status"><div class="admin-panel__head"><h2>Configuración pendiente</h2><button class="small-btn small-btn--primary" data-go="settings" data-params="{}" type="button">Completar</button></div><ul>${missing.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>` : '')
    + `<section class="stat-grid">${card('Solicitudes pendientes', pending, 'orders', { status: 'pendiente' }, pending ? 'warning' : '', 'Abrir pedidos')}${card('Cotizaciones abiertas', openQuotes, 'quotes', { status: 'open' }, '', 'Abrir cotizaciones')}${card(`Ventas confirmadas · ${new Date().toLocaleDateString('es-CO', { month: 'long', timeZone: 'America/Bogota' })}`, `${monthSales.length}<small class="stat-card__sub">${formatMoney(monthTotal)}</small>`, 'sales', { status: 'confirmed' }, monthSales.length ? 'success' : '', 'Abrir ventas')}${card('Clientes registrados', customers.length, 'customers', {}, '', 'Abrir clientes')}${card('Cumpleaños hoy / 7 días', `${today} / ${birthdays.length}`, 'customers', { view: 'week' }, birthdays.length ? 'warning' : '', 'Revisar cumpleaños')}${card('Stock bajo o agotado', low, 'stock', { status: 'low' }, low ? 'danger' : '', 'Revisar stock')}</section>`
    + `<section class="admin-panel"><div class="admin-panel__head"><h2>Cumpleaños próximos</h2></div>${birthdays.length ? `<div class="crm-list">${birthdays.slice(0, 6).map(({ customer, info }) => birthdayCard(customer, info)).join('')}</div>` : emptyMarkup('Sin datos todavía', 'Aquí aparecerán los clientes que cumplen años hoy o en los próximos 7 días.')}</section>`
    + `<section class="admin-panel"><div class="admin-panel__head"><h2>Acciones rápidas</h2></div><div class="quick-actions"><button class="quick-action" data-go="orders" data-params='{"new":"1"}' type="button"><span class="quick-action__icon">#</span><span>Registrar pedido</span></button><button class="quick-action" data-go="customers" data-params='{"new":"1"}' type="button"><span class="quick-action__icon">◎</span><span>Nuevo cliente</span></button><button class="quick-action" data-go="quotes" data-params='{"new":"1"}' type="button"><span class="quick-action__icon">≡</span><span>Nueva cotización</span></button><button class="quick-action" data-go="sales" data-params='{"new":"1"}' type="button"><span class="quick-action__icon">$</span><span>Venta manual</span></button></div></section>`;
  $$('#admin-content [data-go]').forEach(button => button.addEventListener('click', () => ctx.navigateTo(button.dataset.go, JSON.parse(button.dataset.params || '{}'))));
  bindBirthdayCards($('#admin-content'), customers, renderDashboard);
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
  return `<a class="small-btn" href="tel:+${digits}">Llamar</a>${birthday ? (canGreet ? '<button class="small-btn small-btn--primary" data-greet type="button">Felicitar</button>' : `<span class="status-pill">${doNotContact(customer) ? 'No contactar' : 'Sin autorización'}</span>`) : `<a class="small-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de Bodega Mayorista F.C.`)}" target="_blank" rel="noopener">WhatsApp</a>`}`;
}

function bindBirthdayCards(root, customers, refresh) {
  root.querySelectorAll('[data-customer]').forEach(card => {
    const customer = customers.find(item => item.id === card.dataset.customer);
    card.querySelector('[data-open-customer]')?.addEventListener('click', event => openCustomerProfile(customer, refresh, event.currentTarget));
    card.querySelector('[data-greet]')?.addEventListener('click', event => openBirthdayGreeting(customer, refresh, event.currentTarget));
    card.querySelector('[data-analyze-customer]')?.addEventListener('click', event => openCustomerAnalysis(customer, null, event.currentTarget));
  });
}

async function openBirthdayGreeting(customer, refresh, trigger) {
  const config = await settings();
  const contact = contactThisYear(customer);
  if (contact && ['contactado', 'obsequio_ofrecido', 'completado'].includes(contact.status)) {
    const again = await confirmAction(`Este año ya registraste “${CONTACT_STATUS[contact.status]}” para ${customer.full_name}. ¿Quieres abrir WhatsApp de nuevo?`, 'Felicitación ya registrada', { confirmLabel: 'Abrir de nuevo', tone: 'primary', trigger });
    if (!again) return;
  }
  const template = config.birthday_message || 'Hola {nombre}, te deseamos un feliz cumpleaños de parte de Bodega Mayorista F.C.';
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

export async function renderCustomers() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', view: params.get('view') || 'all', page: Number(params.get('page')) || 1 };
  let loadedArchived = state.view === 'archived';
  let customers = await getCustomers({ archived: loadedArchived });
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('CRM privado', 'Clientes', 'Datos, historial y cumpleaños. Quien nació el 29 de febrero celebra el 28 en años no bisiestos.', '<button id="new-customer" class="btn btn--primary" type="button">+ Nuevo cliente</button>')
    + `<section class="admin-panel">${toolbar(state, 'Buscar nombre, teléfono o ciudad', { all: 'Todos', today: 'Cumpleaños hoy', week: 'Próximos 7 días', month: 'Este mes', archived: 'Archivados' }, 'view')}<div class="crm-list" data-list></div><div data-pagination></div></section>`;
  const refresh = () => renderCustomers();
  const render = async () => {
    syncUrl('customers', state);
    if ((state.view === 'archived') !== loadedArchived) {
      loadedArchived = state.view === 'archived';
      customers = await getCustomers({ archived: loadedArchived });
    }
    const term = normalizeText(state.q);
    let visible = customers.map(customer => ({ customer, info: birthdayInfo(customer.birth_date) }))
      .filter(({ customer }) => !term || normalizeText(`${customer.full_name} ${customer.phone_original} ${customer.phone_normalized} ${customer.city || ''}`).includes(term));
    if (state.view === 'today') visible = visible.filter(({ info }) => info?.days === 0);
    if (state.view === 'week') visible = visible.filter(({ info }) => info && info.days <= 7).sort((a, b) => a.info.days - b.info.days);
    if (state.view === 'month') visible = visible.filter(({ info }) => info?.inCurrentMonth).sort((a, b) => a.info.daysFromThisYear - b.info.daysFromThisYear);
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').textContent = `${visible.length} cliente${visible.length === 1 ? '' : 's'}`;
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map(({ customer, info }) => {
      const birthday = ['today', 'week', 'month'].includes(state.view) && info;
      const when = info ? (info.days === 0 ? 'cumple hoy' : state.view === 'month' && info.daysFromThisYear < 0 ? `cumplió hace ${-info.daysFromThisYear} día(s)` : `cumpleaños en ${info.days} día(s)`) : '';
      return `<article class="crm-card" data-customer="${customer.id}"><div><strong>${escapeHtml(customer.full_name)}</strong><span>${escapeHtml(customer.phone_original)}${customer.city ? ` · ${escapeHtml(customer.city)}` : ''}</span><small>${info ? `${info.age} años · ${when} · ` : ''}Origen: ${escapeHtml(SOURCES[customer.source] || customer.source)}${customer.archived_at ? ' · archivado' : ''}</small></div><div class="admin-row-actions"><button class="small-btn small-btn--primary" data-open-customer type="button">Ficha</button><button class="small-btn" data-analyze-customer type="button">Analizar</button>${customerContactButtons(customer, Boolean(birthday))}</div></article>`;
    }).join('') : emptyMarkup(customers.length ? 'Sin coincidencias' : 'Sin clientes todavía', customers.length ? 'Prueba con otro filtro o búsqueda.' : 'Los pedidos de la tienda y las altas manuales aparecerán aquí.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    bindBirthdayCards(root.querySelector('[data-list]'), customers, refresh);
  };
  bindToolbar(root, state, render, 'view');
  $('#new-customer').addEventListener('click', event => openCustomerForm(null, refresh, event.currentTarget));
  await render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=customers`); openCustomerForm(null, refresh); }
}

export async function openCustomerForm(customer, onSaved, trigger = null) {
  const config = await settings();
  const today = bogotaTodayIso();
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.noValidate = true;
  form.innerHTML = `<div class="form-grid"><label>Nombre completo<input name="full_name" required maxlength="120" value="${escapeHtml(customer?.full_name || '')}"></label><label>Teléfono<input name="phone_original" required inputmode="tel" maxlength="30" placeholder="300 123 4567 o +57 300 123 4567" value="${escapeHtml(customer?.phone_original || '')}"></label><label>Ciudad <small>Opcional</small><input name="city" maxlength="80" value="${escapeHtml(customer?.city || '')}"></label><label>Fecha de nacimiento <small>Opcional</small><input name="birth_date" type="date" min="1900-01-01" max="${today}" value="${escapeHtml(customer?.birth_date || '')}"></label><label class="form-grid__full">Dirección habitual <small>Opcional</small><input name="address" maxlength="250" value="${escapeHtml(customer?.address || '')}"></label><label>Documento de identificación <small>Opcional y privado</small><input name="identification" maxlength="40" value="${escapeHtml(customer?.identification || '')}"></label><label>Origen<select name="source">${['manual', 'WhatsApp', 'presencial', 'tienda'].map(value => `<option value="${value}" ${(customer?.source || 'manual') === value ? 'selected' : ''}>${SOURCES[value]}</option>`).join('')}</select></label><label class="check-field form-grid__full"><input name="marketing_consent" type="checkbox" ${customer && marketingAllowed(customer) ? 'checked' : ''}> El cliente autorizó felicitaciones, ofertas y contacto promocional${config.marketing_consent_version ? ` (versión ${escapeHtml(config.marketing_consent_version)})` : ' <small>(texto pendiente de configuración)</small>'}</label><label class="form-grid__full">Notas internas <small>Opcional</small><textarea name="notes" rows="3">${escapeHtml(customer?.notes || '')}</textarea></label></div><p class="product-form-error" data-error role="alert" hidden></p><div class="form-actions"><button class="btn btn--primary" type="submit">Guardar cliente</button></div>`;
  const signature = () => JSON.stringify(Object.fromEntries(new FormData(form)));
  const guard = guardUnsaved(signature);
  const modal = openModal({ title: customer ? 'Editar cliente' : 'Nuevo cliente', content: form, trigger, closeOnBackdrop: false, beforeClose: guard.beforeClose });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const error = form.querySelector('[data-error]');
    const birth = data.get('birth_date');
    const problem = String(data.get('full_name')).trim().length < 2 ? 'Escribe el nombre completo.' : String(data.get('phone_original')).replace(/\D/g, '').length < 8 ? 'Escribe un teléfono válido.' : birth && !isValidBirthDate(birth, today) ? 'La fecha de nacimiento no puede ser futura ni anterior a 1900.' : '';
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    const button = event.submitter || form.querySelector('[type="submit"]');
    setButtonLoading(button, true, 'Guardando…');
    try {
      const saved = await saveCustomer({ full_name: data.get('full_name'), phone_original: data.get('phone_original'), city: data.get('city'), address: data.get('address'), birth_date: birth || null, identification: data.get('identification'), source: data.get('source'), notes: String(data.get('notes') || '').trim() || null }, customer?.id);
      const consent = data.has('marketing_consent');
      if (consent !== Boolean(customer && marketingAllowed(customer)) && (consent || customer)) await recordConsent(saved.id, 'marketing_birthday', consent, config.marketing_consent_version, 'admin');
      toast('Cliente guardado'); modal.close(true); await onSaved?.(saved);
    } catch (saveError) { error.textContent = requestError(saveError, 'No pudimos guardar el cliente.'); error.hidden = false; setButtonLoading(button, false); }
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
  return `<details class="doc-card" data-kind="${kind}" data-id="${doc.id}" data-search="${escapeHtml(search)}"><summary><span class="doc-card__thumbs" aria-hidden="true">${thumbs.map(src => `<img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async">`).join('')}${items.length > 3 ? `<b>+${items.length - 3}</b>` : ''}</span><span class="doc-card__main"><span class="doc-card__title"><strong>${escapeHtml(doc[DOC_NUMBER[kind]])}</strong>${pill(doc.status, KIND_STATUS[kind])}${note}</span><small>${dateText(docDate(kind, doc))} · ${plural(items.length, 'producto')} · ${plural(docUnits(items), 'unidad', 'unidades')}${extra ? ` · ${escapeHtml(extra)}` : ''}</small><span class="doc-card__preview">${escapeHtml(itemsPreview(items, 3))}</span></span><span class="doc-card__amount">${formatMoney(doc.total)}</span><span class="doc-card__chevron" aria-hidden="true">${icon('chevronDown', { size: 18 })}</span></summary><div class="doc-card__body">${docLinesMarkup(items, { returned })}<div class="doc-card__foot">${docTotalsMarkup(doc)}<div class="doc-card__actions"><button class="small-btn small-btn--primary" data-doc-open type="button">Ver detalle completo</button>${kind !== 'order' ? '<button class="small-btn" data-doc-pdf type="button">Descargar PDF</button>' : ''}</div></div></div></details>`;
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
  const data = analyzeCustomer(record, insightOptions());
  const info = birthdayInfo(customer.birth_date);
  const contact = contactThisYear(customer);
  const consents = (customer.customer_consents || []).slice().sort((a, b) => new Date(b.recorded_at) - new Date(a.recorded_at));
  const allowed = marketingAllowed(customer); const digits = waDigits(customer);
  const uid = crypto.randomUUID().slice(0, 8);
  const tabs = [['summary', 'Resumen'], ['sale', 'Compras', record.sales.length], ['quote', 'Cotizaciones', record.quotes.length], ['order', 'Pedidos', record.orders.length], ['data', 'Datos']];
  const birthdayText = info ? (info.days === 0 ? 'Cumple hoy' : info.days <= 30 ? `Cumple en ${plural(info.days, 'día')}` : `Cumple el ${dateText(info.next)}`) : '';
  const interest = !data.categories.length && data.interestCategories.length;
  const panel = (key, content, first = false) => `<section class="profile-panel" role="tabpanel" id="cp-panel-${key}-${uid}" aria-labelledby="cp-tab-${key}-${uid}" data-panel="${key}" ${first ? '' : 'hidden'}>${content}</section>`;
  wrapper.innerHTML = `<section class="profile-hero">
      <div class="profile-hero__chips">${(() => { const dx = diagnoseCustomer(data, { allowed, digits, birthday: info }); return `<span class="status-pill status-pill--${dx.segment.tone}" title="${escapeHtml(dx.headline)}">${escapeHtml(dx.segment.label)}</span>`; })()}<span class="meta-chip ${allowed ? 'meta-chip--ok' : ''}">${icon(allowed ? 'check' : 'x', { size: 14 })}${allowed ? 'Acepta promociones' : 'Sin autorización promocional'}</span>${customer.city ? `<span class="meta-chip">${icon('pin', { size: 14 })}${escapeHtml(customer.city)}</span>` : ''}${info ? `<span class="meta-chip ${info.days <= 7 ? 'meta-chip--warn' : ''}">${icon('star', { size: 14 })}${birthdayText} · ${info.age} años</span>` : ''}${customer.archived_at ? '<span class="status-pill status-pill--danger">Archivado</span>' : ''}</div>
      <div class="profile-hero__actions">${digits ? `<a class="small-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de Bodega Mayorista F.C.`)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}<span>WhatsApp</span></a><a class="small-btn" href="tel:+${digits}">${icon('phone', { size: 16 })}<span>Llamar</span></a>` : ''}<button class="small-btn" data-edit type="button">${icon('pencil', { size: 16 })}<span>Editar</span></button><button class="small-btn small-btn--primary" data-analyze type="button">${icon('chart', { size: 16 })}<span>Analizar cliente</span></button><details class="action-menu action-menu--right"><summary aria-label="Más acciones">${icon('more', { size: 18 })}</summary><div class="action-menu__popover"><button data-merge type="button">Fusionar duplicado</button>${customer.archived_at ? '<button data-restore type="button">Restaurar cliente</button>' : '<button data-archive class="is-danger" type="button">Archivar cliente</button>'}</div></details></div>
    </section>
    <section class="kpi-strip" aria-label="Indicadores del cliente">
      ${kpiTile('Total comprado', formatMoney(data.spent), plural(data.count, 'compra confirmada', 'compras confirmadas'), data.count ? 'accent' : '')}
      ${kpiTile('Ticket promedio', data.count ? formatMoney(data.avgTicket) : '—', data.count ? `Máximo ${formatMoney(data.maxTicket)}` : 'Sin compras')}
      ${kpiTile('Última compra', relativeDays(data.daysSinceLast), data.last ? dateText(data.last) : 'Nunca ha comprado', data.daysSinceLast > 120 ? 'warning' : '')}
      ${kpiTile('Frecuencia', data.avgGap ? `Cada ${Math.round(data.avgGap)} días` : '—', plural(data.units, 'unidad comprada', 'unidades compradas'))}
      ${kpiTile('Cotizado', formatMoney(data.quotedTotal), `${plural(record.quotes.length, 'cotización', 'cotizaciones')}${data.conversion != null ? ` · ${percent(data.conversion)} convertidas` : ''}`)}
      ${kpiTile('En seguimiento', formatMoney(data.openQuotesValue), `${plural(data.openQuotes.length, 'cotización abierta', 'cotizaciones abiertas')} · ${plural(data.pendingOrders, 'pedido pendiente', 'pedidos pendientes')}`, data.openQuotes.length || data.pendingOrders ? 'warning' : '')}
    </section>
    <div class="profile-tabs" role="tablist" aria-label="Secciones de la ficha">${tabs.map(([key, label, count], position) => `<button role="tab" type="button" id="cp-tab-${key}-${uid}" aria-controls="cp-panel-${key}-${uid}" aria-selected="${position === 0}" tabindex="${position === 0 ? 0 : -1}" data-tab="${key}">${label}${count != null ? `<span>${count}</span>` : ''}</button>`).join('')}</div>
    ${panel('summary', `<div class="card-grid">
      <article class="panel-card"><header><h3>Lo que más compra</h3><p>${data.categories.length ? 'Participación de cada categoría en sus compras' : interest ? 'Según lo que ha cotizado o pedido (aún sin compras)' : 'Categorías de sus compras'}</p></header>${barList(categoryRows(data.categories.length ? data.categories : data.interestCategories), { limit: 5, empty: 'Cuando compre o cotice verás aquí sus categorías.' })}${preferencesMarkup(data.preferences)}</article>
      <article class="panel-card"><header><h3>Productos favoritos</h3><p>Los que más ha comprado</p></header>${productMiniList(data.topProducts.slice(0, 5), data.opportunities.length ? 'Aún no compra; revisa lo que cotizó en la pestaña Cotizaciones.' : 'Aún no ha comprado productos.')}</article>
      <article class="panel-card"><header><h3>Hallazgos</h3><p>Lectura automática de su historial</p></header>${insightsMarkup(data.insights.slice(0, 5))}<button class="link-btn" data-analyze type="button">Ver análisis completo →</button></article>
      <article class="panel-card"><header><h3>Actividad reciente</h3><p>Últimos documentos; toca uno para ver su detalle</p></header>${timelineMarkup(data.timeline.slice(0, 6))}</article>
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
  wrapper.querySelectorAll('[data-analyze]').forEach(button => button.addEventListener('click', () => openCustomerAnalysis(customer, record, button)));
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

// Diagnóstico comercial: segmento, intención de compra, evidencia y plan de acción.
function diagnosisMarkup(dx, data) {
  const length = 2 * Math.PI * 20;
  const rfm = data.count ? `<div class="dx-rfm" aria-label="Puntaje RFM">${[['Recencia', dx.scores.recency], ['Frecuencia', dx.scores.frequency], ['Valor', dx.scores.monetary]].map(([label, score]) => `<span title="${label}: ${score} de 5"><small>${label}</small><i>${[1, 2, 3, 4, 5].map(step => `<b class="${step <= score ? 'is-on' : ''}"></b>`).join('')}</i></span>`).join('')}</div>` : '';
  return `<section class="dx-card dx-card--${dx.segment.tone}">
    <div class="dx-card__main">
      <div class="dx-card__top">
        <div class="dx-badge"><small>Segmento</small><strong>${escapeHtml(dx.segment.label)}</strong></div>
        <div class="dx-intent dx-intent--${dx.intent.tone}" title="Índice de intención de compra (0 a 100): combina cotizaciones abiertas, pedidos, actividad reciente e historial de conversión.">
          <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" class="dx-intent__track"/><circle cx="24" cy="24" r="20" class="dx-intent__value" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - dx.intent.value / 100)).toFixed(1)}"/></svg>
          <b>${dx.intent.value}</b><span><small>Intención de compra</small><strong>${dx.intent.label}</strong></span>
        </div>
      </div>
      <p class="dx-headline">${escapeHtml(dx.headline)}</p>
      ${dx.evidence.length ? `<div class="dx-evidence">${dx.evidence.map(chip => `<span class="dx-chip dx-chip--${chip.tone}">${escapeHtml(chip.label)}</span>`).join('')}</div>` : ''}
      ${rfm}
    </div>
    <div class="dx-plan">
      <small>${icon('sparkles', { size: 14 })} Plan de acción</small>
      ${dx.actions.length ? `<ol>${dx.actions.map((action, position) => `<li><span class="dx-plan__n">${position + 1}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.detail)}</p></div></li>`).join('')}</ol>` : '<p class="dx-plan__empty">Sin acciones pendientes por ahora.</p>'}
      <p class="dx-channel">${icon('chat', { size: 14 })}<span>${escapeHtml(dx.channel)}</span></p>
    </div>
  </section>`;
}

// --- Análisis del cliente ----------------------------------------------------------
const PERIODS = [['all', 'Todo el historial'], ['365', 'Últimos 12 meses'], ['180', 'Últimos 6 meses'], ['90', 'Últimos 90 días']];

function exportCustomerCsv(customer, data) {
  const rows = [['Tipo', 'Documento', 'Fecha', 'Estado', 'Producto', 'Opciones', 'Referencia', 'Categoría', 'Marca', 'Cantidad', 'Precio unitario', 'Total línea']];
  const push = (label, kind, lines) => lines.forEach(line => rows.push([label, line.doc[DOC_NUMBER[kind]], line.date, KIND_STATUS[kind][line.doc.status] || line.doc.status, line.name, optionText(line.options), line.sku, line.category, line.brand, line.quantity, Math.round(line.unitPrice), Math.round(line.amount)]));
  push('Compra', 'sale', data.purchaseLines); push('Cotización', 'quote', data.quoteLines); push('Pedido', 'order', data.orderLines);
  const csv = `﻿${rows.map(row => row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n')}`;
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: `Historial_${slugify(customer.full_name) || 'cliente'}_${bogotaTodayIso()}.csv` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`${link.download} descargado`);
}

// record: historial ya cargado (desde la ficha) o null para cargarlo aquí.
async function openCustomerAnalysis(customer, record = null, trigger = null) {
  let rank = null; let storeSales = []; let recoRevealed = false;
  const allowed = marketingAllowed(customer) && !doNotContact(customer); const digits = waDigits(customer);
  const wrapper = document.createElement('div');
  wrapper.className = 'customer-analysis';
  let period = 'all';
  const modal = openModal({ title: `Análisis de ${customer.full_name}`, content: wrapper, trigger, className: 'modal--wide modal--analysis', headerIcon: `<span class="avatar">${escapeHtml(initials(customer.full_name))}</span>` });
  const subtitle = document.createElement('p');
  subtitle.className = 'modal__subtitle';
  subtitle.textContent = 'Qué compra, cuánto gasta y qué ofrecerle';
  modal.element.querySelector('.modal__title h2').after(subtitle);
  const render = () => {
    const since = period === 'all' ? null : addDaysIso(bogotaTodayIso(), -Number(period));
    const data = analyzeCustomer(record, insightOptions({ since, storeSales, customerId: customer.id }));
    const monthly = data.monthly.map((bucket, position) => ({ label: bucket.label, sublabel: position === 0 || bucket.label === 'ene' ? `'${String(bucket.year).slice(2)}` : '', value: bucket.amount, tip: `${bucket.label} ${bucket.year}: ${formatMoney(bucket.amount)} en ${plural(bucket.count, 'compra')} · cotizado ${formatMoney(bucket.quoted)}`, cells: [formatMoney(bucket.amount), String(bucket.count), formatMoney(bucket.quoted)] }));
    const purchased = groupByProduct(data.purchaseLines);
    const nothing = !data.count && !data.quotes.length && !data.orders.length;
    wrapper.innerHTML = `<div class="analysis-toolbar"><div class="admin-chips" role="group" aria-label="Periodo del análisis">${PERIODS.map(([value, label]) => `<button class="filter-chip ${period === value ? 'active' : ''}" data-period="${value}" type="button" aria-pressed="${period === value}">${label}</button>`).join('')}</div><button class="small-btn" data-export type="button">${icon('download', { size: 16 })}<span>Exportar CSV</span></button></div>
      ${diagnosisMarkup(diagnoseCustomer(data, { allowed, digits, rank, birthday: birthdayInfo(customer.birth_date) }), data)}
      <section class="kpi-strip kpi-strip--analysis" aria-label="Indicadores del periodo">
        <article class="kpi-tile kpi-tile--hero"><small>Total comprado</small><strong>${formatMoney(data.spent)}</strong><span>${plural(data.count, 'compra')} · ${plural(data.units, 'unidad', 'unidades')}${data.returnedValue ? ` · devoluciones ${formatMoney(data.returnedValue)}` : ''}</span></article>
        ${kpiTile('Ticket promedio', data.count ? formatMoney(data.avgTicket) : '—', data.count ? `Máximo ${formatMoney(data.maxTicket)}` : 'Sin compras en el periodo')}
        ${kpiTile('Recencia', relativeDays(data.daysSinceLast), data.last ? `Última: ${dateText(data.last)}` : 'Sin compras', data.daysSinceLast > 120 ? 'warning' : '')}
        ${kpiTile('Frecuencia', data.avgGap ? `Cada ${Math.round(data.avgGap)} días` : '—', data.nextExpected ? `Próxima estimada: ${dateText(data.nextExpected)}` : 'Necesita 2 compras o más')}
        ${kpiTile('Conversión de cotizaciones', data.conversion != null ? percent(data.conversion) : '—', data.quotes.length ? `${data.converted} de ${plural(data.quotes.length - data.openQuotes.length, 'cerrada', 'cerradas')} · ${data.openQuotes.length} abiertas` : 'Sin cotizaciones')}
        ${kpiTile('Ranking de clientes', rank ? `#${rank.position} de ${rank.total}` : '—', rank ? `Top ${rank.top} % · ${percent(rank.share)} de las ventas` : 'Aún no aparece entre los compradores')}
      </section>
      ${nothing ? emptyMarkup('Sin actividad en este periodo', 'Cambia el periodo o espera a que el cliente cotice o compre.') : `<div class="card-grid card-grid--analysis">
        <article class="panel-card panel-card--span2"><header><h3>Compras por mes</h3><p>Últimos 12 meses · ventas confirmadas netas de devoluciones (no depende del periodo elegido)</p></header>${columnChart(monthly, { caption: 'Compras por mes en los últimos 12 meses', tableHead: ['Mes', 'Comprado', 'Compras', 'Cotizado'] })}</article>
        <article class="panel-card"><header><h3>Rango de precios que paga</h3><p>${data.price ? `Precio unitario según sus ${data.price.basedOn}` : 'Sin datos de precio'}</p></header>${data.price ? `${rangeMeter(data.price)}<p class="panel-note">Ofrécele productos entre <b>${formatMoney(data.price.avg * 0.7)}</b> y <b>${formatMoney(data.price.avg * 1.4)}</b> por unidad: es el rango en el que suele decidir.</p>` : '<p class="history-empty">Aparecerá cuando compre o cotice.</p>'}</article>
        <article class="panel-card"><header><h3>Gasto por categoría</h3><p>${data.categories.length ? 'Qué le gusta comprar' : 'Interés según lo cotizado o pedido'}</p></header>${barList(categoryRows(data.categories.length ? data.categories : data.interestCategories), { limit: 6, empty: 'Sin categorías en el periodo.' })}</article>
        <article class="panel-card"><header><h3>Marcas preferidas</h3><p>${data.brands.length ? 'Participación en el gasto' : 'Según lo cotizado o pedido'}</p></header>${barList((data.brands.length ? data.brands : data.interestBrands).map(item => ({ label: item.name, detail: plural(item.units, 'unidad', 'unidades'), value: item.amount, display: percent(item.share), tip: `${item.name}: ${formatMoney(item.amount)} · ${percent(item.share)}` })), { limit: 5, empty: 'Sin marcas en el periodo.' })}</article>
        <article class="panel-card"><header><h3>Tallas, colores y opciones</h3><p>Unidades por opción elegida</p></header>${data.preferences.length ? data.preferences.slice(0, 3).map(group => `<div class="pref-block"><h4>${escapeHtml(group.name)}</h4>${barList(group.values.map(item => ({ label: item.value, value: item.units, display: `${item.units} u.`, tip: `${group.name} ${item.value}: ${plural(item.units, 'unidad', 'unidades')}` })), { limit: 5, format: value => `${value} u.` })}</div>`).join('') : '<p class="history-empty">Sus productos no tienen tallas ni colores registrados.</p>'}</article>
        <article class="panel-card panel-card--wide panel-card--insights"><header><h3>Hallazgos</h3><p>Lectura automática del periodo</p></header>${insightsMarkup(data.insights)}</article>
        <article class="panel-card panel-card--wide"><header><h3>Productos que ha comprado</h3><p>${plural(purchased.length, 'producto distinto', 'productos distintos')} · variantes elegidas y última compra</p></header>${productTableMarkup(purchased.slice(0, 12))}</article>
        <article class="panel-card panel-card--span2"><header><h3>Cotizó y no compró</h3><p>Oportunidades de cierre</p></header>${productMiniList(data.opportunities.slice(0, 6), 'No hay productos cotizados pendientes de compra.', { detail: row => `${row.doc.quote_number} · ${dateText(row.date)} · cotizado a ${formatMoney(row.unitPrice)}`, right: row => `${row.open ? '<span class="status-pill status-pill--warning">Abierta</span>' : '<span class="status-pill status-pill--muted">Cerrada</span>'}<small>${row.product ? (row.inStock ? `Hoy ${formatMoney(row.currentPrice)}` : 'Sin stock') : 'Fuera del catálogo'}</small>` })}</article>
        <article class="panel-card"><header><h3>Cotizaciones abiertas</h3><p>Valor pendiente de decisión: ${formatMoney(data.openQuotesValue)}</p></header>${data.openQuotes.length ? `<ul class="history-list">${data.openQuotes.map(quote => `<li><span>${escapeHtml(quote.quote_number)} · ${formatMoney(quote.total)}</span><small>${QUOTE_STATUS[quote.status]} · ${quote.valid_until ? `vence ${dateText(quote.valid_until)}` : 'sin vigencia'}</small></li>`).join('')}</ul>` : '<p class="history-empty">No tiene cotizaciones abiertas.</p>'}</article>
        ${recoPanelMarkup(data, customer, { revealed: recoRevealed, allowed, digits })}
      </div>`}`;
    wrapper.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => { period = button.dataset.period; render(); }));
    wrapper.querySelector('[data-export]').addEventListener('click', () => exportCustomerCsv(customer, data));
    bindRecoPanel(wrapper, data, customer, { allowed, digits, onReveal: () => { recoRevealed = true; } });
    bindChartTooltips(wrapper);
  };
  const load = async () => {
    const stopLoading = showLoading(wrapper, `Analizando a ${firstName(customer.full_name)}…`, 'analysis');
    try {
      const [history, allSales] = await Promise.all([record || getCustomerHistory(customer.id), getSales().catch(() => [])]);
      if (!wrapper.isConnected) { stopLoading(); return; }
      record = history; rank = customerRank(allSales, customer.id); storeSales = allSales;
      await nextFrame();
      stopLoading(); render();
    } catch (error) {
      stopLoading();
      if (wrapper.isConnected) showLoadError(wrapper, 'No pudimos cargar el análisis', requestError(error, 'Revisa la conexión e intenta de nuevo.'), load);
    }
  };
  await load();
}

async function openMergeForm(customer, after, trigger) {
  const candidates = (await getCustomers()).filter(item => item.id !== customer.id);
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
export async function renderOrders() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'all', page: Number(params.get('page')) || 1 };
  const orders = await getOrders();
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Solicitudes', 'Pedidos', 'Un pedido es una solicitud: no descuenta inventario ni es una venta. Abrir WhatsApp no prueba que el cliente envió el mensaje.', '<button id="new-order" class="btn btn--primary" type="button">+ Registrar pedido</button>')
    + `<section class="admin-panel">${toolbar(state, 'Buscar número, cliente o teléfono', { all: 'Todos', ...Object.fromEntries(Object.entries(ORDER_STATUS).map(([key, label]) => [key, `${label}s`])) })}<div class="crm-list" data-list></div><div data-pagination></div></section>`;
  const refresh = () => renderOrders();
  const render = () => {
    syncUrl('orders', state);
    const term = normalizeText(state.q);
    const visible = orders.filter(order => (state.status === 'all' || order.status === state.status) && (!term || normalizeText(`${order.order_number} ${order.customers?.full_name || ''} ${order.customers?.phone_original || ''} ${order.customers?.phone_normalized || ''}`).includes(term)));
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').textContent = `${visible.length} pedido${visible.length === 1 ? '' : 's'}`;
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map(order => `<article class="crm-card" data-order="${order.id}"><div><strong>${escapeHtml(order.order_number)} ${pill(order.status, ORDER_STATUS)}</strong><span>${escapeHtml(order.customers?.full_name || 'Cliente')} · ${formatMoney(order.total)} · ${order.order_items?.length || 0} producto(s)</span><span class="crm-card__items">${escapeHtml(itemsPreview(docItems('order', order), 3))}</span><small>${dateTimeText(order.created_at)} · ${escapeHtml(SOURCES[order.source] || order.source)}${order.source === 'tienda' ? (order.whatsapp_opened_at ? ' · WhatsApp preparado' : ' · WhatsApp no abierto') : ''}${Object.keys(order.customer_conflicts || {}).length ? ' · <b class="text-warning">datos distintos a la ficha</b>' : ''}${order.sales?.length ? ` · venta ${escapeHtml(order.sales[0].sale_number)}` : ''}</small></div><div class="admin-row-actions"><button class="small-btn small-btn--primary" data-open-order type="button">Revisar</button></div></article>`).join('') : emptyMarkup(orders.length ? 'Sin coincidencias' : 'Sin pedidos todavía', orders.length ? 'Prueba con otro filtro.' : 'Las solicitudes registradas por el checkout o manualmente aparecerán aquí.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-open-order]').forEach(button => button.addEventListener('click', () => openOrderDetail(orders.find(item => item.id === button.closest('[data-order]').dataset.order), refresh, button)));
  };
  bindToolbar(root, state, render);
  $('#new-order').addEventListener('click', event => openOrderForm(refresh, event.currentTarget));
  render();
  if (params.get('new')) { history.replaceState({}, '', `${location.pathname}?section=orders`); openOrderForm(refresh); }
}

const CONFLICT_LABELS = { full_name: 'Nombre', city: 'Ciudad', address: 'Dirección', birth_date: 'Fecha de nacimiento', cliente_archivado: 'Cliente archivado', telefono_de_ficha_fusionada: 'Teléfono de ficha fusionada' };

function openOrderDetail(order, refresh, trigger, { fromProfile = false } = {}) {
  const customer = order.customers || {};
  const conflicts = Object.entries(order.customer_conflicts || {});
  const items = docItems('order', order);
  const wrapper = document.createElement('div');
  wrapper.className = 'doc-detail';
  wrapper.innerHTML = `${docHeroMarkup({ kicker: `Pedido · ${SOURCES[order.source] || order.source}`, status: `${pill(order.status, ORDER_STATUS)}${order.sales?.length ? ` <span class="status-pill status-pill--success">Venta ${escapeHtml(order.sales[0].sale_number)}</span>` : ''}`, meta: [`Registrado ${dateTimeText(order.created_at)}`], total: order.total, items })}
    ${conflicts.length ? `<section class="notice-box"><h3>Datos distintos a la ficha del cliente</h3><p>El teléfono no verifica identidad: revisa antes de aplicar.</p><ul class="history-list">${conflicts.map(([key, value]) => `<li><span>${escapeHtml(CONFLICT_LABELS[key] || key)}: <strong>${escapeHtml(String(value))}</strong>${['full_name', 'city', 'address', 'birth_date'].includes(key) ? ` <small>(ficha: ${escapeHtml(String(customer[key] ?? '—'))})</small>` : ''}</span>${['full_name', 'city', 'address', 'birth_date'].includes(key) ? `<button class="small-btn" data-apply="${key}" type="button">Aplicar a la ficha</button>` : ''}</li>`).join('')}</ul></section>` : ''}
    <div class="info-cards">
      ${infoCard('user', 'Cliente', customerCardBody(customer.full_name, customer.phone_original, customer.city), customerLink(order.customer_id, fromProfile))}
      ${infoCard('truck', 'Entrega', `<p><strong>${escapeHtml(order.delivery_name || 'Sin definir')}</strong>${order.shipping_city ? `<span>${escapeHtml(order.shipping_city)}</span>` : ''}${order.shipping_address ? `<span>${escapeHtml(order.shipping_address)}</span>` : ''}</p>`)}
      ${infoCard('wallet', 'Pago y contacto', `<p><strong>${escapeHtml(order.payment_name || 'Pago sin definir')}</strong><span>${order.whatsapp_opened_at ? `WhatsApp preparado ${dateTimeText(order.whatsapp_opened_at)} (no confirma envío)` : 'Sin registro de apertura de WhatsApp'}</span></p>`)}
    </div>
    ${order.notes ? `<div class="doc-note"><small>Observaciones del cliente</small><p>${escapeHtml(order.notes)}</p></div>` : ''}
    <section class="doc-section"><header><h3>Productos solicitados</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items)}${docTotalsMarkup(order)}</section>
    <form class="admin-form order-status-form" data-status-form><div class="form-grid"><fieldset class="status-picker form-grid__full"><legend>Estado del pedido</legend><div class="status-picker__options">${Object.entries(ORDER_STATUS).map(([value, label]) => `<label class="status-option status-option--${value}"><input type="radio" name="status" value="${value}" ${order.status === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div></fieldset><label class="form-grid__full">Notas internas<textarea name="admin_notes" rows="2">${escapeHtml(order.admin_notes || '')}</textarea></label></div><div class="form-actions order-actions"><button class="btn btn--ghost" type="submit">${icon('check', { size: 18 })}<span>Guardar<span class="order-actions__long"> cambios</span></span></button>${waDigits(customer) ? `<a class="btn btn--ghost" href="${waLink(waDigits(customer), `Hola ${firstName(customer.full_name)}, te escribimos de Bodega Mayorista F.C. sobre tu pedido ${order.order_number}.`)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 18 })}<span>WhatsApp</span></a>` : ''}${order.sales?.length ? '' : `<button class="btn btn--primary" data-to-sale type="button"><span>Convertir a venta</span>${icon('arrowRight', { size: 18 })}</button>`}</div></form>`;
  const modal = openModal({ title: `Pedido ${order.order_number}`, content: wrapper, trigger, className: 'modal--wide modal--doc' });
  bindCustomerLinks(wrapper);
  wrapper.querySelector('[data-status-form]').addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const button = event.submitter;
    setButtonLoading(button, true, 'Guardando…');
    try { await updateOrder(order.id, { status: data.get('status'), admin_notes: String(data.get('admin_notes') || '').trim() || null }); toast('Pedido actualizado'); modal.close(true); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar el pedido.'), 'error'); setButtonLoading(button, false); }
  });
  wrapper.querySelectorAll('[data-apply]').forEach(button => button.addEventListener('click', async () => {
    const key = button.dataset.apply;
    setButtonLoading(button, true, 'Aplicando…');
    try { await saveCustomer({ [key]: order.customer_conflicts[key] }, order.customer_id); toast('Ficha actualizada'); button.replaceWith(Object.assign(document.createElement('small'), { textContent: 'Aplicado' })); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar la ficha.'), 'error'); setButtonLoading(button, false); }
  }));
  wrapper.querySelector('[data-to-sale]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    setButtonLoading(button, true, 'Revisando…');
    try {
      const sale = await runWithReview(accept => createSaleFromOrder(order.id, accept), button, 'Crear venta con importes del pedido');
      if (!sale) { setButtonLoading(button, false); return; }
      toast(`Venta ${sale.sale_number} creada. Confírmala para descontar inventario.`); modal.close(true); ctx.navigateTo('sales', { q: sale.sale_number });
    } catch (error) { toast(requestError(error, 'No pudimos crear la venta.'), 'error'); setButtonLoading(button, false); }
  });
}

async function openOrderForm(refresh, trigger = null) {
  const [customers, deliveries, payments] = await Promise.all([getCustomers(), getDeliveryMethods({ all: true }), getPaymentMethods({ all: true })]);
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">Registra aquí los pedidos que llegan por WhatsApp o en persona. Usa precios vigentes del catálogo y no descuenta inventario.</p><div class="form-grid">${customerPickerMarkup(customers)}<label>Origen<select name="source"><option value="WhatsApp">WhatsApp</option><option value="presencial">Presencial</option><option value="manual">Manual</option></select></label><label>Entrega<select name="delivery_method_id"><option value="">Sin definir</option>${deliveries.map(item => `<option value="${item.id}" data-cost="${item.base_cost}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Costo de entrega (COP)<input name="delivery_cost" data-money type="text" inputmode="decimal" value="0"></label><label>Pago preferido<select name="payment_method_id"><option value="">Sin definir</option>${payments.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Ciudad de envío<input name="city" maxlength="80"></label><label class="form-grid__full">Dirección de envío<input name="address" maxlength="250"></label>${lineEditorMarkup()}<label class="form-grid__full">Observaciones<textarea name="notes" rows="2"></textarea></label></div><p class="product-form-error" data-error role="alert" hidden></p><div class="form-actions"><button class="btn btn--primary" type="submit">Registrar pedido</button></div>`;
  const editor = mountLineEditor(form, { deliveryInput: form.elements.delivery_cost });
  bindCustomerPicker(form, customers);
  form.elements.delivery_method_id.addEventListener('change', () => { form.elements.delivery_cost.value = editableMoney(Number(form.elements.delivery_method_id.selectedOptions[0]?.dataset.cost || 0)); form.elements.delivery_cost.dispatchEvent(new Event('input')); });
  const guard = guardUnsaved(() => JSON.stringify(Object.fromEntries(new FormData(form))) + editor.signature());
  const modal = openModal({ title: 'Registrar pedido', content: form, trigger, className: 'modal--wide', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  const requestKey = crypto.randomUUID();
  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const error = form.querySelector('[data-error]'); const data = new FormData(form);
    const delivery = parseMoneyInput(data.get('delivery_cost'));
    const problem = !data.get('customer_id') ? 'Selecciona o crea el cliente.' : delivery == null ? 'Revisa el costo de entrega.' : editor.validate();
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    const button = event.submitter; saving = true; modal.setDismissible(false); setButtonLoading(button, true, 'Registrando…');
    try {
      const order = await createAdminOrder({ customer_id: data.get('customer_id'), source: data.get('source'), delivery_method_id: data.get('delivery_method_id'), payment_method_id: data.get('payment_method_id'), delivery_cost: delivery, city: data.get('city'), address: data.get('address'), notes: data.get('notes'), items: editor.items(), request_key: requestKey });
      toast(`Pedido ${order.order_number} registrado`); modal.close(true); await refresh();
    } catch (saveError) { error.textContent = requestError(saveError, 'No pudimos registrar el pedido.'); error.hidden = false; saving = false; modal.setDismissible(true); setButtonLoading(button, false); }
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

export async function renderQuotes() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'open', page: Number(params.get('page')) || 1 };
  const quotes = await getQuotes();
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Documentos', 'Cotizaciones', 'Las cotizaciones no reservan ni descuentan inventario.', '<button id="new-quote" class="btn btn--primary" type="button">+ Nueva cotización</button>')
    + `<section class="admin-panel">${toolbar(state, 'Buscar número o cliente', { open: 'Abiertas', all: 'Todas', ...QUOTE_STATUS })}<div class="crm-list" data-list></div><div data-pagination></div></section>`;
  const refresh = () => renderQuotes();
  const render = () => {
    syncUrl('quotes', state);
    const term = normalizeText(state.q);
    const matches = quote => state.status === 'all' ? true : state.status === 'open' ? OPEN_QUOTE.includes(quote.status) && !isQuoteExpired(quote) : state.status === 'vencida' ? quote.status === 'vencida' || isQuoteExpired(quote) : quote.status === state.status;
    const visible = quotes.filter(quote => matches(quote) && (!term || normalizeText(`${quote.quote_number} ${quote.customers?.full_name || ''} ${quote.customers?.phone_original || ''}`).includes(term)));
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').textContent = `${visible.length} cotización${visible.length === 1 ? '' : 'es'}`;
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map(quote => `<article class="crm-card" data-quote="${quote.id}"><div><strong>${escapeHtml(quote.quote_number)} ${pill(quote.status, QUOTE_STATUS)}${isQuoteExpired(quote) ? ' <span class="status-pill status-pill--muted">Vigencia vencida</span>' : ''}</strong><span>${escapeHtml(quote.customers?.full_name || 'Cliente')} · ${formatMoney(quote.total)} · ${quote.quote_items?.length || 0} línea(s)</span><span class="crm-card__items">${escapeHtml(itemsPreview(docItems('quote', quote), 3))}</span><small>${dateText(quote.created_at)} · vigencia ${quote.valid_until ? dateText(quote.valid_until) : 'sin definir'}</small></div><div class="admin-row-actions"><button class="small-btn" data-view-quote type="button">Detalle</button>${quoteActionButtons(quote)}</div></article>`).join('') : emptyMarkup(quotes.length ? 'Sin coincidencias' : 'Sin cotizaciones todavía', quotes.length ? 'Prueba con otro filtro.' : 'Crea la primera cuando tengas un cliente y productos.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-quote]').forEach(card => {
      const quote = quotes.find(item => item.id === card.dataset.quote);
      card.querySelector('[data-view-quote]').addEventListener('click', event => openQuoteDetail(quote, refresh, event.currentTarget));
      bindQuoteActions(card, quote, refresh);
    });
  };
  bindToolbar(root, state, render);
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
    <section class="doc-section"><header><h3>Productos cotizados</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items)}${docTotalsMarkup(quote)}</section>
    ${quote.terms_snapshot ? `<details class="doc-terms"><summary>Condiciones comerciales</summary><p>${escapeHtml(quote.terms_snapshot).replace(/\n/g, '<br>')}</p></details>` : ''}
    <div class="doc-actions">${quoteActionButtons(quote, { detail: true })}</div>`;
  const modal = openModal({ title: `Cotización ${quote.quote_number}`, content: wrapper, trigger, className: 'modal--wide modal--doc' });
  bindCustomerLinks(wrapper);
  bindQuoteActions(wrapper, quote, async () => { modal.close(true); await refresh(); }, { onLeave: () => modal.close(true) });
}

async function sendQuoteWhatsapp(quote, refresh, trigger) {
  const customer = quote.customers;
  const text = `Hola ${firstName(customer.full_name)}, te compartimos la cotización ${quote.quote_number} de Bodega Mayorista F.C. por ${formatMoney(quote.total)}${quote.valid_until ? `, válida hasta ${dateText(quote.valid_until)}` : ''}. Te adjuntamos el PDF por este chat.`;
  window.open(waLink(waDigits(customer), text), '_blank', 'noopener');
  if (quote.status !== 'borrador') return;
  const sent = await confirmAction('Descarga el PDF y adjúntalo en el chat. ¿Ya enviaste la cotización? Abrir WhatsApp no la marca como enviada.', 'Marcar como enviada', { confirmLabel: 'Sí, marcar enviada', cancelLabel: 'Todavía no', tone: 'primary', trigger });
  if (!sent) return;
  try { await setQuoteStatus(quote.id, 'enviada'); toast('Cotización marcada como enviada'); await refresh(); } catch (error) { toast(requestError(error, 'No pudimos cambiar el estado.'), 'error'); }
}

async function openQuoteForm(quote, refresh, trigger = null) {
  const [customers, config] = await Promise.all([getCustomers(), settings()]);
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
export async function renderSales() {
  const params = new URLSearchParams(location.search);
  const state = { q: params.get('q') || '', status: params.get('status') || 'all', page: Number(params.get('page')) || 1 };
  const [sales, config] = await Promise.all([getSales(), settings()]);
  const root = $('#admin-content');
  root.innerHTML = ctx.heading('Ventas', 'Ventas y comprobantes', 'Confirmar descuenta inventario una sola vez; cancelar lo restaura una sola vez. Los pagos se registran según lo declarado: la tienda no verifica transacciones bancarias.', '<button id="new-sale" class="btn btn--primary" type="button">+ Venta manual</button>')
    + `<section class="admin-panel">${toolbar(state, 'Buscar número o cliente', { all: 'Todas', confirmed: 'Confirmadas', ...SALE_STATUS })}<div class="crm-list" data-list></div><div data-pagination></div></section>`;
  const refresh = () => renderSales();
  const render = () => {
    syncUrl('sales', state);
    const term = normalizeText(state.q);
    const visible = sales.filter(sale => (state.status === 'all' || (state.status === 'confirmed' ? CONFIRMED_SALE.includes(sale.status) : sale.status === state.status)) && (!term || normalizeText(`${sale.sale_number} ${sale.customers?.full_name || ''} ${sale.customers?.phone_original || ''}`).includes(term)));
    const { pageItems, pages } = paginate(visible, state);
    root.querySelector('[data-results-meta]').textContent = `${visible.length} venta${visible.length === 1 ? '' : 's'}`;
    root.querySelector('[data-list]').innerHTML = pageItems.length ? pageItems.map(sale => `<article class="crm-card" data-sale="${sale.id}"><div><strong>${escapeHtml(sale.sale_number)} ${pill(sale.status, SALE_STATUS)}</strong><span>${escapeHtml(sale.customers?.full_name || 'Cliente')} · ${formatMoney(sale.total)}</span><span class="crm-card__items">${escapeHtml(itemsPreview(docItems('sale', sale), 3))}</span><small>${dateTimeText(sale.created_at)} · origen ${escapeHtml(SOURCES[sale.source] || sale.source)}${sale.payment_method ? ` · pago: ${escapeHtml(sale.payment_method)}` : ''}${sale.sale_returns?.length ? ` · ${sale.sale_returns.length} devolución(es)` : ''}</small></div><div class="admin-row-actions"><button class="small-btn" data-view-sale type="button">Detalle</button><button class="small-btn" data-download-sale type="button">Descargar PDF</button><button class="small-btn" data-print-sale type="button">Imprimir</button>${saleStateButtons(sale)}</div></article>`).join('') : emptyMarkup(sales.length ? 'Sin coincidencias' : 'Sin ventas todavía', sales.length ? 'Prueba con otro filtro.' : 'Convierte un pedido o cotización, o registra una venta manual.');
    root.querySelector('[data-pagination]').innerHTML = paginationMarkup(state.page, pages);
    bindPagination(root.querySelector('[data-pagination]'), state, render);
    root.querySelectorAll('[data-sale]').forEach(card => bindSaleCard(card, sales.find(item => item.id === card.dataset.sale), config, refresh));
  };
  bindToolbar(root, state, render);
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
  card.querySelector('[data-confirm-sale]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    if (!await confirmAction(`Se descontará del inventario lo vendido en ${sale.sale_number}. Si falta stock en alguna línea, no se descuenta nada.`, 'Confirmar venta', { confirmLabel: 'Confirmar y descontar', tone: 'primary', trigger: button })) return;
    setButtonLoading(button, true, 'Confirmando…');
    try { await confirmSale(sale.id); await ctx.refreshProducts(); toast('Venta confirmada e inventario actualizado'); await refresh(); }
    catch (error) { toast(requestError(error, 'No se pudo confirmar.'), 'error'); setButtonLoading(button, false); }
  });
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
  const config = await settings();
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
    <section class="doc-section"><header><h3>Productos vendidos</h3><span>${plural(items.length, 'línea')}</span></header>${docLinesMarkup(items, { returned })}${docTotalsMarkup(sale)}</section>
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

async function openPaidForm(sale, refresh, trigger) {
  const names = await paymentOptions();
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">Registra el pago según lo que confirmaste tú. La tienda web no verifica pagos ni transferencias.</p><label>Método de pago<input name="payment_method" list="payment-method-options" maxlength="80" value="${escapeHtml(sale.payment_method || '')}" required><datalist id="payment-method-options">${names.map(name => `<option value="${escapeHtml(name)}">`).join('')}</datalist></label><div class="form-actions"><button class="btn btn--primary" type="submit">Marcar pagada</button></div>`;
  const modal = openModal({ title: `Pago de ${sale.sale_number}`, content: form, trigger });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; setButtonLoading(button, true, 'Guardando…');
    try { await setSaleStatus(sale.id, 'pagada', form.elements.payment_method.value.trim()); toast('Pago registrado'); modal.close(true); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos registrar el pago.'), 'error'); setButtonLoading(button, false); }
  });
}

function openCancelForm(sale, refresh, trigger) {
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">${sale.stock_applied_at ? 'El inventario descontado se restaurará una sola vez.' : 'Esta venta aún no descontó inventario.'} El comprobante se conserva con estado cancelada.</p><label>Motivo <small>Opcional</small><textarea name="reason" rows="2" maxlength="300"></textarea></label><div class="form-actions"><button class="btn btn--danger" type="submit">Cancelar venta</button></div>`;
  const modal = openModal({ title: `Cancelar ${sale.sale_number}`, content: form, trigger });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; setButtonLoading(button, true, 'Cancelando…');
    try { await cancelSale(sale.id, form.elements.reason.value.trim() || null); await ctx.refreshProducts(); toast('Venta cancelada'); modal.close(true); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos cancelar la venta.'), 'error'); setButtonLoading(button, false); }
  });
}

function openReturnForm(sale, refresh, trigger) {
  const returned = new Map();
  (sale.sale_returns || []).forEach(item => returned.set(item.sale_item_id, (returned.get(item.sale_item_id) || 0) + item.quantity));
  const lines = (sale.sale_items || []).map(item => ({ item, max: item.quantity - (returned.get(item.id) || 0) })).filter(line => line.max > 0);
  const requestKey = crypto.randomUUID();
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<div class="return-lines">${lines.map(({ item, max }) => `<label class="return-line"><span><strong>${escapeHtml(item.product_name)}</strong><small>${escapeHtml(optionText(item.option_snapshot))} · disponible para devolver: ${max}</small></span><input type="number" name="qty-${item.id}" min="0" max="${max}" step="1" value="0" aria-label="Cantidad a devolver de ${escapeHtml(item.product_name)}"></label>`).join('')}</div><fieldset class="return-restock"><legend>¿Las unidades vuelven al inventario?</legend><label class="check-field"><input type="radio" name="restock" value="yes" required> Sí, reintegrar al stock</label><label class="check-field"><input type="radio" name="restock" value="no" required> No (producto dañado u otro motivo)</label></fieldset><label>Nota <small>Opcional</small><textarea name="note" rows="2" maxlength="300"></textarea></label><p class="product-form-error" data-error role="alert" hidden></p><div class="form-actions"><button class="btn btn--primary" type="submit">Registrar devolución</button></div>`;
  const modal = openModal({ title: `Devolución de ${sale.sale_number}`, content: form, trigger, closeOnBackdrop: false });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = form.querySelector('[data-error]');
    const selected = lines.map(({ item }) => ({ sale_item_id: item.id, quantity: Number(form.elements[`qty-${item.id}`].value) || 0 })).filter(line => line.quantity > 0);
    const restock = form.elements.restock.value;
    if (!selected.length) { error.textContent = 'Indica al menos una cantidad a devolver.'; error.hidden = false; return; }
    if (!restock) { error.textContent = 'Decide si las unidades vuelven al inventario.'; error.hidden = false; return; }
    const button = event.submitter; setButtonLoading(button, true, 'Registrando…');
    try { await registerSaleReturn(sale.id, selected, restock === 'yes', requestKey, form.elements.note.value.trim() || null); await ctx.refreshProducts(); toast('Devolución registrada'); modal.close(true); await refresh(); }
    catch (saveError) { error.textContent = requestError(saveError, 'No pudimos registrar la devolución.'); error.hidden = false; setButtonLoading(button, false); }
  });
}

async function openManualSaleForm(refresh, trigger = null) {
  const [customers, names] = await Promise.all([getCustomers(), paymentOptions()]);
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<p class="form-help">Para compras cerradas por WhatsApp o en persona. Se crea como solicitud; el inventario se descuenta solo al confirmar.</p><div class="form-grid">${customerPickerMarkup(customers)}<label>Origen<select name="source"><option value="presencial">Presencial</option><option value="WhatsApp">WhatsApp</option><option value="manual">Manual</option></select></label><label>Método de pago <small>Declarado</small><input name="payment_method" list="manual-payment-options" maxlength="80"><datalist id="manual-payment-options">${names.map(name => `<option value="${escapeHtml(name)}">`).join('')}</datalist></label>${lineEditorMarkup()}<label>Costo de entrega (COP)<input name="delivery_cost" data-money type="text" inputmode="decimal" value="0"></label><label class="check-field"><input name="confirm_now" type="checkbox"> Confirmar y descontar inventario al guardar</label><label class="form-grid__full">Observaciones<textarea name="notes" rows="2"></textarea></label></div><p class="product-form-error" data-error role="alert" hidden></p><div class="form-actions"><button class="btn btn--primary" type="submit">Registrar venta</button></div>`;
  const editor = mountLineEditor(form, { customPrice: true, discount: true, deliveryInput: form.elements.delivery_cost });
  bindCustomerPicker(form, customers);
  const guard = guardUnsaved(() => JSON.stringify(Object.fromEntries(new FormData(form))) + editor.signature());
  const modal = openModal({ title: 'Venta manual', content: form, trigger, className: 'modal--wide', closeOnBackdrop: false, beforeClose: guard.beforeClose });
  let createdSale = null;
  let saving = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const error = form.querySelector('[data-error]'); const data = new FormData(form);
    const delivery = parseMoneyInput(data.get('delivery_cost'));
    const problem = !data.get('customer_id') ? 'Selecciona o crea el cliente.' : delivery == null ? 'Revisa el costo de entrega.' : editor.validate();
    if (problem) { error.textContent = problem; error.hidden = false; return; }
    const button = event.submitter; saving = true; modal.setDismissible(false); setButtonLoading(button, true, 'Registrando…');
    try {
      // Si la confirmación falla, un segundo clic no vuelve a crear la venta.
      createdSale ||= await createManualSale({ customer_id: data.get('customer_id'), source: data.get('source'), payment_method: data.get('payment_method'), delivery_cost: delivery, notes: data.get('notes'), items: editor.items() });
      if (data.has('confirm_now')) { await confirmSale(createdSale.id); await ctx.refreshProducts(); }
      toast(`Venta ${createdSale.sale_number} registrada${data.has('confirm_now') ? ' y confirmada' : ''}`); modal.close(true); await refresh();
    } catch (saveError) {
      error.textContent = createdSale ? `La venta ${createdSale.sale_number} quedó registrada como solicitud, pero no se pudo confirmar: ${requestError(saveError, 'revisa el stock.')}` : requestError(saveError, 'No pudimos registrar la venta.');
      error.hidden = false; saving = false; modal.setDismissible(true); setButtonLoading(button, false);
    }
  });
}
