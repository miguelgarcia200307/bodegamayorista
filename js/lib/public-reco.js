// Recomendación pública. Solo recibe catálogo y reglas de relación: nunca perfiles,
// compras, segmentos ni datos de otros compradores. Devuelve un DTO { product, reason }.
// Objetivos distintos por contexto:
//   · Ficha: alternativas para comparar y complementos, en bloques separados.
//   · Carrito: complementos de TODO el contenido, sin ofrecer sustitutos de lo elegido.
//   · Inicio: continuidad (vistos, con autorización) o tendencias agregadas / destacados.
import { currentPrice } from './helpers.js';
import { isEligible, leafCategory, relationIndex } from './reco-core.js';

const MAX = 8;
const dto = (product, reason) => ({ product, reason });
const categoryMap = (categories, products) => {
  const map = new Map(categories.map(category => [category.id, category]));
  products.forEach(product => (product.product_categories || []).forEach(link => { if (link.categories && !map.has(link.categories.id)) map.set(link.categories.id, link.categories); }));
  return map;
};

function complementsFor(sources, { products, categoryById, rules, exclude }) {
  const scores = new Map();
  sources.forEach(({ product: source, weight }) => {
    const fromRules = rules.from(source, categoryById);
    const blocked = fromRules.filter(rule => rule.kind === 'excluir');
    products.forEach(candidate => {
      if (exclude.has(candidate.id) || !isEligible(candidate)) return;
      if (blocked.some(rule => rules.targets(rule, candidate, categoryById))) { exclude.add(candidate.id); scores.delete(candidate.id); return; }
      fromRules.filter(rule => ['complemento', 'compatible_con'].includes(rule.kind) && rules.targets(rule, candidate, categoryById)).forEach(rule => {
        const value = weight * (Number(rule.strength) || 0.5) * (rule.kind === 'compatible_con' ? 1.2 : 1);
        const prev = scores.get(candidate.id);
        // Motivo público prudente: "compatible" solo con regla explícita compatible_con.
        const reason = rule.kind === 'compatible_con' ? `Compatible con ${source.name}` : `Complementa ${source.name}`;
        if (!prev || value > prev.value) scores.set(candidate.id, { product: candidate, value, reason });
      });
    });
  });
  return [...scores.values()].sort((a, b) => b.value - a.value);
}

export function recommendForProduct(product, { products = [], categories = [], relationships = [] } = {}) {
  const categoryById = categoryMap(categories, products);
  const rules = relationIndex(relationships);
  const leaf = leafCategory(product, categoryById);
  const price = currentPrice(product);
  const exclude = new Set([product.id]);
  const complements = complementsFor([{ product, weight: 1 }], { products, categoryById, rules, exclude }).slice(0, MAX).map(item => dto(item.product, item.reason));
  complements.forEach(item => exclude.add(item.product.id));
  const explicitAlternatives = new Set(rules.from(product, categoryById).filter(rule => rule.kind === 'alternativa').flatMap(rule => products.filter(candidate => rules.targets(rule, candidate, categoryById)).map(candidate => candidate.id)));
  const alternatives = products.filter(candidate => !exclude.has(candidate.id) && isEligible(candidate) && (explicitAlternatives.has(candidate.id) || (leaf && leafCategory(candidate, categoryById)?.id === leaf.id)))
    .map(candidate => ({ candidate, closeness: Math.abs(Math.log((currentPrice(candidate) || 1) / (price || 1))) - (explicitAlternatives.has(candidate.id) ? 10 : 0) }))
    .filter(item => item.closeness <= 0.5 || explicitAlternatives.has(item.candidate.id))
    .sort((a, b) => a.closeness - b.closeness).slice(0, MAX)
    .map(({ candidate }) => dto(candidate, explicitAlternatives.has(candidate.id) ? 'Alternativa sugerida por la tienda' : `Otra opción de ${leaf?.name?.toLowerCase() || 'la categoría'} en un precio similar`));
  return { complements, alternatives };
}

// cart: [{ product_id, quantity, price }]; el peso de cada artículo es su valor en el carrito.
export function recommendForCart(cart = [], { products = [], categories = [], relationships = [] } = {}) {
  const categoryById = categoryMap(categories, products);
  const rules = relationIndex(relationships);
  const byId = new Map(products.map(product => [product.id, product]));
  const inCart = cart.map(item => ({ product: byId.get(item.product_id), weight: Math.max(1, Number(item.quantity) || 1) * Math.max(1, Number(item.price) || currentPrice(byId.get(item.product_id) || {}) || 1) })).filter(item => item.product);
  if (!inCart.length) return [];
  const max = Math.max(...inCart.map(item => item.weight));
  const exclude = new Set(inCart.map(item => item.product.id));
  // Sustitutos: misma subcategoría que algo del carrito, salvo regla explícita entre ellos.
  const cartLeaves = new Set(inCart.map(item => leafCategory(item.product, categoryById)?.id).filter(Boolean));
  const ranked = complementsFor(inCart.map(item => ({ product: item.product, weight: 0.5 + 0.5 * (item.weight / max) })), { products, categoryById, rules, exclude });
  return ranked.filter(item => {
    const leaf = leafCategory(item.product, categoryById)?.id;
    if (!leaf || !cartLeaves.has(leaf)) return true;
    return inCart.some(source => rules.from(source.product, categoryById).some(rule => ['complemento', 'compatible_con'].includes(rule.kind) && rule.target_type === 'product' && rule.target_id === item.product.id));
  }).slice(0, MAX).map(item => dto(item.product, item.reason));
}

// Inicio: continuidad con autorización de personalización; si no, tendencias agregadas
// (o destacados) presentadas como tales.
export function recommendForHome({ products = [], recentIds = [], personalization = false, trendingIds = [] } = {}) {
  const byId = new Map(products.map(product => [product.id, product]));
  if (personalization && recentIds.length) {
    const items = recentIds.map(id => byId.get(id)).filter(product => product && isEligible(product)).slice(0, MAX);
    if (items.length) return { kind: 'continuidad', title: 'Continúa donde lo dejaste', items: items.map(product => dto(product, 'Lo viste recientemente')) };
  }
  const trending = trendingIds.map(id => byId.get(id)).filter(product => product && isEligible(product));
  if (trending.length) return { kind: 'tendencia', title: 'Lo más pedido en la tienda', items: trending.slice(0, MAX).map(product => dto(product, 'Tendencia de la tienda')) };
  return { kind: 'destacados', title: 'Destacados', items: products.filter(product => product.featured && isEligible(product)).slice(0, MAX).map(product => dto(product, 'Destacado')) };
}
