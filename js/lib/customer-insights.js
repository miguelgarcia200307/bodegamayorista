// Análisis comercial de un cliente sobre el contrato de métricas (metrics.js): qué compró
// y devolvió, qué interés real mostró, qué oportunidades existen y qué ofrecerle.
// Solo lee datos; no modifica nada.
import { escapeHtml, normalizeText, productImage } from './helpers.js';
import { bogotaDate, customerMetrics, daysBetween as metricDays, addDays, fromCents, saleEconomics, toCents } from './metrics.js';
import { buildRecommendations, categoryPriceProfile } from './recommender.js';
import { eligibleUnitCents, leafCategory, variantStock } from './reco-core.js';
import { tierFor, variantPrice } from './pricing.js';

export { CONFIRMED_STATUS as CONFIRMED_SALE } from './metrics.js';
export const OPEN_QUOTE = ['borrador', 'enviada', 'aceptada'];
export const bogotaIso = bogotaDate;
export const saleDate = sale => sale.confirmed_at || sale.created_at;
export const daysBetween = metricDays;
export const addDaysIso = addDays;
export const DOC_ITEMS = { sale: 'sale_items', quote: 'quote_items', order: 'order_items' };
export const DOC_NUMBER = { sale: 'sale_number', quote: 'quote_number', order: 'order_number' };

// --- Catálogo ------------------------------------------------------------------------
let cachedIndex = null;
export function catalogIndex(products = [], categories = []) {
  if (cachedIndex?.products === products && cachedIndex?.categories === categories) return cachedIndex;
  const categoryById = new Map(categories.map(category => [category.id, category]));
  products.forEach(product => (product.product_categories || []).forEach(link => {
    if (link.categories && !categoryById.has(link.categories.id)) categoryById.set(link.categories.id, link.categories);
  }));
  const productById = new Map(products.map(product => [product.id, product]));
  const variantToProduct = new Map();
  products.forEach(product => (product.product_variants || []).forEach(variant => variantToProduct.set(variant.id, product)));
  cachedIndex = { products, categories, categoryById, productById, variantToProduct };
  return cachedIndex;
}

export function describeLine(item, index) {
  const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id) || null;
  const category = leafCategory(product, index.categoryById);
  return {
    product, key: product?.id || item.product_id || normalizeText(item.product_name), name: item.product_name || product?.name || 'Producto',
    options: item.option_snapshot || {}, sku: item.sku || '', categoryId: category?.id || 'none', category: category?.name || 'Sin categoría',
    categoryParent: category?.parentName || '', brandId: product?.brands?.id || 'none', brand: product?.brands?.name || 'Sin marca', image: productImage(product)
  };
}

export function returnedBySaleItem(sale) {
  const returned = new Map();
  (sale.sale_returns || []).forEach(item => returned.set(item.sale_item_id, (returned.get(item.sale_item_id) || 0) + Number(item.quantity || 0)));
  return returned;
}

// Disponibilidad HOY de una línea concreta (variante y cantidad reales del documento).
// docUnits: unidades del mismo producto en el documento (para el tramo por volumen).
export function lineAvailability(item, index, docUnits = null) {
  const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id) || null;
  const quantity = Math.max(1, Number(item.quantity) || 1);
  if (!product) return { status: 'fuera_catalogo', label: 'Ya no está en el catálogo', ok: false };
  if (product.status !== 'published') return { status: 'no_publicado', label: 'No publicado en la tienda', ok: false, product };
  const variant = (product.product_variants || []).find(entry => entry.id === item.variant_id);
  if (!variant || variant.active === false) return { status: 'variante_inactiva', label: 'La variante cotizada ya no está activa', ok: false, product };
  const stock = variantStock(product, variant);
  const unitCents = eligibleUnitCents(product, variant, docUnits ?? quantity);
  const quotedCents = toCents(item.unit_price);
  const priceChange = unitCents === quotedCents ? 'igual' : unitCents < quotedCents ? 'baja' : 'sube';
  if (stock < quantity) return { status: 'stock_insuficiente', label: stock ? `Solo hay ${stock} de ${quantity}` : 'Variante agotada', ok: false, product, variant, stock, quantity, unitCents, quotedCents, priceChange };
  return { status: 'disponible', label: 'Disponible', ok: true, product, variant, stock, quantity, unitCents, quotedCents, priceChange };
}

function docAvailability(lines, index) {
  const units = new Map();
  lines.forEach(item => { const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id); if (product) units.set(product.id, (units.get(product.id) || 0) + Number(item.quantity || 0)); });
  return lines.map(item => {
    const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id);
    return { item, ...lineAvailability(item, index, product ? units.get(product.id) : null) };
  });
}

// --- Agregaciones ----------------------------------------------------------------------
function aggregate(lines, keyOf, seed) {
  const map = new Map();
  lines.forEach(line => {
    const key = keyOf(line);
    const entry = map.get(key) || { ...seed(line), cents: 0, units: 0, docs: new Set(), dates: new Set(), lastDate: '' };
    entry.cents += line.cents; entry.units += line.quantity; entry.docs.add(line.docId); entry.dates.add(line.date);
    if (line.date > entry.lastDate) entry.lastDate = line.date;
    map.set(key, entry);
  });
  const total = [...map.values()].reduce((sum, entry) => sum + entry.cents, 0);
  return [...map.values()].map(entry => ({ ...entry, amount: fromCents(entry.cents), times: entry.docs.size, occasions: entry.dates.size, share: total ? entry.cents / total : 0 }))
    .sort((a, b) => b.cents - a.cents || b.units - a.units);
}

function optionPreferences(lines) {
  const groups = new Map();
  lines.forEach(line => Object.entries(line.options || {}).forEach(([name, value]) => {
    if (!value || /^única$/i.test(String(value))) return;
    const label = String(name).trim(); const values = groups.get(label) || new Map();
    values.set(String(value), (values.get(String(value)) || 0) + line.quantity);
    groups.set(label, values);
  }));
  return [...groups.entries()].map(([name, values]) => {
    const list = [...values.entries()].map(([value, units]) => ({ value, units })).sort((a, b) => b.units - a.units);
    return { name, values: list, units: list.reduce((sum, item) => sum + item.units, 0) };
  }).sort((a, b) => b.units - a.units);
}

// history: { sales, quotes, orders } completo; coverage: { complete, errors, truncated }.
// context: datos privados ya cargados (relaciones, patrones, señales, contexto de compra).
export function analyzeCustomer(history, {
  products = [], categories = [], since = null, asOf, coverage = { complete: true },
  relationships = [], peers = [], signals = [], trending = [], buyingContext = 'desconocido'
} = {}) {
  const index = catalogIndex(products, categories);
  const metrics = customerMetrics(history, { asOf, since, coverage });

  // Líneas conservadas (netas de devoluciones) de las compras de la cohorte.
  const purchaseLines = metrics.cohort.flatMap(entry => entry.eco.lines.filter(line => line.keptQuantity > 0).map(line => ({
    ...describeLine(line.item, index), item: line.item, docId: entry.sale.id, doc: entry.sale, kind: 'sale', date: entry.date,
    quantity: line.keptQuantity, cents: line.keptCents, amount: fromCents(line.keptCents), unitPrice: line.keptQuantity ? fromCents(Math.round(line.keptCents / line.keptQuantity)) : 0
  })));
  const returnedLines = metrics.cohort.flatMap(entry => entry.eco.lines.filter(line => line.returnedQuantity > 0).map(line => ({
    ...describeLine(line.item, index), docId: entry.sale.id, doc: entry.sale, date: entry.date, quantity: line.returnedQuantity, cents: line.returnedCents
  })));
  // Interés: una sola contribución por recorrido; las líneas heredan el peso del recorrido.
  const inRange = date => !since || date >= since;
  const interestJourneys = metrics.journeys.filter(journey => !journey.purchase && inRange(journey.date));
  const interestLines = interestJourneys.flatMap(journey => journey.lines.map(item => ({
    ...describeLine(item, index), item, docId: journey.origin?.id || journey.sale?.id, doc: journey.origin || journey.sale, journey, kind: journey.originKind,
    date: journey.date, quantity: Number(item.quantity) || 0, cents: toCents(item.line_total), amount: Number(item.line_total) || 0, unitPrice: Number(item.unit_price) || 0, weight: journey.weight
  })));
  const buyerInterest = interestLines.filter(line => line.weight > 0);

  // Oportunidades: recorridos abiertos con señal, revisando TODAS sus líneas y variantes.
  const opportunities = interestJourneys.filter(journey => journey.weight > 0).map(journey => {
    const lines = docAvailability(journey.lines, index);
    return { journey, doc: journey.origin || journey.sale, lines, allAvailable: lines.length > 0 && lines.every(line => line.ok), date: journey.date, label: journey.label };
  });

  const categoriesBought = aggregate(purchaseLines, line => line.categoryId, line => ({ id: line.categoryId, name: line.category, parent: line.categoryParent }));
  const brandsBought = aggregate(purchaseLines, line => line.brandId, line => ({ id: line.brandId, name: line.brand }));
  const topProducts = aggregate(purchaseLines, line => line.key, line => ({ key: line.key, name: line.product?.name || line.name, product: line.product, image: line.image, category: line.category, brand: line.brand }));
  const interestCategories = aggregate(buyerInterest, line => line.categoryId, line => ({ id: line.categoryId, name: line.category, parent: line.categoryParent }));
  const preferences = optionPreferences(purchaseLines.length ? purchaseLines : buyerInterest);

  // Entradas del recomendador (historial completo, no solo el periodo).
  const allPurchases = metrics.purchases.flatMap(entry => entry.eco.lines.map(line => ({
    product: index.productById.get(line.item.product_id) || index.variantToProduct.get(line.item.variant_id) || null,
    variantId: line.item.variant_id, date: entry.date, keptQty: line.keptQuantity, keptCents: line.keptCents, options: line.item.option_snapshot || {}
  }))).filter(entry => entry.product);
  const interests = metrics.journeys.filter(journey => !journey.purchase).flatMap(journey => journey.lines.map(item => ({
    product: index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id) || null,
    variantId: item.variant_id, qty: Number(item.quantity) || 1, date: journey.date, weight: journey.weight, label: journey.label, journeyKey: journey.key
  }))).filter(entry => entry.product);
  const engine = buildRecommendations({
    products, categoryById: index.categoryById, asOf, purchases: allPurchases, interests, signals, relationships, peers, trending,
    context: buyingContext, evidence: metrics.evidence
  });
  const priceProfile = categoryPriceProfile(allPurchases, index.categoryById);

  const timeline = [
    ...history.sales.map(doc => ({ kind: 'sale', doc, date: saleDate(doc) })),
    ...history.quotes.map(doc => ({ kind: 'quote', doc, date: doc.created_at })),
    ...history.orders.map(doc => ({ kind: 'order', doc, date: doc.created_at })),
    ...metrics.purchases.flatMap(entry => entry.eco.returnEvents.map(event => ({ kind: 'return', doc: entry.sale, date: `${event.date}T12:00:00`, event })))
  ].sort((a, b) => new Date(b.date) - new Date(a.date) || String(a.doc.id).localeCompare(String(b.doc.id)));

  // Todas las líneas cotizadas (vista "por producto" de la ficha) y lo conservado.
  const quoteLines = history.quotes.flatMap(quote => (quote.quote_items || []).map(item => ({ ...describeLine(item, index), item, docId: quote.id, doc: quote, date: bogotaDate(quote.created_at), quantity: Number(item.quantity) || 0, cents: toCents(item.line_total) })));
  const bought = new Set(allPurchases.filter(entry => entry.keptQty > 0).map(entry => entry.product.id));
  const analysis = {
    quoteLines, bought,
    index, asOf, today: asOf, since, coverage, metrics,
    sales: history.sales, quotes: history.quotes, orders: history.orders,
    purchaseLines, returnedLines, interestLines, buyerInterest, opportunities,
    categories: categoriesBought, brands: brandsBought, topProducts, interestCategories, preferences, priceProfile,
    recommendations: engine.items, recommendationFallback: engine.fallback, recommendationExclusions: engine.exclusions, recommendationStats: engine.stats,
    timeline, buyingContext
  };
  analysis.insights = insightsFor(analysis);
  return analysis;
}

const money = cents => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(fromCents(cents || 0));
const dmy = iso => iso ? iso.split('-').reverse().join('/') : '';

// Hallazgos: cada uno indica si es un hecho observado, calculado o inferido y su fuente.
function insightsFor(a) {
  const m = a.metrics; const list = [];
  const b = value => `<b>${escapeHtml(value)}</b>`;
  const fav = a.categories[0];
  if (fav && m.occasions >= 2) list.push({ tone: 'success', kind: 'calculado', text: `Compra sobre todo ${b(fav.name)}: ${Math.round(fav.share * 100)} % de lo conservado en el periodo (${fav.occasions} de ${m.occasions} compras).` });
  else if (fav) list.push({ tone: 'info', kind: 'observado', text: `Compró ${b(fav.name)} (una sola compra en el periodo: aún no es un hábito).` });
  else if (a.interestCategories[0]) list.push({ tone: 'info', kind: 'observado', text: `Pidió o cotizó ${b(a.interestCategories[0].name)}; aún sin compra confirmada.` });
  if (a.brands[0] && a.brands[0].id !== 'none' && a.brands[0].occasions >= 2) list.push({ tone: 'info', kind: 'calculado', text: `Marca presente en ${a.brands[0].occasions} compras: ${b(a.brands[0].name)}.` });
  if (m.cadence.medianGap) list.push({ tone: 'info', kind: 'calculado', text: `Entre sus ${m.cadence.occasions} compras pasaron entre ${m.cadence.minGap} y ${m.cadence.maxGap} días (mediana ${Math.round(m.cadence.medianGap)}). Ventana orientativa para volver a contactarlo: ${dmy(m.cadence.window[0])} – ${dmy(m.cadence.window[1])}.` });
  else if (m.cadence.occasions === 2) list.push({ tone: 'muted', kind: 'calculado', text: 'Tiene dos compras: todavía no hay historial suficiente para estimar un intervalo de recompra.' });
  if (m.cohortReturnedCents > 0) list.push({ tone: 'danger', kind: 'observado', text: `Devolvió ${money(m.cohortReturnedCents)} de lo comprado en el periodo${m.fullyReturnedOperations ? ` (${m.fullyReturnedOperations} compra${m.fullyReturnedOperations === 1 ? '' : 's'} devuelta${m.fullyReturnedOperations === 1 ? '' : 's'} por completo)` : ''}. Revisa el motivo antes de ofrecerle lo mismo.` });
  const funnel = m.funnel;
  if (funnel.toConfirmedSale.den) list.push({ tone: funnel.toConfirmedSale.rate != null && funnel.toConfirmedSale.rate >= 0.5 ? 'success' : 'info', kind: 'calculado', text: `Cotizaciones enviadas con resultado: ${funnel.toConfirmedSale.num} de ${funnel.toConfirmedSale.den} terminaron en venta confirmada vigente${funnel.toConfirmedSale.rate == null ? ' (muestra pequeña: no se calcula porcentaje)' : ''}.` });
  const pr = a.priceProfile.find(item => item.enough);
  if (pr) list.push({ tone: 'info', kind: 'calculado', text: `En ${b(pr.name)} pagó entre ${money(pr.min)} y ${money(pr.max)} por unidad (mediana ${money(pr.median)}, ${pr.n} unidades). No indica su capacidad de pago.` });
  if (!a.coverage.complete) list.push({ tone: 'warning', kind: 'calculado', text: 'Parte del historial no se pudo cargar: estos hallazgos son parciales.' });
  return list;
}

// Agrupa líneas por producto: unidades, importe, documentos y variantes elegidas.
export function groupByProduct(lines, bought = new Set()) {
  const map = new Map();
  lines.forEach(line => {
    const entry = map.get(line.key) || { key: line.key, name: line.product?.name || line.name, image: line.image, category: line.category, brand: line.brand, cents: 0, units: 0, docs: new Set(), variants: new Map(), lastDate: '', search: '' };
    entry.cents += line.cents ?? toCents(line.amount); entry.units += line.quantity; entry.docs.add(line.docId || line.doc?.id);
    const variant = Object.entries(line.options || {}).filter(([, value]) => value && !/^única$/i.test(String(value))).map(([, value]) => value).join(' / ');
    if (variant) entry.variants.set(variant, (entry.variants.get(variant) || 0) + line.quantity);
    if (line.date > entry.lastDate) entry.lastDate = line.date;
    entry.search += ` ${line.name} ${line.sku} ${variant}`;
    map.set(line.key, entry);
  });
  return [...map.values()].map(entry => ({ ...entry, amount: fromCents(entry.cents), times: entry.docs.size, bought: bought.has(entry.key), variants: [...entry.variants.entries()].sort((a, b) => b[1] - a[1]) }))
    .sort((a, b) => b.cents - a.cents || b.units - a.units);
}

export { saleEconomics, variantPrice, tierFor };
