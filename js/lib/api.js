import { supabase } from './supabase.js';
import { currentPrice, discountPercent, normalizeText } from './helpers.js';

const PRODUCT_SELECT = `
  *,
  brands(id,name,slug,logo_url),
  product_categories(category_id,categories(id,name,slug,parent_id)),
  product_colors(id,name,hex_code,sort_order),
  product_sizes(id,name,sort_order),
  product_variants(id,color_id,size_id,stock,active,updated_at,price),
  product_images(id,color_id,url,alt_text,is_primary,sort_order)
`;

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Tramos de precio por volumen (tabla product_price_tiers, migración 202609290001).
// La migración agrega site_settings.price_tiers_enabled. Mientras no esté aplicada esa
// columna no existe y la tienda NO consulta la tabla (cero peticiones, cero 404) y
// funciona exactamente igual que antes. Tras aplicarla se activa sola.
let priceTiersAvailable = true;
let tiersFeaturePromise;
const isMissingRelation = error => ['PGRST205', 'PGRST200', '42P01'].includes(error?.code) || Number(error?.status) === 404 || /does not exist|could not find the table|schema cache/i.test(error?.message || '');

function priceTiersEnabled() {
  tiersFeaturePromise ??= import('../site-config.js')
    .then(module => module.loadSettings())
    .then(settings => settings?.price_tiers_enabled === true)
    .catch(() => false);
  return tiersFeaturePromise.then(enabled => enabled && priceTiersAvailable);
}

export async function attachPriceTiers(products) {
  const list = (Array.isArray(products) ? products : [products]).filter(Boolean);
  list.forEach(product => { if (!Array.isArray(product.price_tiers)) product.price_tiers = []; });
  if (!list.length || !(await priceTiersEnabled())) return products;
  const ids = [...new Set(list.map(product => product.id))];
  const byProduct = new Map();
  for (let start = 0; start < ids.length; start += 150) {
    const { data, error } = await supabase.from('product_price_tiers').select('product_id,min_quantity,unit_price').in('product_id', ids.slice(start, start + 150)).order('min_quantity');
    if (error) {
      if (isMissingRelation(error)) priceTiersAvailable = false;
      return products;
    }
    (data || []).forEach(tier => byProduct.set(tier.product_id, [...(byProduct.get(tier.product_id) || []), tier]));
  }
  list.forEach(product => { product.price_tiers = byProduct.get(product.id) || []; });
  return products;
}

// Guarda los tramos de un producto de forma atómica (solo administradores).
export async function saveProductPriceTiers(productId, tiers) {
  return unwrap(await supabase.rpc('save_product_price_tiers', { target_product: productId, tiers }));
}

export const priceTiersSupported = () => priceTiersEnabled();

// Ids de productos con tramos por volumen (vacío mientras la migración no esté aplicada).
export async function getWholesaleProductIds() {
  if (!(await priceTiersEnabled())) return [];
  const { data, error } = await supabase.from('product_price_tiers').select('product_id').limit(1000);
  if (error) { if (isMissingRelation(error)) priceTiersAvailable = false; return []; }
  return [...new Set((data || []).map(row => row.product_id))];
}

export function storageUploadMessage(error) {
  const message = String(error?.message || error?.error || '').toLowerCase();
  const status = Number(error?.statusCode || error?.status || 0);
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /failed to fetch|network|timeout|aborted|fetch/.test(message)) return 'La conexión se interrumpió durante la carga. Revisa tu internet y pulsa Reintentar.';
  if (status === 401 || status === 403 || /unauthorized|forbidden|row-level security|permission|jwt/.test(message)) return 'Tu sesión no tiene permiso para subir imágenes. Inicia sesión nuevamente e inténtalo otra vez.';
  if (status === 413 || /too large|maximum allowed|file size|payload/.test(message)) return 'La fotografía supera el límite de Storage incluso después de optimizarse.';
  if (status === 404 || /bucket not found|not found/.test(message)) return 'El almacenamiento de fotografías no está disponible en este momento.';
  if (status >= 500 || /storage|database/.test(message)) return 'El almacenamiento no respondió correctamente. Espera un momento y pulsa Reintentar.';
  return 'No pudimos subir esta fotografía. Puedes pulsar Reintentar sin volver a seleccionarla.';
}

export async function getSettings() {
  return unwrap(await supabase.from('site_settings').select('*').eq('id', 1).single());
}

export async function getHomepageBanners({ all = false } = {}) {
  let query = supabase.from('homepage_banners')
    .select('id,desktop_image_url,mobile_image_url,alt_text,link_url,active,sort_order')
    .order('sort_order').order('id');
  if (!all) query = query.eq('active', true);
  return unwrap(await query);
}

export async function saveHomepageBanners(enabled, intervalSeconds, banners) {
  return unwrap(await supabase.rpc('save_homepage_banners', {
    new_enabled: Boolean(enabled), new_interval: Number(intervalSeconds),
    new_banners: banners
  }));
}

export async function uploadBannerImage(file) {
  const extension = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/avif': 'avif' }[file.type];
  if (!extension || file.size > 1048576) throw new Error('La imagen optimizada debe pesar menos de 1 MB.');
  const path = `home/${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from('banner-images').upload(path, file, {
    contentType: file.type, cacheControl: '31536000', upsert: false
  }));
  return supabase.storage.from('banner-images').getPublicUrl(path).data.publicUrl;
}

export async function removeBannerImage(assetUrl) {
  if (!/^https:\/\//i.test(assetUrl || '')) return false;
  let url;
  try { url = new URL(assetUrl); } catch { return false; }
  if (url.origin !== new URL(supabase.supabaseUrl).origin) return false;
  const marker = '/storage/v1/object/public/banner-images/';
  const position = url.pathname.indexOf(marker);
  if (position < 0) return false;
  const path = decodeURIComponent(url.pathname.slice(position + marker.length));
  if (!/^home\/[0-9a-f-]+\.(?:webp|jpg|jpeg|png|avif)$/.test(path)) return false;
  unwrap(await supabase.storage.from('banner-images').remove([path]));
  return true;
}

export async function getCategories({ all = false } = {}) {
  let query = supabase.from('categories').select('*').order('sort_order').order('name');
  if (!all) query = query.eq('active', true);
  return unwrap(await query);
}

export async function getBrands({ all = false } = {}) {
  let query = supabase.from('brands').select('*').order('name');
  if (!all) query = query.eq('active', true);
  return unwrap(await query);
}

export async function getPaymentMethods({ all = false } = {}) {
  let query = supabase.from('payment_methods').select('*').order('sort_order').order('name');
  if (!all) query = query.eq('active', true);
  return unwrap(await query);
}

export async function getDeliveryMethods({ all = false } = {}) {
  let query = supabase.from('delivery_methods').select('*').order('sort_order').order('name');
  if (!all) query = query.eq('active', true);
  return unwrap(await query);
}

export async function createStorefrontOrder(payload, requestKey) {
  return unwrap(await supabase.rpc('create_storefront_order', { payload, request_key: requestKey }));
}

// Solo registra que el navegador preparó el enlace de WhatsApp; no prueba el envío.
export async function markOrderWhatsappOpened(requestKey) {
  return unwrap(await supabase.rpc('mark_order_whatsapp_opened', { request_key: requestKey }));
}

const CUSTOMER_REF = 'customers(id,full_name,phone_original,phone_normalized,city,address,birth_date,archived_at)';

export async function getCustomers({ archived = false } = {}) {
  let query = supabase.from('customers').select('*,customer_consents(*),birthday_contacts(*)').is('merged_into', null).order('updated_at', { ascending: false });
  query = archived ? query.not('archived_at', 'is', null) : query.is('archived_at', null);
  return unwrap(await query);
}

// Mismo detalle que los listados (líneas, devoluciones y cliente) para analizar qué compra
// el cliente y abrir, descargar o imprimir cada documento desde su ficha.
export async function getCustomerHistory(customerId) {
  const [orders, quotes, sales] = await Promise.all([
    supabase.from('orders').select(`*,${CUSTOMER_REF},order_items(*),sales(id,sale_number,status)`).eq('customer_id', customerId).order('created_at', { ascending: false }),
    supabase.from('quotes').select(`*,${CUSTOMER_REF},quote_items(*)`).eq('customer_id', customerId).order('created_at', { ascending: false }),
    supabase.from('sales').select(`*,${CUSTOMER_REF},sale_items(*),sale_returns(*)`).eq('customer_id', customerId).order('created_at', { ascending: false })
  ]);
  return { orders: unwrap(orders), quotes: unwrap(quotes), sales: unwrap(sales) };
}

// phone_normalized lo calcula siempre la base de datos a partir de phone_original.
export async function saveCustomer(values, id = null) {
  const { phone_normalized, ...clean } = values;
  return saveRow('customers', clean, id);
}

export async function recordConsent(customerId, purpose, granted, textVersion, source = 'admin') {
  return unwrap(await supabase.from('customer_consents').insert({ customer_id: customerId, purpose, granted, text_version: textVersion || 'pendiente', source }).select().single());
}

export async function saveBirthdayContact(values, id = null) { return saveRow('birthday_contacts', values, id); }
export async function mergeCustomers(keepId, duplicateId) { return unwrap(await supabase.rpc('merge_customers', { keep_customer: keepId, duplicate_customer: duplicateId })); }

export async function getOrders() {
  return unwrap(await supabase.from('orders').select(`*,${CUSTOMER_REF},order_items(*),sales(id,sale_number,status)`).order('created_at', { ascending: false }));
}
export async function updateOrder(id, values) { return unwrap(await supabase.from('orders').update(values).eq('id', id).select().single()); }
export async function createAdminOrder(payload) { return unwrap(await supabase.rpc('create_admin_order', { payload })); }

export async function getQuotes() {
  return unwrap(await supabase.from('quotes').select(`*,${CUSTOMER_REF},quote_items(*)`).order('created_at', { ascending: false }));
}
export async function saveAdminQuote(id, payload) { return unwrap(await supabase.rpc('save_admin_quote', { target_quote: id, payload })); }
export async function setQuoteStatus(id, status) { return unwrap(await supabase.rpc('set_quote_status', { target_quote: id, new_status: status })); }
export async function deleteAdminQuote(id) { return unwrap(await supabase.rpc('delete_admin_quote', { target_quote: id })); }

export async function getSales() {
  return unwrap(await supabase.from('sales').select(`*,${CUSTOMER_REF},sale_items(*),sale_returns(*)`).order('created_at', { ascending: false }));
}

export async function confirmSale(id) { return unwrap(await supabase.rpc('confirm_sale', { target_sale: id })); }
export async function cancelSale(id, reason = null) { return unwrap(await supabase.rpc('cancel_sale', { target_sale: id, reason })); }
export async function setSaleStatus(id, status, paymentMethod = null) { return unwrap(await supabase.rpc('set_sale_status', { target_sale: id, new_status: status, payment_method: paymentMethod })); }
export async function registerSaleReturn(id, lines, restock, requestKey, note = null) {
  return unwrap(await supabase.rpc('register_sale_return', { target_sale: id, lines, restock, request_key: requestKey, note }));
}
export async function updateSaleNotes(id, notes) { return unwrap(await supabase.from('sales').update({ notes }).eq('id', id).select('id').single()); }
export async function createManualSale(payload) { return unwrap(await supabase.rpc('create_manual_sale', { payload })); }
// accept_changes solo se envía después de que el administrador revisa las diferencias (error BM001).
export async function createSaleFromOrder(id, acceptChanges = false) { return unwrap(await supabase.rpc('create_sale_from_order', { target_order: id, accept_changes: acceptChanges })); }
export async function convertQuoteToSale(id, acceptChanges = false) { return unwrap(await supabase.rpc('convert_quote_to_sale', { target_quote: id, accept_changes: acceptChanges })); }

// "Única" identifica productos sin opciones: no es un valor filtrable.
const isRealOption = item => item?.name && !/^única$/i.test(item.name.trim());

export async function getFilterOptions() {
  const [allColors, allSizes] = await Promise.all([
    unwrap(await supabase.from('product_colors').select('name,hex_code,sort_order').order('name')),
    unwrap(await supabase.from('product_sizes').select('name').order('sort_order'))
  ]);
  const colors = allColors.filter(isRealOption);
  const sizes = allSizes.filter(isRealOption);
  return {
    colors: [...new Set(colors.map(item => item.name))],
    colorDetails: [...colors.reduce((items, item) => {
      if (!items.has(item.name)) items.set(item.name, { name: item.name, hex_code: item.hex_code || '' });
      return items;
    }, new Map()).values()],
    sizes: [...new Set(sizes.map(item => item.name))]
  };
}

async function idsForFilter(table, column, value) {
  if (!value) return null;
  const query = supabase.from(table).select('product_id');
  const rows = unwrap(await (Array.isArray(value) ? query.in(column, value) : query.eq(column, value)));
  return [...new Set(rows.map(row => row.product_id))];
}

async function productIdsForAvailability(value) {
  if (!value) return null;
  let productQuery = supabase.from('products').select('id,force_sold_out,force_last_units,low_stock_threshold').eq('status', 'published');
  const products = unwrap(await productQuery);
  if (!products.length) return [];
  const variants = unwrap(await supabase
    .from('product_variants')
    .select('product_id,stock')
    .in('product_id', products.map(product => product.id))
    .eq('active', true));
  const stockByProduct = variants.reduce((totals, variant) => {
    totals[variant.product_id] = (totals[variant.product_id] || 0) + Number(variant.stock || 0);
    return totals;
  }, {});
  return products.filter(product => {
    const stock = stockByProduct[product.id] || 0;
    const soldOut = product.force_sold_out || stock === 0;
    if (value === 'sold') return soldOut;
    if (value === 'low') return !soldOut && (product.force_last_units || stock <= Number(product.low_stock_threshold ?? 3));
    return !soldOut;
  }).map(product => product.id);
}

function intersectSets(sets) {
  const available = sets.filter(Boolean);
  if (!available.length) return null;
  return [...available.reduce((acc, list) => new Set([...acc].filter(id => list.includes(id))), new Set(available[0]))];
}

export async function getProducts({
  page = 0, pageSize = 20, sort = 'featured', categoryId, brandId,
  color, size, minPrice, maxPrice, promotion = false, availability, featured, ids, search
} = {}) {
  let filteredIds = ids || null;
  const relationIds = intersectSets([
    categoryId ? await idsForFilter('product_categories', 'category_id', categoryId) : null,
    color ? await idsForFilter('product_colors', 'name', color) : null,
    size ? await idsForFilter('product_sizes', 'name', size) : null,
    availability ? await productIdsForAvailability(availability) : null
  ]);
  if (relationIds) filteredIds = filteredIds ? filteredIds.filter(id => relationIds.includes(id)) : relationIds;
  if (filteredIds && !filteredIds.length) return { products: [], count: 0 };

  let query = supabase.from('products').select(PRODUCT_SELECT, { count: 'exact' }).eq('status', 'published');
  if (filteredIds) query = query.in('id', filteredIds);
  if (brandId) query = Array.isArray(brandId) ? query.in('brand_id', brandId) : query.eq('brand_id', brandId);
  if (featured === true) query = query.eq('featured', true);
  if (promotion) {
    const now = new Date().toISOString();
    query = query
      .not('promo_price', 'is', null)
      .eq('promo_enabled', true)
      .or(`promo_start.is.null,promo_start.lte.${now}`)
      .or(`promo_end.is.null,promo_end.gte.${now}`);
  }
  if (availability === 'available') query = query.eq('force_sold_out', false);
  if (minPrice != null && minPrice !== '') query = query.gte('base_price', Number(minPrice));
  if (maxPrice != null && maxPrice !== '') query = query.lte('base_price', Number(maxPrice));
  if (search) query = query.ilike('name', `%${search.replace(/[%_]/g, '')}%`);
  if (sort === 'commercial') query = query.order('force_sold_out', { ascending: true }).order('featured', { ascending: false }).order('created_at', { ascending: false });
  else if (sort === 'newest') query = query.order('created_at', { ascending: false });
  else if (sort === 'price-asc') query = query.order('base_price', { ascending: true });
  else if (sort === 'price-desc') query = query.order('base_price', { ascending: false });
  else if (sort === 'name') query = query.order('name');
  else query = query.order('featured', { ascending: false }).order('created_at', { ascending: false });
  query = query.range(page * pageSize, page * pageSize + pageSize - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  let products = promotion ? data.filter(product => currentPrice(product) < Number(product.base_price)) : data;
  if (sort === 'discount') products = products
    .sort((a, b) => (1 - currentPrice(b) / Number(b.base_price || 1)) - (1 - currentPrice(a) / Number(a.base_price || 1)));
  if (sort === 'relevance' && ids) products.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  await attachPriceTiers(products);
  return { products, count };
}

export async function getDiscountSortedProductIds({
  categoryId, brandId, color, size, minPrice, maxPrice, promotion = false, availability
} = {}) {
  const relationIds = intersectSets([
    categoryId ? await idsForFilter('product_categories', 'category_id', categoryId) : null,
    color ? await idsForFilter('product_colors', 'name', color) : null,
    size ? await idsForFilter('product_sizes', 'name', size) : null,
    availability ? await productIdsForAvailability(availability) : null
  ]);
  if (relationIds && !relationIds.length) return [];
  let query = supabase.from('products').select('id,base_price,promo_price,promo_start,promo_end,promo_enabled,created_at').eq('status', 'published');
  if (relationIds) query = query.in('id', relationIds);
  if (brandId) query = Array.isArray(brandId) ? query.in('brand_id', brandId) : query.eq('brand_id', brandId);
  if (promotion) {
    const now = new Date().toISOString();
    query = query.not('promo_price', 'is', null).eq('promo_enabled', true).or(`promo_start.is.null,promo_start.lte.${now}`).or(`promo_end.is.null,promo_end.gte.${now}`);
  }
  if (minPrice != null && minPrice !== '') query = query.gte('base_price', Number(minPrice));
  if (maxPrice != null && maxPrice !== '') query = query.lte('base_price', Number(maxPrice));
  const products = unwrap(await query);
  return products
    .sort((a, b) => discountPercent(b) - discountPercent(a) || new Date(b.created_at) - new Date(a.created_at))
    .map(product => product.id);
}

export async function getProductBySlug(slug) {
  const product = unwrap(await supabase.from('products').select(PRODUCT_SELECT).eq('slug', slug).maybeSingle());
  if (!product) throw new Error('Producto no encontrado');
  await attachPriceTiers(product);
  return product;
}

export async function getProductsByIds(ids = []) {
  if (!ids.length) return [];
  const products = unwrap(await supabase.from('products').select(PRODUCT_SELECT).in('id', ids).eq('status', 'published'));
  await attachPriceTiers(products);
  return ids.map(id => products.find(product => product.id === id)).filter(Boolean);
}

export async function getEntityBySlug(type, slug) {
  const table = { category: 'categories', brand: 'brands' }[type];
  if (!table) throw new Error('Tipo de listado no válido');
  const entity = unwrap(await supabase.from(table).select('*').eq('slug', slug).maybeSingle());
  if (!entity) throw new Error('Listado no encontrado');
  return entity;
}

export async function getEntityById(type, id) {
  const table = { category: 'categories', brand: 'brands' }[type];
  if (!table) throw new Error('Tipo de listado no válido');
  const entity = unwrap(await supabase.from(table).select('*').eq('id', id).maybeSingle());
  if (!entity) throw new Error('Listado no encontrado');
  return entity;
}

export async function searchProducts(term, limit = 8) {
  const clean = term.trim();
  if (clean.length < 2) return [];
  const rpc = await supabase.rpc('search_products', { search_term: clean, result_limit: limit });
  if (!rpc.error) return rpc.data;
  console.warn('RPC search fallback:', rpc.error.message);
  const { products } = await getProducts({ pageSize: 50 });
  const words = normalizeText(clean).split(' ');
  return products.map(product => {
    const haystack = normalizeText([
      product.name, product.description, product.model, product.sku, product.brands?.name,
      ...product.product_colors.map(c => c.name), ...product.product_categories.map(c => c.categories?.name)
    ].filter(Boolean).join(' '));
    return { ...product, image_url: product.product_images[0]?.url, brand_name: product.brands?.name, score: words.filter(word => haystack.includes(word)).length };
  }).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function validateCart(items) {
  const payload = items.map(item => ({ variant_id: item.variant_id, quantity: item.quantity }));
  const result = await supabase.rpc('validate_cart', { cart_items: payload });
  if (!result.error) return result.data;
  console.warn('Cart validation fallback:', result.error.message);
  const variantIds = payload.map(item => item.variant_id);
  const variants = unwrap(await supabase.from('product_variants').select('*, product_colors(name), product_sizes(name), products(*)').in('id', variantIds));
  return payload.map(item => {
    const variant = variants.find(v => v.id === item.variant_id);
    if (!variant) return { variant_id: item.variant_id, valid: false, reason: 'Esta combinación ya no está disponible.' };
    const product = variant.products;
    const valid = product.status === 'published' && variant.active && !product.force_sold_out && variant.stock >= item.quantity;
    return { variant_id: variant.id, product_id: product.id, product_name: product.name, product_slug: product.slug, product_status: product.status, color_name: variant.product_colors.name, size_name: variant.product_sizes.name, stock: variant.stock, current_price: currentPrice(product), requested_quantity: item.quantity, valid, reason: valid ? null : `Actualmente solo quedan ${variant.stock} unidades.` };
  });
}

export async function getAdminProducts() {
  return attachPriceTiers(unwrap(await supabase.from('products').select(PRODUCT_SELECT).order('updated_at', { ascending: false })));
}

export async function saveRow(table, values, id = null) {
  const query = id ? supabase.from(table).update(values).eq('id', id) : supabase.from(table).insert(values);
  return unwrap(await query.select().single());
}

export async function deleteRow(table, id) {
  return unwrap(await supabase.from(table).delete().eq('id', id).select());
}

export async function getCatalogEntityDependencies(entityType, entityId) {
  return unwrap(await supabase.rpc('catalog_entity_dependencies', {
    entity_type: entityType,
    entity_id: entityId
  }));
}

export async function deleteCatalogEntitySafely(entityType, entityId) {
  return unwrap(await supabase.rpc('delete_catalog_entity_safely', {
    entity_type: entityType,
    entity_id: entityId
  }));
}

export async function removeCatalogEntityAsset(entityType, assetUrl = '') {
  const config = {
    categories: { bucket: 'category-images', folder: 'categories/' },
    brands: { bucket: 'brand-assets', folder: 'brands/' }
  }[entityType];
  if (!config || !/^https?:\/\//i.test(assetUrl)) return false;
  const marker = `/storage/v1/object/public/${config.bucket}/`;
  let pathname;
  try { pathname = new URL(assetUrl).pathname; } catch { return false; }
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return false;
  const path = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!path.startsWith(config.folder) || path.includes('..')) return false;
  unwrap(await supabase.storage.from(config.bucket).remove([path]));
  return true;
}

export async function removePaymentMethodAsset(assetUrl = '') {
  if (!/^https?:\/\//i.test(assetUrl)) return false;
  const marker = '/storage/v1/object/public/site-assets/';
  let pathname;
  try { pathname = new URL(assetUrl).pathname; } catch { return false; }
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return false;
  const path = decodeURIComponent(pathname.slice(markerIndex + marker.length));
  if (!path.startsWith('payment-methods/') || path.includes('..')) return false;
  unwrap(await supabase.storage.from('site-assets').remove([path]));
  return true;
}

export async function saveSettings(values) {
  return unwrap(await supabase.from('site_settings').update(values).eq('id', 1).select().single());
}

export async function prepareProductRelations(productId, { categoryIds, colors, sizes }) {
  if (categoryIds) {
    unwrap(await supabase.from('product_categories').delete().eq('product_id', productId));
    if (categoryIds.length) unwrap(await supabase.from('product_categories').insert(categoryIds.map(category_id => ({ product_id: productId, category_id }))));
  }
  const existingColors = unwrap(await supabase.from('product_colors').select('id').eq('product_id', productId));
  const existingSizes = unwrap(await supabase.from('product_sizes').select('id').eq('product_id', productId));
  const savedColors = [];
  for (const [index, item] of colors.entries()) {
    const row = unwrap(await (item.id
      ? supabase.from('product_colors').update({ name: item.name, sort_order: index }).eq('id', item.id)
      : supabase.from('product_colors').insert({ product_id: productId, name: item.name, sort_order: index })).select().single());
    savedColors.push({ ...row, client_id: item.clientId });
  }
  const savedSizes = [];
  for (const [index, item] of sizes.entries()) {
    const row = unwrap(await (item.id
      ? supabase.from('product_sizes').update({ name: item.name, sort_order: index }).eq('id', item.id)
      : supabase.from('product_sizes').insert({ product_id: productId, name: item.name, sort_order: index })).select().single());
    savedSizes.push({ ...row, client_id: item.clientId });
  }
  return {
    savedColors,
    savedSizes,
    removedColorIds: existingColors.map(row => row.id).filter(id => !colors.some(item => item.id === id)),
    removedSizeIds: existingSizes.map(row => row.id).filter(id => !sizes.some(item => item.id === id))
  };
}

// Las variantes se actualizan en su lugar (mismo id) para no romper carritos,
// pedidos ni movimientos de inventario que ya apuntan a ellas.
export async function finalizeProductRelations(productId, { savedColors, savedSizes, removedColorIds, removedSizeIds, variants }) {
  const rows = [];
  for (const color of savedColors) for (const size of savedSizes) {
    const original = variants.find(item => item.colorKey === color.client_id && item.sizeKey === size.client_id);
    rows.push({ color_id: color.id, size_id: size.id, stock: Math.max(0, Number(original?.stock || 0)), active: original?.active !== false });
  }
  unwrap(await supabase.rpc('save_product_variants', { target_product: productId, variants: rows }));
  if (removedColorIds.length) unwrap(await supabase.from('product_colors').delete().in('id', removedColorIds));
  if (removedSizeIds.length) unwrap(await supabase.from('product_sizes').delete().in('id', removedSizeIds));
}

async function removeUploadedProductImage(url) {
  const marker = '/storage/v1/object/public/product-images/';
  let path = '';
  try {
    const pathname = new URL(url).pathname;
    const index = pathname.indexOf(marker);
    if (index < 0) return;
    path = decodeURIComponent(pathname.slice(index + marker.length));
  } catch { return; }
  if (path && !path.includes('..')) unwrap(await supabase.storage.from('product-images').remove([path]));
}

export async function syncProductImages(productId, images, colorIds, onProgress = () => {}) {
  const active = images.filter(image => !image.deleted);
  const failures = [];
  for (const image of images.filter(item => item.deleted && item.id)) {
    try {
      unwrap(await supabase.from('product_images').delete().eq('id', image.id));
      await removeUploadedProductImage(image.url);
    } catch (error) { failures.push({ image, error }); }
  }
  for (const image of active.filter(item => !item.id && item.file)) {
    image.status = 'uploading'; image.statusDetail = 'Enviando a almacenamiento seguro…'; onProgress(image);
    let url = '';
    try {
      url = await uploadImage('product-images', image.file, productId);
      const row = unwrap(await supabase.from('product_images').insert({ product_id: productId, color_id: image.colorKey ? colorIds.get(image.colorKey) || null : null, url, alt_text: image.file.name, is_primary: false, sort_order: image.sortOrder }).select().single());
      Object.assign(image, row, { file: null, url: row.url || url, status: 'loaded', statusDetail: 'Guardada correctamente', error: null, errorStage: '' });
      onProgress(image);
    } catch (error) {
      if (url) try { await removeUploadedProductImage(url); } catch (cleanupError) { console.error('No se pudo limpiar el archivo incompleto:', cleanupError); }
      console.error(`No se pudo cargar ${image.name || 'la fotografía'}:`, error);
      image.status = 'error'; image.error = error; image.errorStage = 'upload'; image.statusDetail = storageUploadMessage(error); failures.push({ image, error }); onProgress(image);
    }
  }
  const persisted = active.filter(image => image.id);
  for (const image of persisted) {
    try {
      unwrap(await supabase.from('product_images').update({ color_id: image.colorKey ? colorIds.get(image.colorKey) || null : null, is_primary: false, sort_order: image.sortOrder }).eq('id', image.id));
      if (image.status !== 'error') image.status = 'loaded';
      onProgress(image);
    } catch (error) { image.status = 'error'; image.error = error; failures.push({ image, error }); onProgress(image); }
  }
  const candidates = persisted.filter(image => image.status !== 'error');
  const primary = candidates.find(image => image.isPrimary) || candidates.find(image => !image.colorKey) || candidates[0];
  if (primary) {
    try { unwrap(await supabase.from('product_images').update({ is_primary: true }).eq('id', primary.id)); primary.isPrimary = true; }
    catch (error) { primary.status = 'error'; primary.error = error; failures.push({ image: primary, error }); }
  }
  candidates.filter(image => image !== primary).forEach(image => { image.isPrimary = false; });
  if (failures.length) {
    const error = new Error(`${failures.length} fotografía${failures.length === 1 ? '' : 's'} no se pudieron guardar.`);
    error.imageFailures = failures;
    error.userMessage = storageUploadMessage(failures[0].error);
    throw error;
  }
  return persisted;
}

export async function uploadImage(bucket, file, folder = 'uploads') {
  const extensionByMime = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
  const namedExtension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
  const extension = extensionByMime[file.type] || namedExtension || 'jpg';
  const safeFolder = String(folder || 'uploads').split('/').filter(part => part && part !== '.' && part !== '..').map(part => part.replace(/[^a-zA-Z0-9_-]/g, '')).filter(Boolean).join('/') || 'uploads';
  const path = `${safeFolder}/${crypto.randomUUID()}.${extension}`;
  unwrap(await supabase.storage.from(bucket).upload(path, file, { cacheControl: '31536000', upsert: false }));
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export { supabase };
