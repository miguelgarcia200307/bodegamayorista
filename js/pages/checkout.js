// Checkout ligero: una sola pantalla. Registra el pedido en el servidor
// (create_storefront_order, número PED-AAAA-000001) y luego abre WhatsApp con el
// mensaje del pedido. El formato del enlace (wa.me/<número>?text=) no cambia.
import { createStorefrontOrder, getDeliveryMethods, getPaymentMethods, markOrderWhatsappOpened } from '../lib/api.js';
import { loadSettings } from '../components/layout.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { cleanLabel, realValue } from '../site-config.js';
import { $, debounce, emptyState, escapeHtml, formatMoney, localAsset, paymentInitials } from '../lib/helpers.js';
import { cartPricing } from '../lib/pricing.js';
import { clearCart, getCart } from '../lib/store.js';

const DRAFT_KEY = 'bodega_mayorista_fc_checkout_v1';
const REQUEST_KEY = 'bodega_mayorista_fc_checkout_request_v1';
let submitting = false;

export async function initCheckout() {
  document.querySelectorAll('.checkout-submit svg').forEach(svg => { svg.outerHTML = icon('whatsapp', { size: 20 }); });
  const cart = getCart();
  if (!cart.length) {
    $('.checkout-page').innerHTML = emptyState('Tu carrito está vacío', 'Agrega productos antes de finalizar el pedido.', 'promociones.html', 'Ver ofertas', 'bag');
    $('#checkout-sticky').hidden = true;
    return;
  }
  const form = $('#checkout-form');
  const settings = await loadSettings();
  const draft = readDraft();
  let deliveries = [], payments = [];
  try { [deliveries, payments] = await Promise.all([getDeliveryMethods(), getPaymentMethods()]); }
  catch (error) { console.warn('No se cargaron los métodos de entrega o pago:', error); }

  const policy = realValue(settings.data_policy_text);
  if (policy) {
    $('#data-policy').hidden = false;
    $('#data-policy-text').textContent = `${policy}${realValue(settings.data_policy_version) ? ` (versión ${settings.data_policy_version})` : ''}`;
  }
  const marketing = realValue(settings.marketing_consent_text);
  if (marketing) $('#marketing-consent-text').textContent = marketing;
  renderDeliveryMethods(deliveries, draft.deliveryMethodId);
  renderPaymentMethods(payments, draft.paymentMethodId);
  restoreDraft(form, draft);
  updateDelivery(form, deliveries);
  renderSummary(cart, selectedDelivery(form, deliveries));
  bindDraftPersistence(form, deliveries);
  bindStickyAction();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !validateForm(form, deliveries, payments, true)) return;
    if (!settings.whatsapp) {
      renderStatus('error', 'Por ahora no podemos recibir pedidos en línea. Escríbenos directamente para ayudarte.');
      return;
    }
    submitting = true;
    setCheckoutLoading(true, 'Registrando tu pedido…');
    const customer = normalizedFormData(form, deliveries);
    const requestKey = currentRequestKey();
    try {
      const response = await createStorefrontOrder({
        name: customer.fullName, phone: customer.phone, city: customer.city, address: customer.address,
        birth_date: customer.birthDate || null, delivery_method_id: customer.deliveryMethodId,
        payment_method_id: customer.paymentMethodId, notes: customer.notes,
        marketing_consent: customer.marketingConsent,
        items: cart.map(item => ({ variant_id: item.variant_id, quantity: Number(item.quantity) }))
      }, requestKey);
      const order = Array.isArray(response) ? response[0] : response;
      if (!order?.order_number) throw new Error('No recibimos el número del pedido.');
      const whatsapp = String(order.whatsapp || '').replace(/\D/g, '');
      if (!whatsapp) throw new Error('El WhatsApp de la tienda no está disponible.');
      const url = `https://wa.me/${encodeURIComponent(whatsapp)}?text=${encodeURIComponent(buildMessage(order, customer, settings))}`;
      saveDraft(customer);
      sessionStorage.removeItem(REQUEST_KEY);
      if (settings.checkout_behavior === 'clear') clearCart();
      showConfirmation(order, url);
      // Solo deja constancia de que se preparó el enlace; no prueba que el mensaje se envió.
      await Promise.race([markOrderWhatsappOpened(requestKey).catch(error => console.warn('No se registró la apertura de WhatsApp:', error)), new Promise(resolve => setTimeout(resolve, 1500))]);
      setTimeout(() => { location.href = url; }, 900);
    } catch (error) {
      console.error(error);
      renderStatus('error', `${String(error?.message || 'No pudimos registrar el pedido.')} Tus datos y tu carrito siguen guardados.`);
      toast('No pudimos registrar el pedido. Revisa los datos e intenta de nuevo.', 'error', 6500);
      setCheckoutLoading(false);
    } finally { submitting = false; }
  });
}

function showConfirmation(order, url) {
  $('#checkout-form').hidden = true;
  $('#checkout-sticky').hidden = true;
  $('#checkout-status').hidden = true;
  document.querySelector('.checkout-title')?.setAttribute('hidden', '');
  const root = $('#checkout-confirmation');
  root.hidden = false;
  root.innerHTML = `<div class="confirmation-card">
    <span class="confirmation-card__icon" aria-hidden="true">${icon('checkCircle', { size: 32 })}</span>
    <p class="eyebrow-label">Pedido ${escapeHtml(order.order_number)}</p>
    <h1>Tu pedido ${escapeHtml(order.order_number)} está listo</h1>
    <p>Te llevamos a WhatsApp para confirmarlo. Solo tienes que enviar el mensaje.</p>
    <p class="confirmation-card__total">Total: <strong>${formatMoney(order.total)}</strong></p>
    <a class="btn btn--whatsapp btn--block" href="${escapeHtml(url)}">${icon('whatsapp', { size: 20 })}<span>Abrir WhatsApp</span></a>
    <p class="field__hint">¿No se abrió automáticamente? Usa el botón de arriba.</p>
    <a class="btn--tertiary" href="index.html">Volver a la tienda</a>
  </div>`;
  scrollTo({ top: 0 });
  root.querySelector('h1').setAttribute('tabindex', '-1');
  root.querySelector('h1').focus();
}

function choiceMarkup(name, method, selected, extra = '') {
  const label = cleanLabel(method.name);
  const cost = name === 'delivery' ? (Number(method.base_cost) ? formatMoney(method.base_cost) : 'Costo por confirmar') : '';
  return `<label class="choice"><input type="radio" name="${name}" value="${method.id}" required ${method.id === selected ? 'checked' : ''}>${extra}<span class="choice__text"><strong>${escapeHtml(label)}</strong>${realValue(method.instructions) ? `<small>${escapeHtml(method.instructions)}</small>` : ''}</span>${cost ? `<span class="choice__meta">${cost}</span>` : ''}</label>`;
}

function renderDeliveryMethods(methods, selected = '') {
  const root = $('#delivery-methods');
  root.innerHTML = methods.length ? methods.map(method => choiceMarkup('delivery', method, selected)).join('') : '<p class="notice notice--warning">Por ahora no hay métodos de entrega disponibles. Escríbenos por WhatsApp para ayudarte.</p>';
}

function renderPaymentMethods(methods, selected = '') {
  const root = $('#payment-methods');
  root.innerHTML = methods.length ? methods.map(method => choiceMarkup('payment', method, selected, `<span class="choice__logo" aria-hidden="true">${method.logo_url ? `<img src="${escapeHtml(localAsset(method.logo_url))}" alt="">` : escapeHtml(paymentInitials(cleanLabel(method.name)))}</span>`)).join('') : '<p class="notice notice--warning">Por ahora no hay métodos de pago disponibles. Escríbenos por WhatsApp para ayudarte.</p>';
}

function selectedDelivery(form, deliveries) { return deliveries.find(item => item.id === form.elements.delivery?.value) || null; }

function bindDraftPersistence(form, deliveries) {
  const persist = debounce(() => saveDraft(normalizedFormData(form, deliveries)), 180);
  form.addEventListener('input', event => { clearFieldError(event.target.name); persist(); });
  form.addEventListener('change', event => {
    clearFieldError(event.target.name);
    if (event.target.name === 'delivery') { updateDelivery(form, deliveries); renderSummary(getCart(), selectedDelivery(form, deliveries)); }
    persist();
  });
  // Validación en línea al salir de cada campo.
  form.addEventListener('focusout', event => {
    const name = event.target.name;
    if (!['fullName', 'phone', 'city', 'address'].includes(name) || !event.target.value) return;
    const errors = fieldErrors(form, deliveries, []);
    setFieldError(form, name, errors[name] || '');
  });
}

function updateDelivery(form, deliveries) {
  const method = selectedDelivery(form, deliveries);
  const needsCity = Boolean(method?.requires_city || method?.requires_address);
  const needsAddress = Boolean(method?.requires_address);
  $('#city-field').hidden = !needsCity; $('#checkout-city').required = needsCity;
  $('#address-field').hidden = !needsAddress; $('#checkout-address').required = needsAddress;
  $('#delivery-note').hidden = true;
}

function fieldErrors(form, deliveries, payments) {
  const method = selectedDelivery(form, deliveries);
  const values = normalizedFormData(form, deliveries);
  return {
    fullName: values.fullName.length < 2 ? 'Escribe tu nombre completo.' : '',
    phone: /^\+?[0-9\s().-]{8,20}$/.test(values.phone) && values.phone.replace(/\D/g, '').length >= 7 ? '' : 'Escribe un número de celular válido, por ejemplo 300 123 4567.',
    delivery: method ? '' : deliveries.length ? 'Elige cómo quieres recibir tu pedido.' : 'No hay métodos de entrega disponibles.',
    city: (method?.requires_city || method?.requires_address) && values.city.length < 2 ? 'Escribe tu ciudad y departamento.' : '',
    address: method?.requires_address && values.address.length < 5 ? 'Escribe la dirección completa de entrega.' : '',
    payment: payments.some(item => item.id === values.paymentMethodId) || !payments.length && values.paymentMethodId ? '' : payments.length ? 'Elige tu método de pago preferido.' : 'No hay métodos de pago disponibles.'
  };
}

function validateForm(form, deliveries, payments, focusFirst = false) {
  const errors = fieldErrors(form, deliveries, payments);
  let first;
  Object.entries(errors).forEach(([name, message]) => {
    setFieldError(form, name, message);
    if (message && !first) first = fieldTarget(form, name) || $(`#${name}-error`);
  });
  const birth = form.elements.birthDate?.value;
  if (birth && new Date(`${birth}T12:00:00`) > new Date()) { toast('La fecha de nacimiento no puede ser futura.', 'error'); first ||= form.elements.birthDate; }
  if (first && focusFirst) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); first.focus?.({ preventScroll: true }); }
  if (first) toast('Revisa los datos marcados', 'error');
  return !first;
}

function setFieldError(form, name, message) {
  const error = $(`#${name}-error`);
  if (error) error.textContent = message;
  const target = fieldTarget(form, name);
  if (['delivery', 'payment'].includes(name)) target?.closest('.checkout-choice-group')?.classList.toggle('has-error', Boolean(message));
  else target?.closest('.field')?.classList.toggle('has-error', Boolean(message));
  target?.setAttribute('aria-invalid', String(Boolean(message)));
}
function clearFieldError(name) { const form = $('#checkout-form'); if (form && name) setFieldError(form, name, ''); }
function fieldTarget(form, name) { return ['delivery', 'payment'].includes(name) ? form.querySelector(`[name="${name}"]`) : form.elements[name]; }

function normalizedFormData(form, deliveries) {
  const method = selectedDelivery(form, deliveries);
  return {
    fullName: String(form.elements.fullName?.value || '').trim().replace(/\s+/g, ' '),
    phone: String(form.elements.phone?.value || '').trim(),
    city: method?.requires_city || method?.requires_address ? String(form.elements.city?.value || '').trim() : '',
    address: method?.requires_address ? String(form.elements.address?.value || '').trim() : '',
    birthDate: String(form.elements.birthDate?.value || ''),
    deliveryMethodId: String(form.elements.delivery?.value || ''),
    deliveryName: method ? cleanLabel(method.name) : '',
    paymentMethodId: String(form.elements.payment?.value || ''),
    paymentName: form.querySelector('[name="payment"]:checked')?.closest('label')?.querySelector('strong')?.textContent || '',
    notes: String(form.elements.notes?.value || '').trim(),
    marketingConsent: Boolean(form.elements.marketingConsent?.checked)
  };
}
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; } }
function saveDraft(value) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(value)); } catch { /* sin almacenamiento */ } }
function restoreDraft(form, draft) {
  for (const name of ['fullName', 'phone', 'city', 'address', 'birthDate', 'notes']) if (typeof draft[name] === 'string' && form.elements[name]) form.elements[name].value = draft[name];
  if (draft.marketingConsent && form.elements.marketingConsent) form.elements.marketingConsent.checked = true;
}
function currentRequestKey() { let key = sessionStorage.getItem(REQUEST_KEY); if (!key) { key = crypto.randomUUID(); sessionStorage.setItem(REQUEST_KEY, key); } return key; }

function renderSummary(cart, delivery) {
  const pricing = cartPricing(cart);
  const deliveryCost = Number(delivery?.base_cost || 0);
  const total = pricing.subtotal + deliveryCost;
  const lines = cart.map(item => {
    const line = pricing.lines.get(item.line_id);
    const options = [item.color, item.size].filter(value => value && !/^única$/i.test(String(value).trim())).join(' · ');
    return `<article class="checkout-line"><img src="${escapeHtml(item.image || 'assets/images/product-white.svg')}" alt="" width="56" height="56"><div><strong>${escapeHtml(item.name)}</strong><span>${options ? `${escapeHtml(options)} · ` : ''}${item.quantity} u${line?.wholesale ? ' · precio por mayor' : ''}</span></div><strong>${formatMoney(line?.total ?? 0)}</strong></article>`;
  }).join('');
  $('#checkout-mobile-products').innerHTML = lines;
  $('#checkout-desktop-products').innerHTML = lines;
  $('#checkout-mobile-count').textContent = `${pricing.units} producto${pricing.units === 1 ? '' : 's'}`;
  $('#checkout-mobile-total').textContent = formatMoney(total);
  $('#checkout-sticky-total').textContent = formatMoney(total);
  $('#checkout-totals').innerHTML = `<div><dt>Productos</dt><dd>${formatMoney(pricing.subtotal + pricing.totalSavings)}</dd></div>${pricing.totalSavings > 0 ? `<div class="is-saving"><dt>Ahorro</dt><dd>−${formatMoney(pricing.totalSavings)}</dd></div>` : ''}<div><dt>Envío</dt><dd class="summary__muted">${delivery ? (deliveryCost ? formatMoney(deliveryCost) : 'Se confirma por WhatsApp') : 'Elige la entrega'}</dd></div><div class="summary__total"><dt>Total</dt><dd>${formatMoney(total)}</dd></div>`;
}

// Mensaje de WhatsApp: saludo, número de pedido, productos con variante, cantidad y
// subtotal, total y datos de entrega. Los importes vienen del servidor.
function buildMessage(order, customer, settings) {
  const business = realValue(settings.business_name) || 'Bodega Mayorista F.C.';
  const lines = [
    `¡Hola ${business}! Quiero confirmar mi pedido.`,
    '',
    `*Pedido ${order.order_number}*`,
    ''
  ];
  (order.items || []).forEach(item => {
    const options = Object.values(item.options || {}).filter(Boolean).join(' · ');
    lines.push(`• ${item.name}${options ? ` (${options})` : ''}`);
    lines.push(`   ${item.quantity} × ${formatMoney(item.unit_price ?? (Number(item.line_total) / Number(item.quantity || 1)))} = ${formatMoney(item.line_total)}`);
  });
  lines.push('', `*Total: ${formatMoney(order.total)}*`, '', '*Datos de entrega*', `Nombre: ${customer.fullName}`, `Celular: ${customer.phone}`, `Entrega: ${customer.deliveryName}`);
  if (customer.city) lines.push(`Ciudad: ${customer.city}`);
  if (customer.address) lines.push(`Dirección: ${customer.address}`);
  if (customer.paymentName) lines.push(`Pago preferido: ${cleanLabel(customer.paymentName)}`);
  if (customer.notes) lines.push(`Notas: ${customer.notes}`);
  lines.push('', 'Quedo atento a la confirmación de disponibilidad, envío y pago. ¡Gracias!');
  return lines.join('\n');
}

function renderStatus(type, message, scroll = true) {
  const root = $('#checkout-status');
  root.hidden = false;
  root.className = `notice notice--${type === 'error' ? 'warning' : 'info'}`;
  root.innerHTML = `${icon(type === 'error' ? 'alert' : 'info', { size: 18 })}<p>${escapeHtml(message)}</p>`;
  if (scroll) root.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setCheckoutLoading(loading, label = '') {
  document.querySelectorAll('.checkout-submit, .checkout-sticky__button').forEach(button => {
    button.classList.toggle('is-loading', loading);
    button.disabled = loading;
    button.setAttribute('aria-busy', String(loading));
  });
  if (loading && label) renderStatus('info', label, false);
}

function bindStickyAction() {
  const sticky = $('#checkout-sticky');
  const primary = $('#checkout-primary-action');
  sticky.hidden = false;
  if (!('IntersectionObserver' in window) || !primary) return;
  new IntersectionObserver(([entry]) => sticky.classList.toggle('is-hidden', entry.isIntersecting), { threshold: .15 }).observe(primary);
}
