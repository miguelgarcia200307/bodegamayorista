// Precios de la tienda. Reproduce exactamente la regla del servidor
// (create_storefront_order, migración 202609290001):
//   precio regular = precio de la variante si existe; si no, promoción vigente o precio base.
//   tramo mayorista = el de mayor cantidad mínima alcanzada por la suma de unidades del
//   MISMO producto en el pedido (todas sus variantes cuentan).
//   precio unitario final = el menor entre el regular y el del tramo.
// El servidor siempre recalcula; el navegador solo lo muestra.
import { currentPrice } from './helpers.js';

export function variantPrice(product, variant) {
  const own = variant?.price;
  return own != null && own !== '' && Number.isFinite(Number(own)) ? Number(own) : currentPrice(product);
}

export function priceTiers(source) {
  const tiers = Array.isArray(source) ? source : source?.price_tiers;
  return (Array.isArray(tiers) ? tiers : [])
    .map(tier => ({ min_quantity: Math.round(Number(tier.min_quantity)), unit_price: Number(tier.unit_price) }))
    .filter(tier => tier.min_quantity >= 2 && tier.unit_price > 0)
    .sort((a, b) => a.min_quantity - b.min_quantity);
}

export const hasTiers = source => priceTiers(source).length > 0;

export function tierFor(source, quantity) {
  return priceTiers(source).filter(tier => quantity >= tier.min_quantity).at(-1) || null;
}

export function nextTier(source, quantity) {
  return priceTiers(source).find(tier => tier.min_quantity > quantity) || null;
}

export function bestTier(source) {
  return priceTiers(source).reduce((best, tier) => (!best || tier.unit_price < best.unit_price ? tier : best), null);
}

export function unitPriceFor(regular, source, quantity) {
  const tier = tierFor(source, quantity);
  return tier ? Math.min(Number(regular), tier.unit_price) : Number(regular);
}

// Rangos legibles para la tabla de la ficha: "1–5 u", "6–11 u", "12+ u".
export function tierRanges(source, regular) {
  const tiers = priceTiers(source);
  if (!tiers.length) return [];
  const rows = [{ from: 1, to: tiers[0].min_quantity - 1, unit: Number(regular) }];
  tiers.forEach((tier, index) => rows.push({ from: tier.min_quantity, to: tiers[index + 1] ? tiers[index + 1].min_quantity - 1 : null, unit: Math.min(Number(regular), tier.unit_price) }));
  return rows;
}

// Totales del carrito. Cada línea guarda `price` (precio regular unitario) y, desde el
// rediseño, `price_tiers` y `base_price`; las líneas antiguas sin esos campos siguen
// funcionando con el precio regular.
export function cartPricing(cart = []) {
  const unitsByProduct = cart.reduce((totals, item) => {
    const key = item.product_id || item.variant_id;
    totals.set(key, (totals.get(key) || 0) + Number(item.quantity || 0));
    return totals;
  }, new Map());
  const lines = new Map();
  let subtotal = 0; let regularTotal = 0; let listTotal = 0; let units = 0;
  cart.forEach(item => {
    const quantity = Number(item.quantity || 0);
    const regular = Number(item.price || 0);
    const productUnits = unitsByProduct.get(item.product_id || item.variant_id) || quantity;
    const tier = tierFor(item.price_tiers, productUnits);
    const unit = tier ? Math.min(regular, tier.unit_price) : regular;
    const list = Math.max(regular, Number(item.base_price || 0));
    const next = nextTier(item.price_tiers, productUnits);
    lines.set(item.line_id, { unit, regular, list, tier, next, productUnits, total: unit * quantity, wholesale: Boolean(tier && tier.unit_price < regular) });
    subtotal += unit * quantity; regularTotal += regular * quantity; listTotal += list * quantity; units += quantity;
  });
  return { lines, subtotal, units, wholesaleSavings: regularTotal - subtotal, promoSavings: listTotal - regularTotal, totalSavings: listTotal - subtotal };
}
