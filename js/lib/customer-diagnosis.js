// Diagnóstico comercial del cliente. ÚNICA implementación de segmentación (reglas
// SEGMENT_RULES versionadas): la usan la ficha rápida, el análisis, la lista de clientes y
// las pruebas. Separa tres dimensiones: relación (historial de compras), interés actual
// (señales recientes del comprador) y etapa del recorrido (qué está pendiente hoy).
// No inventa probabilidades: la intención es una etiqueta con sus motivos fechados.
import { formatMoney } from './helpers.js';
import { daysBetween, fromCents, quoteExpired } from './metrics.js';

export const SEGMENT_RULES = { version: 'segmentos-v1', newDays: 60, recurrentBase: 90, gapFactor: 1.5, frequentOccasions: 4, frequentRecency: 60, dormantDays: 365, intentHighDays: 14, intentMediumDays: 30, intentLowDays: 60 };
const shortDate = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
const agoText = days => days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`;
const money = cents => formatMoney(fromCents(cents || 0));

// Relación según compras netas (m = customerMetrics del historial COMPLETO).
export function relationshipSegment(m) {
  const R = SEGMENT_RULES;
  const occasions = m.cadence.occasions;
  const hasJourneys = m.journeys.some(journey => !journey.purchase && !journey.internal);
  if (!m.purchases.length) {
    if (hasJourneys) return { key: 'prospecto', label: 'Prospecto', tone: 'info', text: 'Ha pedido o cotizado, pero no tiene compras confirmadas.' };
    if (m.journeys.length) return { key: 'sin_actividad_cliente', label: 'Sin actividad del cliente', tone: 'muted', text: 'Solo hay documentos internos (borradores nunca enviados).' };
    return { key: 'sin_historial', label: 'Sin historial', tone: 'muted', text: 'Aún no tiene pedidos, cotizaciones ni compras registradas.' };
  }
  if (!occasions) return { key: 'devoluciones', label: 'Compras devueltas', tone: 'danger', text: 'Todas sus compras se devolvieron por completo.' };
  const window = m.cadence.medianGap ? Math.max(R.recurrentBase, m.cadence.medianGap * R.gapFactor) : R.recurrentBase;
  const days = m.daysSinceLast;
  if (occasions >= R.frequentOccasions && days <= R.frequentRecency) return { key: 'frecuente', label: 'Cliente frecuente', tone: 'success', text: `${occasions} compras en días distintos; la última ${agoText(days)}.` };
  if (occasions >= 2 && days <= window) return { key: 'recurrente', label: 'Recurrente', tone: 'success', text: `Repitió compra (${occasions} ocasiones) y sigue activo.` };
  if (occasions === 1 && days <= R.newDays) return { key: 'nuevo', label: 'Nuevo comprador', tone: 'info', text: `Primera compra ${agoText(days)}.` };
  if (days <= R.dormantDays) return { key: 'por_reactivar', label: 'Por reactivar', tone: 'warning', text: `Lleva ${days} días sin comprar${m.cadence.medianGap ? ` (su intervalo habitual es de ${Math.round(m.cadence.medianGap)} días)` : ''}.` };
  return { key: 'inactivo', label: 'Inactivo', tone: 'danger', text: `No compra desde hace ${days} días.` };
}

// Interés actual: etiqueta con motivos fechados (señales del comprador, nunca borradores).
export function currentIntent(m, signals = [], asOf) {
  const R = SEGMENT_RULES; const reasons = [];
  m.journeys.filter(journey => !journey.purchase && journey.weight > 0).forEach(journey => {
    const age = daysBetween(journey.date, asOf);
    reasons.push({ weight: journey.weight, age, text: journey.label, date: journey.date, kind: journey.by === 'cliente' ? 'observado' : 'declarado por el vendedor' });
  });
  signals.forEach(signal => {
    if (!signal.last_seen) return;
    const age = daysBetween(signal.last_seen.slice(0, 10), asOf);
    const strong = Number(signal.cart_qty) > 0 || signal.favorite || Number(signal.sessions) >= 2;
    if (strong) reasons.push({ weight: Number(signal.cart_qty) > 0 ? 0.8 : 0.5, age, text: `Navegación autorizada: ${signal.product_name || 'producto'}${Number(signal.cart_qty) > 0 ? ' en el carrito' : signal.favorite ? ' en favoritos' : ` visto en ${signal.sessions} sesiones`}`, date: signal.last_seen.slice(0, 10), kind: 'observado' });
  });
  reasons.sort((a, b) => b.weight - a.weight || a.age - b.age);
  const high = reasons.find(reason => reason.weight >= 1 && reason.age <= R.intentHighDays);
  const medium = reasons.find(reason => reason.weight >= 0.5 && reason.age <= R.intentMediumDays);
  const low = reasons.find(reason => reason.age <= R.intentLowDays);
  const level = high ? 'alta' : medium ? 'media' : low ? 'baja' : 'sin_senales';
  return { level, label: { alta: 'Interés alto', media: 'Interés medio', baja: 'Interés bajo', sin_senales: 'Sin señales recientes' }[level], tone: { alta: 'success', media: 'warning', baja: 'muted', sin_senales: 'muted' }[level], reasons: reasons.slice(0, 3), version: R.version };
}

// Etapa: lo que está pendiente hoy en el recorrido.
export function journeyStage(m, asOf) {
  const open = m.journeys.filter(journey => !journey.purchase);
  const find = stage => open.find(journey => journey.stage === stage);
  const returnRecent = m.purchases.flatMap(entry => entry.eco.returnEvents).filter(event => daysBetween(event.date, asOf) <= 30).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (returnRecent) return { key: 'devolucion', label: 'Devolución reciente por revisar', date: returnRecent.date, tone: 'danger' };
  const map = [['pedido_pendiente', 'Pedido pendiente de atención', 'warning'], ['venta_solicitud', 'Venta en solicitud sin confirmar', 'warning'], ['cotizacion_aceptada', 'Cotización aceptada por convertir', 'success'], ['pedido_contactado', 'Pedido en conversación', 'info'], ['cotizacion_enviada', 'Cotización enviada sin respuesta', 'info'], ['cotizacion_borrador', 'Borrador interno por completar', 'muted']];
  for (const [stage, label, tone] of map) { const journey = find(stage); if (journey) return { key: stage, label, journey, date: journey.date, tone }; }
  return { key: 'ninguna', label: 'Nada pendiente', tone: 'muted' };
}

function headlineFor(segment, stage, intent, a) {
  const m = a.metrics;
  if (stage.key === 'devolucion') return `Registró una devolución el ${shortDate(stage.date)}. Conviene resolverla antes de ofrecer algo nuevo.`;
  if (stage.journey) {
    const doc = stage.journey.origin || stage.journey.sale;
    const number = doc?.order_number || doc?.quote_number || doc?.sale_number || '';
    const opportunity = a.opportunities.find(item => item.journey.key === stage.journey.key);
    const stock = opportunity ? (opportunity.allAvailable ? 'Todo lo solicitado está disponible.' : 'Hay productos sin stock suficiente o sin la variante pedida.') : '';
    if (stage.key === 'cotizacion_borrador') return `Hay un borrador interno (${number}) que nunca se envió. No indica interés del cliente: complétalo o descártalo.`;
    return `${stage.label}: ${number} por ${formatMoney(doc?.total)} (${shortDate(stage.date)}). ${stock}`.trim();
  }
  if (segment.key === 'sin_historial') return 'Todavía no hay compras ni solicitudes. Es una oportunidad para presentarle la tienda.';
  if (segment.key === 'devoluciones') return 'Sus compras se devolvieron por completo. Revisa qué ocurrió antes de ofrecer más productos.';
  if (!m.purchases.length) return `${segment.text} ${intent.level === 'sin_senales' ? 'Sin señales recientes.' : ''}`.trim();
  return `${segment.text} Ha conservado ${money(m.productsKeptCents)} en ${m.positiveOperations} compra${m.positiveOperations === 1 ? '' : 's'} del periodo.`;
}

// Evidencias fechadas, cada una con su naturaleza (observado, declarado, calculado).
function evidenceFor(a, intent, stage) {
  const m = a.metrics; const list = [];
  if (stage.journey) list.push({ label: stage.label, date: stage.date, kind: 'observado' });
  intent.reasons.filter(reason => !stage.journey || reason.text !== stage.journey.label).slice(0, 2).forEach(reason => list.push({ label: reason.text, date: reason.date, kind: reason.kind }));
  if (m.lastPurchase) list.push({ label: `Última compra conservada`, date: m.lastPurchase, kind: 'observado' });
  if (m.cohortReturnedCents) list.push({ label: `Devoluciones por ${money(m.cohortReturnedCents)}`, date: m.periodReturnEvents.at(-1)?.date || '', kind: 'observado' });
  return list.slice(0, 3);
}

// Acciones sugeridas: cada una con motivo explícito y una acción ejecutable en el panel.
function actionsFor(a, { allowed, birthday, tasks, stage, segment, intent }) {
  const m = a.metrics; const actions = [];
  const push = (priority, key, title, reason, action) => actions.push({ priority, key, title, reason, action });
  const pendingTask = key => (tasks || []).some(task => task.kind === key && ['pendiente', 'pospuesta'].includes(task.status));
  if (stage.key === 'devolucion') push(95, 'devolucion', 'Resolver la devolución', 'Hay una devolución en los últimos 30 días; no insistas con ofertas hasta revisarla.', { type: 'open_doc', kind: 'sale', id: m.purchases.find(entry => entry.eco.returnEvents.some(event => event.date === stage.date))?.sale.id });
  a.opportunities.slice(0, 2).forEach(opportunity => {
    const doc = opportunity.doc; const kind = opportunity.journey.originKind === 'order' ? 'order' : opportunity.journey.originKind === 'quote' ? 'quote' : 'sale';
    const missing = opportunity.lines.filter(line => !line.ok);
    const base = opportunity.journey.stage === 'pedido_pendiente' ? 92 : opportunity.journey.stage === 'cotizacion_aceptada' ? 90 : opportunity.journey.stage === 'venta_solicitud' ? 88 : 72;
    push(base, `abrir_${kind}`, kind === 'order' ? `Atender el pedido ${doc.order_number}` : kind === 'quote' ? `Dar seguimiento a ${doc.quote_number}` : `Confirmar la venta ${doc.sale_number}`,
      `${opportunity.label} (${shortDate(opportunity.date)}).${missing.length ? ` ${missing.length} línea(s) sin stock suficiente o con variante inactiva: ten una alternativa.` : ' Todas las líneas están disponibles hoy.'}`, { type: 'open_doc', kind, id: doc.id });
  });
  const draft = a.metrics.journeys.find(journey => journey.stage === 'cotizacion_borrador');
  if (draft) push(55, 'borrador', `Completar o enviar ${draft.origin.quote_number}`, 'Es un documento interno: no refleja interés del cliente hasta que se envíe.', { type: 'open_doc', kind: 'quote', id: draft.origin.id });
  const top = a.recommendations.filter(item => item.affinity != null && item.affinity >= 40).slice(0, 2);
  if (top.length && stage.key !== 'devolucion') push(allowed ? 70 : 40, 'oferta', `Preparar oferta: ${top.map(item => item.product.name).join(' y ')}`, `${top[0].reasons[0]?.text || ''}. ${allowed ? 'Autorizó contacto promocional.' : 'Sin autorización promocional: úsalo solo si el cliente te contacta.'}`, { type: 'create_offer', products: top.map(item => item.product.id) });
  if (segment.key === 'nuevo' && m.daysSinceLast <= 15) push(74, 'postventa', 'Seguimiento postventa', 'Primera compra reciente: pregunta cómo le fue. No es una oferta.', { type: 'message', template: 'postventa' });
  if (segment.key === 'por_reactivar' && m.cadence.occasions >= 3 && a.metrics.evidence.level !== 'limitada') push(allowed ? 66 : 30, 'reactivar', 'Reactivar con una propuesta puntual', `${segment.text} Evidencia ${a.metrics.evidence.label.toLowerCase()}.`, { type: 'create_offer', products: top.map(item => item.product.id) });
  if (birthday && birthday.days <= 7 && allowed) push(birthday.days <= 2 ? 80 : 60, 'cumpleanos', birthday.days === 0 ? 'Hoy es su cumpleaños' : `Cumple en ${birthday.days} días`, 'Autorizó contacto promocional. Revisa que no se haya saludado este año.', { type: 'birthday' });
  if (intent.level === 'sin_senales' && !actions.length && segment.key === 'sin_historial') push(30, 'presentar', 'Presentarle la tienda', 'Sin historial ni señales: comparte categorías y novedades si te contacta.', { type: 'message', template: 'presentacion' });
  return actions.filter(action => !pendingTask(action.key)).sort((x, y) => y.priority - x.priority).slice(0, 3);
}

// a: analyzeCustomer() del historial; signals: señales autorizadas; tasks: tareas abiertas.
export function diagnoseCustomer(a, { allowed = false, digits = '', birthday = null, signals = [], tasks = [] } = {}) {
  const asOf = a.asOf;
  const segment = relationshipSegment(a.metrics);
  const intent = currentIntent(a.metrics, signals, asOf);
  const stage = journeyStage(a.metrics, asOf);
  const channel = !digits ? 'Sin WhatsApp válido: contáctalo por llamada.'
    : allowed ? 'Puedes usar WhatsApp para ofertas: autorizó contacto promocional.'
      : 'Escríbele por WhatsApp solo sobre sus pedidos y cotizaciones: no autorizó promociones.';
  return {
    segment, intent, stage, version: SEGMENT_RULES.version,
    headline: headlineFor(segment, stage, intent, a),
    evidence: evidenceFor(a, intent, stage),
    actions: actionsFor(a, { allowed, birthday, tasks, stage, segment, intent }),
    channel
  };
}

export { quoteExpired };
