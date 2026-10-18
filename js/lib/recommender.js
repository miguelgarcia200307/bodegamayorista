// Recomendador privado del CRM (versión RECO_RULES.version). Etapas separadas:
//   1. Universo elegible (reco-core): publicado, variante activa, stock suficiente, precio real.
//   2. Candidatos y restricciones: relaciones configuradas (complemento, alternativa,
//      compatible_con, reposición, excluir), variante exigida y contexto de compra.
//   3. Puntuación con contribuciones explícitas (puntos 0‑100, NO probabilidad).
//   4. Diversificación y explicación a partir de las contribuciones FINALES.
// La afinidad no es una probabilidad: no hay calibración con resultados reales todavía.
import { isPromoActive, productImage } from './helpers.js';
import { addDays, daysBetween, median, quantile, toCents } from './metrics.js';
import { describeRuleSource, diversify, eligibleVariants, isEligible, leafCategory, priceQuote, referencePrices, relationIndex, variantStock } from './reco-core.js';

export const RECO_RULES = {
  version: 'reco-2026.10-v2',
  maxResults: 6,
  minAffinity: 15,
  explicitHalfLife: 30, behaviorHalfLife: 14, relationHalfLife: 180,
  points: { explicit: 40, behavior: 25, sameCategory: 18, complement: 26, compatible: 30, reposition: 35, brand: 10, peers: 10, promo: 5, recentSameCategory: -15, priceRisk: -12 },
  peers: { minSupport: 5 },
  recentSameCategoryDays: 90,
  // Mínimo de compras en una categoría para hablar de su rango de precio.
  minPriceSample: 2
};
const decay = (days, halfLife) => Math.pow(0.5, Math.max(0, days) / halfLife);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const shortDate = iso => iso ? iso.split('-').reverse().join('/') : '';
const optionMatch = (variant, preferred) => Object.values(variant?.option_values || {}).concat([variant?.color_name, variant?.size_name]).filter(Boolean).some(value => preferred.has(String(value).toLowerCase()));

// purchases: [{ product, variantId, date, keptQty, keptCents, options }]
// interests: [{ product, variantId, qty, date, weight, label, journeyKey }]
// signals:   [{ product_id, variant_id, sessions, last_seen, favorite, cart_qty, identity_level }]
// peers:     [{ from_category, to_category, support, both, window_days }]
export function buildRecommendations({ products = [], categoryById = new Map(), asOf, purchases = [], interests = [], signals = [], relationships = [], peers = [], trending = [], context = 'desconocido', evidence = null }) {
  if (!asOf) throw new Error('buildRecommendations necesita asOf');
  const R = RECO_RULES;
  const productById = new Map(products.map(product => [product.id, product]));
  const leafOf = product => leafCategory(product, categoryById);
  const universe = products.filter(product => product.status === 'published');
  const references = referencePrices(universe, categoryById);
  const rules = relationIndex(relationships);
  const reseller = context === 'reventa';

  // --- Perfil del cliente --------------------------------------------------------------
  const byLeaf = new Map(); const byBrand = new Map(); const byProduct = new Map(); const preferredOptions = new Set();
  const leafEntry = id => byLeaf.get(id) || byLeaf.set(id, { occasions: new Set(), lastDate: '', units: [], unitCents: [], name: '' }).get(id);
  purchases.forEach(entry => {
    const leaf = leafOf(entry.product); const brandId = entry.product?.brands?.id;
    if (leaf) { const item = leafEntry(leaf.id); item.name = leaf.name; item.occasions.add(entry.date); if (entry.date > item.lastDate) item.lastDate = entry.date; if (entry.keptQty > 0) { item.units.push(entry.keptQty); item.unitCents.push(Math.round(entry.keptCents / entry.keptQty)); } }
    if (brandId) byBrand.set(brandId, new Set([...(byBrand.get(brandId) || []), entry.date]));
    if (entry.product) { const prev = byProduct.get(entry.product.id) || { dates: new Set(), lastDate: '', qtys: [] }; prev.dates.add(entry.date); if (entry.date > prev.lastDate) prev.lastDate = entry.date; prev.qtys.push(entry.keptQty); byProduct.set(entry.product.id, prev); }
    Object.values(entry.options || {}).filter(value => value && !/^única$/i.test(String(value))).forEach(value => preferredOptions.add(String(value).toLowerCase()));
  });
  const totalOccasions = new Set(purchases.map(entry => entry.date)).size;
  const interestByProduct = new Map(); const interestByLeaf = new Map();
  interests.filter(entry => entry.weight > 0 && entry.product).forEach(entry => {
    const prev = interestByProduct.get(entry.product.id);
    const strength = entry.weight * decay(daysBetween(entry.date, asOf), R.explicitHalfLife);
    if (!prev || strength > prev.strength) interestByProduct.set(entry.product.id, { ...entry, strength });
    const leaf = leafOf(entry.product);
    if (leaf) interestByLeaf.set(leaf.id, Math.max(interestByLeaf.get(leaf.id) || 0, strength));
  });
  const signalByProduct = new Map(signals.filter(signal => signal.product_id).map(signal => [signal.product_id, signal]));
  // Orígenes para las relaciones: lo comprado (1) y lo pedido/cotizado con señal (0,7).
  const sources = [
    ...purchases.filter(entry => entry.product && entry.keptQty > 0).map(entry => ({ product: entry.product, date: entry.date, strength: 1, how: 'compró' })),
    ...[...interestByProduct.values()].map(entry => ({ product: entry.product, date: entry.date, strength: 0.7 * entry.weight, how: entry.label.toLowerCase().startsWith('pedido') ? 'pidió' : 'cotizó' }))
  ];
  const excluded = new Map();
  const exclude = (product, reason) => { if (!excluded.has(product.id)) excluded.set(product.id, { product, reason }); };

  const scored = [];
  universe.forEach(product => {
    const leaf = leafOf(product);
    const contributions = [];
    const add = (key, value, text, detail, kind) => { if (value) contributions.push({ key, value, text, detail, kind }); };
    const interest = interestByProduct.get(product.id);
    const bought = byProduct.get(product.id);

    // Restricción "excluir": cualquier origen del cliente que excluya este candidato.
    const blocking = sources.flatMap(source => rules.from(source.product, categoryById).filter(rule => rule.kind === 'excluir' && rules.targets(rule, product, categoryById)));
    if (blocking.length) { exclude(product, `Regla configurada: no recomendar junto a ${describeRuleSource(blocking[0], { productById, categoryById })}`); return; }

    // Variante y cantidad exigidas: la del pedido/cotización si existe; si está agotada,
    // el candidato no es elegible (no se cambia por otra variante en silencio).
    let quantity = Math.max(1, Math.round(interest?.qty || 1));
    if (reseller && !interest && leaf && byLeaf.get(leaf.id)?.units.length) quantity = Math.max(1, Math.round(median(byLeaf.get(leaf.id).units)));
    let variant = null;
    if (interest?.variantId) {
      variant = (product.product_variants || []).find(item => item.id === interest.variantId) || null;
      if (!variant || variant.active === false || variantStock(product, variant) < quantity) { exclude(product, !variant || variant.active === false ? 'La variante que pidió ya no está activa' : `La variante que pidió no tiene ${quantity} unidad(es) disponibles`); return; }
    }
    if (!variant) {
      const options = eligibleVariants(product, quantity);
      if (!options.length) { if (interest || bought) exclude(product, isEligible(product) ? `No hay ${quantity} unidades en una misma variante` : 'Sin stock disponible'); return; }
      variant = options.find(item => optionMatch(item, preferredOptions)) || options[0];
    }
    if (product.force_sold_out || product.status !== 'published') return;

    // 1. Intención explícita (pedido, cotización aceptada/enviada, venta en solicitud).
    if (interest) add('explicit', R.points.explicit * interest.strength, interest.label, `${shortDate(interest.date)}`, 'observado');
    // 2. Navegación autorizada (sesiones independientes, favoritos, carrito).
    const signal = signalByProduct.get(product.id);
    if (signal) {
      const sessions = Number(signal.sessions) || 0;
      const raw = Math.min(1, (sessions >= 2 ? sessions / 3 : 0) + (signal.favorite ? 0.4 : 0) + (Number(signal.cart_qty) > 0 ? 0.6 : 0));
      const age = signal.last_seen ? daysBetween(signal.last_seen.slice(0, 10), asOf) : 30;
      const parts = [sessions ? `visto en ${sessions} ${sessions === 1 ? 'sesión' : 'sesiones'}` : '', signal.favorite ? 'guardado en favoritos' : '', Number(signal.cart_qty) > 0 ? 'agregado al carrito' : ''].filter(Boolean);
      add('behavior', R.points.behavior * raw * decay(age, R.behaviorHalfLife), `Navegación: ${parts.join(', ')}`, `Último registro ${shortDate(signal.last_seen?.slice(0, 10))} · identidad ${signal.identity_level === 'verificada' ? 'verificada' : 'declarada'}`, 'observado');
    }
    // 3. Interés en la categoría (por otros productos).
    if (leaf && !interest && interestByLeaf.get(leaf.id)) add('sameCategory', R.points.sameCategory * Math.min(1, interestByLeaf.get(leaf.id)), `Pidió o cotizó productos de ${leaf.name.toLowerCase()}`, 'Interés en la categoría, no en este producto', 'observado');
    // 4. Relaciones configuradas desde lo comprado o pedido.
    let best = null;
    sources.forEach(source => {
      if (source.product.id === product.id) return;
      rules.from(source.product, categoryById).filter(rule => ['complemento', 'compatible_con'].includes(rule.kind) && rules.targets(rule, product, categoryById)).forEach(rule => {
        const value = (rule.kind === 'compatible_con' ? R.points.compatible : R.points.complement) * clamp(Number(rule.strength) || 0.5, 0, 1) * source.strength * (0.5 + 0.5 * decay(daysBetween(source.date, asOf), R.relationHalfLife));
        if (!best || value > best.value) best = { value, rule, source };
      });
    });
    if (best) {
      const name = best.source.product.name;
      add(best.rule.kind === 'compatible_con' ? 'compatible' : 'complement', best.value,
        best.rule.kind === 'compatible_con' ? `Compatible con ${name}` : `Complementa ${name}`,
        best.rule.kind === 'compatible_con' ? `Regla de compatibilidad configurada${best.rule.note ? `: ${best.rule.note}` : ''} · ${best.source.how} el ${shortDate(best.source.date)}` : `Regla de complemento configurada (no garantiza compatibilidad técnica) · ${best.source.how} el ${shortDate(best.source.date)}`, 'configurado');
    }
    // 5. Reposición: regla configurada o, en reventa, historial repetido del producto.
    const reposition = sources.filter(source => source.how === 'compró').flatMap(source => rules.from(source.product, categoryById)
      .filter(rule => rule.kind === 'reposicion' && Number(rule.reposition_days) > 0 && (rules.targets(rule, product, categoryById) || (rule.source_type === 'product' && rule.source_id === product.id && rule.target_type === 'product' && rule.target_id === product.id)))
      .map(rule => ({ rule, source, days: daysBetween(source.date, asOf) })))
      .sort((a, b) => a.days - b.days)[0];
    if (reposition) {
      const cycle = Number(reposition.rule.reposition_days); const ratio = reposition.days / cycle;
      if (ratio >= 0.8) add('reposition', R.points.reposition * clamp(1 - Math.abs(1 - ratio) / 1.5, 0.3, 1), `Reposición: compró ${reposition.source.product.name} hace ${reposition.days} días`, `Ciclo configurado de ${cycle} días · ventana orientativa`, 'configurado');
    } else if (bought && reseller && bought.dates.size >= 3) {
      const dates = [...bought.dates].sort(); const gaps = dates.slice(1).map((date, index) => daysBetween(dates[index], date));
      const typical = median(gaps); const since = daysBetween(bought.lastDate, asOf);
      if (typical && since >= typical * 0.8) add('reposition', R.points.reposition * 0.8, `Lo ha comprado en ${bought.dates.size} ocasiones`, `Intervalo típico ${Math.round(typical)} días (calculado) · última hace ${since} días`, 'calculado');
    }
    // Recompra del mismo producto: solo con reposición, reventa con historial o pedido explícito.
    if (bought && !interest && !contributions.some(item => item.key === 'reposition')) { exclude(product, `Ya lo compró el ${shortDate(bought.lastDate)} y no hay regla de reposición`); return; }
    // 6. Marca presente en compras independientes.
    const brandOccasions = product.brands?.id ? (byBrand.get(product.brands.id)?.size || 0) : 0;
    if (brandOccasions >= 2 && totalOccasions >= 2) add('brand', R.points.brand * (brandOccasions / totalOccasions), `Ha comprado ${product.brands.name} en ${brandOccasions} de ${totalOccasions} compras`, 'Preferencia observada, no declarada', 'calculado');
    // 7. Patrones entre clientes (agregados del servidor, soporte mínimo).
    if (leaf) {
      const pattern = peers.filter(row => row.to_category === leaf.id && byLeaf.has(row.from_category) && Number(row.support) >= R.peers.minSupport && Number(row.both) >= 2)
        .sort((a, b) => b.both / b.support - a.both / a.support)[0];
      if (pattern) add('peers', R.points.peers * Math.min(1, (pattern.both / pattern.support) * 2), `Patrón entre clientes de la tienda`, `${pattern.both} de ${pattern.support} compradores de ${byLeaf.get(pattern.from_category)?.name || 'su categoría'} compraron también ${leaf.name.toLowerCase()} en ${pattern.window_days} días`, 'calculado');
    }
    // 8. Comercial: promoción vigente.
    if (isPromoActive(product)) add('promo', R.points.promo, 'En promoción', 'Precio promocional vigente', 'observado');
    // Penalizaciones (no aplican a reventa).
    if (leaf && !reseller && !interest && byLeaf.get(leaf.id)?.lastDate) {
      const days = daysBetween(byLeaf.get(leaf.id).lastDate, asOf);
      if (days <= R.recentSameCategoryDays && !contributions.some(item => item.key === 'reposition')) add('recentSameCategory', R.points.recentSameCategory, `Compró ${leaf.name.toLowerCase()} hace ${days} días`, 'Podría ser un sustituto de lo que ya compró', 'calculado');
    }
    const quote = priceQuote(product, variant, quantity);
    const paid = leaf ? byLeaf.get(leaf.id)?.unitCents || [] : [];
    if (paid.length >= R.minPriceSample && quote.unitCents > quantile(paid, 0.75) * 1.5) add('priceRisk', R.points.priceRisk, 'Precio por encima de lo que suele pagar en la categoría', `Pagó hasta ${Math.round(Math.max(...paid) / 100).toLocaleString('es-CO')} COP por unidad en ${leaf.name.toLowerCase()}`, 'calculado');

    const positive = contributions.filter(item => item.value > 0).sort((a, b) => b.value - a.value);
    if (!positive.length) return;
    const affinity = Math.round(clamp(contributions.reduce((sum, item) => sum + item.value, 0), 0, 100));
    const independent = new Set(positive.map(item => item.key)).size;
    let level = independent >= 3 && positive.some(item => ['explicit', 'behavior'].includes(item.key)) ? 'amplia' : independent >= 2 ? 'suficiente' : 'limitada';
    if (evidence && evidence.level === 'limitada' && level !== 'limitada') level = 'limitada';
    scored.push({
      product, variant, quantity, leaf, affinity, evidence: level, price: quote, image: productImage(product, variant?.color_id),
      reasons: positive.slice(0, 2), contributions: contributions.slice().sort((a, b) => b.value - a.value), limits: contributions.filter(item => item.value < 0),
      kind: positive[0].key === 'reposition' ? 'reposicion' : positive[0].key === 'explicit' ? 'cierre' : ['complement', 'compatible'].includes(positive[0].key) ? 'complemento' : 'siguiente_oferta'
    });
  });

  const personal = scored.filter(item => item.affinity >= R.minAffinity);
  // La diversificación elige qué mostrar; la lista se presenta ordenada por afinidad.
  let items = diversify(personal, R.maxResults).sort((x, y) => y.affinity - x.affinity);
  let fallback = false;
  if (!items.length && !purchases.length && !interests.some(entry => entry.weight > 0) && !signals.length) {
    // Sin historial: popularidad agregada (o destacados) presentada como tal.
    const popularIds = trending.map(row => row.product_id);
    const pool = [...popularIds.map(id => productById.get(id)), ...universe.filter(product => product.featured)].filter((product, index, list) => product && isEligible(product) && list.indexOf(product) === index);
    items = pool.slice(0, R.maxResults).map(product => {
      const variant = eligibleVariants(product, 1)[0];
      return { product, variant, quantity: 1, leaf: leafOf(product), affinity: null, evidence: 'general', price: priceQuote(product, variant, 1), image: productImage(product, variant?.color_id), reasons: [{ key: 'popular', text: popularIds.includes(product.id) ? 'De los más vendidos de la tienda' : 'Producto destacado del catálogo', detail: 'Recomendación general: el cliente aún no tiene historial', kind: 'calculado' }], contributions: [], limits: [], kind: 'general' };
    });
    fallback = items.length > 0;
  }
  return {
    items, fallback, exclusions: [...excluded.values()],
    stats: { version: R.version, universe: universe.length, eligible: universe.filter(product => isEligible(product)).length, scored: scored.length, shown: items.length, sources: sources.length, context, references, asOf, nextReview: addDays(asOf, 7) }
  };
}

// Rango de precio por categoría de lo que el cliente compró (mediana y dispersión).
export function categoryPriceProfile(purchases, categoryById) {
  const byLeaf = new Map();
  purchases.filter(entry => entry.keptQty > 0 && entry.product).forEach(entry => {
    const leaf = leafCategory(entry.product, categoryById); if (!leaf) return;
    const unit = Math.round(entry.keptCents / entry.keptQty);
    const item = byLeaf.get(leaf.id) || { id: leaf.id, name: leaf.name, values: [] };
    for (let k = 0; k < entry.keptQty; k += 1) item.values.push(unit);
    byLeaf.set(leaf.id, item);
  });
  return [...byLeaf.values()].map(item => ({ id: item.id, name: item.name, n: item.values.length, median: median(item.values), p25: quantile(item.values, 0.25), p75: quantile(item.values, 0.75), min: Math.min(...item.values), max: Math.max(...item.values), enough: item.values.length >= RECO_RULES.minPriceSample }))
    .sort((a, b) => b.n - a.n);
}

export const centsToUnits = cents => Math.round(cents / 100);
export { toCents };
