const CART_KEY = 'bodega_mayorista_fc_cart_v1';
const FAVORITES_KEY = 'bodega_mayorista_fc_favorites_v1';

function read(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent('store:changed', { detail: { key, value } }));
}

export const getCart = () => read(CART_KEY, []).filter(item => item && typeof item === 'object' && typeof item.variant_id === 'string' && Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0);
export const setCart = cart => write(CART_KEY, cart);
export const clearCart = () => setCart([]);
export const getFavorites = () => read(FAVORITES_KEY, []).filter(id => typeof id === 'string');
export const setFavorites = favorites => write(FAVORITES_KEY, favorites);
export const isFavorite = id => getFavorites().includes(id);

export function toggleFavorite(id) {
  const favorites = getFavorites();
  const next = favorites.includes(id) ? favorites.filter(item => item !== id) : [...favorites, id];
  setFavorites(next);
  return next.includes(id);
}

export function addCartItem(item) {
  const cart = getCart();
  const identity = candidate => String(candidate.variant_id);
  const existing = cart.find(candidate => identity(candidate) === identity(item));
  if (existing) existing.quantity = Math.min(Number(existing.stock || 99), existing.quantity + item.quantity);
  else cart.push({ ...item, line_id: crypto.randomUUID() });
  setCart(cart);
  window.dispatchEvent(new CustomEvent('cart:added', { detail: { item } }));
}

export function updateCartLine(lineId, patch) {
  setCart(getCart().map(item => item.line_id === lineId ? { ...item, ...patch } : item));
}

export function removeCartLine(lineId) { setCart(getCart().filter(item => item.line_id !== lineId)); }
export const cartCount = () => getCart().reduce((sum, item) => sum + Number(item.quantity || 0), 0);
export const cartTotal = () => getCart().reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

// Línea de carrito a partir de la selección del cliente. Conserva exactamente los campos
// del formato v1 (variant_id, quantity, price…) y agrega base_price y price_tiers, que las
// versiones anteriores simplemente ignoran.
export function buildCartItem({ product, variant, color = null, size = null, quantity = 1, image = '', price }) {
  return {
    product_id: product.id,
    variant_id: variant.id,
    name: product.name,
    slug: product.slug,
    brand: product.brands?.name || '',
    image,
    color_id: color?.id || variant.color_id || null,
    color: color?.name || null,
    size_id: size?.id || variant.size_id || null,
    size: size?.name || null,
    quantity,
    stock: Number(variant.stock || 0),
    price: Number(price),
    base_price: Number(product.base_price || price),
    price_tiers: Array.isArray(product.price_tiers) ? product.price_tiers.map(tier => ({ min_quantity: Number(tier.min_quantity), unit_price: Number(tier.unit_price) })) : []
  };
}
