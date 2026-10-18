// Análisis del cliente en página propia (admin/?section=customer&id=…&tab=…).
// Primera pantalla: relación → oportunidad → evidencias fechadas → acción → indicadores.
// Cada dato indica si es observado, declarado, calculado o configurado. La carga muestra
// el estado real de cada fuente; un error deja el análisis como parcial, nunca como cero.
import {
  createCustomerOffer, createQuoteFromOffer, exportCustomerData, generateCustomerTasks, getContactAttempts, getCustomer, getCustomerHistory, getCustomerOffers,
  getCustomerRanking, getCustomerSignals, getCustomerTasks, getIdentityLinks, getPeerPatterns, getProductRelationships, getTrendingProducts, previewOffer,
  recordContactAttempt, saveCustomer, suppressCustomerSignals, unlinkIdentity, updateCustomerOffer
} from '../lib/api.js';
import { analyzeCustomer } from '../lib/customer-insights.js';
import { diagnoseCustomer } from '../lib/customer-diagnosis.js';
import { METRICS_VERSION, addDays, csvRow, fromCents, periodStart } from '../lib/metrics.js';
import { RECO_RULES } from '../lib/recommender.js';
import { eligibleVariants, priceQuote, variantStock } from '../lib/reco-core.js';
import { birthdayInfo, bogotaTodayIso } from '../lib/crm-dates.js';
import { $, escapeHtml, formatMoney, productImage, setButtonLoading, slugify } from '../lib/helpers.js';
import { confirmAction, openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { bindRecoPanel, customerHint, recoPanelMarkup, tierOf } from '../components/reco-panel.js';
import {
  KIND_LABEL, KIND_STATUS, barList, bindChartTooltips, bindTabs, businessName, categoryRows, columnChart, crmSettings, dateText, dateTimeText,
  doNotContact, emptyMarkup, firstName, initials, insightOptions, insightsMarkup, kpiTile, marketingAllowed, openCustomerProfile, openDocument, pill,
  plural, preferencesMarkup, productMiniList, productTableMarkup, rangeMeter, relativeDays, requestError, waDigits, waLink
} from './admin-crm.js';
import { TASK_KIND, bindTaskCards, openManualTaskForm, taskCardMarkup } from './admin-tasks.js';

let ctx = null;
export function configureAnalysis(context) { ctx = context; }

const PERIODS = [['all', 'Todo el historial'], ['365', 'Últimos 12 meses'], ['180', 'Últimos 6 meses'], ['90', 'Últimos 90 días']];
const TABS = [['summary', 'Resumen'], ['interests', 'Intereses'], ['purchases', 'Compras'], ['offers', 'Ofertas'], ['activity', 'Actividad'], ['follow', 'Seguimiento']];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const KIND_BADGE = { observado: 'Observado', declarado: 'Declarado', 'declarado por el vendedor': 'Declarado por el vendedor', calculado: 'Calculado', configurado: 'Regla configurada', inferido: 'Inferido' };
const OFFER_STATUS = { preparada: 'Preparada', enviada_declarada: 'Enviada (declarado)', respondida: 'Respondida', aceptada: 'Aceptada', rechazada: 'Rechazada', cerrada: 'Cerrada', expirada: 'Expirada' };
const CONTEXT_LABEL = { desconocido: 'Sin declarar', consumo: 'Uso propio', regalo: 'Regalos', reventa: 'Reventa / mayorista' };
const money = cents => (cents == null ? '—' : formatMoney(fromCents(cents)));
const optionLabel = (product, variant) => {
  const color = product.product_colors?.find(item => item.id === variant?.color_id)?.name; const size = product.product_sizes?.find(item => item.id === variant?.size_id)?.name;
  return [color, size].filter(value => value && !/^única$/i.test(value)).join(' · ') || Object.values(variant?.option_values || {}).join(' · ');
};
const storeUrl = path => new URL(`../${path}`, location.href).href;

// --- Carga con estado real por fuente ------------------------------------------------
const SOURCES = [
  ['customer', 'Ficha del cliente', true], ['history', 'Pedidos, cotizaciones y ventas (todas las páginas)', true], ['relationships', 'Reglas de productos'],
  ['ranking', 'Posición entre clientes (agregado)'], ['peers', 'Patrones entre clientes (agregados)'], ['signals', 'Navegación autorizada'],
  ['tasks', 'Tareas'], ['offers', 'Ofertas'], ['contacts', 'Contactos registrados'], ['links', 'Vínculos de identidad'], ['trending', 'Tendencias de la tienda']
];
// Etapas que corre analyzeCustomer/diagnoseCustomer; se muestran tras leer las fuentes.
const AI_PHASES = ['Cruzando historial de compras y frecuencia', 'Comparando con patrones de clientes similares', 'Estimando probabilidad y momento de recompra', 'Generando recomendaciones y próxima acción'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SPARK = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 2.5l2.3 7.2 7.2 2.3-7.2 2.3L12 21.5l-2.3-7.2L2.5 12l7.2-2.3z"/></svg>';
const scanMarkup = () => `<section class="ai-scan" aria-label="Análisis del cliente en curso">
    <div class="ai-scan__grid" aria-hidden="true"></div><div class="ai-scan__beam" aria-hidden="true"></div>
    <div class="ai-scan__stage">
      <div class="ai-core" aria-hidden="true"><span class="ai-core__glow"></span><span class="ai-core__radar"></span><span class="ai-core__ring ai-core__ring--1"></span><span class="ai-core__ring ai-core__ring--2"></span><span class="ai-core__ring ai-core__ring--3"></span><span class="ai-core__orbit"><i></i></span><span class="ai-core__orbit ai-core__orbit--2"><i></i></span><span class="ai-core__nucleus">${SPARK}</span></div>
      <div class="ai-scan__copy">
        <span class="ai-scan__eyebrow"><span class="ai-scan__live"></span>Motor de análisis inteligente</span>
        <h2 data-ai-title>Analizando cliente</h2>
        <p data-ai-phase role="status" aria-live="polite">Conectando con las fuentes de datos</p>
        <div class="ai-progress" aria-hidden="true"><div class="ai-progress__track"><span></span></div><strong data-ai-pct>0%</strong></div>
      </div>
    </div>
    <div class="ai-scan__body">
      <ol class="ai-sources">${SOURCES.map(([key, label], index) => `<li data-source="${key}" data-state="pending" style="--i:${index}"><span class="ai-sources__dot" aria-hidden="true"></span><span class="ai-sources__label">${escapeHtml(label)}</span><small>En cola</small></li>`).join('')}</ol>
      <div class="ai-log" aria-hidden="true"><div class="ai-log__head"><span></span><span></span><span></span><em>Registro del análisis</em></div><ul data-ai-log><li>› Iniciando motor de análisis</li></ul></div>
    </div>
  </section>`;

export async function renderCustomerAnalysis() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const root = $('#admin-content');
  if (!id) { root.innerHTML = ctx.heading('CRM privado', 'Análisis de cliente', '') + emptyMarkup('Elige un cliente', 'Abre un cliente desde la lista para ver su análisis.'); return; }
  const view = { id, period: params.get('period') || 'all', tab: params.get('tab') || 'summary', data: {}, errors: {}, loadedAt: null, selected: new Set() };

  async function load({ refreshCatalog = false } = {}) {
    // Las fuentes se consultan en paralelo; la pantalla las recorre en orden con un ritmo
    // mínimo para que se lea. Cada marca refleja el resultado real (✓ o falló).
    root.innerHTML = scanMarkup();
    const scan = root.querySelector('.ai-scan');
    const pace = view.loadedAt || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.35 : 1;
    const total = SOURCES.length + AI_PHASES.length;
    const progress = step => { const pct = Math.round((step / total) * 100); scan.style.setProperty('--ai-progress', `${pct}%`); scan.querySelector('[data-ai-pct]').textContent = `${pct}%`; };
    const phase = text => { scan.querySelector('[data-ai-phase]').textContent = text; };
    const log = text => { const list = scan.querySelector('[data-ai-log]'); list.insertAdjacentHTML('beforeend', `<li>${escapeHtml(text)}</li>`); while (list.children.length > 6) list.firstElementChild.remove(); };
    const setState = (key, state, note) => { const item = scan.querySelector(`[data-source="${key}"]`); item.dataset.state = state; item.querySelector('small').textContent = note; };
    const since = periodStart(view.period, bogotaTodayIso());
    const tasks = {
      customer: () => getCustomer(id), history: () => getCustomerHistory(id), relationships: () => getProductRelationships({ refresh: refreshCatalog }),
      ranking: () => getCustomerRanking(id, since), peers: () => getPeerPatterns(id, 90, RECO_RULES.peers.minSupport), signals: () => getCustomerSignals(id),
      tasks: () => getCustomerTasks(id), offers: () => getCustomerOffers(id), contacts: () => getContactAttempts(id), links: () => getIdentityLinks(id), trending: () => getTrendingProducts(30, 12)
    };
    if (refreshCatalog) await ctx.refreshProducts().catch(error => { view.errors.catalog = error; });
    await crmSettings().catch(() => null);
    // Cada promesa resuelve con la duración en ms, o null si la fuente falló.
    const results = Object.fromEntries(Object.entries(tasks).map(([key, run]) => {
      const started = performance.now();
      return [key, Promise.resolve().then(run).then(
        value => { view.data[key] = value; delete view.errors[key]; return performance.now() - started; },
        error => { console.error(`Análisis (${key}):`, error); view.errors[key] = error; return null; }
      )];
    }));
    let step = 0;
    for (const [key, label] of SOURCES) {
      if (!scan.isConnected) return;
      setState(key, 'active', 'Analizando'); phase(`Consultando · ${label}`);
      const [ms] = await Promise.all([results[key], wait(230 * pace)]);
      if (!scan.isConnected) return;
      setState(key, ms == null ? 'error' : 'ok', ms == null ? 'Falló' : `${Math.max(1, Math.round(ms))} ms`);
      log(ms == null ? `✕ ${label} — análisis parcial` : `✓ ${label}`);
      if (key === 'customer' && ms != null && view.data.customer?.full_name) scan.querySelector('[data-ai-title]').textContent = `Analizando a ${view.data.customer.full_name}`;
      progress(++step);
    }
    for (const text of AI_PHASES) {
      phase(text); log(`› ${text}`);
      await wait(420 * pace);
      if (!scan.isConnected) return;
      progress(++step);
    }
    view.loadedAt = new Date();
    if (view.errors.customer || view.errors.history || !view.data.customer) {
      root.innerHTML = `<div class="loading-screen loading-screen--error" role="alert"><span class="loading-screen__icon" aria-hidden="true">${icon('alert', { size: 26 })}</span><strong>No pudimos cargar el análisis</strong><p>${escapeHtml(view.data.customer === null ? 'El cliente no existe o fue fusionado.' : requestError(view.errors.customer || view.errors.history, 'Revisa la conexión e intenta de nuevo.'))}</p><button class="btn btn--primary" data-retry type="button">Reintentar</button></div>`;
      root.querySelector('[data-retry]').addEventListener('click', () => load());
      return;
    }
    scan.classList.add('is-done'); scan.querySelector('[data-ai-title]').textContent = 'Análisis completo'; phase('Preparando el informe'); log('✓ Análisis listo');
    await wait(650 * pace);
    if (!scan.isConnected) return;
    render();
  }

  function syncUrl() { history.replaceState({}, '', `${location.pathname}?section=customer&id=${encodeURIComponent(id)}&tab=${view.tab}${view.period !== 'all' ? `&period=${view.period}` : ''}`); }

  function render() {
    const asOf = bogotaTodayIso();
    const customer = view.data.customer; const record = view.data.history;
    const allowed = marketingAllowed(customer) && !doNotContact(customer); const digits = waDigits(customer);
    const links = view.data.links || [];
    const verified = links.some(link => link.level === 'verificado' && !link.scope_to);
    const since = periodStart(view.period, asOf);
    const partial = [...Object.keys(view.errors), ...(record.coverage?.errors || []), ...(record.coverage?.truncated || []).map(key => `${key} (truncado)`)];
    const coverage = { ...(record.coverage || {}), complete: Boolean(record.coverage?.complete) };
    const a = analyzeCustomer(record, insightOptions({ asOf, since, coverage, relationships: view.data.relationships || [], peers: view.data.peers || [], signals: view.data.signals || [], trending: view.data.trending || [], buyingContext: customer.buying_context }));
    const tasks = view.data.tasks || [];
    const dx = diagnoseCustomer(a, { allowed, digits, birthday: birthdayInfo(customer.birth_date), signals: view.data.signals || [], tasks });
    view.analysis = a; view.dx = dx; view.allowed = allowed; view.digits = digits; view.verified = verified;
    const m = a.metrics;
    const panel = (key, content) => `<section class="analysis-panel" role="tabpanel" id="an-panel-${key}" aria-labelledby="an-tab-${key}" data-tab-panel="${key}" ${view.tab === key ? '' : 'hidden'}>${content}</section>`;
    root.innerHTML = `<header class="analysis-head">
        <button class="link-btn" data-back type="button">← Clientes</button>
        <div class="analysis-head__id"><span class="avatar" aria-hidden="true">${escapeHtml(initials(customer.full_name))}</span><div><h1>${escapeHtml(customer.full_name)}</h1><p>${escapeHtml([customer.phone_original, customer.city, `cliente desde ${dateText(customer.created_at)}`].filter(Boolean).join(' · '))}</p></div></div>
        <div class="analysis-head__chips"><span class="status-pill status-pill--${dx.segment.tone}">${escapeHtml(dx.segment.label)}</span><span class="status-pill status-pill--${dx.intent.tone}">${escapeHtml(dx.intent.label)}</span><span class="meta-chip ${allowed ? 'meta-chip--ok' : ''}">${allowed ? 'Acepta promociones' : 'Sin autorización promocional'}</span><span class="meta-chip">${verified ? 'Número verificado' : 'Número declarado (sin verificar)'}</span><span class="meta-chip">Compra para: ${escapeHtml(CONTEXT_LABEL[customer.buying_context] || 'Sin declarar')}</span></div>
        <div class="analysis-head__actions">${digits ? `<a class="small-btn" href="${waLink(digits, `Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 16 })}<span>WhatsApp</span></a>` : ''}<button class="small-btn" data-quick type="button">Ficha rápida</button><button class="small-btn" data-refresh type="button">${icon('history', { size: 16 })}<span>Actualizar datos</span></button><button class="small-btn" data-export type="button">${icon('download', { size: 16 })}<span>Exportar CSV</span></button></div>
      </header>
      <div class="analysis-toolbar"><div class="admin-chips" role="group" aria-label="Periodo de los indicadores">${PERIODS.map(([value, label]) => `<button class="filter-chip ${view.period === value ? 'active' : ''}" data-period="${value}" type="button" aria-pressed="${view.period === value}">${label}</button>`).join('')}</div>
        <p class="analysis-coverage" role="status">Datos consultados ${dateTimeText(view.loadedAt.toISOString())} · ${escapeHtml(METRICS_VERSION)} · ${escapeHtml(dx.version)} · ${escapeHtml(RECO_RULES.version)}${partial.length ? ` · <strong class="text-warning">Parcial: falló ${escapeHtml(partial.join(', '))}</strong>` : ' · historial completo'}</p></div>
      <div class="profile-tabs analysis-tabs" role="tablist" aria-label="Secciones del análisis">${TABS.map(([key, label]) => `<button role="tab" type="button" id="an-tab-${key}" aria-controls="an-panel-${key}" aria-selected="${view.tab === key}" tabindex="${view.tab === key ? 0 : -1}" data-tab="${key}">${label}</button>`).join('')}</div>
      ${panel('summary', summaryMarkup(a, dx, view))}
      ${panel('interests', interestsMarkup(a, view))}
      ${panel('purchases', purchasesMarkup(a, customer, view))}
      ${panel('offers', offersMarkup(a, view))}
      ${panel('activity', activityMarkup(a, view, view.activityPage || 1))}
      ${panel('follow', followMarkup(view))}`;
    bind();
  }

  function bind() {
    const customer = view.data.customer;
    const tabs = bindTabs(root);
    root.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => { view.tab = tab.dataset.tab; syncUrl(); }));
    root.querySelector('[data-back]').addEventListener('click', () => ctx.navigateTo('customers'));
    root.querySelector('[data-quick]').addEventListener('click', event => openCustomerProfile(customer, () => load(), event.currentTarget));
    root.querySelector('[data-refresh]').addEventListener('click', () => load({ refreshCatalog: true }));
    root.querySelector('[data-export]').addEventListener('click', () => exportCsv(customer, view.analysis));
    root.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', async () => {
      view.period = button.dataset.period; syncUrl();
      // El ranking depende del periodo: se consulta de nuevo con el mismo contrato.
      try { view.data.ranking = await getCustomerRanking(id, periodStart(view.period, bogotaTodayIso())); delete view.errors.ranking; } catch (error) { view.errors.ranking = error; }
      render();
    }));
    root.querySelectorAll('[data-go-tab]').forEach(button => button.addEventListener('click', () => { view.tab = button.dataset.goTab; tabs.select(view.tab); syncUrl(); }));
    root.querySelectorAll('[data-open-doc]').forEach(button => button.addEventListener('click', () => {
      const kind = button.dataset.kind; const doc = view.data.history[`${kind}s`]?.find(item => item.id === button.dataset.openDoc);
      if (doc) openDocument(kind, doc, () => load(), button, { fromProfile: true });
    }));
    root.querySelectorAll('[data-action-offer]').forEach(button => button.addEventListener('click', () => {
      const ids = (button.dataset.actionOffer || '').split(',').filter(Boolean);
      const items = view.analysis.recommendations.filter(item => ids.includes(item.product.id));
      openCampaign(items.length ? items : view.analysis.recommendations.slice(0, 1), button);
    }));
    root.querySelector('[data-generate-tasks]')?.addEventListener('click', async event => {
      const button = event.currentTarget; setButtonLoading(button, true, 'Revisando…');
      try { const created = await generateCustomerTasks(id); toast(created ? `${created} tarea(s) nueva(s)` : 'No hay tareas nuevas'); view.data.tasks = await getCustomerTasks(id); render(); }
      catch (error) { toast(requestError(error, 'No pudimos generar tareas.'), 'error'); setButtonLoading(button, false); }
    });
    root.querySelector('[data-new-task]')?.addEventListener('click', event => openManualTaskForm(id, async () => { view.data.tasks = await getCustomerTasks(id); render(); }, event.currentTarget));
    const taskList = root.querySelector('[data-task-list]');
    if (taskList) bindTaskCards(taskList, view.data.tasks || [], async () => { view.data.tasks = await getCustomerTasks(id); view.data.contacts = await getContactAttempts(id).catch(() => view.data.contacts); render(); }, () => customer);
    bindReco(tabs);
    bindOffers();
    bindIdentity();
    root.querySelector('[data-context]')?.addEventListener('change', async event => {
      try { const saved = await saveCustomer({ buying_context: event.target.value, buying_context_source: 'comerciante', buying_context_at: new Date().toISOString() }, id); view.data.customer = { ...view.data.customer, ...saved }; toast('Contexto de compra guardado'); render(); }
      catch (error) { toast(requestError(error, 'No pudimos guardar.'), 'error'); }
    });
    root.querySelectorAll('[data-activity-page]').forEach(button => button.addEventListener('click', () => { view.activityPage = Number(button.dataset.activityPage); render(); root.querySelector('#an-panel-activity')?.scrollIntoView({ block: 'start' }); }));
    bindChartTooltips(root);
  }

  // Panel de recomendaciones (Resumen): escaneo animado → selección → oferta con código.
  function bindReco(tabs) {
    const panel = bindRecoPanel(root, view.analysis, view.data.customer, {
      allowed: view.allowed, digits: view.digits, selected: view.selected, signals: view.data.signals || [], peers: (view.data.peers || []).length,
      products: view.analysis.index.products, productImage, storeUrl: product => storeUrl(`producto.html?slug=${encodeURIComponent(product.slug)}`),
      onReveal: () => { view.recoRevealed = true; }, onCampaign: (items, trigger, withCode) => openCampaign(items, trigger, withCode)
    });
    root.querySelectorAll('[data-go-reco]').forEach(button => button.addEventListener('click', () => {
      if (view.tab !== 'summary') { view.tab = 'summary'; tabs.select('summary'); syncUrl(); }
      if (view.recoRevealed) root.querySelector('#recomendados')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else panel?.run();
    }));
  }

  // Oferta personalizada en un paso: productos recomendados → beneficio y vigencia →
  // totales calculados por la tienda → código privado real → mensaje listo en WhatsApp.
  // withCode = false prepara solo el mensaje con los precios de hoy (sin código).
  function openCampaign(items, trigger, withCode = true) {
    const customer = view.data.customer; const digits = view.digits; const name = firstName(customer.full_name);
    const today = bogotaTodayIso();
    const state = { percent: 10, kind: 'porcentaje', fixed: 20000, days: 7, audience: 'portador', preview: null, edited: false, result: null };
    const lines = items.map(item => ({ item, variantId: item.variant?.id || eligibleVariants(item.product, 1)[0]?.id, quantity: item.quantity || 1, hint: customerHint(item, customer.buying_context) }));
    const wrapper = document.createElement('div');
    wrapper.className = 'campaign';
    wrapper.innerHTML = `<div class="campaign__config">
        ${view.allowed ? '' : `<p class="doc-alert doc-alert--warning">${icon('alert', { size: 16 })} ${digits ? `${escapeHtml(name)} no autorizó mensajes promocionales: envía esta oferta solo si él te la pidió.` : 'El cliente no tiene WhatsApp válido: podrás copiar el mensaje.'}</p>`}
        <section class="campaign__block"><h4><span>1</span> Productos para ${escapeHtml(name)}</h4><ul class="campaign__products">${lines.map((line, index) => `<li data-line="${index}"><img src="${escapeHtml(line.item.image)}" alt="" loading="lazy"><div><strong>${escapeHtml(line.item.product.name)}</strong><small>${escapeHtml(line.hint)}</small></div><span class="campaign__price" data-line-price="${index}"><b>${formatMoney(fromCents(line.item.price.unitCents))}</b></span>${line.item.affinity != null ? `<em class="campaign__aff campaign__aff--${tierOf(line.item.affinity)}">${line.item.affinity} %</em>` : ''}</li>`).join('')}</ul></section>
        ${withCode ? `<section class="campaign__block"><h4><span>2</span> Beneficio del código</h4>
          <div class="campaign__chips" role="radiogroup" aria-label="Descuento">${[5, 10, 15, 20].map(value => `<label><input type="radio" name="benefit" value="p${value}" ${value === 10 ? 'checked' : ''}><span>${value} %</span></label>`).join('')}<label><input type="radio" name="benefit" value="fixed"><span>Valor fijo</span></label></div>
          <label class="campaign__fixed" hidden>Descuento en pesos<input name="fixed" type="number" min="1000" step="1000" value="20000"></label>
          <h4><span>3</span> Vigencia</h4>
          <div class="campaign__chips" role="radiogroup" aria-label="Vigencia">${[[2, '48 horas'], [3, '3 días'], [7, '7 días'], [15, '15 días']].map(([value, label]) => `<label><input type="radio" name="days" value="${value}" ${value === 7 ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
          <label class="check-field campaign__audience"><input type="checkbox" name="verified" ${view.verified ? '' : 'disabled'}><span>Solo para ${escapeHtml(name)} (número verificado) <small>${view.verified ? 'Si no lo marcas, el código es de un solo uso y transferible.' : 'Su número no está verificado: el código será de un solo uso y transferible.'}</small></span></label>
        </section>
        <section class="campaign__totals" data-totals aria-live="polite"><p class="form-help">Calculando con los precios de hoy…</p></section>` : ''}
        <details class="campaign__edit"><summary>${icon('pencil', { size: 14 })} Editar el mensaje</summary><textarea name="message" rows="12" maxlength="1500" aria-label="Mensaje para WhatsApp"></textarea></details>
        <p class="product-form-error" data-error role="alert" hidden></p>
        <div class="campaign__actions">
          <button class="btn btn--primary" data-go type="button">${icon(withCode ? 'sparkles' : 'whatsapp', { size: 18 })}<span>${withCode ? (digits ? 'Generar código y abrir WhatsApp' : 'Generar código') : (digits ? 'Abrir WhatsApp' : 'Copiar mensaje')}</span></button>
          <button class="btn btn--ghost" data-copy type="button">Copiar mensaje</button>
          ${withCode ? '<button class="link-btn" data-advanced type="button">Opciones avanzadas (variantes, cantidades, tope)</button>' : ''}
        </div>
      </div>
      <div class="campaign__phone" aria-label="Vista previa en WhatsApp">
        <div class="wa-mock"><div class="wa-mock__head"><span class="avatar" aria-hidden="true">${escapeHtml(initials(customer.full_name))}</span><div><strong>${escapeHtml(customer.full_name)}</strong><small>${escapeHtml(customer.phone_original || '')}</small></div></div>
        <div class="wa-mock__body"><div class="wa-mock__bubble" data-bubble></div></div></div>
      </div>`;
    const modal = openModal({ title: withCode ? `Oferta personalizada para ${name}` : `Mensaje para ${name}`, content: wrapper, trigger, className: 'modal--wide modal--campaign', closeOnBackdrop: false });
    const textarea = wrapper.querySelector('textarea');
    const errorBox = wrapper.querySelector('[data-error]');
    const CODE_TOKEN = '[CÓDIGO]';
    const benefit = () => ({ kind: state.kind, value: state.kind === 'porcentaje' ? state.percent : state.fixed, max_discount: null, ends_at: `${addDays(today, state.days)}T23:59:59-05:00` });
    const benefitText = () => (state.kind === 'porcentaje' ? `${state.percent} % de descuento` : `${formatMoney(state.fixed)} de descuento`);
    const payloadItems = () => lines.map(line => ({ variant_id: line.variantId, quantity: Number(line.quantity) }));

    const buildMessage = () => {
      const code = state.result?.coupon.code || CODE_TOKEN;
      const preview = state.result ? { lines: state.result.offer.items } : state.preview;
      const blocks = lines.map((line, index) => {
        const server = preview?.lines?.[index];
        const now = fromCents(line.item.price.unitCents) * line.quantity;
        const list = fromCents(line.item.price.listCents) * line.quantity;
        const priceLine = withCode && server && Number(server.discount) > 0
          ? `Antes ~${formatMoney(Number(server.gross ?? (Number(server.line_total) + Number(server.discount))))}~ → *${formatMoney(server.line_total)}* con tu código`
          : list > now ? `~${formatMoney(list)}~ *${formatMoney(now)}*` : `*${formatMoney(now)}*`;
        return [`*${index + 1}. ${line.item.product.name}*${line.quantity > 1 ? ` × ${line.quantity}` : ''}`, `_${line.hint}_`, `💰 ${priceLine}`, `👉 ${storeUrl(`producto.html?slug=${encodeURIComponent(line.item.product.slug)}`)}`].join('\n');
      });
      const total = state.result?.offer.totals?.total ?? (state.preview ? Number(state.preview.subtotal) - Number(state.preview.discount_total) : null);
      return [
        `Hola ${name} 👋`,
        `Te escribimos de *${businessName().replace(/\.+$/, '')}* 🛍️`,
        `${withCode ? 'Preparamos una oferta exclusiva para ti' : `Elegimos ${lines.length === 1 ? 'este producto' : 'estos productos'} pensando en ti`}:`,
        ...blocks,
        withCode ? `🎁 Tu código: *${code}*\n${benefitText()}${total != null ? ` · total *${formatMoney(total)}*` : ''} · válido hasta el ${dateText(addDays(today, state.days))} · un solo uso.` : '',
        withCode ? `Úsalo en el carrito de la tienda (${storeUrl('carrito.html')}) o respóndenos este mensaje y te lo apartamos. 🙌` : `¿Te interesa ${lines.length === 1 ? 'este producto' : 'alguno'}? Respóndenos con ${lines.length === 1 ? 'un *sí*' : 'el *número*'} y te confirmamos disponibilidad y formas de pago.`,
        '_Precios y stock sujetos a confirmación._'
      ].filter(Boolean).join('\n\n');
    };
    // Formato de WhatsApp en la vista previa: *negrita*, _cursiva_, ~tachado~.
    const waFormat = text => escapeHtml(text).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>').replace(/\[CÓDIGO\]/g, '<mark>CÓDIGO</mark>').replace(/\n/g, '<br>');
    const refreshMessage = () => {
      if (!state.edited) textarea.value = buildMessage();
      else if (state.result) textarea.value = textarea.value.split(CODE_TOKEN).join(state.result.coupon.code);
      wrapper.querySelector('[data-bubble]').innerHTML = `${waFormat(textarea.value)}<time>${new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })} ✓✓</time>`;
    };
    textarea.addEventListener('input', () => { state.edited = true; refreshMessage(); });

    let previewTimer = 0; let previewSeq = 0;
    const runPreview = () => {
      if (!withCode) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const seq = ++previewSeq; const box = wrapper.querySelector('[data-totals]');
        box.classList.add('is-loading');
        try {
          const preview = await previewOffer(payloadItems(), benefit());
          if (seq !== previewSeq) return;
          state.preview = preview;
          const ok = preview.status === 'valido' && !Number(preview.unavailable_lines);
          box.innerHTML = `${ok ? '' : `<p class="doc-alert doc-alert--warning">${Number(preview.unavailable_lines) ? 'Algún producto no tiene stock suficiente: usa "Opciones avanzadas".' : 'El beneficio no aplica a estos productos.'}</p>`}
            <dl><div><dt>Subtotal</dt><dd>${formatMoney(preview.subtotal)}</dd></div><div class="is-discount"><dt>Descuento del código</dt><dd>−${formatMoney(preview.discount_total)}</dd></div><div class="is-total"><dt>Total para ${escapeHtml(name)}</dt><dd>${formatMoney(Number(preview.subtotal) - Number(preview.discount_total))}</dd></div></dl>
            <p class="panel-note">${preview.margin_available ? `Margen estimado: <b>${formatMoney(preview.margin_total)}</b> (${Math.round(Number(preview.margin_rate) * 100)} %) con los costos registrados.` : 'Margen no disponible: faltan costos registrados.'} El envío se cobra aparte.</p>`;
          (preview.lines || []).forEach((line, index) => { const cell = wrapper.querySelector(`[data-line-price="${index}"]`); if (cell && Number(line.discount) > 0) cell.innerHTML = `<del>${formatMoney(Number(line.line_total) + Number(line.discount))}</del><b>${formatMoney(line.line_total)}</b>`; else if (cell) cell.innerHTML = `<b>${formatMoney(line.line_total)}</b>`; });
          wrapper.querySelector('[data-go]').disabled = !ok;
          refreshMessage();
        } catch (error) { if (seq === previewSeq) box.innerHTML = `<p class="doc-alert doc-alert--warning">${escapeHtml(requestError(error, 'No pudimos calcular los totales.'))}</p>`; }
        finally { box.classList.remove('is-loading'); }
      }, 220);
    };
    wrapper.addEventListener('change', event => {
      const target = event.target;
      if (target.name === 'benefit') { const fixed = target.value === 'fixed'; state.kind = fixed ? 'valor_fijo' : 'porcentaje'; if (!fixed) state.percent = Number(target.value.slice(1)); wrapper.querySelector('.campaign__fixed').hidden = !fixed; }
      if (target.name === 'fixed') state.fixed = Math.max(1000, Number(target.value) || 0);
      if (target.name === 'days') state.days = Number(target.value);
      if (target.name === 'verified') state.audience = target.checked ? 'cliente_verificado' : 'portador';
      if (['benefit', 'fixed', 'days'].includes(target.name)) runPreview();
      refreshMessage();
    });
    wrapper.querySelector('[data-advanced]')?.addEventListener('click', event => { modal.close(true); openOfferForm(customer, items, event.currentTarget); });
    wrapper.querySelector('[data-copy]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(textarea.value); toast('Mensaje copiado'); } catch { toast('No se pudo copiar automáticamente.', 'error'); } });

    const openWhatsApp = (win, text) => {
      const url = waLink(digits, text);
      if (win && !win.closed) { win.opener = null; win.location.href = url; } else window.open(url, '_blank', 'noopener');
    };
    const showSuccess = () => {
      const { coupon, offer } = state.result;
      const config = wrapper.querySelector('.campaign__config');
      config.innerHTML = `<div class="campaign__done"><span class="campaign__done-icon" aria-hidden="true">${icon('checkCircle', { size: 30 })}</span><h4>Código generado</h4>
        <button class="campaign__code" data-copy-code type="button" title="Copiar código"><code>${escapeHtml(coupon.code)}</code>${icon('download', { size: 14 })}</button>
        <p>${escapeHtml(benefitText())} · total ${formatMoney(offer.totals?.total)} · vence el ${dateText(coupon.ends_at || addDays(today, state.days))}. La oferta quedó guardada en la pestaña Ofertas.</p>
        <div class="campaign__actions">${digits ? `<button class="btn btn--primary" data-reopen type="button">${icon('whatsapp', { size: 18 })}<span>Abrir WhatsApp otra vez</span></button>` : ''}<button class="btn btn--ghost" data-copy-final type="button">Copiar mensaje</button><button class="btn btn--ghost" data-declare type="button">${icon('check', { size: 18 })}<span>Ya lo envié</span></button></div>
        <p class="form-help">Abrir WhatsApp no prueba que el mensaje se envió: marca "Ya lo envié" cuando lo mandes.</p></div>`;
      config.querySelector('[data-copy-code]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(coupon.code); toast('Código copiado'); } catch { toast(coupon.code); } });
      config.querySelector('[data-copy-final]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(textarea.value); toast('Mensaje copiado'); } catch { toast('No se pudo copiar automáticamente.', 'error'); } });
      config.querySelector('[data-reopen]')?.addEventListener('click', () => openWhatsApp(null, textarea.value));
      config.querySelector('[data-declare]').addEventListener('click', async event => {
        const button = event.currentTarget; setButtonLoading(button, true, 'Guardando…');
        try { await updateCustomerOffer(offer.id, { status: 'enviada_declarada', message: textarea.value }); toast('Registrado como enviado'); modal.close(true); }
        catch (error) { toast(requestError(error, 'No pudimos registrar el envío.'), 'error'); setButtonLoading(button, false); }
      });
    };

    wrapper.querySelector('[data-go]').addEventListener('click', async event => {
      const button = event.currentTarget; errorBox.hidden = true;
      if (!withCode) {
        if (digits) { openWhatsApp(null, textarea.value); recordContactAttempt({ customer_id: customer.id, kind: 'preparado', purpose: 'comercial' }).catch(console.warn); modal.close(true); }
        else { try { await navigator.clipboard.writeText(textarea.value); toast('Mensaje copiado'); } catch { toast('No se pudo copiar automáticamente.', 'error'); } }
        return;
      }
      // La pestaña se abre en el clic (los navegadores bloquean ventanas abiertas después de esperar).
      const win = digits ? window.open('', '_blank') : null;
      if (win) win.document.write('<p style="font:16px system-ui;padding:2rem">Generando código y preparando el mensaje…</p>');
      setButtonLoading(button, true, 'Generando código…'); modal.setDismissible(false);
      try {
        state.result = await createCustomerOffer({ customer_id: customer.id, title: `Oferta para ${name} · ${lines.map(line => line.item.product.name).join(', ').slice(0, 80)}`, items: payloadItems(), benefit: benefit(), audience: state.audience, max_uses: 1,
          recommendation: { version: RECO_RULES.version, items: lines.map(line => ({ product_id: line.item.product.id, affinity: line.item.affinity, reasons: line.item.reasons.map(reason => reason.text) })) } });
        refreshMessage();
        await updateCustomerOffer(state.result.offer.id, { message: textarea.value }).catch(console.warn);
        if (digits) { openWhatsApp(win, textarea.value); recordContactAttempt({ customer_id: customer.id, offer_id: state.result.offer.id, kind: 'preparado', purpose: 'comercial' }).catch(console.warn); }
        modal.setDismissible(true);
        showSuccess();
        view.data.offers = await getCustomerOffers(id).catch(() => view.data.offers);
        const offersPanel = root.querySelector('#an-panel-offers');
        if (offersPanel) { offersPanel.innerHTML = offersMarkup(view.analysis, view); bindOffers(); }
      } catch (error) {
        win?.close();
        errorBox.textContent = requestError(error, 'No pudimos generar el código.'); errorBox.hidden = false;
        modal.setDismissible(true); setButtonLoading(button, false);
      }
    });
    refreshMessage();
    runPreview();
  }

  function bindOffers() {
    root.querySelectorAll('[data-offer]').forEach(card => {
      const offer = (view.data.offers || []).find(item => item.id === card.dataset.offer); if (!offer) return;
      const reload = async () => { view.data.offers = await getCustomerOffers(id); view.data.contacts = await getContactAttempts(id).catch(() => view.data.contacts); render(); };
      card.querySelector('[data-offer-message]')?.addEventListener('click', event => openMessage(view.data.customer, offer.message_text || offerMessage(view.data.customer, offer, offer.coupons?.code), { purpose: 'comercial', offerId: offer.id, trigger: event.currentTarget, onDeclared: reload }));
      card.querySelector('[data-offer-response]')?.addEventListener('click', event => openOfferResponse(offer, reload, event.currentTarget));
      card.querySelector('[data-offer-quote]')?.addEventListener('click', async event => {
        const button = event.currentTarget; setButtonLoading(button, true, 'Creando…');
        try { const quote = await createQuoteFromOffer(offer.id); toast(`Cotización ${quote.quote_number} creada con los mismos importes`); await reload(); }
        catch (error) { toast(requestError(error, 'No pudimos crear la cotización.'), 'error'); setButtonLoading(button, false); }
      });
      card.querySelector('[data-offer-close]')?.addEventListener('click', async event => {
        if (!await confirmAction('La oferta se cerrará y su código quedará inactivo si nadie lo ha usado.', 'Cerrar oferta', { confirmLabel: 'Cerrar oferta', trigger: event.currentTarget })) return;
        try { await updateCustomerOffer(offer.id, { status: 'cerrada' }); toast('Oferta cerrada'); await reload(); } catch (error) { toast(requestError(error, 'No pudimos cerrar la oferta.'), 'error'); }
      });
    });
  }

  function bindIdentity() {
    root.querySelectorAll('[data-unlink]').forEach(button => button.addEventListener('click', async () => {
      if (!await confirmAction('Se dejará de asociar la navegación de ese dispositivo con este cliente (por ejemplo, si es un dispositivo compartido).', 'Desvincular', { confirmLabel: 'Desvincular', trigger: button })) return;
      try { await unlinkIdentity(button.dataset.unlink, 'desvinculado_por_comerciante'); view.data.links = await getIdentityLinks(id); view.data.signals = await getCustomerSignals(id); toast('Vínculo terminado'); render(); }
      catch (error) { toast(requestError(error, 'No pudimos desvincular.'), 'error'); }
    }));
    root.querySelector('[data-export-subject]')?.addEventListener('click', async event => {
      const button = event.currentTarget; setButtonLoading(button, true, 'Preparando…');
      try { const data = await exportCustomerData(id); download(`Datos_${slugify(view.data.customer.full_name) || 'cliente'}_${bogotaTodayIso()}.json`, JSON.stringify(data, null, 2), 'application/json'); }
      catch (error) { toast(requestError(error, 'No pudimos exportar.'), 'error'); }
      finally { setButtonLoading(button, false); }
    });
    root.querySelector('[data-suppress]')?.addEventListener('click', async event => {
      if (!await confirmAction('Se borrarán las señales de navegación vinculadas a este cliente y se terminarán sus vínculos. Pedidos, cotizaciones y ventas se conservan.', 'Suprimir navegación', { confirmLabel: 'Suprimir', trigger: event.currentTarget })) return;
      try { const result = await suppressCustomerSignals(id, 'solicitud_del_titular'); toast(`${result.eventos_borrados} evento(s) borrado(s)`); await load(); }
      catch (error) { toast(requestError(error, 'No pudimos suprimir.'), 'error'); }
    });
  }

  // Crear oferta: variantes y cantidades → beneficio → revisar totales (servidor) → guardar.
  function openOfferForm(customer, items, trigger) {
    if (!items.length) { toast('Elige al menos un producto recomendado.', 'error'); return; }
    const today = bogotaTodayIso();
    const lines = items.map(item => ({ product: item.product, variantId: item.variant?.id || eligibleVariants(item.product, 1)[0]?.id, quantity: item.quantity || 1, affinity: item.affinity, reasons: item.reasons.map(reason => reason.text) }));
    const form = document.createElement('form');
    form.className = 'admin-form offer-form';
    const linesMarkup = () => lines.map((line, index) => {
      const options = eligibleVariants(line.product, 1);
      return `<div class="offer-line" data-line="${index}"><strong>${escapeHtml(line.product.name)}</strong><label>Variante<select data-field="variantId">${options.map(variant => `<option value="${variant.id}" ${variant.id === line.variantId ? 'selected' : ''}>${escapeHtml(optionLabel(line.product, variant) || 'Única')} · stock ${variantStock(line.product, variant)}</option>`).join('')}</select></label><label>Cantidad<input data-field="quantity" type="number" min="1" max="999" value="${line.quantity}"></label><button class="line-row__remove" data-remove-line type="button" aria-label="Quitar ${escapeHtml(line.product.name)}">×</button></div>`;
    }).join('');
    form.innerHTML = `<p class="form-help">La oferta crea un código privado; no cambia el precio público ni la promoción del producto. El total final lo recalcula la tienda cuando el cliente aplica el código.</p>
      <fieldset class="form-grid__full"><legend>Productos</legend><div data-lines>${linesMarkup()}</div></fieldset>
      <div class="form-grid"><label>Tipo de beneficio<select name="kind"><option value="porcentaje">Porcentaje</option><option value="valor_fijo">Valor fijo (COP)</option></select></label><label>Valor<input name="value" type="number" min="1" step="1" value="10" required></label>
      <label>Tope del descuento (COP) <small>Opcional</small><input name="max_discount" type="number" min="1" step="1"></label><label>Válido hasta<input name="ends_at" type="date" min="${addDays(today, 1)}" value="${addDays(today, 7)}" required></label>
      <fieldset class="form-grid__full"><legend>Quién puede usarlo</legend><label class="check-field"><input type="radio" name="audience" value="portador" checked><span>Código de un solo uso. <small>Es transferible: quien tenga el código puede usarlo una vez.</small></span></label><label class="check-field"><input type="radio" name="audience" value="cliente_verificado" ${view.verified ? '' : 'disabled'}><span>Solo este cliente verificado. <small>${view.verified ? 'Su número está verificado por WhatsApp entrante.' : 'Requiere que el cliente verifique su número desde la tienda.'}</small></span></label></fieldset>
      <label class="form-grid__full">Título interno<input name="title" maxlength="120" value="Oferta para ${escapeHtml(firstName(customer.full_name))}"></label></div>
      <div class="offer-preview" data-preview aria-live="polite"><p class="form-help">Pulsa "Revisar totales" para calcular con el precio vigente (variante, promoción y tramo).</p></div>
      <p class="product-form-error" data-error role="alert" hidden></p>
      <div class="form-actions"><button class="btn btn--ghost" data-preview-btn type="button">Revisar totales</button><button class="btn btn--primary" type="submit" disabled>Guardar oferta</button></div>`;
    const modal = openModal({ title: `Crear oferta para ${customer.full_name}`, content: form, trigger, className: 'modal--wide', closeOnBackdrop: false });
    let previewed = null; let signature = '';
    const payloadItems = () => lines.map(line => ({ variant_id: line.variantId, quantity: Number(line.quantity) }));
    const benefit = () => ({ kind: form.elements.kind.value, value: Number(form.elements.value.value), max_discount: form.elements.max_discount.value ? Number(form.elements.max_discount.value) : null, ends_at: form.elements.ends_at.value ? `${form.elements.ends_at.value}T23:59:59-05:00` : null });
    const currentSignature = () => JSON.stringify([payloadItems(), benefit(), form.elements.audience.value]);
    const invalidate = () => { if (currentSignature() !== signature) { form.querySelector('[type="submit"]').disabled = true; } };
    form.addEventListener('input', event => {
      const row = event.target.closest('[data-line]');
      if (row && event.target.dataset.field) lines[Number(row.dataset.line)][event.target.dataset.field] = event.target.value;
      invalidate();
    });
    form.addEventListener('change', invalidate);
    form.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-line]');
      if (remove) { lines.splice(Number(remove.closest('[data-line]').dataset.line), 1); form.querySelector('[data-lines]').innerHTML = linesMarkup(); invalidate(); if (!lines.length) modal.close(true); }
    });
    form.querySelector('[data-preview-btn]').addEventListener('click', async event => {
      const button = event.currentTarget; const error = form.querySelector('[data-error]'); error.hidden = true;
      setButtonLoading(button, true, 'Calculando…');
      try {
        previewed = await previewOffer(payloadItems(), benefit());
        signature = currentSignature();
        form.querySelector('[data-preview]').innerHTML = previewMarkup(previewed, lines);
        form.querySelector('[type="submit"]').disabled = previewed.status !== 'valido' || Number(previewed.unavailable_lines) > 0;
      } catch (previewError) { error.textContent = requestError(previewError, 'No pudimos calcular la oferta.'); error.hidden = false; }
      finally { setButtonLoading(button, false); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!previewed || currentSignature() !== signature) return;
      const button = event.submitter; setButtonLoading(button, true, 'Guardando…'); modal.setDismissible(false);
      try {
        const result = await createCustomerOffer({ customer_id: customer.id, title: form.elements.title.value, items: payloadItems(), benefit: benefit(), audience: form.elements.audience.value, max_uses: 1,
          recommendation: { version: RECO_RULES.version, items: lines.map(line => ({ product_id: line.product.id, affinity: line.affinity, reasons: line.reasons })) } });
        const message = offerMessage(customer, { items: result.offer.items, totals: result.offer.totals }, result.coupon.code, result.coupon.ends_at);
        await updateCustomerOffer(result.offer.id, { message });
        modal.close(true);
        view.data.offers = await getCustomerOffers(id).catch(() => view.data.offers);
        render();
        openMessage(customer, message, { purpose: 'comercial', offerId: result.offer.id, title: `Oferta lista · código ${result.coupon.code}`, onDeclared: async () => { view.data.offers = await getCustomerOffers(id); render(); } });
      } catch (saveError) { const error = form.querySelector('[data-error]'); error.textContent = requestError(saveError, 'No pudimos guardar la oferta.'); error.hidden = false; modal.setDismissible(true); setButtonLoading(button, false); }
    });
  }

  // Mensaje editable. Abrir WhatsApp solo registra "preparado"; "Ya lo envié" es declarado.
  function openMessage(customer, text, { purpose = 'comercial', offerId = null, trigger = null, title = 'Preparar mensaje', onDeclared = null } = {}) {
    const digits = waDigits(customer);
    const form = document.createElement('form');
    form.className = 'admin-form';
    form.innerHTML = `${purpose === 'comercial' && !view.allowed ? '<p class="doc-alert doc-alert--warning">El cliente no autorizó contacto promocional: envía esto solo si él lo pidió.</p>' : ''}<label>Mensaje <small>Puedes editarlo</small><textarea name="message" rows="10" maxlength="1500">${escapeHtml(text)}</textarea></label><div class="form-actions">${digits ? '<button class="btn btn--primary" type="submit">Abrir WhatsApp</button>' : '<p class="doc-alert doc-alert--warning">Sin WhatsApp válido.</p>'}<button class="btn btn--ghost" data-copy type="button">Copiar</button><button class="btn btn--ghost" data-declare type="button">Ya lo envié</button></div><p class="form-help">Abrir WhatsApp no prueba que el mensaje se envió ni que se leyó.</p>`;
    const modal = openModal({ title, content: form, trigger, className: 'modal--wide' });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      window.open(waLink(digits, form.elements.message.value.trim()), '_blank', 'noopener');
      try { await recordContactAttempt({ customer_id: customer.id, offer_id: offerId, kind: 'preparado', purpose }); } catch (error) { console.warn(error); }
    });
    form.querySelector('[data-copy]').addEventListener('click', async () => { try { await navigator.clipboard.writeText(form.elements.message.value); toast('Mensaje copiado'); } catch { toast('No se pudo copiar automáticamente.', 'error'); } });
    form.querySelector('[data-declare]').addEventListener('click', async event => {
      setButtonLoading(event.currentTarget, true, 'Guardando…');
      try {
        if (offerId) await updateCustomerOffer(offerId, { status: 'enviada_declarada', message: form.elements.message.value });
        else await recordContactAttempt({ customer_id: customer.id, kind: 'declarado_enviado', purpose, note: 'Declarado por el vendedor' });
        toast('Registrado como enviado (declarado por ti)'); modal.close(true); await onDeclared?.();
      } catch (error) { toast(requestError(error, 'No pudimos registrar el envío.'), 'error'); setButtonLoading(event.currentTarget, false); }
    });
  }

  await load();
}

// --- Contenido de cada pestaña ------------------------------------------------------------
// Puntaje RFM (1–5) calculado para la vista; 0 = sin datos. El valor usa la posición
// entre clientes cuando está disponible.
function rfmScores(m, rank) {
  const d = m.daysSinceLast; const occasions = m.cadence?.occasions ?? m.occasions ?? 0;
  const recency = d == null ? 0 : d <= 30 ? 5 : d <= 60 ? 4 : d <= 120 ? 3 : d <= 240 ? 2 : 1;
  const frequency = !occasions ? 0 : occasions >= 6 ? 5 : occasions >= 4 ? 4 : occasions;
  const share = rank?.total_customers ? rank.position_rank / rank.total_customers : null;
  const monetary = !m.productsKeptCents ? 0 : share == null ? 1 : share <= 0.1 ? 5 : share <= 0.25 ? 4 : share <= 0.5 ? 3 : share <= 0.75 ? 2 : 1;
  return { recency, frequency, monetary };
}
const INTENT_FILL = { alta: 0.86, media: 0.56, baja: 0.26, sin_senales: 0.06 };
const INTENT_SHORT = { alta: 'Alta', media: 'Media', baja: 'Baja', sin_senales: '—' };
const EVIDENCE_TONE = { observado: 'success', calculado: 'info', declarado: 'warning', configurado: 'info', inferido: 'warning' };

function planItem(action, position) {
  const target = action.action || {};
  const attr = target.type === 'open_doc' && target.id ? `data-open-doc="${escapeHtml(target.id)}" data-kind="${escapeHtml(target.kind)}"`
    : target.type === 'create_offer' ? `data-action-offer="${escapeHtml((target.products || []).join(','))}"` : 'data-go-tab="follow"';
  const cta = target.type === 'open_doc' ? 'Abrir documento' : target.type === 'create_offer' ? 'Preparar oferta' : 'Ir a seguimiento';
  return `<li><span class="dx-plan__n">${position + 1}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.reason)}</p><button class="dx-plan__go" ${attr} type="button">${cta} ${icon('arrowRight', { size: 14 })}</button></div></li>`;
}

// Tarjeta principal: relación (segmento) + intención + RFM | plan de acción numerado.
function diagnosisCard(a, dx, view) {
  const m = a.metrics; const length = 2 * Math.PI * 20;
  const scores = rfmScores(m, view.data.ranking);
  const fill = INTENT_FILL[dx.intent.level] ?? 0.06;
  const hasRecos = a.recommendations.length > 0;
  const actions = dx.actions.slice(0, 3);
  return `<section class="dx-card dx-card--${dx.segment.tone}">
    <div class="dx-card__main">
      <div class="dx-card__top">
        <div class="dx-badge"><small>Segmento</small><strong>${escapeHtml(dx.segment.label)}</strong></div>
        <div class="dx-intent dx-intent--${dx.intent.tone}" title="${escapeHtml(dx.intent.reasons.map(reason => reason.text).join(' · ') || 'Sin señales recientes')}">
          <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="20" class="dx-intent__track"/><circle cx="24" cy="24" r="20" class="dx-intent__value" stroke-dasharray="${length.toFixed(1)}" stroke-dashoffset="${(length * (1 - fill)).toFixed(1)}"/></svg>
          <b>${INTENT_SHORT[dx.intent.level] || '—'}</b><span><small>Intención de compra</small><strong>${escapeHtml(dx.intent.label)}</strong></span>
        </div>
      </div>
      <p class="dx-headline">${escapeHtml(dx.headline)}</p>
      <p class="dx-sub">${escapeHtml(dx.segment.text)} <span class="dx-stage">${escapeHtml(dx.stage.label)}</span></p>
      ${dx.evidence.length ? `<div class="dx-evidence">${dx.evidence.map(item => `<span class="dx-chip dx-chip--${EVIDENCE_TONE[item.kind] || 'info'}">${escapeHtml(item.label)}${item.date ? ` · ${dateText(item.date)}` : ''}</span>`).join('')}</div>` : ''}
      <div class="dx-rfm" aria-label="Puntaje RFM calculado">${[['Recencia', scores.recency], ['Frecuencia', scores.frequency], ['Valor', scores.monetary]].map(([label, score]) => `<span title="${label}: ${score} de 5"><small>${label}</small><i>${[1, 2, 3, 4, 5].map(step => `<b class="${step <= score ? 'is-on' : ''}"></b>`).join('')}</i></span>`).join('')}</div>
    </div>
    <div class="dx-plan">
      <small>${icon('sparkles', { size: 14 })} Plan de acción</small>
      ${actions.length ? `<ol>${actions.map(planItem).join('')}</ol>` : '<p class="dx-plan__empty">Sin acciones con motivo suficiente ahora mismo.</p>'}
      ${hasRecos ? `<button class="dx-plan__cta" data-go-reco type="button">${icon('sparkles', { size: 16 })}<span>Ver qué ofrecerle a ${escapeHtml(firstName(view.data.customer.full_name))}</span></button>` : ''}
      <p class="dx-channel">${icon('chat', { size: 14 })}<span>${escapeHtml(dx.channel)}</span></p>
    </div>
  </section>`;
}

// Navegación autorizada: qué mira, qué guarda en favoritos y qué dejó en el carrito.
function watchingMarkup(view, a) {
  const signals = [...(view.data.signals || [])].sort((x, y) => (Number(y.cart_qty) > 0) - (Number(x.cart_qty) > 0) || y.favorite - x.favorite || y.views - x.views);
  if (view.errors.signals) return '<p class="doc-alert doc-alert--warning">No se pudo consultar la navegación.</p>';
  if (!signals.length) return '<p class="history-empty">Sin navegación vinculada: el cliente no autorizó la personalización o no ha verificado su número. Se analiza solo su historial.</p>';
  return `<ul class="watching">${signals.slice(0, 6).map(signal => {
    const product = a.index.productById.get(signal.product_id);
    const heat = Math.min(100, Number(signal.views) * 14 + (signal.favorite ? 20 : 0) + (Number(signal.cart_qty) > 0 ? 30 : 0));
    return `<li><img src="${escapeHtml(productImage(product))}" alt="" loading="lazy" decoding="async"><span class="watching__main"><strong>${escapeHtml(signal.product_name)}</strong>
      <span class="watching__tags"><em>${icon('zoom', { size: 12 })} ${plural(signal.views, 'vista')} · ${plural(signal.sessions, 'sesión', 'sesiones')}</em>${signal.favorite ? `<em class="is-fav">${icon('heart', { size: 12, filled: true })} Favorito</em>` : ''}${Number(signal.cart_qty) > 0 ? `<em class="is-cart">${icon('bag', { size: 12 })} ${signal.cart_qty} en carrito</em>` : ''}</span>
      <span class="watching__heat" aria-hidden="true"><i style="width:${heat}%"></i></span></span><small>${relativeDays(Math.max(0, Math.round((Date.now() - new Date(signal.last_seen)) / 86400000)))}</small></li>`;
  }).join('')}</ul><p class="panel-note">Identidad ${escapeHtml(signals[0].identity_level)} · solo con personalización autorizada.</p>`;
}

// Cotizó (o pidió) y nunca compró: oportunidades de cierre con precio de hoy.
function quotedNotBought(a) {
  const latest = new Map();
  a.quoteLines.filter(line => line.product && !a.bought.has(line.product.id)).forEach(line => { const prev = latest.get(line.product.id); if (!prev || line.date > prev.date) latest.set(line.product.id, line); });
  return [...latest.values()].sort((x, y) => (y.date > x.date ? 1 : -1)).slice(0, 6).map(line => ({ ...line, unit: line.quantity ? fromCents(line.cents) / line.quantity : 0, open: ['borrador', 'enviada', 'aceptada'].includes(line.doc.status) }));
}

function priceBand(a) {
  const units = a.purchaseLines.filter(line => line.quantity > 0 && line.cents > 0).map(line => fromCents(line.cents) / line.quantity).sort((x, y) => x - y);
  if (!units.length) return null;
  return { min: units[0], max: units.at(-1), avg: units[Math.floor(units.length / 2)], n: units.length };
}

function summaryMarkup(a, dx, view) {
  const m = a.metrics; const rank = view.data.ranking; const funnel = m.funnel.toConfirmedSale;
  const band = priceBand(a);
  const monthly = m.monthly.buckets.map((bucket, position) => ({ label: MONTHS[bucket.month], sublabel: position === 0 || bucket.month === 0 ? `'${String(bucket.year).slice(2)}` : '', value: fromCents(bucket.keptCents), tip: `${MONTHS[bucket.month]} ${bucket.year}: ${money(bucket.keptCents)} en ${plural(bucket.operations, 'compra')}`, cells: [money(bucket.keptCents), String(bucket.operations), money(bucket.returnedCents)] }));
  const nextExpected = m.cadence?.medianGap && m.lastPurchase ? addDays(m.lastPurchase, Math.round(m.cadence.medianGap)) : null;
  const quoted = quotedNotBought(a);
  return `${diagnosisCard(a, dx, view)}
  <section class="kpi-strip kpi-strip--analysis" aria-label="Indicadores del periodo">
    ${kpiTile('Total comprado', money(m.productsKeptCents), `${plural(m.positiveOperations, 'compra')} · ${plural(m.units, 'unidad', 'unidades')}${m.periodReturnedCents ? ` · devuelto ${money(m.periodReturnedCents)}` : ''}`, 'hero')}
    ${kpiTile('Ticket promedio', money(m.avgTicketCents), m.maxTicketCents ? `Máximo ${money(m.maxTicketCents)}` : 'Sin compras en el periodo')}
    ${kpiTile('Recencia', relativeDays(m.daysSinceLast), m.lastPurchase ? `Última: ${dateText(m.lastPurchase)}` : 'Sin compras', m.daysSinceLast > 120 ? 'warning' : '')}
    ${kpiTile('Frecuencia', m.cadence?.medianGap ? `Cada ${Math.round(m.cadence.medianGap)} días` : '—', nextExpected ? `Próxima estimada: ${dateText(nextExpected)}` : 'Necesita 3 compras o más')}
    ${kpiTile('Conversión de cotizaciones', funnel.den ? `${funnel.num} de ${funnel.den}` : '—', funnel.den ? (funnel.rate == null ? 'Muestra pequeña' : `${Math.round(funnel.rate * 100)} % termina en venta`) : 'Sin cotizaciones con resultado')}
    ${kpiTile('Ranking de clientes', view.errors.ranking ? 'No disponible' : rank ? `#${rank.position_rank} de ${rank.total_customers}` : '—', rank ? `${(rank.share_bp / 100).toLocaleString('es-CO')} % de las ventas del periodo` : 'Aún no aparece entre los compradores')}
  </section>
  <div class="card-grid card-grid--analysis">
    <article class="panel-card panel-card--span2"><header><h3>Compras por mes</h3><p>Últimos 12 meses · neto conservado (no depende del periodo elegido)</p></header>${columnChart(monthly, { caption: 'Compras por mes en los últimos 12 meses', tableHead: ['Mes', 'Comprado', 'Compras', 'Devuelto'] })}</article>
    <article class="panel-card"><header><h3>Rango de precios que paga</h3><p>${band ? `Precio unitario en ${plural(band.n, 'línea comprada', 'líneas compradas')}` : 'Sin datos de precio'}</p></header>${band ? `${rangeMeter(band)}<p class="panel-note">Ofrécele productos entre <b>${formatMoney(band.avg * 0.7)}</b> y <b>${formatMoney(band.avg * 1.4)}</b> por unidad: es el rango en el que suele decidir.</p>` : '<p class="history-empty">Aparecerá cuando compre.</p>'}</article>
    <article class="panel-card"><header><h3>Gasto por categoría</h3><p>${a.categories.length ? 'Qué le gusta comprar' : 'Interés según lo cotizado o pedido'}</p></header>${barList(categoryRows(a.categories.length ? a.categories : a.interestCategories), { limit: 6, empty: 'Sin categorías en el periodo.' })}</article>
    <article class="panel-card"><header><h3>Marcas preferidas</h3><p>Participación en lo comprado</p></header>${barList((a.brands || []).map(item => ({ label: item.name, detail: plural(item.units || 0, 'unidad', 'unidades'), value: item.amount, display: `${Math.round(item.share * 100)} %`, tip: `${item.name}: ${formatMoney(item.amount)}` })), { limit: 5, empty: 'Sin marcas en el periodo.' })}</article>
    <article class="panel-card"><header><h3>Lo que está mirando</h3><p>Navegación autorizada de los últimos días</p></header>${watchingMarkup(view, a)}</article>
    <article class="panel-card panel-card--wide panel-card--insights"><header><h3>Hallazgos</h3><p>Lectura automática del periodo</p></header>${insightsMarkup(a.insights)}</article>
    <article class="panel-card panel-card--wide"><header><h3>Productos que ha comprado</h3><p>${plural(groupProducts(a).length, 'producto distinto', 'productos distintos')} · variantes elegidas y última compra</p></header>${a.purchaseLines.length ? productTableMarkup(groupProducts(a).slice(0, 12)) : '<p class="history-empty">Sin compras conservadas en el periodo.</p>'}</article>
    <article class="panel-card panel-card--span2"><header><h3>Cotizó y no compró</h3><p>Oportunidades de cierre con el precio de hoy</p></header>${productMiniList(quoted, 'No hay productos cotizados pendientes de compra.', { detail: row => `${row.doc.quote_number} · ${dateText(row.date)} · cotizado a ${formatMoney(row.unit)}`, right: row => `${row.open ? '<span class="status-pill status-pill--warning">Abierta</span>' : '<span class="status-pill status-pill--muted">Cerrada</span>'}<small>${row.product.status === 'published' ? `Hoy ${formatMoney(fromCents(priceQuote(row.product, eligibleVariants(row.product, 1)[0], 1).unitCents))}` : 'No publicado'}</small>` })}</article>
    <article class="panel-card"><header><h3>Pedidos y cotizaciones abiertos</h3><p>${plural(a.opportunities.length, 'oportunidad abierta', 'oportunidades abiertas')}</p></header>${a.opportunities.length ? `<ul class="history-list">${a.opportunities.map(item => `<li><button class="link-btn" data-open-doc="${escapeHtml(item.doc.id)}" data-kind="${item.journey.originKind === 'order' ? 'order' : item.journey.originKind === 'quote' ? 'quote' : 'sale'}" type="button">${escapeHtml(item.doc.order_number || item.doc.quote_number || item.doc.sale_number)} · ${formatMoney(item.doc.total)}</button><small>${escapeHtml(item.label)} · ${dateText(item.date)}</small></li>`).join('')}</ul>` : '<p class="history-empty">No tiene pedidos ni cotizaciones abiertos.</p>'}</article>
    ${recoPanelMarkup(a, view.data.customer, { revealed: view.recoRevealed, allowed: view.allowed, digits: view.digits, selected: view.selected, storeUrl: product => storeUrl(`producto.html?slug=${encodeURIComponent(product.slug)}`) })}
  </div>`;
}

function opportunityMarkup(opportunity) {
  const doc = opportunity.doc; const kind = opportunity.journey.originKind === 'order' ? 'order' : opportunity.journey.originKind === 'quote' ? 'quote' : 'sale';
  const number = doc.order_number || doc.quote_number || doc.sale_number;
  const status = { disponible: 'Disponible', stock_insuficiente: 'Stock insuficiente', variante_inactiva: 'Variante inactiva', no_publicado: 'No publicado', fuera_catalogo: 'Fuera del catálogo' };
  return `<article class="panel-card opportunity"><header><h3>${escapeHtml(number)} · ${escapeHtml(opportunity.label)}</h3><p>${dateText(opportunity.date)} · ${formatMoney(doc.total)}</p></header>
    <ul class="availability-list">${opportunity.lines.map(line => `<li class="${line.ok ? '' : 'is-warning'}"><span><strong>${escapeHtml(line.item.product_name)}</strong><small>${escapeHtml(Object.values(line.item.option_snapshot || {}).filter(Boolean).join(' · '))} · ${line.item.quantity} u</small></span><span>${escapeHtml(status[line.status] || line.label)}${line.stock != null ? ` (${line.stock} en stock)` : ''}${line.priceChange && line.priceChange !== 'igual' ? ` · precio ${line.priceChange === 'baja' ? 'más bajo' : 'más alto'} hoy (${formatMoney(fromCents(line.unitCents))})` : ''}</span></li>`).join('')}</ul>
    <button class="small-btn" data-open-doc="${escapeHtml(doc.id)}" data-kind="${kind}" type="button">Abrir ${KIND_LABEL[kind].toLowerCase()}</button></article>`;
}

function interestsMarkup(a, view) {
  const signals = view.data.signals || []; const links = view.data.links || [];
  return `<div class="card-grid">
    <article class="panel-card panel-card--wide"><header><h3>Lo que pidió o cotizó y sigue abierto</h3><p>Un recorrido pedido/cotización → venta cuenta una vez; los borradores internos no son interés del cliente</p></header>${a.opportunities.length ? `<div class="opportunity-grid">${a.opportunities.map(opportunityMarkup).join('')}</div>` : '<p class="history-empty">No hay pedidos ni cotizaciones abiertos con señal del cliente.</p>'}</article>
    <article class="panel-card"><header><h3>Categorías de interés</h3><p>Según pedidos y cotizaciones con señal</p></header>${barList(categoryRows(a.interestCategories), { limit: 6, empty: 'Sin interés registrado en el periodo.' })}</article>
    <article class="panel-card"><header><h3>Navegación autorizada</h3><p>Solo con personalización autorizada y vínculo verificado (o la sesión de un pedido)</p></header>${view.errors.signals ? '<p class="doc-alert doc-alert--warning">No se pudo consultar la navegación.</p>' : signals.length ? `<ul class="history-list">${signals.map(signal => `<li><span><strong>${escapeHtml(signal.product_name)}</strong> · ${plural(signal.sessions, 'sesión', 'sesiones')}${signal.favorite ? ' · en favoritos' : ''}${Number(signal.cart_qty) > 0 ? ` · ${signal.cart_qty} en carrito` : ''}</span><small>Último registro ${dateTimeText(signal.last_seen)} · identidad ${escapeHtml(signal.identity_level)}</small></li>`).join('')}</ul>` : '<p class="history-empty">Sin navegación vinculada. Puede que el cliente no haya autorizado la personalización, no haya verificado su número o la tienda tenga la analítica desactivada. No se reconstruye navegación anterior a la autorización.</p>'}</article>
    <article class="panel-card"><header><h3>Identidad y privacidad</h3><p>El teléfono escrito en un pedido no verifica identidad</p></header>${links.length ? `<ul class="history-list">${links.map(link => `<li><span>${escapeHtml({ declarado: 'Declarado (sesión de un pedido)', verificado: 'Verificado por WhatsApp entrante', conflicto: 'En conflicto', desvinculado: 'Desvinculado' }[link.level] || link.level)}</span><small>Desde ${dateTimeText(link.scope_from)}${link.scope_to ? ` hasta ${dateTimeText(link.scope_to)}` : ' · vigente'}${link.ended_reason ? ` · ${escapeHtml(link.ended_reason)}` : ''}</small>${link.level !== 'desvinculado' ? `<button class="small-btn" data-unlink="${escapeHtml(link.id)}" type="button">Desvincular</button>` : ''}</li>`).join('')}</ul>` : '<p class="history-empty">Sin vínculos de navegación.</p>'}
      <div class="admin-row-actions"><button class="small-btn" data-export-subject type="button">Exportar datos del titular</button><button class="small-btn small-btn--danger" data-suppress type="button">Suprimir navegación</button></div></article>
  </div>`;
}

function purchasesMarkup(a, customer, view) {
  const m = a.metrics;
  const monthly = m.monthly.buckets.map((bucket, position) => ({ label: MONTHS[bucket.month], sublabel: position === 0 || bucket.month === 0 ? `'${String(bucket.year).slice(2)}` : '', value: fromCents(bucket.keptCents), tip: `${MONTHS[bucket.month]} ${bucket.year}: ${money(bucket.keptCents)} conservados en ${plural(bucket.operations, 'compra')} · devuelto ese mes ${money(bucket.returnedCents)}`, cells: [money(bucket.keptCents), String(bucket.operations), money(bucket.returnedCents)] }));
  const products = a.purchaseLines.length ? productTableMarkup(groupProducts(a)) : '<p class="history-empty">Sin compras conservadas en el periodo.</p>';
  return `<div class="card-grid card-grid--analysis">
    <article class="panel-card panel-card--span2"><header><h3>Compras por mes</h3><p>Siempre los 12 meses anteriores a hoy con el historial completo (no depende del periodo elegido) · neto conservado por mes de compra</p></header>${columnChart(monthly, { caption: 'Compras netas por mes en los últimos 12 meses', tableHead: ['Mes', 'Neto conservado', 'Compras', 'Devuelto en el mes'] })}</article>
    <article class="panel-card"><header><h3>Contexto de compra</h3><p>Declarado o revisado por ti; cambia cómo se sugieren reposiciones</p></header><label class="field">Compra para<select data-context>${Object.entries(CONTEXT_LABEL).map(([value, label]) => `<option value="${value}" ${customer.buying_context === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${customer.buying_context_at ? `<p class="panel-note">Actualizado ${dateTimeText(customer.buying_context_at)}</p>` : ''}</article>
    <article class="panel-card"><header><h3>Gasto por categoría</h3><p>Neto conservado en el periodo</p></header>${barList(categoryRows(a.categories), { limit: 6, empty: 'Sin compras en el periodo.' })}${preferencesMarkup(a.preferences)}</article>
    <article class="panel-card"><header><h3>Rango de precio por categoría</h3><p>Con la muestra disponible; no indica capacidad de pago</p></header>${a.priceProfile.length ? `<ul class="history-list">${a.priceProfile.map(item => `<li><span><strong>${escapeHtml(item.name)}</strong> · mediana ${money(item.median)}</span><small>${item.enough ? `Entre ${money(item.p25)} y ${money(item.p75)} (25–75 %) · ${item.n} unidades` : `Muestra insuficiente (${item.n} unidad${item.n === 1 ? '' : 'es'})`}</small></li>`).join('')}</ul>` : '<p class="history-empty">Sin compras conservadas.</p>'}</article>
    <article class="panel-card"><header><h3>Devoluciones</h3><p>Compras devueltas en el periodo (valor al neto pactado)</p></header>${a.returnedLines.length ? `<ul class="history-list">${a.returnedLines.map(line => `<li><span>${escapeHtml(line.name)} · ${line.quantity} u</span><small>${escapeHtml(line.doc.sale_number)} · ${money(line.cents)}</small></li>`).join('')}</ul>` : '<p class="history-empty">Sin devoluciones.</p>'}</article>
    <article class="panel-card panel-card--wide"><header><h3>Productos que conserva</h3><p>Variantes elegidas y última compra</p></header>${products}</article>
  </div>`;
}
function groupProducts(a) {
  const map = new Map();
  a.purchaseLines.forEach(line => {
    const entry = map.get(line.key) || { key: line.key, name: line.product?.name || line.name, image: line.image, category: line.category, brand: line.brand, cents: 0, units: 0, docs: new Set(), variants: new Map(), lastDate: '', search: '' };
    entry.cents += line.cents; entry.units += line.quantity; entry.docs.add(line.docId); if (line.date > entry.lastDate) entry.lastDate = line.date;
    const variant = Object.values(line.options || {}).filter(value => value && !/^única$/i.test(String(value))).join(' / ');
    if (variant) entry.variants.set(variant, (entry.variants.get(variant) || 0) + line.quantity);
    map.set(line.key, entry);
  });
  return [...map.values()].map(entry => ({ ...entry, amount: fromCents(entry.cents), times: entry.docs.size, variants: [...entry.variants.entries()] })).sort((x, y) => y.cents - x.cents);
}

function offersMarkup(a, view) {
  const offers = view.data.offers || [];
  const recos = a.recommendations;
  return `<article class="panel-card panel-card--wide offer-cta"><div><h3>${icon('sparkles', { size: 18 })} Productos para ofrecer</h3><p>${recos.length ? `${plural(recos.length, 'producto recomendado', 'productos recomendados')} con afinidad y motivos. Selecciónalos, genera un código y envíalo por WhatsApp en un paso.` : 'No hay productos elegibles con afinidad suficiente todavía.'}</p></div>${recos.length ? `<button class="btn btn--primary" data-go-reco type="button">${icon('sparkles', { size: 18 })}<span>Analizar y recomendar</span></button>` : ''}
      ${a.recommendationExclusions.length ? `<details class="reco-exclusions"><summary>${plural(a.recommendationExclusions.length, 'producto descartado', 'productos descartados')} y por qué</summary><ul>${a.recommendationExclusions.slice(0, 20).map(entry => `<li><strong>${escapeHtml(entry.product.name)}</strong>: ${escapeHtml(entry.reason)}</li>`).join('')}</ul></details>` : ''}
    </article>
    <article class="panel-card panel-card--wide"><header><h3>Ofertas preparadas</h3><p>Código privado por oferta; el uso se registra solo al crear el pedido (reserva) y al confirmar la venta (consumo)</p></header>
      ${view.errors.offers ? '<p class="doc-alert doc-alert--warning">No se pudieron cargar las ofertas.</p>' : offers.length ? `<div class="offer-list">${offers.map(offer => {
        const uses = offer.coupons?.coupon_uses || [];
        const useText = uses.length ? uses.map(use => ({ reservada: 'Reservado en un pedido', consumida: 'Usado en una venta confirmada', liberada: 'Uso liberado' }[use.status])).join(', ') : 'Sin uso registrado';
        return `<article class="offer-card" data-offer="${offer.id}"><div><strong>${escapeHtml(offer.title)}</strong><span>${pill(offer.status, OFFER_STATUS)} · código <code>${escapeHtml(offer.coupons?.code || '—')}</code>${offer.coupons?.ends_at ? ` · vence ${dateText(offer.coupons.ends_at)}` : ''}</span><small>Creada ${dateTimeText(offer.created_at)} · total ${formatMoney(offer.totals?.total)} (ahorro ${formatMoney(offer.totals?.discount_total)}) · ${escapeHtml(useText)}${offer.sent_declared_at ? ` · enviada (declarado) ${dateTimeText(offer.sent_declared_at)}` : ''}${offer.outcome ? ` · resultado: ${escapeHtml(offer.outcome)}` : ''}</small></div><div class="admin-row-actions">${['preparada', 'enviada_declarada', 'respondida'].includes(offer.status) ? '<button class="small-btn" data-offer-message type="button">Preparar mensaje</button><button class="small-btn" data-offer-response type="button">Registrar resultado</button>' : ''}${offer.quote_id ? '<span class="status-pill status-pill--info">Con cotización</span>' : '<button class="small-btn" data-offer-quote type="button">Crear cotización</button>'}${!['cerrada', 'rechazada', 'expirada'].includes(offer.status) ? '<button class="small-btn small-btn--danger" data-offer-close type="button">Cerrar</button>' : ''}</div></article>`;
      }).join('')}</div>` : '<p class="history-empty">Aún no hay ofertas para este cliente.</p>'}
    </article>`;
}

function activityMarkup(a, view, page = 1) {
  const PAGE = 20;
  const entries = a.timeline;
  const pages = Math.max(1, Math.ceil(entries.length / PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const slice = entries.slice((current - 1) * PAGE, current * PAGE);
  const contacts = view.data.contacts || [];
  return `<div class="card-grid"><article class="panel-card panel-card--wide"><header><h3>Cronología</h3><p>Documentos y devoluciones en orden; ${plural(entries.length, 'registro')}</p></header>
    ${slice.length ? `<ol class="timeline">${slice.map(({ kind, doc, date, event }) => kind === 'return' ? `<li><span class="timeline__row"><span class="timeline__dot timeline__dot--sale" aria-hidden="true"></span><span class="timeline__main"><strong>Devolución en ${escapeHtml(doc.sale_number)}</strong><small>${dateText(event.date)} · ${event.quantity} u</small></span><span class="timeline__end"><b>−${money(event.cents)}</b></span></span></li>` : `<li><button type="button" data-open-doc="${escapeHtml(doc.id)}" data-kind="${kind}"><span class="timeline__dot timeline__dot--${kind}" aria-hidden="true"></span><span class="timeline__main"><strong>${KIND_LABEL[kind]} ${escapeHtml(doc[{ sale: 'sale_number', quote: 'quote_number', order: 'order_number' }[kind]])}</strong><small>${dateText(date)}</small></span><span class="timeline__end"><b>${formatMoney(doc.total)}</b>${pill(doc.status, KIND_STATUS[kind])}</span></button></li>`).join('')}</ol>` : '<p class="history-empty">Sin actividad registrada.</p>'}
    ${pages > 1 ? `<nav class="pagination" aria-label="Páginas de la cronología"><button data-activity-page="${current - 1}" ${current === 1 ? 'disabled' : ''} type="button">← Anterior</button><span>Página ${current} de ${pages}</span><button data-activity-page="${current + 1}" ${current === pages ? 'disabled' : ''} type="button">Siguiente →</button></nav>` : ''}</article>
    <article class="panel-card"><header><h3>Contactos registrados</h3><p>Preparado ≠ enviado (declarado) ≠ respuesta</p></header>${contacts.length ? `<ul class="history-list">${contacts.slice(0, 15).map(item => `<li><span>${escapeHtml({ preparado: 'Mensaje preparado', declarado_enviado: 'Enviado (declarado)', respuesta: 'Respuesta', resultado: 'Resultado' }[item.kind] || item.kind)} · ${escapeHtml(item.channel)}${item.outcome ? ` · ${escapeHtml(item.outcome)}` : ''}</span><small>${dateTimeText(item.created_at)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></li>`).join('')}</ul>` : '<p class="history-empty">Sin contactos registrados.</p>'}</article></div>`;
}

function followMarkup(view) {
  const tasks = view.data.tasks || [];
  const open = tasks.filter(task => ['pendiente', 'pospuesta'].includes(task.status));
  const closed = tasks.filter(task => !['pendiente', 'pospuesta'].includes(task.status)).slice(0, 10);
  return `<article class="panel-card panel-card--wide"><header><h3>Tareas de seguimiento</h3><p>Generadas por reglas con motivo visible; no se duplican</p></header><div class="admin-row-actions"><button class="btn btn--primary" data-generate-tasks type="button">Revisar tareas de este cliente</button><button class="btn btn--ghost" data-new-task type="button">Nueva tarea</button></div>
    <div class="task-list" data-task-list>${open.length ? open.map(task => taskCardMarkup(task, { showCustomer: false })).join('') : '<p class="history-empty">No hay tareas abiertas.</p>'}</div>
    ${closed.length ? `<details><summary>Historial (${closed.length})</summary><ul class="history-list">${closed.map(task => `<li><span>${escapeHtml(TASK_KIND[task.kind] || task.kind)} · ${escapeHtml(task.title)}</span><small>${task.status}${task.outcome ? ` · ${escapeHtml(task.outcome)}` : ''}${task.discard_reason ? ` · ${escapeHtml(task.discard_reason)}` : ''}</small></li>`).join('')}</ul></details>` : ''}</article>`;
}

function previewMarkup(preview, lines) {
  const status = { valido: '', sin_productos_elegibles: 'Ningún producto aplica.', minimo_no_alcanzado: 'No alcanza el mínimo.', carrito_no_valido: 'Alguna variante ya no existe.' };
  return `${preview.status !== 'valido' ? `<p class="doc-alert doc-alert--warning">${escapeHtml(status[preview.status] || preview.status)}</p>` : ''}${Number(preview.unavailable_lines) ? '<p class="doc-alert doc-alert--warning">Hay productos sin stock suficiente en la variante elegida: ajusta variante o cantidad.</p>' : ''}
    <table class="offer-table"><thead><tr><th>Producto</th><th>Cant.</th><th>Precio elegible</th><th>Descuento</th><th>Total</th></tr></thead><tbody>${preview.lines.map(line => `<tr class="${line.available ? '' : 'is-warning'}"><td>${escapeHtml(line.product_name)}</td><td>${line.quantity}</td><td>${formatMoney(line.unit_price)}${Number(line.unit_price) < Number(line.regular_unit) ? ' <small>(tramo)</small>' : ''}</td><td>−${formatMoney(line.discount)}</td><td>${formatMoney(line.line_total)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">Subtotal</td><td>${formatMoney(preview.subtotal)}</td></tr><tr><td colspan="4">Descuento de la oferta</td><td>−${formatMoney(preview.discount_total)}</td></tr><tr><th colspan="4">Total sin envío</th><th>${formatMoney(Number(preview.subtotal) - Number(preview.discount_total))}</th></tr></tfoot></table>
    <p class="panel-note">${preview.margin_available ? `Margen bruto estimado: <b>${formatMoney(preview.margin_total)}</b> (${Math.round(Number(preview.margin_rate) * 100)} % del total sin envío), con los costos registrados.` : `Margen no disponible: ${escapeHtml(preview.margin_reason || 'faltan costos')}.`} El envío no se descuenta.</p>`;
  void lines;
}

// --- Mensajes -------------------------------------------------------------------------
function recommendationMessage(customer, items) {
  return [`Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`, 'Pensamos que esto puede interesarte:',
    ...items.map(item => `• ${item.product.name}${optionLabel(item.product, item.variant) ? ` (${optionLabel(item.product, item.variant)})` : ''}: ${formatMoney(fromCents(item.price.unitCents))}\n  ${storeUrl(`producto.html?slug=${encodeURIComponent(item.product.slug)}`)}`),
    'Precios y disponibilidad sujetos a confirmación. ¿Te interesa?'].join('\n\n');
}
function offerMessage(customer, offer, code, endsAt = null) {
  const lines = (offer.items || []).map(line => `• ${line.product_name} × ${line.quantity}: ${Number(line.discount) ? `~${formatMoney(line.gross)}~ ` : ''}*${formatMoney(line.line_total)}*`);
  const expiry = endsAt || offer.coupons?.ends_at;
  return [`Hola ${firstName(customer.full_name)}, te escribimos de ${businessName()}.`, 'Preparamos esta oferta para ti:', ...lines,
    `Total: *${formatMoney(offer.totals?.total)}* (ahorras ${formatMoney(offer.totals?.discount_total)}; envío aparte).`,
    `Usa el código *${code}* en el carrito de ${storeUrl('carrito.html')}${expiry ? ` antes del ${dateText(expiry)}` : ''}. Aplica a los productos indicados y sirve para un solo pedido.`,
    'Precios y stock se confirman al registrar tu pedido.'].join('\n\n');
}

function openOfferResponse(offer, reload, trigger) {
  const form = document.createElement('form');
  form.className = 'admin-form';
  form.innerHTML = `<label>Estado<select name="status"><option value="respondida">Respondió (sin decidir)</option><option value="aceptada">Aceptó</option><option value="rechazada">Rechazó</option></select></label><label>Resultado<select name="outcome"><option value="">Sin definir</option><option value="compro">Compró</option><option value="no_compro">No compró</option><option value="pospuso">Pospuso</option><option value="sin_respuesta">Sin respuesta</option></select></label><label>Nota <small>Motivo si lo dijo; sin datos sensibles</small><textarea name="note" rows="3" maxlength="500"></textarea></label><div class="form-actions"><button class="btn btn--primary" type="submit">Registrar</button></div>`;
  const modal = openModal({ title: 'Registrar resultado de la oferta', content: form, trigger });
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; setButtonLoading(button, true, 'Guardando…');
    try { await updateCustomerOffer(offer.id, Object.fromEntries(new FormData(form))); toast('Resultado registrado'); modal.close(true); await reload(); }
    catch (error) { toast(requestError(error, 'No pudimos registrar el resultado.'), 'error'); setButtonLoading(button, false); }
  });
}

function download(name, text, type) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast(`${name} descargado`);
}

// CSV con celdas de texto neutralizadas contra fórmulas (=, +, -, @…).
function exportCsv(customer, a) {
  const rows = [csvRow(['Tipo', 'Documento', 'Fecha', 'Estado', 'Producto', 'Opciones', 'Referencia', 'Categoría', 'Marca', 'Cantidad', 'Importe neto (COP)', 'Señal'])];
  a.purchaseLines.forEach(line => rows.push(csvRow(['Compra conservada', line.doc.sale_number, line.date, KIND_STATUS.sale[line.doc.status] || line.doc.status, line.name, Object.values(line.options || {}).join(' / '), line.sku, line.category, line.brand, line.quantity, fromCents(line.cents), 'Observado'])));
  a.returnedLines.forEach(line => rows.push(csvRow(['Devolución', line.doc.sale_number, line.date, 'Devuelta', line.name, '', '', line.category, line.brand, line.quantity, -fromCents(line.cents), 'Observado'])));
  a.interestLines.forEach(line => rows.push(csvRow([line.kind === 'order' ? 'Pedido' : line.kind === 'quote' ? 'Cotización' : 'Venta sin confirmar', line.doc?.order_number || line.doc?.quote_number || line.doc?.sale_number || '', line.date, line.journey.label, line.name, Object.values(line.options || {}).join(' / '), line.sku, line.category, line.brand, line.quantity, fromCents(line.cents), line.weight > 0 ? 'Interés del cliente' : 'Sin señal positiva'])));
  download(`Historial_${slugify(customer.full_name) || 'cliente'}_${bogotaTodayIso()}.csv`, `﻿${rows.join('\r\n')}`, 'text/csv;charset=utf-8');
}

