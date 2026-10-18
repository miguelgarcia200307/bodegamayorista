// Piezas comunes del recomendador público y del privado: universo elegible, categoría
// más específica, relaciones configuradas por el comerciante y precio real elegible
// (variante → promoción → tramo por volumen, igual que el servidor). No conoce clientes.
import { currentPrice, isPromoActive } from './helpers.js';
import { tierFor, variantPrice } from './pricing.js';
import { median, quantile, toCents } from './metrics.js';

export const RELATION_KINDS = {
  complemento: 'Complemento',
  alternativa: 'Alternativa',
  compatible_con: 'Compatible con',
  reposicion: 'Reposición',
  excluir: 'No recomendar juntos'
};

// Un producto es elegible si está publicado, no está forzado como agotado y alguna
// variante activa cubre la cantidad pedida.
export const variantStock = (product, variant) => (product?.force_sold_out ? 0 : Math.max(0, Number(variant?.stock) || 0));
export const activeVariants = product => (product?.product_variants || []).filter(variant => variant.active !== false);
export function eligibleVariants(product, quantity = 1) {
  if (!product || product.status !== 'published' || product.force_sold_out) return [];
  return activeVariants(product).filter(variant => variantStock(product, variant) >= quantity);
}
export const isEligible = (product, quantity = 1) => eligibleVariants(product, quantity).length > 0;

// Categoría más específica (subcategoría si existe) y su padre.
export function leafCategory(product, categoryById = new Map()) {
  const list = (product?.product_categories || []).map(link => link.categories || categoryById.get(link.category_id)).filter(Boolean);
  if (!list.length) return null;
  const leaf = list.find(item => item.parent_id && !list.some(other => other.parent_id === item.id)) || list.find(item => item.parent_id) || list[0];
  return { id: leaf.id, name: leaf.name, slug: leaf.slug || '', parentId: leaf.parent_id || null, parentName: (leaf.parent_id && categoryById.get(leaf.parent_id)?.name) || '' };
}
export const categoryIdsOf = (product, categoryById) => { const leaf = leafCategory(product, categoryById); return leaf ? [leaf.id, leaf.parentId].filter(Boolean) : []; };

// Precio unitario elegible en centavos para una variante y cantidad (todas las variantes
// del mismo producto suman para el tramo, como en create_storefront_order).
export function eligibleUnitCents(product, variant, productUnits = 1) {
  const regular = variantPrice(product, variant);
  const tier = tierFor(product, productUnits);
  return toCents(tier ? Math.min(regular, tier.unit_price) : regular);
}
export function priceQuote(product, variant, quantity = 1) {
  const regularCents = toCents(variantPrice(product, variant));
  const unitCents = eligibleUnitCents(product, variant, quantity);
  const listCents = Math.max(regularCents, toCents(product.base_price));
  return { unitCents, regularCents, listCents, totalCents: unitCents * quantity, wholesale: unitCents < regularCents, promo: isPromoActive(product) && variant?.price == null };
}

// Rango de precios de referencia por categoría con el universo PUBLICADO y elegible.
export function referencePrices(products, categoryById) {
  const byLeaf = new Map();
  products.filter(product => isEligible(product)).forEach(product => {
    const leaf = leafCategory(product, categoryById); if (!leaf) return;
    byLeaf.set(leaf.id, [...(byLeaf.get(leaf.id) || []), toCents(currentPrice(product))]);
  });
  return new Map([...byLeaf].map(([id, values]) => [id, { n: values.length, median: median(values), p25: quantile(values, 0.25), p75: quantile(values, 0.75) }]));
}

// Índice de relaciones configuradas. Una regla de categoría aplica a sus productos y a
// los de sus subcategorías; una regla de producto solo a ese producto.
export function relationIndex(rules = []) {
  const active = rules.filter(rule => rule && rule.active !== false && RELATION_KINDS[rule.kind]);
  const key = (type, id) => `${type}:${id}`;
  const bySource = new Map();
  active.forEach(rule => { const k = key(rule.source_type, rule.source_id); bySource.set(k, [...(bySource.get(k) || []), rule]); });
  return {
    size: active.length,
    // Reglas cuyo origen es este producto o alguna de sus categorías.
    from(product, categoryById) {
      if (!product) return [];
      return [key('product', product.id), ...categoryIdsOf(product, categoryById).map(id => key('category', id))].flatMap(k => bySource.get(k) || []);
    },
    fromCategory(categoryId) { return bySource.get(key('category', categoryId)) || []; },
    // ¿La regla apunta a este candidato?
    targets(rule, product, categoryById) {
      if (rule.target_type === 'product') return rule.target_id === product.id;
      return categoryIdsOf(product, categoryById).includes(rule.target_id);
    }
  };
}

export function describeRuleSource(rule, { productById = new Map(), categoryById = new Map() } = {}) {
  if (rule.source_type === 'product') return productById.get(rule.source_id)?.name || 'un producto';
  return categoryById.get(rule.source_id)?.name || 'una categoría';
}

// Diversificación: penaliza repetir subcategoría y marca en la lista final.
export function diversify(items, max, { leafOf = item => item.leaf?.id, brandOf = item => item.product?.brands?.id, score = item => item.affinity } = {}) {
  const picked = []; const pool = [...items].sort((a, b) => score(b) - score(a));
  while (picked.length < max && pool.length) {
    let bestIndex = 0; let bestValue = -Infinity;
    pool.forEach((item, position) => {
      const sameLeaf = picked.filter(other => leafOf(other) && leafOf(other) === leafOf(item)).length;
      const sameBrand = picked.filter(other => brandOf(other) && brandOf(other) === brandOf(item)).length;
      const value = score(item) - 12 * sameLeaf - 4 * sameBrand;
      if (value > bestValue) { bestValue = value; bestIndex = position; }
    });
    picked.push(pool.splice(bestIndex, 1)[0]);
  }
  return picked;
}
