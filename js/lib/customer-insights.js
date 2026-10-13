// Análisis comercial de un cliente: cruza su historial (pedidos, cotizaciones y ventas)
// con el catálogo para saber qué compra, cuánto gasta y qué ofrecerle. Todo se calcula
// en el navegador a partir de los documentos ya emitidos: no modifica ningún dato.
import { bogotaTodayIso } from './crm-dates.js';
import { currentPrice, escapeHtml, normalizeText, productImage } from './helpers.js';
import { buildRecommendations } from './recommender.js';

export const CONFIRMED_SALE = ['confirmada', 'pagada', 'entregada'];
export const OPEN_QUOTE = ['borrador', 'enviada', 'aceptada'];
const DAY = 86400000;
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export const bogotaIso = value => value ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }) : '';
export const saleDate = sale => sale.confirmed_at || sale.created_at;
export const daysBetween = (fromIso, toIso) => Math.round((new Date(`${toIso}T12:00:00Z`) - new Date(`${fromIso}T12:00:00Z`)) / DAY);
export function addDaysIso(iso, days) { const date = new Date(`${iso}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + Math.round(days)); return date.toISOString().slice(0, 10); }
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

// La categoría más específica del producto (la subcategoría si existe) y su categoría padre.
function primaryCategory(product, index) {
  const list = (product?.product_categories || []).map(link => link.categories || index.categoryById.get(link.category_id)).filter(Boolean);
  if (!list.length) return null;
  const leaf = list.find(item => item.parent_id && !list.some(other => other.parent_id === item.id)) || list.find(item => item.parent_id) || list[0];
  const parent = leaf.parent_id ? index.categoryById.get(leaf.parent_id) : null;
  return { id: leaf.id, name: leaf.name, slug: leaf.slug || '', parentId: leaf.parent_id || null, parent: parent?.name || '' };
}

export function describeLine(item, index) {
  const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id) || null;
  const category = primaryCategory(product, index);
  return {
    product, key: product?.id || item.product_id || normalizeText(item.product_name), name: item.product_name || product?.name || 'Producto',
    options: item.option_snapshot || {}, sku: item.sku || '', categoryId: category?.id || 'none', category: category?.name || 'Sin categoría',
    categoryParent: category?.parent || '', brandId: product?.brands?.id || 'none', brand: product?.brands?.name || 'Sin marca', image: productImage(product)
  };
}

export function returnedBySaleItem(sale) {
  const returned = new Map();
  (sale.sale_returns || []).forEach(item => returned.set(item.sale_item_id, (returned.get(item.sale_item_id) || 0) + Number(item.quantity || 0)));
  return returned;
}

export const isQuoteOpen = (quote, today = bogotaTodayIso()) => OPEN_QUOTE.includes(quote.status) && !(quote.valid_until && quote.valid_until < today);
const productInStock = product => product.status === 'published' && !product.force_sold_out && (product.product_variants || []).some(variant => variant.active !== false && Number(variant.stock) > 0);

// --- Agregaciones ----------------------------------------------------------------------
function aggregate(lines, keyOf, seed) {
  const map = new Map();
  lines.forEach(line => {
    const key = keyOf(line);
    const entry = map.get(key) || { ...seed(line), amount: 0, units: 0, docs: new Set(), lastDate: '' };
    entry.amount += line.amount; entry.units += line.quantity; entry.docs.add(line.doc.id);
    if (line.date > entry.lastDate) entry.lastDate = line.date;
    map.set(key, entry);
  });
  const total = [...map.values()].reduce((sum, entry) => sum + entry.amount, 0);
  return [...map.values()].map(entry => ({ ...entry, times: entry.docs.size, share: total ? entry.amount / total : 0 })).sort((a, b) => b.amount - a.amount || b.units - a.units);
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

function monthlySeries(confirmedSales, quotes, today) {
  const [year, month] = today.split('-').map(Number);
  const buckets = Array.from({ length: 12 }, (_, offset) => {
    const date = new Date(Date.UTC(year, month - 1 - (11 - offset), 1));
    const key = date.toISOString().slice(0, 7);
    return { key, label: MONTHS[date.getUTCMonth()], year: date.getUTCFullYear(), amount: 0, count: 0, quoted: 0, quotes: 0 };
  });
  const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
  confirmedSales.forEach(sale => { const bucket = byKey.get(bogotaIso(saleDate(sale)).slice(0, 7)); if (bucket) { bucket.amount += sale.netTotal; bucket.count += 1; } });
  quotes.forEach(quote => { const bucket = byKey.get(bogotaIso(quote.created_at).slice(0, 7)); if (bucket) { bucket.quoted += Number(quote.total) || 0; bucket.quotes += 1; } });
  return buckets;
}

// Segmento tipo RFM (recencia, frecuencia y valor) con una acción concreta para el vendedor.
function segmentFor({ count, daysSinceLast, avgGap, quotesCount, ordersCount, openQuotes }) {
  if (!count) {
    if (quotesCount || ordersCount) return { key: 'prospect', label: 'Prospecto', tone: 'info', text: 'Ha cotizado o pedido, pero todavía no concreta una compra confirmada.', action: openQuotes ? 'Haz seguimiento a su cotización abierta y ofrece una condición de cierre: entrega, forma de pago o un descuento por decidir hoy.' : 'Retoma el contacto con lo que cotizó: confirma disponibilidad y precio vigente y propón cerrar la compra.' };
    return { key: 'new', label: 'Sin historial', tone: 'muted', text: 'Aún no tiene pedidos, cotizaciones ni compras registradas.', action: 'Preséntale el catálogo y las categorías más vendidas para generar su primera cotización.' };
  }
  const window = avgGap ? Math.max(45, avgGap * 1.5) : 90;
  if (count >= 3 && daysSinceLast <= Math.max(60, window)) return { key: 'vip', label: 'Cliente VIP', tone: 'success', text: 'Compra con frecuencia y lo hizo recientemente. Es de los clientes que sostienen el negocio.', action: 'Dale trato preferente: acceso anticipado a novedades, precio por volumen y atención directa.' };
  if (count >= 2 && daysSinceLast <= Math.max(90, window)) return { key: 'loyal', label: 'Recurrente', tone: 'success', text: 'Ya repitió compra y sigue activo.', action: 'Ofrécele productos de sus categorías favoritas y complementos para subir el ticket.' };
  if (count === 1 && daysSinceLast <= 60) return { key: 'first', label: 'Nuevo comprador', tone: 'info', text: 'Hizo su primera compra hace poco.', action: 'Agradece la compra, confirma su satisfacción e invítalo a una segunda compra con una novedad de lo que ya le gustó.' };
  if (daysSinceLast <= 180) return { key: 'risk', label: count >= 2 ? 'En riesgo' : 'Por reactivar', tone: 'warning', text: `Lleva ${daysSinceLast} días sin comprar${avgGap ? `, más de lo habitual (compra cada ${Math.round(avgGap)} días)` : ''}.`, action: 'Contáctalo con una oferta puntual de su categoría favorita antes de que se enfríe la relación.' };
  return { key: 'dormant', label: 'Inactivo', tone: 'danger', text: `No compra desde hace ${daysSinceLast} días.`, action: 'Campaña de reactivación: novedades y una promoción con fecha límite en lo que más compraba.' };
}

// since: fecha ISO (Bogotá) desde la que se analiza; null analiza todo el historial.
// storeSales: ventas de toda la tienda (patrones entre clientes); customerId: el cliente analizado.
export function analyzeCustomer(history, { products = [], categories = [], since = null, today = bogotaTodayIso(), storeSales = [], customerId = null } = {}) {
  const index = catalogIndex(products, categories);
  const inRange = date => !since || bogotaIso(date) >= since;
  const sales = history.sales.filter(sale => inRange(saleDate(sale)));
  const quotes = history.quotes.filter(quote => inRange(quote.created_at));
  const orders = history.orders.filter(order => inRange(order.created_at));

  // Ventas confirmadas, netas de devoluciones.
  let returnedValue = 0;
  const purchaseLines = [];
  const confirmed = sales.filter(sale => CONFIRMED_SALE.includes(sale.status)).map(sale => {
    const returned = returnedBySaleItem(sale); let saleReturned = 0;
    (sale.sale_items || []).forEach(item => {
      const quantity = Number(item.quantity) || 0; const back = Math.min(quantity, returned.get(item.id) || 0);
      const unitNet = quantity ? Number(item.line_total) / quantity : 0;
      saleReturned += unitNet * back;
      if (quantity - back > 0) purchaseLines.push({ ...describeLine(item, index), item, doc: sale, kind: 'sale', date: bogotaIso(saleDate(sale)), quantity: quantity - back, unitPrice: Number(item.unit_price) || 0, amount: unitNet * (quantity - back) });
    });
    returnedValue += saleReturned;
    return { ...sale, netTotal: Math.max(0, Number(sale.total) - saleReturned) };
  });
  const quoteLines = quotes.flatMap(quote => (quote.quote_items || []).map(item => ({ ...describeLine(item, index), item, doc: quote, kind: 'quote', date: bogotaIso(quote.created_at), quantity: Number(item.quantity) || 0, unitPrice: Number(item.unit_price) || 0, amount: Number(item.line_total) || 0 })));
  const orderLines = orders.flatMap(order => (order.order_items || []).map(item => ({ ...describeLine(item, index), item, doc: order, kind: 'order', date: bogotaIso(order.created_at), quantity: Number(item.quantity) || 0, unitPrice: Number(item.unit_price) || 0, amount: Number(item.line_total) || 0 })));

  const spent = confirmed.reduce((sum, sale) => sum + sale.netTotal, 0);
  const productSpend = purchaseLines.reduce((sum, line) => sum + line.amount, 0);
  const units = purchaseLines.reduce((sum, line) => sum + line.quantity, 0);
  const purchaseDates = confirmed.map(sale => bogotaIso(saleDate(sale))).sort();
  const first = purchaseDates[0] || ''; const last = purchaseDates.at(-1) || '';
  const gaps = purchaseDates.slice(1).map((date, position) => daysBetween(purchaseDates[position], date)).filter(gap => gap > 0);
  const avgGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null;
  const daysSinceLast = last ? daysBetween(last, today) : null;
  const tickets = confirmed.map(sale => sale.netTotal);

  const openQuotes = quotes.filter(quote => isQuoteOpen(quote, today));
  const converted = quotes.filter(quote => quote.status === 'convertida');
  const closedQuotes = quotes.filter(quote => !isQuoteOpen(quote, today));

  const categoriesBought = aggregate(purchaseLines, line => line.categoryId, line => ({ id: line.categoryId, name: line.category, parent: line.categoryParent }));
  const brandsBought = aggregate(purchaseLines, line => line.brandId, line => ({ id: line.brandId, name: line.brand }));
  const topProducts = aggregate(purchaseLines, line => line.key, line => ({ key: line.key, name: line.product?.name || line.name, product: line.product, image: line.image, category: line.category, brand: line.brand }));
  const interestLines = [...quoteLines, ...orderLines];
  const interestCategories = aggregate(interestLines, line => line.categoryId, line => ({ id: line.categoryId, name: line.category, parent: line.categoryParent }));
  const interestBrands = aggregate(interestLines, line => line.brandId, line => ({ id: line.brandId, name: line.brand }));

  const bought = new Set(history.sales.filter(sale => CONFIRMED_SALE.includes(sale.status)).flatMap(sale => {
    const returned = returnedBySaleItem(sale);
    return (sale.sale_items || []).filter(item => Number(item.quantity) > (returned.get(item.id) || 0)).map(item => describeLine(item, index).key);
  }));
  const opportunityMap = new Map();
  quoteLines.filter(line => line.doc.status !== 'convertida' && !bought.has(line.key)).sort((a, b) => b.date.localeCompare(a.date)).forEach(line => {
    if (!opportunityMap.has(line.key)) opportunityMap.set(line.key, { ...line, open: isQuoteOpen(line.doc, today), inStock: line.product ? productInStock(line.product) : false, currentPrice: line.product ? currentPrice(line.product) : null });
  });
  const opportunities = [...opportunityMap.values()];

  const pricedLines = purchaseLines.length ? purchaseLines : interestLines;
  const pricedUnits = pricedLines.reduce((sum, line) => sum + line.quantity, 0);
  const unitPrices = pricedLines.map(line => line.quantity ? line.amount / line.quantity : line.unitPrice).filter(value => value > 0);
  const price = unitPrices.length ? { min: Math.min(...unitPrices), max: Math.max(...unitPrices), avg: pricedLines.reduce((sum, line) => sum + line.amount, 0) / Math.max(1, pricedUnits), basedOn: purchaseLines.length ? 'compras' : 'cotizaciones' } : null;

  const engine = buildRecommendations({
    index, leafOf: product => primaryCategory(product, index), inStock: productInStock, purchaseLines, interestLines, bought,
    exclude: new Set(opportunities.map(item => item.key)), storeSales, customerId: customerId || history.sales[0]?.customer_id || history.quotes[0]?.customer_id || null, today
  });
  const recommendations = engine.items;

  const segment = segmentFor({ count: confirmed.length, daysSinceLast, avgGap, quotesCount: quotes.length, ordersCount: orders.length, openQuotes: openQuotes.length });
  const preferences = optionPreferences(purchaseLines.length ? purchaseLines : interestLines);

  const timeline = [
    ...history.sales.map(doc => ({ kind: 'sale', doc, date: saleDate(doc) })),
    ...history.quotes.map(doc => ({ kind: 'quote', doc, date: doc.created_at })),
    ...history.orders.map(doc => ({ kind: 'order', doc, date: doc.created_at }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const insights = [];
  const b = value => `<b>${escapeHtml(value)}</b>`;
  const favorite = categoriesBought[0];
  if (favorite) insights.push({ tone: 'success', text: `Su categoría favorita es ${b(favorite.name)}: ${Math.round(favorite.share * 100)} % de lo que compra en productos.` });
  else if (interestCategories[0]) insights.push({ tone: 'info', text: `Le interesa ${b(interestCategories[0].name)} según lo que ha cotizado o pedido.` });
  if (brandsBought[0] && brandsBought[0].id !== 'none') insights.push({ tone: 'info', text: `Marca preferida: ${b(brandsBought[0].name)} (${Math.round(brandsBought[0].share * 100)} % del gasto).` });
  if (preferences[0]?.values[0]) insights.push({ tone: 'info', text: `${preferences.slice(0, 2).map(group => `${escapeHtml(group.name)} más elegida: ${b(group.values[0].value)}`).join(' · ')}.` });
  if (avgGap && last) {
    const next = addDaysIso(last, avgGap);
    insights.push({ tone: next < today ? 'warning' : 'info', text: `Compra en promedio cada <b>${Math.round(avgGap)} días</b>. ${next < today ? `Su próxima compra estaba prevista para el ${next.split('-').reverse().join('/')}: ya está atrasado.` : `Próxima compra estimada: ${next.split('-').reverse().join('/')}.`}` });
  }
  if (openQuotes.length) insights.push({ tone: 'warning', text: `Tiene <b>${openQuotes.length} cotización${openQuotes.length === 1 ? '' : 'es'} abierta${openQuotes.length === 1 ? '' : 's'}</b> por ${moneyText(openQuotes.reduce((sum, quote) => sum + Number(quote.total), 0))}. Haz seguimiento antes de que venza${openQuotes.length === 1 ? '' : 'n'}.` });
  if (opportunities.length) insights.push({ tone: 'warning', text: `Cotizó <b>${opportunities.length} producto${opportunities.length === 1 ? '' : 's'}</b> que nunca compró${opportunities[0] ? `, por ejemplo ${escapeHtml(opportunities[0].name)}` : ''}.` });
  if (price && confirmed.length) insights.push({ tone: 'info', text: `Paga en promedio <b>${moneyText(price.avg)}</b> por unidad: ofrécele productos entre ${moneyText(price.avg * 0.7)} y ${moneyText(price.avg * 1.4)}.` });
  if (returnedValue > 0) insights.push({ tone: 'danger', text: `Ha devuelto productos por ${moneyText(returnedValue)}. Revisa el motivo antes de ofrecerle lo mismo.` });
  if (quotes.length >= 2 && closedQuotes.length) insights.push({ tone: converted.length / closedQuotes.length >= 0.5 ? 'success' : 'warning', text: `Convierte el <b>${Math.round((converted.length / closedQuotes.length) * 100)} %</b> de sus cotizaciones cerradas en venta.` });

  return {
    index, since, today, sales, quotes, orders, confirmed, purchaseLines, quoteLines, orderLines,
    spent, productSpend, units, returnedValue, count: confirmed.length, avgTicket: confirmed.length ? spent / confirmed.length : 0, maxTicket: tickets.length ? Math.max(...tickets) : 0,
    first, last, daysSinceLast, avgGap, nextExpected: avgGap && last ? addDaysIso(last, avgGap) : null,
    quotedTotal: quotes.reduce((sum, quote) => sum + Number(quote.total || 0), 0), openQuotes, openQuotesValue: openQuotes.reduce((sum, quote) => sum + Number(quote.total || 0), 0),
    converted: converted.length, conversion: closedQuotes.length ? converted.length / closedQuotes.length : null,
    pendingOrders: orders.filter(order => order.status === 'pendiente').length, lostOrders: orders.filter(order => ['cancelado', 'abandonado'].includes(order.status)).length,
    categories: categoriesBought, brands: brandsBought, topProducts, interestCategories, interestBrands, preferences, price,
    opportunities, recommendations, recommendationStats: engine.stats, segment, insights, timeline, monthly: monthlySeries(confirmed, history.quotes, today), bought
  };
}

// Posición del cliente frente al resto según lo comprado (ventas confirmadas).
export function customerRank(allSales, customerId) {
  const totals = new Map();
  allSales.filter(sale => CONFIRMED_SALE.includes(sale.status) && sale.customer_id).forEach(sale => totals.set(sale.customer_id, (totals.get(sale.customer_id) || 0) + Number(sale.total || 0)));
  if (!totals.has(customerId)) return null;
  const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const position = ordered.findIndex(([id]) => id === customerId) + 1;
  const share = ordered.reduce((sum, [, value]) => sum + value, 0);
  return { position, total: ordered.length, top: Math.max(1, Math.ceil((position / ordered.length) * 100)), share: share ? totals.get(customerId) / share : 0 };
}

function moneyText(value) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(value) || 0); }

// Agrupa líneas por producto: unidades, importe, documentos y variantes elegidas.
export function groupByProduct(lines, bought = new Set()) {
  const map = new Map();
  lines.forEach(line => {
    const entry = map.get(line.key) || { key: line.key, name: line.product?.name || line.name, image: line.image, category: line.category, brand: line.brand, amount: 0, units: 0, docs: new Set(), variants: new Map(), lastDate: '', search: '' };
    entry.amount += line.amount; entry.units += line.quantity; entry.docs.add(line.doc.id);
    const variant = Object.entries(line.options || {}).filter(([, value]) => value && !/^única$/i.test(String(value))).map(([, value]) => value).join(' / ');
    if (variant) entry.variants.set(variant, (entry.variants.get(variant) || 0) + line.quantity);
    if (line.date > entry.lastDate) entry.lastDate = line.date;
    entry.search += ` ${line.name} ${line.sku} ${variant}`;
    map.set(line.key, entry);
  });
  return [...map.values()].map(entry => ({ ...entry, times: entry.docs.size, bought: bought.has(entry.key), variants: [...entry.variants.entries()].sort((a, b) => b[1] - a[1]) })).sort((a, b) => b.amount - a.amount || b.units - a.units);
}
