// Motor de recomendaciones por cliente. Calcula, para cada producto del catálogo, la
// probabilidad estimada de que le interese a partir de cinco familias de señales:
//   1. Complementos (venta cruzada): qué suele acompañar a lo que ya compró.
//   2. Ciclo de reposición: no ofrece otro celular a quien acaba de comprar uno.
//   3. Afinidad de marca y ecosistema (Apple, Samsung…), con decaimiento por antigüedad.
//   4. Perfil de precio: si suele comprar gama alta, media o económica en cada categoría.
//   5. Patrones de otros clientes (co-compra con suavizado bayesiano) y popularidad.
// Las señales se combinan en un modelo logístico y la lista final se diversifica para no
// repetir la misma categoría o marca. Todo corre en el navegador y no modifica datos.
import { currentPrice, isPromoActive, productImage } from './helpers.js';

const DAY = 86400000;
const HALF_LIFE_DAYS = 180;
const MAX_RESULTS = 6;
const MIN_PROBABILITY = 0.2;

// Ciclo típico de reposición por subcategoría (días). Dentro del ciclo, otro producto de
// la misma subcategoría es un sustituto, no una oportunidad.
const REPLACEMENT_CYCLE = {
  celulares: 540, computadores: 900, tablets: 720, smartwatches: 600, audio: 365, televisores: 1200,
  neveras: 2500, lavadoras: 2200, 'estufas-hornos': 1800, climatizacion: 1500, 'pequenos-electrodomesticos': 240, menaje: 300
};

// Complementos por subcategoría: [subcategoría sugerida, fuerza 0‑1, motivo].
const COMPLEMENTS = {
  celulares: [['audio', 0.9, 'Audífonos y parlantes para su celular'], ['smartwatches', 0.85, 'Reloj que se conecta a su celular'], ['tablets', 0.4, 'Segunda pantalla para su celular']],
  computadores: [['audio', 0.65, 'Audio para trabajar y estudiar'], ['tablets', 0.35, 'Complementa su computador'], ['celulares', 0.3, 'Completa su equipo de trabajo']],
  tablets: [['audio', 0.65, 'Audio para su tablet'], ['smartwatches', 0.35, 'Completa su ecosistema'], ['computadores', 0.3, 'Para trabajo más exigente']],
  audio: [['smartwatches', 0.45, 'Completa su equipo personal'], ['celulares', 0.35, 'Combina con su audio'], ['televisores', 0.3, 'Entretenimiento en casa']],
  smartwatches: [['audio', 0.65, 'Ideal para entrenar con su reloj'], ['celulares', 0.4, 'Se sincroniza con su reloj']],
  televisores: [['audio', 0.75, 'Mejor sonido para su televisor'], ['climatizacion', 0.25, 'Comodidad en la sala']],
  neveras: [['lavadoras', 0.7, 'Clientes que renuevan la nevera suelen renovar la lavadora'], ['estufas-hornos', 0.65, 'Completa su cocina'], ['pequenos-electrodomesticos', 0.45, 'Pequeños electrodomésticos para su cocina']],
  lavadoras: [['neveras', 0.6, 'Completa su línea blanca'], ['estufas-hornos', 0.35, 'Renueve también su cocina'], ['climatizacion', 0.3, 'Comodidad para el hogar']],
  'estufas-hornos': [['menaje', 0.85, 'Ollas y menaje para su estufa'], ['pequenos-electrodomesticos', 0.65, 'Complementa su cocina'], ['neveras', 0.45, 'Completa su cocina']],
  climatizacion: [['televisores', 0.3, 'Comodidad en casa'], ['neveras', 0.25, 'Hogar completo']],
  'pequenos-electrodomesticos': [['menaje', 0.7, 'Complementa su cocina'], ['pequenos-electrodomesticos', 0.55, 'Otro aliado para su cocina'], ['estufas-hornos', 0.35, 'Cocina completa']],
  menaje: [['pequenos-electrodomesticos', 0.7, 'Electrodomésticos para su cocina'], ['estufas-hornos', 0.4, 'Cocina completa'], ['menaje', 0.35, 'Complete su menaje']]
};

// Marcas con ecosistema: la lealtad pesa más y la conexión entre equipos es un argumento de venta.
const ECOSYSTEMS = new Set(['apple', 'samsung', 'xiaomi']);
const CONNECTED = new Set(['celulares', 'computadores', 'tablets', 'audio', 'smartwatches', 'televisores']);

// Pesos del modelo logístico.
const W = { bias: -2.35, complement: 3.1, sameLeaf: 2.0, parent: 0.7, brand: 1.35, ecosystem: 0.9, price: 1.15, peers: 1.6, promo: 0.9, popularity: 0.45, featured: 0.2, fresh: 0.15 };

const sigmoid = value => 1 / (1 + Math.exp(-value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const ageDays = (iso, today) => Math.max(0, (new Date(`${today}T12:00:00Z`) - new Date(`${iso}T12:00:00Z`)) / DAY);
const decay = days => Math.pow(0.5, days / HALF_LIFE_DAYS);
const median = values => { const list = values.filter(value => value > 0).sort((a, b) => a - b); if (!list.length) return 0; const mid = Math.floor(list.length / 2); return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2; };
const normalize = map => { const max = Math.max(0, ...map.values()); if (max > 0) map.forEach((value, key) => map.set(key, value / max)); return map; };
const add = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
// Nombre corto para los motivos: "Apple iPhone 15 128 GB Azul" → "Apple iPhone 15".
const shortName = name => String(name || '').split(/\s\d+(?:[.,]\d+)?\s?(?:GB|TB|L|kg|cm|mm|pies|")/i)[0].trim() || name;
const discountOf = product => isPromoActive(product) && Number(product.base_price) > 0 ? clamp(1 - Number(product.promo_price) / Number(product.base_price), 0, 0.9) : 0;

export function priceTier(index) {
  if (index == null) return null;
  if (index > 0.18) return { key: 'premium', label: 'Gama alta' };
  if (index < -0.18) return { key: 'value', label: 'Precio económico' };
  return { key: 'mid', label: 'Gama media' };
}

// leafOf(product) → { id, slug, name, parentId } de su subcategoría más específica.
// inStock(product) → si se puede vender hoy.
export function buildRecommendations({ index, leafOf, inStock, purchaseLines = [], interestLines = [], bought = new Set(), exclude = new Set(), storeSales = [], customerId = null, today }) {
  const products = index.products;
  const leafCache = new Map(products.map(product => [product.id, leafOf(product)]));
  const leafOfProduct = product => (product && leafCache.get(product.id)) || null;

  // Precio de referencia de cada subcategoría: mediana del catálogo publicado.
  const pricesByLeaf = new Map();
  products.forEach(product => { const leaf = leafOfProduct(product); if (leaf) pricesByLeaf.set(leaf.id, [...(pricesByLeaf.get(leaf.id) || []), currentPrice(product)]); });
  const leafPrices = new Map([...pricesByLeaf].map(([key, values]) => [key, median(values)]));

  // --- Perfil del cliente (compras pesan 1; cotizaciones y pedidos 0,45) con decaimiento.
  const leafAffinity = new Map(), parentAffinity = new Map(), brandAffinity = new Map(), brandCount = new Map(), connectedBrands = new Map();
  const ownedLeaves = new Map(); // leafId → { days, name, slug }
  const interestLeaves = new Set();
  const quotedLeaves = new Map(); // lo cotizado o pedido también sugiere complementos, con menos peso
  const priceSignals = [];
  const signals = [...purchaseLines.map(line => ({ line, weight: 1 })), ...interestLines.filter(line => line.doc?.status !== 'convertida').map(line => ({ line, weight: 0.45 }))];
  signals.forEach(({ line, weight }) => {
    const leaf = leafOfProduct(line.product); if (!leaf) return;
    const days = ageDays(line.date || today, today);
    const w = weight * decay(days) * (1 + Math.log1p(Math.max(0, line.amount || 0) / 1e6) * 0.25);
    add(leafAffinity, leaf.id, w);
    if (leaf.parentId) add(parentAffinity, leaf.parentId, w);
    const brandId = line.product?.brands?.id;
    if (brandId) {
      add(brandAffinity, brandId, w);
      if (weight === 1) add(brandCount, brandId, line.quantity || 1);
      if (weight === 1 && CONNECTED.has(leaf.slug)) add(connectedBrands, brandId, line.quantity || 1);
    }
    if (weight === 1) {
      const previous = ownedLeaves.get(leaf.id);
      if (!previous || days < previous.days) ownedLeaves.set(leaf.id, { days, name: shortName(line.product?.name || line.name), slug: leaf.slug });
    } else {
      interestLeaves.add(leaf.id);
      const previous = quotedLeaves.get(leaf.id);
      if (!previous || days < previous.days) quotedLeaves.set(leaf.id, { days, name: shortName(line.product?.name || line.name), slug: leaf.slug });
    }
    const unit = line.quantity ? line.amount / line.quantity : line.unitPrice;
    const reference = leafPrices.get(leaf.id);
    if (unit > 0 && reference > 0) priceSignals.push({ value: Math.log(unit / reference), weight: w });
  });
  normalize(leafAffinity); normalize(parentAffinity); normalize(brandAffinity);
  const priceWeight = priceSignals.reduce((sum, item) => sum + item.weight, 0);
  const premiumIndex = priceWeight ? priceSignals.reduce((sum, item) => sum + item.value * item.weight, 0) / priceWeight : null;
  const maxPaid = Math.max(0, ...purchaseLines.map(line => line.quantity ? line.amount / line.quantity : 0), ...interestLines.map(line => line.unitPrice || 0));
  const evidence = purchaseLines.length + interestLines.length * 0.5;
  const confidence = 1 - Math.exp(-evidence / 2.5);

  // --- Patrones de la tienda: co-compra entre subcategorías y popularidad por producto.
  const baskets = new Map(); const sold = new Map(); const leafBuyers = new Map();
  storeSales.filter(sale => ['confirmada', 'pagada', 'entregada'].includes(sale.status) && sale.customer_id).forEach(sale => {
    const basket = baskets.get(sale.customer_id) || new Set();
    (sale.sale_items || []).forEach(item => {
      const product = index.productById.get(item.product_id) || index.variantToProduct.get(item.variant_id);
      const leaf = leafOfProduct(product); if (!leaf) return;
      basket.add(leaf.id);
      const days = ageDays((sale.confirmed_at || sale.created_at || '').slice(0, 10) || today, today);
      if (days <= 120) add(sold, product.id, Number(item.quantity) || 1);
    });
    baskets.set(sale.customer_id, basket);
  });
  baskets.forEach((basket, owner) => { if (owner !== customerId) basket.forEach(leaf => add(leafBuyers, leaf, 1)); });
  const otherCustomers = [...baskets.keys()].filter(owner => owner !== customerId).length;
  // P(compra la subcategoría B | compró A), suavizada hacia la tasa base con α = 4.
  const peerRate = (fromLeaf, toLeaf) => {
    let both = 0, from = 0;
    baskets.forEach((basket, owner) => { if (owner === customerId || !basket.has(fromLeaf)) return; from += 1; if (basket.has(toLeaf)) both += 1; });
    const base = otherCustomers ? (leafBuyers.get(toLeaf) || 0) / otherCustomers : 0;
    return { rate: (both + 4 * base) / (from + 4), lift: base ? ((both + 4 * base) / (from + 4)) / base : 1, support: from, both };
  };
  const maxSold = Math.max(1, ...sold.values());
  const recentCutoff = Date.now() - 30 * DAY;

  // --- Puntuación de cada candidato.
  const candidates = products.filter(product => inStock(product) && !bought.has(product.id) && !exclude.has(product.id)).map(product => {
    const leaf = leafOfProduct(product);
    const price = currentPrice(product);
    const brand = product.brands || {};
    const reasons = [];

    // 1. Complemento: mejor relación entre lo que tiene y esta subcategoría.
    let complement = 0, complementReason = null;
    const sources = [...[...ownedLeaves].map(([id, item]) => [id, item, 1]), ...[...quotedLeaves].filter(([id]) => !ownedLeaves.has(id)).map(([id, item]) => [id, item, 0.7])];
    sources.forEach(([ownedLeaf, owned, strength]) => {
      const rule = (COMPLEMENTS[owned.slug] || []).find(([slug]) => slug === leaf?.slug);
      if (!rule || ownedLeaf === leaf?.id) return;
      const recency = owned.days <= 45 ? 1 : decay(owned.days - 45);
      const value = strength * rule[1] * (0.55 + 0.45 * (leafAffinity.get(ownedLeaf) || 0)) * (0.6 + 0.4 * recency);
      if (value > complement) { complement = value; complementReason = { text: strength === 1 ? `Complementa su ${owned.name}` : `Complementa el ${owned.name} que cotizó`, detail: rule[2], days: owned.days }; }
    });
    if (complementReason) reasons.push({ weight: W.complement * complement, text: complementReason.text, detail: complementReason.detail });

    // 2. Misma subcategoría: interés si la cotizó; saturación si ya la compró dentro del ciclo.
    let sameLeaf = leaf ? (leafAffinity.get(leaf.id) || 0) : 0;
    const owned = leaf ? ownedLeaves.get(leaf.id) : null;
    if (owned) {
      const cycle = REPLACEMENT_CYCLE[leaf.slug] || 540;
      const saturation = clamp(1 - owned.days / cycle, 0, 1);
      // Ya cubrió esa necesidad: el complemento pierde fuerza mientras dure el ciclo.
      if (leaf.slug !== 'menaje' && leaf.slug !== 'pequenos-electrodomesticos') complement *= 1 - saturation;
      if (complement < 0.05 && complementReason) { reasons.splice(reasons.findIndex(item => item.text === complementReason.text), 1); complementReason = null; }
      sameLeaf = sameLeaf * (1 - saturation) - 1.1 * saturation;
      if (saturation < 0.25) reasons.push({ weight: W.sameLeaf * Math.max(0.3, sameLeaf), text: 'Buen momento para renovar', detail: `Compró ${leaf.name.toLowerCase()} hace ${Math.round(owned.days / 30)} meses` });
    } else if (leaf && interestLeaves.has(leaf.id) && sameLeaf > 0) {
      reasons.push({ weight: W.sameLeaf * sameLeaf, text: `Ha mostrado interés en ${leaf.name.toLowerCase()}`, detail: 'Lo cotizó o pidió sin comprarlo' });
    }
    const parent = leaf?.parentId && !owned ? (parentAffinity.get(leaf.parentId) || 0) * 0.6 : 0;

    // 3. Marca y ecosistema.
    const brandScore = brandAffinity.get(brand.id) || 0;
    const brandSlug = String(brand.slug || brand.name || '').toLowerCase();
    const connectedOwned = connectedBrands.get(brand.id) || 0;
    const ecosystem = brandScore && connectedOwned && ECOSYSTEMS.has(brandSlug) && CONNECTED.has(leaf?.slug) && (complement > 0 || !owned) ? brandScore : 0;
    if (ecosystem) reasons.push({ weight: W.brand * brandScore + W.ecosystem * ecosystem, text: `Ecosistema ${brand.name}`, detail: `Ya tiene ${connectedOwned} equipo${connectedOwned === 1 ? '' : 's'} ${brand.name}: se conectan entre sí` });
    else if (brandScore > 0.35) reasons.push({ weight: W.brand * brandScore, text: `Marca que prefiere: ${brand.name}`, detail: 'Presente en sus compras' });

    // 4. Perfil de precio dentro de la subcategoría y capacidad de pago.
    const reference = leaf ? leafPrices.get(leaf.id) : 0;
    let priceFit = 0.5;
    if (premiumIndex != null && reference > 0 && price > 0) {
      const position = Math.log(price / reference);
      priceFit = Math.exp(-((position - premiumIndex) ** 2) / (2 * 0.5 ** 2));
      const tier = priceTier(position);
      if (priceFit > 0.7) reasons.push({ weight: W.price * priceFit, text: 'Encaja en su perfil de precio', detail: `${tier.label}, como lo que suele comprar` });
    }
    if (maxPaid > 0 && price > maxPaid * 1.6) priceFit -= clamp(Math.log(price / (maxPaid * 1.6)), 0, 1.2);

    // 5. Patrones de otros clientes.
    let peers = 0;
    if (leaf && otherCustomers >= 3) {
      ownedLeaves.forEach((_, ownedLeaf) => {
        if (ownedLeaf === leaf.id) return;
        const stat = peerRate(ownedLeaf, leaf.id);
        const value = clamp(Math.log(stat.lift), 0, 1.2) * (stat.support / (stat.support + 3));
        if (value > peers) { peers = value; if (stat.both >= 2) reasons.push({ weight: W.peers * value, text: `${Math.round(stat.rate * 100)} % de clientes similares la compran`, detail: `Patrón observado en ${stat.support} clientes de la tienda` }); }
      });
    }

    // Comerciales: promoción, popularidad, destacado, novedad.
    const discount = discountOf(product);
    const promo = clamp(discount / 0.3, 0, 1.2);
    if (discount >= 0.08) reasons.push({ weight: W.promo * promo, text: `En promoción: −${Math.round(discount * 100)} %`, detail: 'Argumento de cierre inmediato' });
    const popularity = Math.log1p(sold.get(product.id) || 0) / Math.log1p(maxSold);
    if (popularity > 0.6) reasons.push({ weight: W.popularity * popularity, text: 'De los más vendidos de la tienda', detail: 'Alta rotación en los últimos 4 meses' });
    const fresh = product.created_at && new Date(product.created_at).getTime() > recentCutoff ? 1 : 0;

    const personal = W.complement * complement + W.sameLeaf * sameLeaf + W.parent * parent + W.brand * brandScore + W.ecosystem * ecosystem + W.price * (priceFit - 0.5) + W.peers * peers;
    const commercial = W.promo * promo + W.popularity * popularity + W.featured * (product.featured ? 1 : 0) + W.fresh * fresh;
    // Con poco historial, lo personal pesa menos y la probabilidad se acerca a la base comercial.
    const z = W.bias + personal * (0.35 + 0.65 * confidence) + commercial;
    // Sin ninguna afinidad real (solo precio o promoción) no es una recomendación personal.
    const affinity = complement > 0 || sameLeaf > 0.15 || parent > 0.2 || brandScore > 0.35 || peers > 0;
    const probability = clamp(sigmoid(z) * (affinity || !evidence ? 1 : 0.55), 0.03, 0.96);
    if (!reasons.length) reasons.push({ weight: 0, text: 'Producto destacado del catálogo', detail: 'Buena opción para presentarle la tienda' });
    reasons.sort((a, b) => b.weight - a.weight);
    return {
      product, leaf, price, promo: isPromoActive(product), discount, image: productImage(product), probability,
      tier: probability >= 0.6 ? 'alta' : probability >= 0.35 ? 'media' : 'exploratoria',
      reasons: reasons.slice(0, 3), personal, complement: complement > 0
    };
  }).filter(item => item.probability >= MIN_PROBABILITY || !purchaseLines.length);

  // --- Diversificación (MMR): penaliza repetir subcategoría y marca en la lista final.
  const picked = []; const pool = [...candidates].sort((a, b) => b.probability - a.probability);
  while (picked.length < MAX_RESULTS && pool.length) {
    let bestIndex = 0, bestValue = -Infinity;
    pool.forEach((item, position) => {
      const sameLeaf = picked.filter(other => other.leaf?.id && other.leaf.id === item.leaf?.id).length;
      const sameBrand = picked.filter(other => other.product.brands?.id && other.product.brands.id === item.product.brands?.id).length;
      const value = item.probability - 0.11 * sameLeaf - 0.04 * sameBrand;
      if (value > bestValue) { bestValue = value; bestIndex = position; }
    });
    picked.push(pool.splice(bestIndex, 1)[0]);
  }
  picked.sort((a, b) => b.probability - a.probability);

  const topLeaves = [...leafAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => index.categoryById.get(id)?.name).filter(Boolean);
  const topBrand = [...brandAffinity.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    items: picked,
    stats: {
      evaluated: products.length, eligible: candidates.length, purchases: purchaseLines.length, interest: interestLines.length,
      peers: otherCustomers, confidence, premiumIndex, tier: priceTier(premiumIndex), topLeaves,
      topBrand: topBrand ? products.find(product => product.brands?.id === topBrand[0])?.brands?.name : null,
      owned: [...ownedLeaves.values()].map(item => item.name)
    }
  };
}
