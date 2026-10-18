// Panel "Recomendados para ofrecerle" del análisis de cliente: botón de análisis,
// animación de escaneo narrada con los datos REALES del cliente y del motor (historial,
// perfil, navegación autorizada, reglas y afinidad producto a producto) y resultados con
// afinidad 0–100, motivos y selección para preparar una oferta con código por WhatsApp.
import { icon } from './icons.js';
import { toast } from './toast.js';
import { escapeHtml, formatMoney } from '../lib/helpers.js';

export const MAX_PICK = 5;
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const cents = value => formatMoney(Math.round(Number(value || 0)) / 100);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const tierOf = affinity => (affinity == null ? 'general' : affinity >= 60 ? 'alta' : affinity >= 35 ? 'media' : 'baja');
const TIER_LABEL = { alta: 'Alta', media: 'Media', baja: 'Baja', general: 'General' };

// Resumen del cliente que alimenta la narración del escaneo (todo sale del análisis real).
function scanFacts(a, signals, peers = 0) {
  const m = a.metrics; const stats = a.recommendationStats || {};
  const topCategory = a.categories[0] || a.interestCategories[0];
  const topBrand = (a.brands || [])[0];
  const views = signals.reduce((sum, signal) => sum + Number(signal.views || 0), 0);
  const sessions = Math.max(0, ...signals.map(signal => Number(signal.sessions || 0)));
  const favorites = signals.filter(signal => signal.favorite);
  const cart = signals.filter(signal => Number(signal.cart_qty) > 0);
  const scored = [...a.recommendations.map(item => ({ name: item.product.name, score: item.affinity, hit: true })), ...a.recommendationExclusions.slice(0, 8).map(entry => ({ name: entry.product.name, score: null, hit: false }))];
  return { m, stats, peers, topCategory, topBrand, views, sessions, favorites, cart, scored, quotes: a.quotes.length, orders: a.orders.length, lines: a.purchaseLines.length };
}

function scanSteps(f, signals) {
  const share = f.topCategory?.share != null ? ` (${Math.round(f.topCategory.share * 100)} %)` : '';
  return [
    { label: 'Leyendo historial de compras', detail: `${plural(f.m.positiveOperations, 'compra')} · ${plural(f.quotes, 'cotización', 'cotizaciones')}`,
      log: [`historial → ${plural(f.lines, 'línea comprada', 'líneas compradas')} · ${plural(f.orders, 'pedido')} · ${plural(f.quotes, 'cotización', 'cotizaciones')}`, f.m.lastPurchase ? `última compra → hace ${f.m.daysSinceLast} días (${f.m.lastPurchase})` : 'última compra → sin compras confirmadas'] },
    { label: 'Detectando perfil de precio y marcas', detail: [f.topCategory?.name, f.topBrand?.name].filter(Boolean).join(' · ') || 'Perfil general',
      log: [f.topCategory ? `categoría dominante → ${f.topCategory.name}${share}` : 'categoría dominante → aún sin datos', f.topBrand ? `marca preferida → ${f.topBrand.name}` : 'marca preferida → sin preferencia clara', f.m.avgTicketCents ? `ticket promedio → ${cents(f.m.avgTicketCents)}` : 'ticket promedio → sin compras'] },
    { label: 'Leyendo navegación autorizada', detail: signals.length ? `${plural(f.views, 'vista')} · ${plural(f.favorites.length, 'favorito')} · ${f.cart.length} en carrito` : 'Sin navegación vinculada',
      log: signals.length ? [`navegación → ${plural(f.views, 'vista')} en ${plural(f.sessions, 'sesión', 'sesiones')} (máx. por producto)`, ...f.favorites.slice(0, 2).map(signal => `♥ favorito → ${signal.product_name}`), ...f.cart.slice(0, 2).map(signal => `🛒 en carrito → ${signal.product_name} × ${signal.cart_qty}`)] : ['navegación → sin vínculo autorizado: se usa solo el historial'] },
    { label: 'Cruzando complementos, reposición y otros clientes', detail: `${plural(f.stats.sources || 0, 'fuente')} de interés`,
      log: [`fuentes de interés → ${f.stats.sources || 0} (compras, pedidos y cotizaciones con señal)`, `reglas de complemento y reposición → aplicadas`, `patrones entre clientes → ${f.peers ? plural(f.peers, 'patrón', 'patrones') + ' con soporte suficiente' : 'muestra pequeña, no influye'}`] },
    { label: 'Calculando afinidad producto por producto', detail: `${f.stats.eligible || 0} evaluados · ${plural(f.stats.shown || 0, 'candidato')}`,
      log: f.scored.slice(0, 7).map(entry => entry.hit ? `✓ ${entry.name} → afinidad ${entry.score ?? '—'}` : `✕ ${entry.name} → descartado`) }
  ];
}

function launchMarkup(a, customer) {
  return `<div class="reco-launch">
    <div class="reco-orb" aria-hidden="true"><i></i><i></i><i></i>${icon('sparkles', { size: 26 })}</div>
    <div class="reco-launch__copy"><strong>Análisis de afinidad</strong><p>Cruza ${a.recommendationStats?.eligible || 'los'} productos del catálogo con el historial de ${escapeHtml(firstName(customer.full_name))}: compras, cotizaciones, navegación autorizada, complementos, ciclos de reposición, marca preferida y patrones de otros clientes.</p></div>
    <button class="btn btn--primary reco-launch__btn" data-reco-run type="button">${icon('sparkles', { size: 18 })}<span>Analizar y recomendar</span></button>
  </div>`;
}

function scanMarkup(a, customer, steps, thumbs) {
  return `<div class="reco-scan" role="status" aria-live="polite" aria-label="Analizando a ${escapeHtml(firstName(customer.full_name))}">
    <div class="reco-radar" aria-hidden="true"><i class="reco-radar__sweep"></i><i></i><i></i><i></i>${thumbs.filter(thumb => thumb.hit).slice(0, 5).map((thumb, index) => `<em class="reco-radar__blip" style="--a:${index * 67 + 25}deg;--r:${28 + (index % 3) * 13}%"></em>`).join('')}<b data-scan-pct>0 %</b></div>
    <div class="reco-scan__body">
      <div class="reco-scan__title"><strong>Analizando a ${escapeHtml(firstName(customer.full_name))}…</strong><span class="reco-scan__live"><i></i>Motor de afinidad</span></div>
      <ol class="reco-steps">${steps.map(step => `<li data-step><span class="reco-steps__dot">${icon('check', { size: 12 })}</span><span>${escapeHtml(step.label)}</span><small>${escapeHtml(step.detail)}</small></li>`).join('')}</ol>
      <div class="reco-log" aria-hidden="true"><div data-log></div></div>
      <div class="reco-progress"><span data-scan-bar></span></div>
      <div class="reco-strip" aria-hidden="true">${thumbs.map(thumb => `<span ${thumb.hit ? 'data-hit' : ''}><img src="${escapeHtml(thumb.image)}" alt="" loading="lazy" decoding="async"></span>`).join('')}</div>
    </div>
  </div>`;
}

function ring(affinity) {
  const length = 2 * Math.PI * 22; const value = (affinity ?? 0) / 100;
  return `<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" class="reco-ring__track"/><circle cx="26" cy="26" r="22" class="reco-ring__value" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${length.toFixed(1)}" data-ring="${(length * (1 - value)).toFixed(1)}"/></svg>`;
}

function itemMarkup(item, position, { selected, storeUrl }) {
  const tier = tierOf(item.affinity);
  const promoOff = item.price.listCents > item.price.unitCents ? Math.round((1 - item.price.unitCents / item.price.listCents) * 100) : 0;
  return `<label class="reco-item reco-item--${tier}" style="--i:${position}">
    <input type="checkbox" value="${escapeHtml(item.product.id)}" ${selected ? 'checked' : ''} aria-label="Incluir ${escapeHtml(item.product.name)} en la oferta">
    <span class="reco-item__media"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async"></span>
    <span class="reco-item__body">
      <strong>${escapeHtml(item.product.name)}</strong>
      <span class="reco-item__price"><b>${cents(item.price.unitCents)}</b>${promoOff ? `<del>${cents(item.price.listCents)}</del><em>−${promoOff} %</em>` : ''}${item.price.wholesale ? '<em class="is-wholesale">por mayor</em>' : ''}</span>
      <ul class="reco-item__why">${item.reasons.slice(0, 2).map(reason => `<li><b>${escapeHtml(reason.text)}</b>${reason.detail ? `<small>${escapeHtml(reason.detail)}</small>` : ''}</li>`).join('')}</ul>
      <a class="reco-item__link" href="${escapeHtml(storeUrl(item.product))}" target="_blank" rel="noopener">Ver en la tienda ${icon('external', { size: 12 })}</a>
    </span>
    <span class="reco-item__score" title="Afinidad 0–100: qué tanto encaja con su historial">${item.affinity == null ? '<span class="reco-item__general">General</span>' : `${ring(item.affinity)}<b data-count="${item.affinity}">${item.affinity} %</b>`}<small>${TIER_LABEL[tier]}</small></span>
  </label>`;
}

function resultsMarkup(a, ctx) {
  const items = a.recommendations;
  if (!items.length) return `<div class="reco-empty">${icon('info', { size: 20 })}<p>No encontramos productos con afinidad suficiente. El cliente necesita más compras, cotizaciones o navegación autorizada, o no hay existencias en lo que suele comprar.</p><button class="link-btn" data-reco-run type="button">Volver a analizar</button></div>`;
  const topCategories = (a.categories.length ? a.categories : a.interestCategories).slice(0, 2).map(item => item.name);
  const chips = [
    a.recommendationFallback ? ['Modo', 'Recomendación general'] : null,
    topCategories.length ? ['Afinidad', topCategories.join(' · ')] : null,
    a.brands?.[0] ? ['Marca', a.brands[0].name] : null,
    ['Evidencia', a.metrics.evidence.label],
    ['Candidatos', `${items.length} de ${a.recommendationStats?.eligible || items.length}`]
  ].filter(Boolean);
  return `<div class="reco-profile">${chips.map(([label, value], index) => `<span style="--i:${index}"><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join('')}</div>
    <div class="reco-results">${items.map((item, position) => itemMarkup(item, position, { selected: ctx.selected.has(item.product.id), storeUrl: ctx.storeUrl })).join('')}</div>
    <p class="reco-note">Afinidad 0–100 calculada con su historial, su navegación autorizada y las reglas de la tienda (${escapeHtml(a.recommendationStats?.version || '')}). Es una guía comercial, no una garantía de compra.</p>
    ${ctx.allowed ? '' : `<p class="doc-alert doc-alert--warning reco-consent">${icon('alert', { size: 16 })}<span>${ctx.digits ? 'El cliente no ha autorizado mensajes promocionales: envía la oferta solo si él te la pidió.' : 'El cliente no tiene un WhatsApp válido: podrás copiar el mensaje.'}</span></p>`}
    <div class="reco-actions">
      <button class="btn btn--primary" data-reco-campaign type="button">${icon('sparkles', { size: 18 })}<span data-campaign-label>Generar código y preparar WhatsApp</span></button>
      <button class="btn btn--ghost" data-reco-plain type="button">${icon('whatsapp', { size: 18 })}<span>Solo mensaje</span></button>
      <small>Marca hasta ${MAX_PICK} productos. Tú revisas el mensaje antes de enviarlo.</small>
      <button class="link-btn" data-reco-run type="button">Volver a analizar</button>
    </div>`;
}

// revealed: si ya se analizó en esta vista (al cambiar de periodo no se repite la animación).
export function recoPanelMarkup(a, customer, ctx) {
  return `<article class="panel-card panel-card--wide reco-panel ${ctx.revealed ? 'is-revealed' : ''}" id="recomendados" data-reco-panel><header><h3>${icon('sparkles', { size: 18 })} Recomendados para ofrecerle</h3><p>Lo que más encaja con ${escapeHtml(firstName(customer.full_name))}, con el porqué de cada sugerencia</p></header><div data-reco-body>${ctx.revealed ? resultsMarkup(a, ctx) : launchMarkup(a, customer)}</div></article>`;
}

function animateResults(body, instant) {
  body.querySelectorAll('[data-ring]').forEach(circle => { if (instant) circle.style.transition = 'none'; requestAnimationFrame(() => requestAnimationFrame(() => { circle.style.strokeDashoffset = circle.dataset.ring; })); });
  if (instant) return;
  body.querySelectorAll('[data-count]').forEach((label, index) => {
    const target = Number(label.dataset.count); let start = null;
    const tick = now => { start ??= now + index * 90; const progress = Math.max(0, Math.min(1, (now - start) / 1000)); label.textContent = `${Math.round(target * (1 - Math.pow(1 - progress, 3)))} %`; if (progress < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

// Escribe una línea del registro letra por letra (más rápido si la línea es larga).
async function typeLine(log, text, quick) {
  const line = document.createElement('p');
  line.innerHTML = '<span class="reco-log__prompt">›</span> <span></span>';
  log.append(line);
  while (log.children.length > 5) log.firstElementChild.remove();
  const target = line.lastElementChild;
  if (quick) { target.textContent = text; return; }
  const step = Math.max(1, Math.ceil(text.length / 26));
  for (let index = 0; index < text.length; index += step) { target.textContent = text.slice(0, index + step); await wait(16); }
}

async function runScan(body, a, customer, { signals = [], products = [], productImage, peers = 0 }) {
  const facts = scanFacts(a, signals, peers);
  const steps = scanSteps(facts, signals);
  const hits = a.recommendations.map(item => ({ image: item.image, hit: true }));
  const pool = products.filter(product => product.product_images?.length && !a.recommendations.some(item => item.product.id === product.id)).slice(0, Math.max(0, 18 - hits.length)).map(product => ({ image: productImage(product), hit: false }));
  const thumbs = [...pool];
  hits.forEach((hit, index) => thumbs.splice(Math.min(thumbs.length, 3 + index * 3), 0, hit));
  body.innerHTML = scanMarkup(a, customer, steps, thumbs);
  const scan = body.querySelector('.reco-scan');
  scan.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  const items = [...body.querySelectorAll('[data-step]')];
  const bar = body.querySelector('[data-scan-bar]'); const pct = body.querySelector('[data-scan-pct]');
  const log = body.querySelector('[data-log]');
  const strip = [...body.querySelectorAll('.reco-strip span')];
  const quick = reducedMotion();
  const stepTime = quick ? 60 : 1050;
  const total = stepTime * items.length;
  const start = performance.now();
  let frame;
  const tick = now => {
    const progress = Math.min(1, (now - start) / total);
    bar.style.width = `${(progress * 100).toFixed(1)}%`; pct.textContent = `${Math.round(progress * 100)} %`;
    strip.forEach((thumb, position) => thumb.classList.toggle('is-active', position === Math.floor((now - start) / 120) % Math.max(1, strip.length)));
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  for (const [index, item] of items.entries()) {
    item.classList.add('is-active');
    const started = performance.now();
    for (const text of steps[index].log) { if (!body.isConnected) return; await typeLine(log, text, quick); await wait(quick ? 0 : 70); }
    await wait(Math.max(0, stepTime - (performance.now() - started)));
    item.classList.remove('is-active'); item.classList.add('is-done');
  }
  cancelAnimationFrame(frame);
  bar.style.width = '100%'; pct.textContent = '100 %';
  strip.forEach(thumb => thumb.classList.remove('is-active'));
  scan.classList.add('is-complete');
  await typeLine(log, a.recommendations.length ? `listo → ${plural(a.recommendations.length, 'producto recomendado', 'productos recomendados')} para ${firstName(customer.full_name)}` : 'listo → sin candidatos con afinidad suficiente', quick);
  await wait(quick ? 0 : 900);
}

// ctx: { allowed, digits, selected:Set, storeUrl(product), signals, peers (n.º de patrones), products, productImage, onReveal, onCampaign(items, trigger, withCode) }
export function bindRecoPanel(root, a, customer, ctx) {
  const panel = root.querySelector('[data-reco-panel]');
  if (!panel) return;
  const body = panel.querySelector('[data-reco-body]');
  const bindResults = () => {
    const boxes = [...body.querySelectorAll('.reco-item input')];
    const label = body.querySelector('[data-campaign-label]');
    const sync = () => {
      boxes.forEach(box => { if (box.checked) ctx.selected.add(box.value); else ctx.selected.delete(box.value); });
      const count = ctx.selected.size;
      boxes.forEach(box => { box.disabled = !box.checked && count >= MAX_PICK; });
      if (label) label.textContent = count ? `Generar código y preparar WhatsApp (${count})` : 'Generar código y preparar WhatsApp';
    };
    boxes.forEach(box => box.addEventListener('change', sync)); sync();
    const picked = () => a.recommendations.filter(item => ctx.selected.has(item.product.id));
    const launch = (withCode, trigger) => { const items = picked(); if (!items.length) { toast('Marca al menos un producto.', 'error'); return; } ctx.onCampaign(items, trigger, withCode); };
    body.querySelector('[data-reco-campaign]')?.addEventListener('click', event => launch(true, event.currentTarget));
    body.querySelector('[data-reco-plain]')?.addEventListener('click', event => launch(false, event.currentTarget));
    body.querySelectorAll('[data-reco-run]').forEach(button => button.addEventListener('click', run));
  };
  async function run() {
    panel.classList.remove('is-revealed'); panel.classList.add('is-scanning');
    await runScan(body, a, customer, ctx);
    if (!body.isConnected) return;
    // Preselección: las tres de mayor afinidad con encaje medio o alto.
    if (!ctx.selected.size) a.recommendations.filter(item => (item.affinity ?? 0) >= 35).slice(0, 3).forEach(item => ctx.selected.add(item.product.id));
    panel.classList.remove('is-scanning');
    body.innerHTML = resultsMarkup(a, ctx);
    panel.classList.add('is-revealed');
    animateResults(body, reducedMotion());
    panel.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    bindResults();
    ctx.onReveal?.();
  }
  if (body.querySelector('.reco-results, .reco-empty')) { animateResults(body, true); bindResults(); }
  else body.querySelector('[data-reco-run]')?.addEventListener('click', run);
  return { run };
}

// Frase para el CLIENTE a partir del motivo principal. Nunca menciona su navegación ni
// datos internos: solo argumentos de venta que él reconoce.
export function customerHint(item, buyingContext) {
  const keys = item.reasons.map(reason => reason.key);
  const reason = item.reasons[0] || {};
  const owned = String(reason.text || '').replace(/^(Complementa|Compatible con) /, '');
  if (keys[0] === 'complement') return `Ideal para acompañar tu ${owned}`;
  if (keys[0] === 'compatible') return `Compatible con tu ${owned}`;
  if (keys[0] === 'reposition') return buyingContext === 'reventa' ? 'Para reponer el inventario de tu negocio' : 'Para que no te quedes sin él';
  if (keys[0] === 'explicit') return 'El que nos consultaste, con precio especial para ti';
  if (keys.includes('brand') && item.product.brands?.name) return `De ${item.product.brands.name}, la marca que ya conoces`;
  if (keys[0] === 'peers') return 'De lo que más se llevan clientes como tú';
  if (keys.includes('promo')) return 'En promoción por tiempo limitado';
  return 'Elegido pensando en ti';
}
