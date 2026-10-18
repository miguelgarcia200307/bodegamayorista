// Datos 100 % ficticios para pruebas y demostración del recorrido CRM. No contienen datos
// reales de clientes ni del negocio. Fecha de evaluación fija para resultados repetibles.
export const ASOF = '2026-10-14';
const now = '2026-01-01T00:00:00Z';
export const categories = [
  { id: 'c-tec', name: 'Tecnología', slug: 'tecnologia', parent_id: null },
  { id: 'c-cel', name: 'Celulares', slug: 'celulares', parent_id: 'c-tec' },
  { id: 'c-aud', name: 'Audio', slug: 'audio', parent_id: 'c-tec' },
  { id: 'c-acc', name: 'Accesorios', slug: 'accesorios', parent_id: 'c-tec' },
  { id: 'c-con', name: 'Consumibles', slug: 'consumibles', parent_id: null },
  { id: 'c-cab', name: 'Cables', slug: 'cables', parent_id: 'c-tec' }
];
const cat = id => categories.find(item => item.id === id);
const brand = { id: 'b-demo', name: 'Marca Demo', slug: 'marca-demo' };
const variant = (productId, n, stock, extra = {}) => ({ id: `${productId}-v${n}`, product_id: productId, stock, active: true, price: null, option_values: {}, ...extra });
const product = (id, name, price, categoryId, variants, extra = {}) => ({
  id, name, slug: id, sku: null, base_price: price, promo_price: null, promo_enabled: true, promo_start: null, promo_end: null,
  status: 'published', force_sold_out: false, featured: false, brand_id: brand.id, brands: brand, created_at: now,
  product_categories: [{ category_id: categoryId, categories: cat(categoryId) }], product_images: [], price_tiers: [],
  product_variants: variants, ...extra
});
export const products = [
  product('p-cel', 'Celular Demo X', 1000000, 'c-cel', [variant('p-cel', 1, 5, { option_values: { Color: 'Negro', Capacidad: '128 GB' } }), variant('p-cel', 2, 0, { option_values: { Color: 'Negro', Capacidad: '256 GB' } }), variant('p-cel', 3, 2, { price: 1100000, option_values: { Color: 'Azul', Capacidad: '256 GB' } })], { promo_price: 900000 }),
  product('p-aud', 'Audífonos Demo', 200000, 'c-aud', [variant('p-aud', 1, 50)]),
  product('p-par', 'Parlante Demo', 150000, 'c-aud', [variant('p-par', 1, 10)]),
  product('p-funda', 'Funda Demo para Celular X', 40000, 'c-acc', [variant('p-funda', 1, 20)]),
  product('p-excluido', 'Cargador genérico demo', 30000, 'c-acc', [variant('p-excluido', 1, 5)]),
  product('p-cart', 'Cartucho de tinta demo', 30000, 'c-con', [variant('p-cart', 1, 50)]),
  product('p-cable', 'Cable USB-C demo', 25000, 'c-cab', [variant('p-cable', 1, 100)], { price_tiers: [{ min_quantity: 6, unit_price: 22000 }, { min_quantity: 12, unit_price: 19000 }] }),
  product('p-draft', 'Producto en borrador', 9000000, 'c-cel', [variant('p-draft', 1, 3)], { status: 'draft' })
];
// Reglas que el comerciante configuraría en "Relaciones de productos".
export const relationships = [
  { id: 'r1', source_type: 'category', source_id: 'c-cel', target_type: 'category', target_id: 'c-aud', kind: 'complemento', strength: 0.9, active: true },
  { id: 'r2', source_type: 'product', source_id: 'p-cel', target_type: 'product', target_id: 'p-funda', kind: 'compatible_con', strength: 1, note: 'Funda diseñada para Celular Demo X', active: true },
  { id: 'r3', source_type: 'product', source_id: 'p-cel', target_type: 'product', target_id: 'p-excluido', kind: 'excluir', strength: 1, active: true },
  { id: 'r4', source_type: 'product', source_id: 'p-cart', target_type: 'product', target_id: 'p-cart', kind: 'reposicion', strength: 1, reposition_days: 60, active: true }
];

const productOf = id => products.find(item => item.id === id);
const lineItems = (prefix, docId, lines) => lines.map(([productId, qty, unit, variantId], index) => ({
  id: `${docId}-i${index}`, line_no: index + 1, product_id: productId, variant_id: variantId || productOf(productId)?.product_variants[0].id || `${productId}-v1`,
  product_name: productOf(productId)?.name || `Producto retirado (${productId})`, sku: null, option_snapshot: {}, quantity: qty, unit_price: unit, discount: 0, line_total: qty * unit
}));
const stamp = (date, at) => at || `${date}T15:00:00Z`;

export function sale({ id, customer = 'C1', status = 'confirmada', confirmed = true, date = ASOF, at = null, lines = [], returns = [], sourceOrder = null, sourceQuote = null, delivery = 0 }) {
  const items = lineItems('s', id, lines);
  const total = items.reduce((sum, item) => sum + item.line_total, 0) + delivery;
  return {
    id, sale_number: `CV-DEMO-${id}`, customer_id: customer, status, created_at: stamp(date, at), confirmed_at: confirmed ? stamp(date, at) : null, stock_applied_at: confirmed ? stamp(date, at) : null,
    source_order_id: sourceOrder, source_quote_id: sourceQuote, subtotal: total - delivery, discount_total: 0, delivery_cost: delivery, total,
    sale_items: items, sale_returns: returns.map(([index, qty, when], k) => ({ id: `${id}-r${k}`, sale_item_id: items[index].id, quantity: qty, created_at: `${when}T16:00:00Z`, restocked: true }))
  };
}
export function quote({ id, customer = 'C1', status = 'enviada', date = ASOF, sent = null, valid = '2026-12-31', lines = [], converted = null }) {
  const items = lineItems('q', id, lines);
  const total = items.reduce((sum, item) => sum + item.line_total, 0);
  return { id, quote_number: `COT-DEMO-${id}`, customer_id: customer, status, created_at: stamp(date), sent_at: sent ? stamp(sent) : (status === 'enviada' ? stamp(date) : null), valid_until: valid, converted_sale_id: converted, subtotal: total, discount_total: 0, delivery_cost: 0, total, quote_items: items };
}
export function order({ id, customer = 'C1', status = 'pendiente', date = ASOF, lines = [], source = 'tienda' }) {
  const items = lineItems('o', id, lines);
  const total = items.reduce((sum, item) => sum + item.line_total, 0);
  return { id, order_number: `PED-DEMO-${id}`, customer_id: customer, status, source, created_at: stamp(date), subtotal: total, delivery_cost: 0, total, order_items: items, sales: [] };
}

// Recorrido de demostración: "Laura Demo" compró un celular, volvió a ver audífonos en dos
// sesiones (autorizadas y verificadas) y tiene una cotización enviada.
export const demoCustomer = { id: 'C1', full_name: 'Laura Demo', phone_original: '300 000 0001', phone_normalized: '+573000000001', city: 'Ciudad Demo', source: 'tienda', created_at: '2026-05-01T12:00:00Z', customer_consents: [{ purpose: 'marketing_birthday', granted: true, text_version: 'demo-1', source: 'checkout', recorded_at: '2026-05-01T12:00:00Z' }], birthday_contacts: [] };
export const demoHistory = {
  sales: [sale({ id: 'd1', date: '2026-06-02', lines: [['p-cel', 1, 900000]] }), sale({ id: 'd2', date: '2026-08-20', lines: [['p-cart', 2, 30000]] })],
  quotes: [quote({ id: 'dq', status: 'enviada', date: '2026-10-08', lines: [['p-par', 1, 150000]] })],
  orders: []
};
export const demoSignals = [{ product_id: 'p-aud', variant_id: 'p-aud-v1', product_name: 'Audífonos Demo', sessions: 2, last_seen: '2026-10-12T20:00:00Z', favorite: false, cart_qty: 1, identity_level: 'verificada' }];
