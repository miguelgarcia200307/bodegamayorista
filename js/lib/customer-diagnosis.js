// Diagnóstico comercial del cliente: segmento RFM afinado, índice de intención de compra,
// evidencia concreta y un plan de acción priorizado construido con SUS datos (cotizaciones,
// vencimientos, cambios de precio, stock, recomendaciones, cumpleaños y autorizaciones).
// Solo lee el resultado de analyzeCustomer: no modifica datos.
import { formatMoney } from './helpers.js';
import { daysBetween } from './customer-insights.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = value => 1 / (1 + Math.exp(-value));
const shortDate = iso => iso ? iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '';
const daysText = days => days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
const agoText = days => days === 0 ? 'hoy' : days === 1 ? 'ayer' : `hace ${days} días`;
const compactMoney = value => value >= 1e6 ? `$ ${(value / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M` : formatMoney(value);
const isoOf = value => value ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }) : '';
const listNames = (names, max = 3) => {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= max) return unique.length > 1 ? `${unique.slice(0, -1).join(', ')} y ${unique.at(-1)}` : unique[0] || '';
  return `${unique.slice(0, max).join(', ')} y ${unique.length - max} más`;
};
const shortName = name => String(name || '').split(/\s\d+(?:[.,]\d+)?\s?(?:GB|TB|L|kg|cm|mm|pies|")/i)[0].trim() || name;

// Puntajes RFM de 1 a 5 (0 = sin compras).
function rfmScores(data, rank) {
  const recency = data.daysSinceLast == null ? 0 : data.daysSinceLast <= 30 ? 5 : data.daysSinceLast <= 60 ? 4 : data.daysSinceLast <= 120 ? 3 : data.daysSinceLast <= 240 ? 2 : 1;
  const frequency = !data.count ? 0 : data.count >= 5 ? 5 : data.count >= 3 ? 4 : data.count === 2 ? 3 : 2;
  let monetary = 0;
  if (data.spent > 0) {
    if (rank && rank.total >= 5) monetary = rank.top <= 10 ? 5 : rank.top <= 25 ? 4 : rank.top <= 50 ? 3 : 2;
    else monetary = data.spent >= 10e6 ? 5 : data.spent >= 5e6 ? 4 : data.spent >= 2e6 ? 3 : 2;
  }
  return { recency, frequency, monetary };
}

// Índice de intención de compra (0‑100) a partir de señales de corto plazo.
function intentIndex(data, today) {
  const lastActivity = [...data.quotes.map(quote => isoOf(quote.created_at)), ...data.orders.map(order => isoOf(order.created_at)), data.last].filter(Boolean).sort().at(-1);
  const sinceActivity = lastActivity ? daysBetween(lastActivity, today) : null;
  let z = -1.6;
  data.openQuotes.forEach((quote, position) => {
    if (position > 1) return;
    const age = daysBetween(isoOf(quote.created_at), today);
    z += 1.5 * Math.exp(-age / 12) + (quote.status === 'aceptada' ? 1.1 : quote.status === 'enviada' ? 0.35 : 0);
  });
  if (data.pendingOrders) z += 1.4;
  if (sinceActivity != null) z += 1.1 * Math.exp(-sinceActivity / 30);
  if (data.conversion != null) z += 1.4 * (data.conversion - 0.4);
  if (data.nextExpected) {
    const offset = daysBetween(today, data.nextExpected);
    if (Math.abs(offset) <= 20) z += 0.8; else if (offset < -60) z -= 0.6;
  }
  z += 0.25 * Math.min(data.count, 4);
  z -= 0.45 * Math.min(data.lostOrders, 2);
  if (sinceActivity == null || sinceActivity > 180) z -= 1.2;
  const value = Math.round(clamp(sigmoid(z), 0.02, 0.98) * 100);
  return { value, label: value >= 65 ? 'Caliente' : value >= 35 ? 'Tibio' : 'Frío', tone: value >= 65 ? 'success' : value >= 35 ? 'warning' : 'muted', sinceActivity };
}

function segmentOf(data, scores, intent, today) {
  const { recency: R, frequency: F, monetary: M } = scores;
  const window = data.avgGap ? Math.max(45, data.avgGap * 1.5) : 90;
  if (!data.count) {
    if (!data.quotes.length && !data.orders.length) return { key: 'new', label: 'Sin historial', tone: 'muted' };
    const freshQuote = data.openQuotes.some(quote => daysBetween(isoOf(quote.created_at), today) <= 10 || quote.status === 'aceptada');
    if (freshQuote || data.pendingOrders) return { key: 'hot-prospect', label: 'Prospecto caliente', tone: 'info' };
    if (data.openQuotes.length) return { key: 'prospect', label: 'Prospecto en seguimiento', tone: 'info' };
    return { key: 'cold-prospect', label: 'Prospecto frío', tone: 'warning' };
  }
  if (F >= 4 && R >= 4 && M >= 4) return { key: 'champion', label: 'Cliente campeón', tone: 'success' };
  if (M >= 4 && data.daysSinceLast > Math.max(90, window)) return { key: 'value-risk', label: 'Alto valor en riesgo', tone: 'danger' };
  if (data.count >= 2 && data.daysSinceLast <= Math.max(90, window)) return { key: 'loyal', label: F >= 4 ? 'Cliente leal' : 'Recurrente', tone: 'success' };
  if (data.count === 1 && data.daysSinceLast <= 60) return intent.value >= 50 || M >= 3 ? { key: 'promising', label: 'Nuevo con potencial', tone: 'info' } : { key: 'first', label: 'Nuevo comprador', tone: 'info' };
  if (data.daysSinceLast <= 180) return { key: 'risk', label: data.count >= 2 ? 'En riesgo' : 'Por reactivar', tone: 'warning' };
  if (data.daysSinceLast <= 365) return { key: 'dormant', label: 'Hibernando', tone: 'danger' };
  return { key: 'lost', label: 'Perdido', tone: 'danger' };
}

// Estado de cada producto de una cotización hoy: stock y cambio de precio.
function quoteLinesStatus(quote, data) {
  return data.opportunities.filter(line => line.doc.id === quote.id).map(line => ({
    name: shortName(line.name), inStock: line.inStock, quoted: line.unitPrice, current: line.currentPrice, inCatalog: Boolean(line.product)
  }));
}

function headlineFor(segment, data, intent, today) {
  const quote = data.openQuotes[0];
  const quoteNames = quote ? listNames((quote.quote_items || []).map(item => shortName(item.product_name))) : '';
  const favorite = data.categories[0]?.name;
  switch (segment.key) {
    case 'new': return 'Aún no tiene cotizaciones, pedidos ni compras. Es una oportunidad para presentarle la tienda.';
    case 'hot-prospect':
      if (quote) return `Cotizó ${quoteNames} por ${formatMoney(quote.total)} ${agoText(daysBetween(isoOf(quote.created_at), today))} y todavía no compra. Su interés está fresco: es el momento de cerrar.`;
      return `Tiene ${data.pendingOrders === 1 ? 'un pedido pendiente' : `${data.pendingOrders} pedidos pendientes`} sin confirmar. Contactarlo pronto evita que se enfríe.`;
    case 'prospect': return `Mantiene ${data.openQuotes.length === 1 ? 'una cotización abierta' : `${data.openQuotes.length} cotizaciones abiertas`} por ${formatMoney(data.openQuotesValue)}${quoteNames ? ` (${quoteNames})` : ''}, pero no ha avanzado ${intent.sinceActivity != null ? `desde ${agoText(intent.sinceActivity)}` : ''}.`;
    case 'cold-prospect': return `Mostró interés${data.quotes.length ? ` en ${data.quotes.length === 1 ? 'una cotización' : `${data.quotes.length} cotizaciones`}` : ''}${data.lostOrders ? ` y tiene ${data.lostOrders} pedido${data.lostOrders === 1 ? '' : 's'} sin concretar` : ''}, pero nunca compró y lleva ${intent.sinceActivity ?? 'muchos'} días sin actividad.`;
    case 'champion': return `De sus mejores clientes: ${data.count} compras por ${formatMoney(data.spent)}, la última ${agoText(data.daysSinceLast)}${favorite ? `. Compra sobre todo ${favorite.toLowerCase()}` : ''}.`;
    case 'value-risk': return `Ha comprado ${formatMoney(data.spent)}, pero lleva ${data.daysSinceLast} días sin volver${data.avgGap ? `, cuando suele comprar cada ${Math.round(data.avgGap)} días` : ''}. Perderlo tendría impacto.`;
    case 'loyal': return `Ya repitió ${data.count} veces (ticket promedio ${formatMoney(data.avgTicket)}) y sigue activo${data.nextExpected ? `; su próxima compra se estima para el ${shortDate(data.nextExpected)}` : ''}.`;
    case 'promising':
    case 'first': return `Hizo su primera compra ${agoText(data.daysSinceLast)} por ${formatMoney(data.spent)}${data.topProducts[0] ? ` (${listNames(data.topProducts.map(item => shortName(item.name)), 2)})` : ''}. La segunda compra es la que lo convierte en cliente recurrente.`;
    case 'risk': return `Lleva ${data.daysSinceLast} días sin comprar${data.avgGap ? `, más de lo habitual (cada ${Math.round(data.avgGap)} días)` : ''}. Aún está a tiempo de recuperarlo.`;
    case 'dormant': return `No compra desde hace ${data.daysSinceLast} días. Necesita un motivo concreto para volver.`;
    default: return `Su última compra fue hace ${data.daysSinceLast} días. Trátalo como un cliente nuevo con una oferta de reactivación.`;
  }
}

function evidenceFor(data, intent, today) {
  const chips = [];
  data.openQuotes.slice(0, 2).forEach(quote => {
    const left = quote.valid_until ? daysBetween(today, quote.valid_until) : null;
    chips.push({ label: `${quote.quote_number} · ${compactMoney(Number(quote.total))}`, tone: 'info' });
    if (left != null) chips.push({ label: left < 0 ? `Venció hace ${-left} días` : `Vence ${daysText(left)}`, tone: left <= 3 ? 'danger' : left <= 7 ? 'warning' : 'muted' });
  });
  if (data.count) chips.push({ label: `${data.count} compra${data.count === 1 ? '' : 's'} · ${compactMoney(data.spent)}`, tone: 'success' });
  if (data.conversion != null) chips.push({ label: `Convierte ${Math.round(data.conversion * 100)} % de lo que cotiza`, tone: data.conversion >= 0.5 ? 'success' : 'warning' });
  if (data.pendingOrders) chips.push({ label: `${data.pendingOrders} pedido${data.pendingOrders === 1 ? '' : 's'} pendiente${data.pendingOrders === 1 ? '' : 's'}`, tone: 'warning' });
  if (data.nextExpected && data.count >= 2) chips.push(data.nextExpected < today
    ? { label: `Debió volver el ${shortDate(data.nextExpected)}`, tone: 'warning' }
    : { label: `Próxima compra estimada ${shortDate(data.nextExpected)}`, tone: 'muted' });
  if (data.returnedValue) chips.push({ label: `Devoluciones ${compactMoney(data.returnedValue)}`, tone: 'danger' });
  if (!data.count && intent.sinceActivity != null) chips.push({ label: `Última actividad ${agoText(intent.sinceActivity)}`, tone: 'muted' });
  return chips.slice(0, 6);
}

function actionsFor(segment, data, { allowed, birthday, today }) {
  const actions = [];
  const push = (priority, icon, title, detail) => actions.push({ priority, icon, title, detail });

  // Cotizaciones abiertas: vencimiento, stock y cambios de precio, con argumentos concretos.
  data.openQuotes.slice(0, 2).forEach((quote, position) => {
    const left = quote.valid_until ? daysBetween(today, quote.valid_until) : null;
    const lines = quoteLinesStatus(quote, data);
    const notes = [];
    const cheaper = lines.filter(line => line.current && line.quoted && line.current < line.quoted * 0.99);
    const pricier = lines.filter(line => line.current && line.quoted && line.current > line.quoted * 1.01);
    const noStock = lines.filter(line => line.inCatalog && !line.inStock);
    if (cheaper.length) notes.push(`Argumento a favor: ${listNames(cheaper.map(line => line.name), 2)} hoy cuesta${cheaper.length === 1 ? '' : 'n'} menos que cuando cotizó`);
    if (pricier.length) notes.push(`${listNames(pricier.map(line => line.name), 2)} subió de precio: respeta lo cotizado mientras esté vigente`);
    if (noStock.length) notes.push(`Sin stock: ${listNames(noStock.map(line => line.name), 2)}. Ten lista una alternativa`);
    if (!notes.length && lines.length) notes.push('Todo lo cotizado sigue disponible al mismo precio');
    const urgency = left == null ? 70 : left <= 2 ? 98 : left <= 7 ? 90 : 78;
    push(urgency - position * 5, 'clock', `Cierra la ${quote.quote_number} (${formatMoney(quote.total)})${left != null ? ` antes de que venza ${daysText(left)}` : ''}`,
      `${quote.status === 'aceptada' ? 'Ya la aceptó: conviértela en venta y coordina entrega y pago. ' : quote.status === 'borrador' ? 'Aún está en borrador: envíasela hoy. ' : 'Pregunta si tiene dudas y propone una forma de pago o entrega para decidir. '}${notes.join('. ')}.`);
  });

  // Cierre conjunto: varias referencias en la misma cotización.
  const bundle = data.openQuotes.find(quote => (quote.quote_items || []).length >= 2);
  if (bundle) push(68, 'package', `Propón cerrar los ${(bundle.quote_items || []).length} productos juntos`, `Un beneficio por llevar todo (envío sin costo, instalación o un descuento por volumen) evita que compre solo una parte o que compare precio por precio.`);

  if (data.pendingOrders) push(92, 'package', `Confirma ${data.pendingOrders === 1 ? 'su pedido pendiente' : `sus ${data.pendingOrders} pedidos pendientes`}`, 'Valida datos de entrega y forma de pago, y conviértelo en venta para reservar el inventario.');

  // Cotizaciones vencidas con productos aún disponibles.
  const expired = data.quotes.filter(quote => !data.openQuotes.includes(quote) && ['borrador', 'enviada', 'aceptada', 'vencida'].includes(quote.status));
  if (expired.length && !data.openQuotes.length) {
    const available = data.opportunities.filter(line => line.inStock);
    if (available.length) push(72, 'undo', `Reactiva lo que cotizó: ${listNames(available.map(line => shortName(line.name)), 2)}`, 'Su cotización ya venció. Envíale una nueva con precios de hoy y una vigencia corta para incentivar la decisión.');
  }

  // Venta cruzada con el motor de recomendaciones.
  const top = data.recommendations.filter(item => item.probability >= 0.45).slice(0, 2);
  if (top.length) {
    const reason = top[0].reasons[0]?.text;
    const names = listNames(top.map(item => shortName(item.product.name)), 2);
    if (data.count) push(segment.key === 'champion' || segment.key === 'loyal' || segment.key === 'promising' ? 80 : 62, 'sparkles', `Ofrécele ${names}`,
      `${Math.round(top[0].probability * 100)} % de probabilidad estimada${reason ? ` · ${reason}` : ''}. Revisa el detalle en "Recomendados para ofrecerle".`);
  }
  // Prospecto: complementos de lo que cotizó (nunca otra opción de la misma categoría).
  if (!data.count && data.openQuotes.length) {
    const quotedLeaves = new Set(data.quoteLines.map(line => line.categoryId));
    const extras = data.recommendations.filter(item => item.probability >= 0.4 && item.complement && !quotedLeaves.has(item.leaf?.id)).slice(0, 2);
    if (extras.length) push(60, 'sparkles', `Al cerrar, sugiere sumar ${listNames(extras.map(item => shortName(item.product.name)), 2)}`,
      `${Math.round(extras[0].probability * 100)} % de probabilidad estimada · ${extras[0].reasons[0]?.detail || 'complementa lo que cotizó'}. Súmalo como complemento, no como reemplazo.`);
  }

  // Ciclo de recompra.
  if (data.nextExpected && data.count >= 2) {
    const offset = daysBetween(today, data.nextExpected);
    if (offset >= -30 && offset <= 15) push(76, 'history', offset < 0 ? `Su recompra está atrasada ${-offset} días` : `Se acerca su recompra (${shortDate(data.nextExpected)})`, `Suele comprar cada ${Math.round(data.avgGap)} días. Contáctalo con novedades de ${data.categories[0]?.name.toLowerCase() || 'lo que compra'}.`);
  }

  // Recuperación según segmento.
  if (['risk', 'value-risk', 'dormant', 'lost'].includes(segment.key)) {
    const favorite = data.categories[0]?.name;
    push(segment.key === 'value-risk' ? 88 : 70, 'returns', segment.key === 'value-risk' ? 'Llamada personal de recuperación' : 'Campaña de reactivación',
      `${segment.key === 'value-risk' ? 'Por su historial merece contacto directo, no un mensaje masivo. ' : ''}Ofrece una promoción con fecha límite${favorite ? ` en ${favorite.toLowerCase()}` : ''}${data.returnedValue ? ' y pregunta cómo le fue con su devolución' : ''}.`);
  }
  if (segment.key === 'champion') push(66, 'star', 'Trato preferente', 'Ofrécele precio por volumen, acceso anticipado a novedades y atención directa. Es el cliente que más conviene cuidar.');
  if ((segment.key === 'first' || segment.key === 'promising') && data.daysSinceLast <= 15) push(74, 'check', 'Seguimiento postventa', 'Pregunta cómo le fue con su compra. Un cliente satisfecho compra de nuevo y recomienda.');
  if (segment.key === 'cold-prospect') push(60, 'chat', 'Descubre qué lo frenó', 'Pregunta si fue el precio, la entrega o la forma de pago. Esa respuesta define la oferta correcta.');
  if (segment.key === 'new') push(50, 'store', 'Preséntale la tienda', 'Comparte las categorías más vendidas y las promociones vigentes para generar su primera cotización.');

  // Cumpleaños (solo con autorización).
  if (birthday && birthday.days <= 15 && allowed) push(birthday.days <= 3 ? 85 : 64, 'star', birthday.days === 0 ? 'Hoy es su cumpleaños' : `Cumple ${daysText(birthday.days)}`, 'Envíale un saludo con un beneficio especial: es el mensaje con más respuesta del año.');
  if (data.returnedValue && !['risk', 'value-risk', 'dormant', 'lost'].includes(segment.key)) push(58, 'alert', 'Revisa su devolución antes de ofrecer', `Devolvió ${formatMoney(data.returnedValue)}. Confirma que el problema quedó resuelto.`);

  return actions.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

// customer: ficha; allowed: autorización promocional; digits: WhatsApp válido; rank: posición en ventas; birthday: birthdayInfo().
export function diagnoseCustomer(data, { allowed = false, digits = '', rank = null, birthday = null } = {}) {
  const today = data.today;
  const scores = rfmScores(data, rank);
  const intent = intentIndex(data, today);
  const segment = segmentOf(data, scores, intent, today);
  const channel = !digits ? 'Sin WhatsApp válido: contáctalo por llamada.'
    : allowed ? 'Canal sugerido: WhatsApp (autorizó mensajes promocionales).'
    : 'Puedes escribirle por WhatsApp sobre sus cotizaciones y pedidos, pero no le envíes promociones: no las ha autorizado.';
  return {
    segment, scores, intent,
    headline: headlineFor(segment, data, intent, today),
    evidence: evidenceFor(data, intent, today),
    actions: actionsFor(segment, data, { allowed, birthday, today }),
    channel
  };
}
