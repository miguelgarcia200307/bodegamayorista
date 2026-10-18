// Pruebas unitarias del contrato de métricas, segmentación y recomendador (sin red).
// Los valores esperados están calculados a mano a partir de los fixtures, no copiados de
// la implementación. Uso: node tools/qa-metrics.mjs
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

globalThis.location = { pathname: '/admin/index.html', href: 'http://localhost/admin/index.html' };
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const load = path => import(pathToFileURL(join(root, path)).href);
const M = await load('js/lib/metrics.js');
const { analyzeCustomer } = await load('js/lib/customer-insights.js');
const { diagnoseCustomer, relationshipSegment, currentIntent } = await load('js/lib/customer-diagnosis.js');
const { buildRecommendations } = await load('js/lib/recommender.js');
const { recommendForProduct, recommendForCart } = await load('js/lib/public-reco.js');
const F = await load('tools/fixtures/crm-demo.mjs');

let passed = 0; const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push(name); console.log(`  ✗ ${name}\n      ${error.message}`); }
}
const ASOF = F.ASOF;
const run = (history, extra = {}) => analyzeCustomer({ sales: [], quotes: [], orders: [], ...history }, { products: F.products, categories: F.categories, asOf: ASOF, relationships: F.relationships, ...extra });

console.log('Métricas y motor');
await test('1. ranking neto: A compra 100 y devuelve 90; B compra 50 → B primero', () => {
  const A = F.sale({ id: 'sA', customer: 'A', date: '2026-09-01', lines: [['p-aud', 10, 10]], returns: [[0, 9, '2026-09-05']] });
  const B = F.sale({ id: 'sB', customer: 'B', date: '2026-09-02', lines: [['p-aud', 1, 50]] });
  const totals = M.netPurchasesByCustomer([A, B]);
  assert.equal(totals.get('A'), 1000); assert.equal(totals.get('B'), 5000); // centavos: 10 y 50 pesos
  assert.equal(M.rankFromTotals(totals, 'B').position, 1);
  assert.equal(M.rankFromTotals(totals, 'A').position, 2);
});
await test('2. devolución completa: neto 0, devolución visible y recorrido conservado', () => {
  const D = F.sale({ id: 'sD', customer: 'D', status: 'devuelta', date: '2026-09-01', lines: [['p-aud', 1, 200000]], returns: [[0, 1, '2026-09-10']] });
  const a = run({ sales: [D] });
  assert.equal(a.metrics.operations, 1); assert.equal(a.metrics.positiveOperations, 0);
  assert.equal(a.metrics.productsKeptCents, 0); assert.equal(a.metrics.cohortReturnedCents, 20000000);
  assert.equal(a.metrics.periodReturnedCents, 20000000);
  assert.equal(a.metrics.avgTicketCents, null, 'sin compras positivas el ticket es desconocido, no cero');
  assert.equal(relationshipSegment(a.metrics).key, 'devoluciones');
  assert.ok(a.timeline.some(entry => entry.kind === 'return'));
});
await test('3. pedido→venta no duplica evidencia; partir una compra en 10 líneas no da evidencia alta', () => {
  const order = F.order({ id: 'oP', date: '2026-09-19', lines: [['p-cel', 1, 1000000]], status: 'confirmado' });
  const sale = F.sale({ id: 'sP', date: '2026-09-20', lines: [['p-cel', 1, 1000000]], sourceOrder: 'oP' });
  const only = run({ sales: [sale] }); const both = run({ sales: [sale], orders: [order] });
  assert.equal(only.metrics.evidence.ops, 1); assert.equal(both.metrics.evidence.ops, 1);
  assert.equal(both.metrics.evidence.level, only.metrics.evidence.level);
  const split = F.sale({ id: 'sS', date: '2026-09-20', lines: Array.from({ length: 10 }, () => ['p-par', 1, 150000]) });
  const s = run({ sales: [split] });
  assert.equal(s.metrics.evidence.ops, 1); assert.equal(s.metrics.evidence.level, 'limitada');
});
await test('4. borrador nunca enviado no es señal; rechazo no suma igual que interés', () => {
  const q = status => F.quote({ id: `q-${status}`, status, date: '2026-10-12', lines: [['p-cel', 1, 1000000]] });
  const draft = run({ quotes: [q('borrador')] }); const rejected = run({ quotes: [q('rechazada')] }); const sent = run({ quotes: [q('enviada')] });
  assert.equal(draft.buyerInterest.length, 0); assert.equal(rejected.buyerInterest.length, 0); assert.equal(sent.buyerInterest.length, 1);
  assert.equal(relationshipSegment(draft.metrics).key, 'sin_actividad_cliente');
  assert.equal(currentIntent(draft.metrics, [], ASOF).level, 'sin_senales');
  assert.equal(currentIntent(sent.metrics, [], ASOF).level, 'media');
  assert.ok(!draft.recommendations.some(item => item.product.id === 'p-cel'), 'el borrador no genera recomendación del producto');
});
await test('5. convertida con venta en solicitud o cancelada no es venta confirmada vigente', () => {
  const quotes = [F.quote({ id: 'qc', status: 'convertida', date: '2026-09-01', sent: '2026-09-01', lines: [['p-aud', 1, 100]], converted: 'sc' }), F.quote({ id: 'qs', status: 'convertida', date: '2026-09-03', sent: '2026-09-03', lines: [['p-aud', 1, 100]], converted: 'ss' }), F.quote({ id: 'qok', status: 'convertida', date: '2026-09-04', sent: '2026-09-04', lines: [['p-aud', 1, 100]], converted: 'sok' })];
  const sales = [F.sale({ id: 'sc', status: 'cancelada', confirmed: false, date: '2026-09-02', lines: [['p-aud', 1, 100]], sourceQuote: 'qc' }), F.sale({ id: 'ss', status: 'solicitud', confirmed: false, date: '2026-09-03', lines: [['p-aud', 1, 100]], sourceQuote: 'qs' }), F.sale({ id: 'sok', date: '2026-09-05', lines: [['p-aud', 1, 100]], sourceQuote: 'qok' })];
  const funnel = M.quoteFunnel(quotes, sales, ASOF);
  assert.deepEqual([funnel.acceptance.num, funnel.acceptance.den], [3, 3]);
  assert.deepEqual([funnel.toSaleRequest.num, funnel.toSaleRequest.den], [3, 3]);
  assert.deepEqual([funnel.toConfirmedSale.num, funnel.toConfirmedSale.den], [1, 3]);
  const small = M.quoteFunnel(quotes.slice(0, 1), sales, ASOF);
  assert.equal(small.toConfirmedSale.rate, null, 'muestra < 3: sin porcentaje');
  assert.equal(run({ sales, quotes }).metrics.operations, 1);
});
await test('6. periodo coherente con KPIs y gráfica mensual independiente del periodo', () => {
  const sales = [F.sale({ id: 'm1', date: '2026-03-10', lines: [['p-aud', 1, 100]] }), F.sale({ id: 'm2', date: '2026-09-10', lines: [['p-aud', 1, 100]] })];
  const all = run({ sales }); const last90 = run({ sales }, { since: M.addDays(ASOF, -90) });
  assert.equal(all.metrics.productsKeptCents, 20000); assert.equal(last90.metrics.productsKeptCents, 10000);
  const sum = a => a.metrics.monthly.buckets.reduce((total, bucket) => total + bucket.keptCents, 0);
  assert.equal(sum(all), 20000); assert.equal(sum(last90), 20000);
  assert.equal(all.metrics.monthly.scope, 'ultimos-12-meses-historial-completo');
});
await test('7. historial incompleto: la evidencia baja y el análisis se marca parcial', () => {
  const sales = Array.from({ length: 6 }, (_, k) => F.sale({ id: `h${k}`, date: M.addDays('2026-03-01', k * 30), lines: [['p-aud', 1, 1000]] }));
  const full = run({ sales }); const partial = run({ sales }, { coverage: { complete: false, errors: ['sales'] } });
  assert.equal(full.metrics.evidence.level, 'amplia'); assert.equal(partial.metrics.evidence.level, 'suficiente');
  assert.ok(partial.insights.some(item => /parcial/.test(item.text)));
});
await test('7b. historial mayor que una respuesta: se recorren todas las páginas con orden estable; el tope se marca como truncado', async () => {
  const { fetchAllPages } = await load('js/lib/paging.js');
  const rows = Array.from({ length: 1234 }, (_, k) => ({ id: k }));
  const builder = () => ({ range: async (from, to) => ({ data: rows.slice(from, to + 1), error: null }) });
  const all = await fetchAllPages(builder, { pageSize: 500 });
  assert.equal(all.length, 1234); assert.equal(all.complete, true); assert.deepEqual(all.slice(498, 502).map(row => row.id), [498, 499, 500, 501]);
  const capped = await fetchAllPages(builder, { pageSize: 500, maxRows: 1000 });
  assert.equal(capped.length, 1000); assert.equal(capped.truncated, true); assert.equal(capped.complete, false);
  await assert.rejects(fetchAllPages(() => ({ range: async () => ({ data: null, error: new Error('fallo de red') }) })), /fallo de red/, 'un error no se convierte en lista vacía');
});
await test('8. Bogotá y reloj inyectado: 04:30 UTC del 1 de enero es 31 de diciembre; dos compras del mismo día son una ocasión', () => {
  assert.equal(M.bogotaDate('2027-01-01T04:30:00Z'), '2026-12-31');
  const sales = [F.sale({ id: 'd1', at: '2026-09-10T14:00:00Z', lines: [['p-aud', 1, 100]] }), F.sale({ id: 'd2', at: '2026-09-11T03:00:00Z', lines: [['p-aud', 1, 100]] })];
  const a = run({ sales });
  assert.equal(a.metrics.operations, 2); assert.equal(a.metrics.occasions, 1, 'ambas son el 10/09 en Bogotá');
  assert.equal(a.metrics.daysSinceLast, M.daysBetween('2026-09-10', ASOF));
  assert.throws(() => M.customerMetrics({ sales: [], quotes: [], orders: [] }, {}), /asOf/);
  // Producto eliminado del catálogo: la compra se conserva con su nombre.
  const gone = run({ sales: [F.sale({ id: 'g', date: '2026-09-01', lines: [['p-eliminado', 1, 500]] })] });
  assert.equal(gone.metrics.productsKeptCents, 50000); assert.equal(gone.purchaseLines[0].category, 'Sin categoría');
  // Muestra mínima: una sola compra no es hábito.
  assert.equal(gone.metrics.cadence.medianGap, null);
});
await test('9. variante agotada no se sustituye; reposición y contexto mayorista', () => {
  const quote = F.quote({ id: 'qv', status: 'aceptada', date: '2026-10-10', sent: '2026-10-10', lines: [['p-cel', 1, 1000000, 'p-cel-v2']] });
  const a = run({ quotes: [quote] });
  assert.ok(!a.recommendations.some(item => item.product.id === 'p-cel'), 'la variante pedida está agotada');
  assert.ok(a.recommendationExclusions.some(item => item.product.id === 'p-cel' && /variante/.test(item.reason)));
  const opp = a.opportunities[0]; assert.equal(opp.allAvailable, false); assert.equal(opp.lines[0].status, 'stock_insuficiente');
  // Reposición configurada (cartuchos cada 60 días): compró hace 70 días → se recomienda de nuevo.
  const refill = run({ sales: [F.sale({ id: 'r1', date: M.addDays(ASOF, -70), lines: [['p-cart', 2, 30000]] })] });
  const item = refill.recommendations.find(entry => entry.product.id === 'p-cart');
  assert.ok(item, 'reposición recomendada'); assert.equal(item.kind, 'reposicion');
  // Sin regla de reposición, lo comprado no se repite (consumo) …
  const once = run({ sales: [F.sale({ id: 'c1', date: M.addDays(ASOF, -20), lines: [['p-aud', 1, 200000]] })] });
  assert.ok(once.recommendationExclusions.some(entry => entry.product.id === 'p-aud'));
  // … pero un mayorista con compras repetidas sí recibe recompra.
  const resale = run({ sales: [0, 1, 2].map(k => F.sale({ id: `w${k}`, date: M.addDays(ASOF, -90 + k * 30), lines: [['p-aud', 12, 150000]] })) }, { buyingContext: 'reventa' });
  const again = resale.recommendations.find(entry => entry.product.id === 'p-aud');
  assert.ok(again, 'recompra mayorista'); assert.equal(again.quantity, 12, 'cantidad típica del mayorista');
  // Compatibilidad: solo con regla compatible_con; la de complemento no la afirma.
  const phone = run({ sales: [F.sale({ id: 'ph', date: M.addDays(ASOF, -10), lines: [['p-cel', 1, 1000000]] })] });
  const audio = phone.recommendations.find(entry => entry.product.id === 'p-aud');
  assert.ok(audio && /Complementa/.test(audio.reasons.map(r => r.text).join(' ')) && /no garantiza compatibilidad/.test(audio.reasons.map(r => r.detail).join(' ')));
  const funda = phone.recommendations.find(entry => entry.product.id === 'p-funda');
  assert.ok(funda && funda.reasons.some(r => /Compatible con/.test(r.text)));
  assert.ok(!phone.recommendations.some(entry => entry.product.id === 'p-excluido'), 'regla excluir');
  assert.ok(phone.recommendations.every(entry => entry.affinity >= 0 && entry.affinity <= 100 && Number.isInteger(entry.affinity)));
});
await test('10. precio recomendado = variante → promoción → tramo por volumen', async () => {
  const resale = run({ sales: [0, 1, 2].map(k => F.sale({ id: `t${k}`, date: M.addDays(ASOF, -90 + k * 30), lines: [['p-cable', 12, 19000]] })) }, { buyingContext: 'reventa' });
  const cable = resale.recommendations.find(entry => entry.product.id === 'p-cable');
  assert.equal(cable.quantity, 12); assert.equal(cable.price.unitCents, 1900000, 'tramo 12+ a 19.000');
  assert.equal(cable.price.regularCents, 2500000);
  const cel = F.products.find(product => product.id === 'p-cel');
  const { priceQuote } = await load('js/lib/reco-core.js');
  assert.equal(priceQuote(cel, cel.product_variants[2], 1).unitCents, 110000000, 'precio propio de la variante 256 GB');
  assert.equal(priceQuote(cel, cel.product_variants[0], 1).unitCents, 90000000, 'promoción vigente');
});
await test('S. las explicaciones salen de las contribuciones finales (penalización incluida)', () => {
  const a = run({ sales: [F.sale({ id: 'x1', date: M.addDays(ASOF, -5), lines: [['p-cel', 1, 1000000]] })] });
  a.recommendations.forEach(item => {
    const total = Math.round(Math.min(100, Math.max(0, item.contributions.reduce((sum, c) => sum + c.value, 0))));
    assert.equal(item.affinity, total);
    item.reasons.forEach(reason => assert.ok(reason.value > 0));
  });
});
await test('Sin historial: recomendación general rotulada como tal', () => {
  const a = run({}, { trending: [{ product_id: 'p-aud' }] });
  assert.equal(a.recommendationFallback, true); assert.equal(a.recommendations[0].affinity, null);
  assert.equal(diagnoseCustomer(a).segment.key, 'sin_historial');
});

console.log('\nRecomendación pública');
await test('Ficha: alternativas y complementos en bloques separados; solo catálogo', () => {
  const cel = F.products.find(product => product.id === 'p-cel');
  const result = recommendForProduct(cel, { products: F.products, categories: F.categories, relationships: F.relationships });
  assert.ok(result.complements.some(item => item.product.id === 'p-aud'));
  assert.ok(result.alternatives.every(item => item.product.id !== 'p-cel'));
  assert.ok(!result.complements.some(item => item.product.id === 'p-excluido'));
  assert.deepEqual(Object.keys(result.complements[0]).sort(), ['product', 'reason']);
});
await test('Carrito: usa todo el carrito, no el primer producto, y no repite sustitutos', () => {
  const cart = [{ product_id: 'p-aud', quantity: 1 }, { product_id: 'p-cel', quantity: 1 }];
  const items = recommendForCart(cart, { products: F.products, categories: F.categories, relationships: F.relationships });
  assert.ok(items.some(item => item.product.id === 'p-funda'), 'complemento del segundo producto');
  assert.ok(!items.some(item => ['p-aud', 'p-cel'].includes(item.product.id)));
  assert.ok(!items.some(item => item.product.id === 'p-par'), 'no ofrece otro sustituto de audio');
});

console.log('\nExportación');
await test('29. CSV neutraliza fórmulas y conserva números', () => {
  assert.equal(M.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(M.csvCell('+57 300'), `"'+57 300"`);
  assert.equal(M.csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(M.csvCell('-2+3'), `"'-2+3"`);
  assert.equal(M.csvCell(-1500), '-1500');
  assert.equal(M.csvCell('Audífonos'), '"Audífonos"');
});
await test('Reparto de centavos exacto (resto mayor)', () => {
  const parts = M.allocateCents(1000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 1000); assert.deepEqual(parts, [334, 333, 333]);
});

console.log(`\n${passed} pruebas superadas, ${failures.length} fallidas.`);
if (failures.length) process.exit(1);
