// Panel "Recomendados para ofrecerle" del análisis de cliente: botón de análisis,
// animación de escaneo con los datos reales del motor y resultados con probabilidad,
// motivos y selección para enviar por WhatsApp.
import { icon } from './icons.js';
import { toast } from './toast.js';
import { escapeHtml, formatMoney, productImage } from '../lib/helpers.js';

const MAX_PICK = 5;
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
const waLink = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
const percent = value => `${Math.round(value * 100)} %`;
const TIER_LABEL = { alta: 'Alta', media: 'Media', exploratoria: 'Baja' };
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function scanSteps(stats) {
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return [
    ['Leyendo historial de compras', `${plural(stats.purchases, 'línea comprada', 'líneas compradas')} · ${plural(stats.interest, 'cotizada', 'cotizadas')}`],
    ['Detectando perfil de precio y marcas', [stats.tier?.label, stats.topBrand].filter(Boolean).join(' · ') || 'Perfil general'],
    ['Cruzando complementos y ciclos de reposición', plural(stats.owned.length, 'necesidad cubierta', 'necesidades cubiertas')],
    ['Comparando con patrones de otros clientes', plural(stats.peers, 'cliente de referencia', 'clientes de referencia')],
    ['Calculando probabilidades', `${stats.evaluated} productos evaluados · ${stats.eligible} candidatos`]
  ];
}

function launchMarkup(data, customer) {
  return `<div class="reco-launch">
    <div class="reco-orb" aria-hidden="true"><i></i><i></i><i></i>${icon('sparkles', { size: 26 })}</div>
    <div class="reco-launch__copy"><strong>Análisis de afinidad</strong><p>Evalúa ${data.recommendationStats.evaluated} productos del catálogo frente al historial de ${escapeHtml(firstName(customer.full_name))} con cinco señales: complementos, ciclo de reposición, marca y ecosistema, perfil de precio y patrones de otros clientes.</p></div>
    <button class="btn btn--primary reco-launch__btn" data-reco-run type="button">${icon('sparkles', { size: 18 })}<span>Analizar y recomendar</span></button>
  </div>`;
}

function scanMarkup(data, customer) {
  const thumbs = data.index.products.filter(product => product.product_images?.length).slice(0, 16);
  return `<div class="reco-scan" role="status" aria-live="polite">
    <div class="reco-radar" aria-hidden="true"><i class="reco-radar__sweep"></i><i></i><i></i><i></i><b data-scan-pct>0 %</b></div>
    <div class="reco-scan__body">
      <strong>Analizando a ${escapeHtml(firstName(customer.full_name))}…</strong>
      <ol class="reco-steps">${scanSteps(data.recommendationStats).map(([label, detail]) => `<li data-step><span class="reco-steps__dot">${icon('check', { size: 12 })}</span><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small></li>`).join('')}</ol>
      <div class="reco-progress"><span data-scan-bar></span></div>
      <div class="reco-strip" aria-hidden="true">${thumbs.map(product => `<span><img src="${escapeHtml(productImage(product))}" alt="" loading="lazy" decoding="async"></span>`).join('')}</div>
    </div>
  </div>`;
}

function ring(probability) {
  const length = 2 * Math.PI * 22;
  return `<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" class="reco-ring__track"/><circle cx="26" cy="26" r="22" class="reco-ring__value" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${length.toFixed(1)}" data-ring="${(length * (1 - probability)).toFixed(1)}"/></svg>`;
}

function resultsMarkup(data, { allowed, digits }) {
  const stats = data.recommendationStats;
  const items = data.recommendations;
  if (!items.length) return `<p class="history-empty">No encontramos productos con suficiente afinidad. El cliente necesita compras o cotizaciones, o no hay existencias en lo que suele comprar.</p>`;
  const canSend = allowed && digits;
  const chips = [
    stats.tier ? ['Perfil de precio', stats.tier.label] : null,
    stats.topLeaves.length ? ['Afinidad', stats.topLeaves.slice(0, 2).join(' · ')] : null,
    stats.topBrand ? ['Marca', stats.topBrand] : null,
    ['Confianza del análisis', percent(stats.confidence)]
  ].filter(Boolean);
  return `<div class="reco-profile">${chips.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join('')}</div>
    <div class="reco-results">${items.map((item, position) => `<label class="reco-item reco-item--${item.tier}" style="--i:${position}">
      <input type="checkbox" value="${position}" ${position < 3 && item.probability >= 0.35 ? 'checked' : ''} ${canSend ? '' : 'disabled'} aria-label="Incluir ${escapeHtml(item.product.name)} en el mensaje">
      <span class="reco-item__media"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async"></span>
      <span class="reco-item__body">
        <strong>${escapeHtml(item.product.name)}</strong>
        <span class="reco-item__price"><b>${formatMoney(item.price)}</b>${item.promo ? `<del>${formatMoney(item.product.base_price)}</del><em>−${Math.round(item.discount * 100)} %</em>` : ''}</span>
        <ul class="reco-item__why">${item.reasons.slice(0, 2).map(reason => `<li><b>${escapeHtml(reason.text)}</b>${reason.detail ? `<small>${escapeHtml(reason.detail)}</small>` : ''}</li>`).join('')}</ul>
      </span>
      <span class="reco-item__score" title="Probabilidad estimada de interés">${ring(item.probability)}<b data-count="${Math.round(item.probability * 100)}">${Math.round(item.probability * 100)} %</b><small>${TIER_LABEL[item.tier]}</small></span>
    </label>`).join('')}</div>
    <div class="reco-actions">${canSend ? `<button class="btn btn--primary" data-send-recos type="button">${icon('whatsapp', { size: 18 })}<span data-send-label>Preparar mensaje de WhatsApp</span></button><small>Marca hasta ${MAX_PICK} productos. WhatsApp se abre con el mensaje listo; tú decides si lo envías.</small>` : `<p class="doc-alert doc-alert--warning">${!digits ? 'El cliente no tiene un teléfono válido para WhatsApp.' : 'El cliente no ha autorizado mensajes promocionales: no le envíes publicidad. Úsalos como guía si él te contacta.'}</p>`}<button class="link-btn" data-reco-run type="button">Volver a analizar</button></div>
    <p class="reco-note">Probabilidad estimada por el modelo de afinidad a partir del historial del cliente y de la tienda. Úsala como guía comercial.</p>`;
}

// Frase corta para el cliente a partir del motivo principal (los demás motivos son internos).
function customerHint(item) {
  const reason = item.reasons.find(entry => entry.text.startsWith('Complementa su ') || entry.text.startsWith('Ecosistema '));
  if (!reason) return '';
  if (reason.text.startsWith('Ecosistema ')) return `Se conecta con tus equipos ${reason.text.slice('Ecosistema '.length)}`;
  // "Acompañar" solo suena natural en accesorios o en la misma marca de lo que ya tiene.
  const owned = reason.text.slice('Complementa su '.length);
  const accessory = ['audio', 'smartwatches', 'menaje', 'pequenos-electrodomesticos'].includes(item.leaf?.slug);
  const sameBrand = item.product.brands?.name && owned.toLowerCase().includes(item.product.brands.name.toLowerCase());
  return accessory || sameBrand ? `Ideal para acompañar tu ${owned}` : '';
}

// Mensaje con formato de WhatsApp: *negrita*, _cursiva_, ~tachado~ y un ítem por bloque.
function whatsappMessage(customer, picked) {
  const store = new URL('../', location.href);
  const items = picked.map((item, position) => {
    const discount = item.promo ? Math.round(item.discount * 100) : 0;
    const hint = customerHint(item);
    return [
      `*${position + 1}. ${item.product.name}*`,
      hint ? `_${hint}_` : '',
      discount ? `💰 *${formatMoney(item.price)}*  ~${formatMoney(item.product.base_price)}~  (−${discount} %)` : `💰 *${formatMoney(item.price)}*`,
      `👉 ${new URL(`producto.html?slug=${encodeURIComponent(item.product.slug)}`, store)}`
    ].filter(Boolean).join('\n');
  });
  const anyPromo = picked.some(item => item.promo);
  return [
    `Hola ${firstName(customer.full_name)} 👋`,
    `Te escribimos de *Bodega Mayorista F.C.* Elegimos ${picked.length === 1 ? 'este producto' : 'estos productos'} pensando en ti:`,
    ...items,
    anyPromo ? '⏳ _Precios promocionales sujetos a disponibilidad._' : '',
    `¿Te interesa ${picked.length === 1 ? 'este producto' : 'alguno'}? Respóndenos con ${picked.length === 1 ? 'un *sí*' : 'el *número*'} y te confirmamos disponibilidad y formas de pago.`
  ].filter(Boolean).join('\n\n');
}

// revealed: si ya se analizó en esta ventana (al cambiar de periodo no se repite la animación).
export function recoPanelMarkup(data, customer, { revealed = false, allowed = false, digits = '' } = {}) {
  return `<article class="panel-card panel-card--wide reco-panel" data-reco-panel><header><h3>${icon('sparkles', { size: 18 })} Recomendados para ofrecerle</h3><p>Lo que es más probable que compre, con el porqué de cada sugerencia</p></header><div data-reco-body>${revealed ? resultsMarkup(data, { allowed, digits }) : launchMarkup(data, customer)}</div></article>`;
}

function animateResults(body, instant) {
  body.querySelectorAll('[data-ring]').forEach(circle => { if (instant) circle.style.transition = 'none'; requestAnimationFrame(() => { circle.style.strokeDashoffset = circle.dataset.ring; }); });
  if (instant) return;
  body.querySelectorAll('[data-count]').forEach(label => {
    const target = Number(label.dataset.count); const start = performance.now();
    const tick = now => { const progress = Math.min(1, (now - start) / 900); label.textContent = `${Math.round(target * (1 - Math.pow(1 - progress, 3)))} %`; if (progress < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

async function runScan(body, data, customer) {
  body.innerHTML = scanMarkup(data, customer);
  const steps = [...body.querySelectorAll('[data-step]')];
  const bar = body.querySelector('[data-scan-bar]'); const pct = body.querySelector('[data-scan-pct]');
  const thumbs = [...body.querySelectorAll('.reco-strip span')];
  const quick = reducedMotion();
  const stepTime = quick ? 80 : 640;
  const total = stepTime * steps.length;
  const start = performance.now();
  let frame;
  const tick = now => {
    const progress = Math.min(1, (now - start) / total);
    bar.style.width = `${(progress * 100).toFixed(1)}%`; pct.textContent = `${Math.round(progress * 100)} %`;
    thumbs.forEach((thumb, position) => thumb.classList.toggle('is-active', position === Math.floor((now - start) / 140) % Math.max(1, thumbs.length)));
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  for (const step of steps) {
    step.classList.add('is-active');
    await wait(stepTime);
    step.classList.remove('is-active'); step.classList.add('is-done');
  }
  cancelAnimationFrame(frame);
  bar.style.width = '100%'; pct.textContent = '100 %';
  await wait(quick ? 0 : 260);
}

export function bindRecoPanel(root, data, customer, { allowed = false, digits = '', onReveal = () => {} } = {}) {
  const panel = root.querySelector('[data-reco-panel]');
  if (!panel) return;
  const body = panel.querySelector('[data-reco-body]');
  const bindResults = () => {
    const boxes = [...body.querySelectorAll('.reco-item input')];
    const label = body.querySelector('[data-send-label]');
    const sync = () => {
      const count = boxes.filter(box => box.checked).length;
      boxes.forEach(box => { box.disabled = !(allowed && digits) || (!box.checked && count >= MAX_PICK); });
      if (label) label.textContent = count ? `Preparar mensaje de WhatsApp (${count})` : 'Preparar mensaje de WhatsApp';
    };
    boxes.forEach(box => box.addEventListener('change', sync)); sync();
    body.querySelector('[data-send-recos]')?.addEventListener('click', () => {
      const picked = boxes.filter(box => box.checked).map(box => data.recommendations[Number(box.value)]);
      if (!picked.length) { toast('Marca al menos un producto para el mensaje.', 'error'); return; }
      window.open(waLink(digits, whatsappMessage(customer, picked)), '_blank', 'noopener');
    });
    body.querySelector('[data-reco-run]')?.addEventListener('click', run);
  };
  async function run() {
    panel.classList.add('is-scanning');
    await runScan(body, data, customer);
    if (!body.isConnected) return;
    panel.classList.remove('is-scanning');
    body.innerHTML = resultsMarkup(data, { allowed, digits });
    panel.classList.add('is-revealed');
    animateResults(body, reducedMotion());
    bindResults();
    onReveal();
  }
  if (body.querySelector('.reco-results')) { animateResults(body, true); bindResults(); }
  else body.querySelector('[data-reco-run]')?.addEventListener('click', run);
}
