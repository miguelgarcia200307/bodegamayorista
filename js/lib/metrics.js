// Contrato comercial de métricas (versión METRICS_VERSION). Única fuente de reglas para
// ficha, análisis, resumen, exportación y pruebas. Reglas:
//   · Dinero en centavos enteros (COP); nunca se suman importes en coma flotante.
//   · Fechas en America/Bogota. La fecha de evaluación (asOf) se inyecta: nada usa Date.now().
//   · Compra = venta que alguna vez se confirmó (descontó inventario) y no se canceló.
//     Una devolución total NO borra la compra: queda como operación histórica con neto 0.
//   · Cohorte de compra (fecha de confirmación) ≠ movimientos de devolución del periodo.
//   · Un recorrido pedido/cotización → venta cuenta una sola vez.
//   · null/desconocido/error es distinto de cero.
// Solo lee datos; no modifica nada.
import { normalizeText } from './helpers.js';

export const METRICS_VERSION = 'metricas-2026.10-v1';
export const TIME_ZONE = 'America/Bogota';
export const CURRENCY = 'COP';
export const MIN_SAMPLE = 3; // por debajo se muestra "n de m", nunca un porcentaje
export const CONFIRMED_STATUS = ['confirmada', 'pagada', 'entregada'];
const DAY = 86400000;

// --- Dinero ------------------------------------------------------------------------
export const toCents = value => Math.round((Number(value) || 0) * 100);
export const fromCents = cents => Math.round(cents) / 100;
export const sumCents = list => list.reduce((total, value) => total + value, 0);
// Reparto proporcional exacto (resto mayor): la suma de las partes es igual al total.
export function allocateCents(totalCents, weights) {
  const base = sumCents(weights);
  if (!base || !totalCents) return weights.map(() => 0);
  const raw = weights.map(weight => (totalCents * weight) / base);
  const floors = raw.map(Math.floor);
  let remainder = totalCents - sumCents(floors);
  raw.map((value, index) => [value - floors[index], index]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, index]) => { if (remainder > 0) { floors[index] += 1; remainder -= 1; } });
  return floors;
}

// --- Fechas ------------------------------------------------------------------------
export function bogotaDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / DAY);
export function addDays(iso, days) { const date = new Date(`${iso}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + Math.round(days)); return date.toISOString().slice(0, 10); }
export function periodStart(period, asOf) { return !period || period === 'all' ? null : addDays(asOf, -Number(period)); }
const inPeriod = (iso, since, until) => Boolean(iso) && (!since || iso >= since) && (!until || iso <= until);
export const median = values => { const list = values.filter(Number.isFinite).slice().sort((a, b) => a - b); if (!list.length) return null; const mid = Math.floor(list.length / 2); return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2; };
export function quantile(values, q) { const list = values.filter(Number.isFinite).slice().sort((a, b) => a - b); if (!list.length) return null; const pos = (list.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos); return list[lo] + (list[hi] - list[lo]) * (pos - lo); }

// --- Ventas --------------------------------------------------------------------------
// Confirmación histórica: el servidor marca stock_applied_at/confirmed_at al confirmar y
// los conserva aunque la venta luego se devuelva o se cancele.
export const wasConfirmed = sale => Boolean(sale?.stock_applied_at || sale?.confirmed_at) || [...CONFIRMED_STATUS, 'devuelta'].includes(sale?.status);
export const isPurchase = sale => wasConfirmed(sale) && sale.status !== 'cancelada';
export const isCurrentSale = sale => CONFIRMED_STATUS.includes(sale?.status);
export const purchaseDate = sale => bogotaDate(sale?.confirmed_at || sale?.created_at);
const byLine = (a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0) || String(a.id).localeCompare(String(b.id));

// Desglose económico de una venta en centavos, con la devolución valorada al neto pactado
// de cada línea (incluye descuentos de línea y de cupón ya asignados a esa línea).
export function saleEconomics(sale) {
  const items = (sale.sale_items || []).slice().sort(byLine);
  const returnsByItem = new Map();
  (sale.sale_returns || []).slice().sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)))
    .forEach(ret => returnsByItem.set(ret.sale_item_id, [...(returnsByItem.get(ret.sale_item_id) || []), ret]));
  const returnEvents = [];
  const lines = items.map(item => {
    const quantity = Math.max(0, Math.round(Number(item.quantity) || 0));
    const netCents = toCents(item.line_total);
    let cumulative = 0; let previousValue = 0;
    (returnsByItem.get(item.id) || []).forEach(ret => {
      const qty = Math.max(0, Math.round(Number(ret.quantity) || 0));
      cumulative = Math.min(quantity, cumulative + qty);
      const value = quantity ? Math.round((netCents * cumulative) / quantity) : 0;
      returnEvents.push({ saleId: sale.id, itemId: item.id, quantity: qty, cents: value - previousValue, date: bogotaDate(ret.created_at) || purchaseDate(sale), restocked: ret.restocked ?? null });
      previousValue = value;
    });
    const returnedQuantity = cumulative;
    const returnedCents = previousValue;
    return {
      item, quantity, returnedQuantity, keptQuantity: quantity - returnedQuantity,
      grossCents: toCents(item.unit_price) * quantity, discountCents: toCents(item.discount), netCents, returnedCents, keptCents: netCents - returnedCents
    };
  });
  const productsNetCents = sumCents(lines.map(line => line.netCents));
  const returnedCents = sumCents(lines.map(line => line.returnedCents));
  return {
    sale, lines, returnEvents,
    productsGrossCents: sumCents(lines.map(line => line.grossCents)),
    discountCents: sumCents(lines.map(line => line.discountCents)),
    productsNetCents, returnedCents, productsKeptCents: productsNetCents - returnedCents,
    deliveryCents: toCents(sale.delivery_cost), totalCents: toCents(sale.total),
    units: sumCents(lines.map(line => line.quantity)), keptUnits: sumCents(lines.map(line => line.keptQuantity)),
    fullyReturned: lines.length > 0 && lines.every(line => line.keptQuantity === 0)
  };
}

// Compras netas por cliente con el MISMO contrato que la ficha (para el ranking local de
// pruebas y la equivalencia con la función SQL crm_customer_ranking).
export function netPurchasesByCustomer(sales, { since = null, until = null } = {}) {
  const totals = new Map();
  sales.filter(isPurchase).filter(sale => sale.customer_id && inPeriod(purchaseDate(sale), since, until)).forEach(sale => {
    totals.set(sale.customer_id, (totals.get(sale.customer_id) || 0) + saleEconomics(sale).productsKeptCents);
  });
  return totals;
}

export function rankFromTotals(totals, customerId) {
  const ordered = [...totals.entries()].filter(([, cents]) => cents > 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const index = ordered.findIndex(([id]) => id === customerId);
  if (index < 0) return null;
  const all = sumCents(ordered.map(([, cents]) => cents));
  return { position: index + 1, total: ordered.length, shareBp: all ? Math.round((ordered[index][1] * 10000) / all) : 0, cents: ordered[index][1] };
}

// --- Recorridos (pedido/cotización → venta) ---------------------------------------
// Cada recorrido aporta UNA contribución. La señal del comprador depende del estado y no
// se inventa un motivo cuando se desconoce.
export const INTENT_RULES = {
  version: 'intencion-v1',
  // [peso 0‑1, etiqueta, quién originó la señal]
  order: { pendiente: [1, 'Pedido pendiente de atención', 'cliente'], contactado: [1, 'Pedido en conversación', 'cliente'], confirmado: [1, 'Pedido confirmado sin venta registrada', 'cliente'], cancelado: [0, 'Pedido cancelado (motivo no registrado)', 'cliente'], abandonado: [0, 'Pedido abandonado (motivo no registrado)', 'cliente'] },
  quote: { borrador: [0, 'Borrador interno nunca enviado', 'vendedor'], enviada: [0.5, 'Cotización enviada, sin respuesta registrada', 'vendedor'], aceptada: [1, 'Cotización aceptada por el cliente', 'cliente'], rechazada: [0, 'Cotización rechazada (motivo no registrado)', 'cliente'], vencida: [0.2, 'Cotización vencida sin respuesta', 'vendedor'] },
  saleRequest: [1, 'Venta en solicitud, aún sin confirmar', 'cliente'],
  saleCancelled: [0, 'Venta cancelada antes de entregarse', 'cliente']
};

export function quoteWasSent(quote) {
  return Boolean(quote.sent_at) || ['enviada', 'aceptada', 'rechazada', 'convertida'].includes(quote.status);
}
export const quoteExpired = (quote, asOf) => quote.status === 'vencida' || (['borrador', 'enviada', 'aceptada'].includes(quote.status) && Boolean(quote.valid_until) && quote.valid_until < asOf);
export const quoteOpen = (quote, asOf) => ['borrador', 'enviada', 'aceptada'].includes(quote.status) && !quoteExpired(quote, asOf);

export function buildJourneys(history, asOf) {
  const salesByOrder = new Map(); const salesByQuote = new Map();
  history.sales.forEach(sale => { if (sale.source_order_id) salesByOrder.set(sale.source_order_id, sale); if (sale.source_quote_id) salesByQuote.set(sale.source_quote_id, sale); });
  const journeys = [];
  const docLines = (kind, doc) => (doc[`${kind}_items`] || []).slice().sort(byLine);
  history.sales.forEach(sale => {
    const origin = sale.source_order_id ? history.orders.find(order => order.id === sale.source_order_id) || null : sale.source_quote_id ? history.quotes.find(quote => quote.id === sale.source_quote_id) || null : null;
    const startDate = bogotaDate(origin?.created_at || sale.created_at);
    const base = { key: sale.source_order_id ? `order:${sale.source_order_id}` : sale.source_quote_id ? `quote:${sale.source_quote_id}` : `sale:${sale.id}`, sale, origin, originKind: sale.source_order_id ? 'order' : sale.source_quote_id ? 'quote' : 'sale', startDate, lines: docLines('sale', sale) };
    if (isPurchase(sale)) journeys.push({ ...base, stage: 'compra', date: purchaseDate(sale), weight: 0, label: sale.status === 'devuelta' ? 'Compra devuelta en su totalidad' : 'Compra confirmada', by: 'cliente', purchase: true });
    else if (sale.status === 'solicitud') journeys.push({ ...base, stage: 'venta_solicitud', date: startDate, weight: INTENT_RULES.saleRequest[0], label: INTENT_RULES.saleRequest[1], by: INTENT_RULES.saleRequest[2] });
    else journeys.push({ ...base, stage: 'venta_cancelada', date: bogotaDate(sale.cancelled_at || sale.created_at), weight: INTENT_RULES.saleCancelled[0], label: sale.cancel_reason ? `Venta cancelada: ${sale.cancel_reason}` : INTENT_RULES.saleCancelled[1], by: INTENT_RULES.saleCancelled[2] });
  });
  history.orders.filter(order => !salesByOrder.has(order.id) && !(order.sales || []).length).forEach(order => {
    const [weight, label, by] = INTENT_RULES.order[order.status] || [0, `Pedido ${order.status}`, 'cliente'];
    journeys.push({ key: `order:${order.id}`, origin: order, originKind: 'order', stage: `pedido_${order.status}`, date: bogotaDate(order.created_at), startDate: bogotaDate(order.created_at), weight, label, by, lines: docLines('order', order) });
  });
  history.quotes.filter(quote => !salesByQuote.has(quote.id) && !quote.converted_sale_id).forEach(quote => {
    const sent = quoteWasSent(quote);
    const status = quote.status === 'borrador' && !sent ? 'borrador' : quoteExpired(quote, asOf) ? 'vencida' : quote.status;
    const [weight, label, by] = INTENT_RULES.quote[status] || [0, `Cotización ${quote.status}`, 'vendedor'];
    journeys.push({ key: `quote:${quote.id}`, origin: quote, originKind: 'quote', stage: `cotizacion_${status}`, date: bogotaDate(quote.sent_at || quote.created_at), startDate: bogotaDate(quote.created_at), weight, label, by, internal: status === 'borrador', lines: docLines('quote', quote) });
  });
  return journeys.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key));
}

// --- Conversión de cotizaciones ---------------------------------------------------
// Tres indicadores con numerador y denominador. Los borradores nunca enviados no cuentan.
export function quoteFunnel(quotes, sales, asOf) {
  const saleById = new Map(sales.map(sale => [sale.id, sale]));
  const saleByQuote = new Map(sales.filter(sale => sale.source_quote_id).map(sale => [sale.source_quote_id, sale]));
  const sent = quotes.filter(quoteWasSent);
  const pending = sent.filter(quote => quote.status === 'enviada' && !quoteExpired(quote, asOf));
  const decided = sent.filter(quote => !pending.includes(quote));
  const linked = quote => saleByQuote.get(quote.id) || saleById.get(quote.converted_sale_id) || null;
  const accepted = decided.filter(quote => ['aceptada', 'convertida'].includes(quote.status));
  const toRequest = decided.filter(quote => linked(quote));
  const toConfirmed = decided.filter(quote => isCurrentSale(linked(quote)));
  const ratio = (num, den) => ({ num, den, rate: den >= MIN_SAMPLE ? num / den : null });
  return {
    sent: sent.length, pending: pending.length, drafts: quotes.filter(quote => !quoteWasSent(quote)).length,
    acceptance: ratio(accepted.length, decided.length),
    toSaleRequest: ratio(toRequest.length, decided.length),
    toConfirmedSale: ratio(toConfirmed.length, decided.length)
  };
}

// --- Evidencia (reglas explícitas y versionadas) ------------------------------------
export const EVIDENCE_RULES = { version: 'evidencia-v1', ampliaOps: 5, ampliaDays: 3, ampliaSpanDays: 60, ampliaRecency: 180, suficienteOps: 2, suficienteDays: 2 };
// ops: operaciones/recorridos independientes con señal; dates: fechas (ISO) de esas operaciones.
export function evidenceLevel({ ops, dates, asOf, complete = true }) {
  const days = [...new Set(dates.filter(Boolean))].sort();
  const span = days.length > 1 ? daysBetween(days[0], days.at(-1)) : 0;
  const recency = days.length ? daysBetween(days.at(-1), asOf) : null;
  const R = EVIDENCE_RULES;
  let level = 'sin_datos';
  if (ops > 0) level = 'limitada';
  if (ops >= R.suficienteOps && days.length >= R.suficienteDays) level = 'suficiente';
  if (ops >= R.ampliaOps && days.length >= R.ampliaDays && span >= R.ampliaSpanDays && recency != null && recency <= R.ampliaRecency) level = 'amplia';
  if (!complete && level !== 'sin_datos') level = level === 'amplia' ? 'suficiente' : 'limitada';
  const label = { sin_datos: 'Sin datos', limitada: 'Evidencia limitada', suficiente: 'Evidencia suficiente', amplia: 'Evidencia amplia' }[level];
  return { level, label, ops, distinctDays: days.length, spanDays: span, recencyDays: recency, complete, version: R.version };
}

// --- Métricas del cliente -----------------------------------------------------------
// history: { sales, quotes, orders } COMPLETO del cliente (la ficha lo pagina hasta el final).
// period: { since, until } aplicado a cohortes y movimientos; los 12 meses no dependen de él.
export function customerMetrics(history, { asOf, since = null, until = null, coverage = { complete: true } } = {}) {
  if (!asOf) throw new Error('customerMetrics necesita la fecha de evaluación (asOf)');
  const purchases = history.sales.filter(isPurchase).map(sale => ({ sale, date: purchaseDate(sale), eco: saleEconomics(sale) }));
  const cohort = purchases.filter(entry => inPeriod(entry.date, since, until));
  const positive = cohort.filter(entry => entry.eco.productsKeptCents > 0);
  const returnEventsInPeriod = purchases.flatMap(entry => entry.eco.returnEvents).filter(event => inPeriod(event.date, since, until));
  const occasions = [...new Set(purchases.filter(entry => entry.eco.productsKeptCents > 0).map(entry => entry.date))].sort();
  const cohortOccasions = [...new Set(positive.map(entry => entry.date))].sort();
  const gaps = occasions.slice(1).map((date, index) => daysBetween(occasions[index], date));
  const medianGap = median(gaps);
  const last = occasions.at(-1) || null;
  const cadence = gaps.length >= 2 ? {
    occasions: occasions.length, medianGap, minGap: Math.min(...gaps), maxGap: Math.max(...gaps),
    window: last ? [addDays(last, quantile(gaps, 0.25)), addDays(last, quantile(gaps, 0.75))] : null
  } : { occasions: occasions.length, medianGap: null, minGap: null, maxGap: null, window: null };
  const sum = key => sumCents(cohort.map(entry => entry.eco[key]));
  const journeys = buildJourneys(history, asOf);
  const signalJourneys = journeys.filter(journey => journey.purchase || journey.weight > 0);
  const funnel = quoteFunnel(history.quotes.filter(quote => inPeriod(bogotaDate(quote.created_at), since, until)), history.sales, asOf);
  return {
    version: METRICS_VERSION, asOf, since, until, timeZone: TIME_ZONE, currency: CURRENCY, coverage,
    purchases, cohort,
    operations: cohort.length, positiveOperations: positive.length, occasions: cohortOccasions.length,
    fullyReturnedOperations: cohort.filter(entry => entry.eco.fullyReturned).length,
    productsGrossCents: sum('productsGrossCents'), discountCents: sum('discountCents'), productsNetCents: sum('productsNetCents'),
    cohortReturnedCents: sum('returnedCents'), productsKeptCents: sum('productsKeptCents'), deliveryCents: sum('deliveryCents'),
    periodReturnedCents: sumCents(returnEventsInPeriod.map(event => event.cents)), periodReturnEvents: returnEventsInPeriod,
    units: sumCents(cohort.map(entry => entry.eco.keptUnits)),
    // Ticket: neto conservado / compras con neto positivo (denominador explícito).
    avgTicketCents: positive.length ? Math.round(sumCents(positive.map(entry => entry.eco.productsKeptCents)) / positive.length) : null,
    maxTicketCents: positive.length ? Math.max(...positive.map(entry => entry.eco.productsKeptCents)) : null,
    firstPurchase: occasions[0] || null, lastPurchase: last, daysSinceLast: last ? daysBetween(last, asOf) : null,
    cadence, journeys, funnel,
    evidence: evidenceLevel({ ops: signalJourneys.length, dates: signalJourneys.map(journey => journey.date), asOf, complete: coverage.complete !== false }),
    monthly: monthlySeries(purchases, asOf)
  };
}

// Contrato: "Compras por mes" son SIEMPRE los 12 meses anteriores a asOf, calculados con el
// historial completo (no dependen del periodo elegido). Neto conservado por mes de compra.
export function monthlySeries(purchases, asOf) {
  const [year, month] = asOf.split('-').map(Number);
  const buckets = Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1 - (11 - offset), 1));
    return { key: date.toISOString().slice(0, 7), month: date.getUTCMonth(), year: date.getUTCFullYear(), keptCents: 0, returnedCents: 0, operations: 0 };
  });
  const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
  purchases.forEach(entry => {
    const bucket = byKey.get(entry.date.slice(0, 7));
    if (bucket) { bucket.keptCents += entry.eco.productsKeptCents; bucket.operations += 1; }
    entry.eco.returnEvents.forEach(event => { const target = byKey.get(event.date.slice(0, 7)); if (target) target.returnedCents += event.cents; });
  });
  return { scope: 'ultimos-12-meses-historial-completo', buckets };
}

// --- Exportación segura -------------------------------------------------------------
// Neutraliza fórmulas de hoja de cálculo en celdas de texto no confiables.
export function csvCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = String(value ?? '');
  if (/^[=+\-@\t\r|%]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export const csvRow = cells => cells.map(csvCell).join(';');

export const searchKey = value => normalizeText(String(value || ''));
