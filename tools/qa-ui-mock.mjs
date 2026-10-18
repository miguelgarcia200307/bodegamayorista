// Prueba de interfaz en Chrome headless con Supabase SIMULADO.
// Todas las peticiones a *.supabase.co se interceptan con CDP y se responden con datos
// de prueba en memoria: ninguna llega al proyecto remoto ni escribe datos reales.
//
// Uso: node tools/qa-ui-mock.mjs [carpeta-de-capturas]
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const outDir = resolve(process.argv[2] || join(tmpdir(), 'bodega-qa-ui'));
await mkdir(outDir, { recursive: true });
const pdfOutDir = join(root, 'output', 'pdf');
const examplePdfName = 'Cotizacion_COT-2026-000001_Miguel-Garcia.pdf';
const examplePdfPath = join(pdfOutDir, examplePdfName);
await mkdir(pdfOutDir, { recursive: true });
await unlink(examplePdfPath).catch(() => {});
const SITE_PORT = 8093, DEBUG_PORT = 9333;
const REF = 'ekepygodvciqnqkrgrsv';
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chromePath) throw new Error('No se encontró Chrome ni Edge.');

// --- Datos simulados (solo existen en memoria durante la prueba) -------------------
const now = new Date().toISOString();
const bogotaToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const brand = { id: 'b1000000-0000-4000-8000-000000000001', name: 'Marca Prueba', slug: 'marca-prueba', logo_url: null, active: true, sort_order: 0, created_at: now, updated_at: now };
const category = { id: 'c1000000-0000-4000-8000-000000000001', name: 'Categoría Prueba', slug: 'categoria-prueba', parent_id: null, description: null, image_url: null, active: true, sort_order: 1, created_at: now, updated_at: now };
const childCategory = { id: 'c2000000-0000-4000-8000-000000000002', name: 'Subcategoría Prueba', slug: 'subcategoria-prueba', parent_id: category.id, description: null, image_url: null, active: true, sort_order: 2, created_at: now, updated_at: now };
const productBase = { description: 'Descripción de prueba.', material: null, care_instructions: null, purchase_delivery_info: null, sku: null, model: null, promo_price: null, promo_enabled: true, promo_start: null, promo_end: null, status: 'published', featured: true, force_sold_out: false, force_last_units: false, low_stock_threshold: 3, option1_name: null, option2_name: null, size_guide_text: null, size_guide_image_url: null, brand_id: brand.id, created_at: now, updated_at: now, brands: brand, product_categories: [{ category_id: category.id, categories: category }], product_images: [], specifications: {} };
const single = (id, name, slug, price, stock, extra = {}) => ({ ...productBase, id, name, slug, base_price: price, ...extra,
  product_colors: [{ id: `${id}-c`, name: 'Única', hex_code: null, sort_order: 0 }], product_sizes: [{ id: `${id}-s`, name: 'Única', sort_order: 0 }],
  product_variants: [{ id: `${id}-v`, color_id: `${id}-c`, size_id: `${id}-s`, stock, active: true, updated_at: now }] });
const products = [
  single('p1000000-0000-4000-8000-000000000001', 'Nevera de prueba', 'nevera-prueba', 1500000, 3, { specifications: { items: [{ label: 'Capacidad', value: '300 litros' }, { label: 'Voltaje', value: '110 V' }] } }),
  { ...productBase, id: 'p2000000-0000-4000-8000-000000000002', name: 'Celular de prueba', slug: 'celular-prueba', base_price: 1999000, promo_price: 1799000, option1_name: 'Color', option2_name: 'Almacenamiento',
    product_colors: [{ id: 'p2-c1', name: 'Negro', hex_code: '#111111', sort_order: 0 }, { id: 'p2-c2', name: 'Azul', hex_code: '#1f4fa0', sort_order: 1 }],
    product_sizes: [{ id: 'p2-s1', name: '128 GB', sort_order: 0 }, { id: 'p2-s2', name: '256 GB', sort_order: 1 }],
    product_variants: [{ id: 'p2-v1', color_id: 'p2-c1', size_id: 'p2-s1', stock: 4, active: true }, { id: 'p2-v2', color_id: 'p2-c1', size_id: 'p2-s2', stock: 0, active: true }, { id: 'p2-v3', color_id: 'p2-c2', size_id: 'p2-s1', stock: 2, active: true }, { id: 'p2-v4', color_id: 'p2-c2', size_id: 'p2-s2', stock: 1, active: true }] },
  single('p3000000-0000-4000-8000-000000000003', 'Juguete agotado de prueba', 'juguete-agotado', 89000, 0, { featured: false }),
  single('p4000000-0000-4000-8000-000000000004', 'Cable USB-C mayorista de prueba con nombre largo para validar que el título nunca se trunca', 'cable-mayorista', 25000, 100, { featured: false, product_categories: [{ category_id: childCategory.id, categories: childCategory }] })
];
// Tramos por volumen (tabla product_price_tiers de la migración 202609290001).
const priceTiers = [
  { id: 't1', product_id: products[3].id, min_quantity: 6, unit_price: 22000 },
  { id: 't2', product_id: products[3].id, min_quantity: 12, unit_price: 19000 }
];
const tierPrice = (product, quantity) => {
  const regular = product.promo_price ?? product.base_price;
  const tier = priceTiers.filter(item => item.product_id === product.id && quantity >= item.min_quantity).sort((a, b) => b.min_quantity - a.min_quantity)[0];
  return tier ? Math.min(regular, tier.unit_price) : regular;
};
// Réplica mínima de create_storefront_order: agrupa por producto para el tramo, igual que el servidor.
function mockOrder(payload) {
  const lines = (payload.items || []).map(line => {
    const product = products.find(item => item.product_variants.some(variant => variant.id === line.variant_id));
    const variant = product.product_variants.find(item => item.id === line.variant_id);
    return { product, variant, quantity: Number(line.quantity) };
  });
  const perProduct = lines.reduce((totals, line) => ({ ...totals, [line.product.id]: (totals[line.product.id] || 0) + line.quantity }), {});
  const items = lines.map(line => {
    const unit = tierPrice(line.product, perProduct[line.product.id]);
    const color = line.product.product_colors.find(item => item.id === line.variant.color_id)?.name;
    const size = line.product.product_sizes.find(item => item.id === line.variant.size_id)?.name;
    const options = Object.fromEntries([[line.product.option1_name, color], [line.product.option2_name, size]].filter(([key, value]) => key && value && value !== 'Única'));
    return { name: line.product.name, sku: null, options, quantity: line.quantity, unit_price: unit, line_total: unit * line.quantity };
  });
  const delivery = tables.delivery_methods.find(item => item.id === payload.delivery_method_id);
  const total = items.reduce((sum, item) => sum + item.line_total, 0) + Number(delivery?.base_cost || 0);
  lastOrderPayload = payload;
  return [{ order_number: 'PED-2026-000123', total, whatsapp: '573001112233', items }];
}
let lastOrderPayload = null;
const customerRef = { id: 'u1000000-0000-4000-8000-000000000001', full_name: 'Cliente Prueba', phone_original: '300 123 4567', phone_normalized: '+573001234567', city: 'Ciudad Prueba', address: null, birth_date: `1990-${bogotaToday.slice(5)}`, archived_at: null };
const customers = [
  { ...customerRef, identification: null, notes: 'Nota interna de prueba', source: 'tienda', merged_into: null, created_at: now, updated_at: now,
    customer_consents: [{ id: 'cc1', purpose: 'marketing_birthday', granted: true, text_version: 'v-prueba', source: 'checkout', recorded_at: now, withdrawn_at: null }], birthday_contacts: [] },
  { id: 'u2000000-0000-4000-8000-000000000002', full_name: 'Persona Bisiesta', phone_original: '+1 202 555 0199', phone_normalized: '+12025550199', city: null, address: null, birth_date: '2000-02-29', identification: null, notes: null, source: 'WhatsApp', archived_at: null, merged_into: null, created_at: now, updated_at: now, customer_consents: [], birthday_contacts: [] }
];
const item = (i, extra = {}) => ({ id: `it-${i}`, line_no: i + 1, product_id: products[i % 2].id, variant_id: products[i % 2].product_variants[0].id, product_name: `${products[i % 2].name} línea ${i + 1}`, sku: i % 3 ? null : `REF-${i}`, option_snapshot: i % 2 ? { Color: 'Negro', Almacenamiento: '128 GB' } : {}, quantity: 1 + (i % 3), unit_price: 125000.5, discount: i % 4 ? 0 : 5000, line_total: (1 + (i % 3)) * 125000.5 - (i % 4 ? 0 : 5000), ...extra });
const orders = [{ id: 'o1000000-0000-4000-8000-000000000001', order_number: 'PED-2026-000001', customer_id: customerRef.id, status: 'pendiente', source: 'tienda', delivery_name: 'Retiro de prueba', payment_name: 'Pago de prueba', shipping_city: null, shipping_address: null, notes: 'Observación de prueba', admin_notes: null, customer_conflicts: { full_name: 'Otro Nombre' }, subtotal: 1500000, delivery_cost: 0, total: 1500000, whatsapp_opened_at: now, created_at: now, updated_at: now, customers: customerRef, order_items: [item(0)], sales: [] }];
const quoteItems = [
  item(0, { product_name: 'Audífonos inalámbricos', sku: 'AUD-1699', quantity: 1, unit_price: 169900, discount: 0, line_total: 169900 }),
  item(1, { product_name: 'Parlante portátil', sku: 'PAR-0999', quantity: 1, unit_price: 99900, discount: 0, line_total: 99900 })
];
const quotes = [{ id: 'q1000000-0000-4000-8000-000000000001', quote_number: 'COT-2026-000001', customer_id: customerRef.id, status: 'borrador', valid_until: '2026-10-21', subtotal: 269800, discount_total: 0, delivery_cost: 5000, total: 274800, notes: 'Entrega coordinada con el cliente.', terms_snapshot: 'Cotización válida por 8 días. Precios sujetos a disponibilidad.', customer_snapshot: { full_name: 'Miguel García', phone: '300 123 4567', city: 'Valledupar' }, business_snapshot: {}, created_at: '2026-10-13T15:00:00.000Z', updated_at: now, customers: customerRef, quote_items: quoteItems }];
const saleItems = Array.from({ length: 60 }, (_, i) => item(i));
const sales = [{ id: 's1000000-0000-4000-8000-000000000001', sale_number: 'CV-2026-000001', customer_id: customerRef.id, source: 'pedido', status: 'confirmada', payment_method: 'Transferencia (declarado)', subtotal: 9000000, discount_total: 75000, delivery_cost: 12000, total: 8937000, notes: 'Entrega coordinada por WhatsApp.', terms_snapshot: null, warranty_snapshot: null, customer_snapshot: { full_name: 'Cliente Prueba', phone: '300 123 4567', city: 'Ciudad Prueba' }, business_snapshot: { business_name: 'Bodega Mayorista F.C.', tagline: 'Tecnología, calidad y confianza' }, stock_applied_at: now, confirmed_at: now, created_at: now, updated_at: now, customers: customerRef, sale_items: saleItems, sale_returns: [] },
  { id: 's2000000-0000-4000-8000-000000000002', sale_number: 'CV-2026-000002', customer_id: customerRef.id, source: 'presencial', status: 'solicitud', payment_method: null, subtotal: 125000.5, discount_total: 0, delivery_cost: 0, total: 125000.5, notes: null, customer_snapshot: {}, business_snapshot: {}, stock_applied_at: null, created_at: now, updated_at: now, customers: customerRef, sale_items: [item(1)], sale_returns: [] }];
const settings = { id: 1, terms_text: 'TÉRMINOS Y CONDICIONES DE PRUEBA\n1. Quién vende.', terms_version: 'tyc-prueba-1', data_policy_text: 'POLÍTICA DE DATOS DE PRUEBA\n1. Responsable.', data_policy_version: 'pd-prueba-1', business_name: 'Bodega Mayorista F.C.', tagline: 'Tecnología, calidad y confianza', whatsapp: '573001112233', phone: null, email: null, address: null, city: null, schedule: null, instagram: null, facebook: null, tiktok: null, maps_url: null, logo_url: null, tax_id: null, default_sort: 'featured', checkout_behavior: 'keep', marketing_consent_text: null, marketing_consent_version: null, quote_terms: null, sale_terms: null, warranty_text: null, birthday_message: 'Hola {nombre}, te deseamos un feliz cumpleaños de parte de Bodega Mayorista F.C.', announcement_enabled: true, announcement_mode: 'static', announcement_static_text: 'Bodega Mayorista F.C. · Tecnología, calidad y confianza', announcement_interval_seconds: 5, announcement_messages: [], banner_enabled: false, banner_interval_seconds: 5, price_tiers_enabled: true, updated_at: now };
const tables = {
  site_settings: [settings], brands: [brand], categories: [category, childCategory], products, homepage_banners: [], product_price_tiers: priceTiers,
  payment_methods: [{ id: 'pm1', name: 'Pago de prueba', instructions: null, logo_url: null, active: true, sort_order: 1 }],
  delivery_methods: [{ id: 'dm1', name: 'Retiro de prueba', instructions: null, requires_city: false, requires_address: false, base_cost: 0, active: true, sort_order: 1 }],
  product_colors: products.flatMap(p => p.product_colors), product_sizes: products.flatMap(p => p.product_sizes),
  product_variants: products.flatMap(p => p.product_variants.map(v => ({ ...v, product_id: p.id }))), product_categories: products.map(p => ({ product_id: p.id, category_id: p.product_categories[0].category_id })),
  admins: [{ user_id: 'a1000000-0000-4000-8000-00000000000a', role: 'propietario' }], customers, orders, quotes, sales,
  product_relationships: [{ id: 'r1', source_type: 'product', source_id: products[1].id, target_type: 'product', target_id: products[3].id, kind: 'compatible_con', strength: 1, reposition_days: null, note: 'Cable compatible verificado', active: true }],
  customer_tasks: [{ id: 't1', customer_id: 'u1000000-0000-4000-8000-000000000001', kind: 'pedido_pendiente', dedupe_key: 'pedido:o1', title: 'Atender el pedido PED-2026-000001', objective: 'Confirmar entrega y pago.', evidence: [{ label: 'Pedido registrado', date: bogotaToday, kind: 'observado' }], priority: 90, priority_reason: { urgencia: 'Pedido sin atender' }, promotional: false, status: 'pendiente', due_at: bogotaToday, rule_version: 'tareas-v1', source_type: 'order', source_id: 'o1000000-0000-4000-8000-000000000001', created_at: now, customers: { id: 'u1000000-0000-4000-8000-000000000001', full_name: 'Cliente Prueba', phone_original: '300 123 4567', phone_normalized: '+573001234567' } }],
  customer_offers: [], contact_attempts: [], identity_links: [], identity_verifications: [], coupons: [{ id: 'c1000000-0000-4000-8000-000000000001', code: 'BIENVENIDO10', name: 'Bienvenida clientes nuevos', kind: 'porcentaje', value: 10, max_discount: 50000, min_eligible: 100000, stacking: 'sobre_precio_vigente', starts_at: null, ends_at: new Date(Date.now() + 5 * 86400000).toISOString(), max_uses_total: 20, max_uses_per_customer: 1, audience: 'publico', customer_id: null, reservation_hours: 72, release_on_cancel: true, release_on_full_return: false, active: true, rules_version: 'cupones-v1', created_at: now, coupon_scopes: [], coupon_uses: [{ id: 'cu1', status: 'consumida', discount_total: 45000, reserved_at: now, expires_at: new Date(Date.now() + 2 * 86400000).toISOString(), consumed_at: now, released_at: null, order_id: null, sale_id: null }, { id: 'cu2', status: 'reservada', discount_total: 20000, reserved_at: now, expires_at: new Date(Date.now() + 2 * 86400000).toISOString(), consumed_at: null, released_at: null, order_id: null, sale_id: null }] }, { id: 'c1000000-0000-4000-8000-000000000002', code: 'OF-PRUEBA01', name: 'Oferta para Cliente Prueba · Nevera', kind: 'valor_fijo', value: 80000, max_discount: null, min_eligible: 0, stacking: 'solo_precio_regular', starts_at: null, ends_at: new Date(Date.now() + 20 * 86400000).toISOString(), max_uses_total: 1, max_uses_per_customer: 1, audience: 'portador', customer_id: 'u1000000-0000-4000-8000-000000000001', reservation_hours: 72, release_on_cancel: true, release_on_full_return: false, active: true, rules_version: 'cupones-v1', created_at: now, coupon_scopes: [], coupon_uses: [] }], maintenance_runs: [], product_costs: [], restock_requests: []
};
const intercepted = [];
// Simulación de las funciones nuevas (cupones, privacidad y CRM). Nada sale a la red.
const privacyCalls = { register: 0, events: [] };
const restockCalls = [];
const offerCalls = [];
function mockCoupon(body) {
  const code = String(body.code || '').trim().toUpperCase();
  if (code === 'CAIDO') return { status: 503, body: { message: 'Servicio no disponible' } };
  if (code === 'VENCIDO') return { status: 200, body: { status: 'vencido', code, ends_at: '2026-01-01T00:00:00Z' } };
  if (code !== 'PRUEBA10') return { status: 200, body: { status: 'no_valido' } };
  const lines = (body.cart_items || []).map((line, index) => {
    const product = products.find(item => item.product_variants.some(variant => variant.id === line.variant_id));
    const unit = tierPrice(product, Number(line.quantity));
    return { line_no: index + 1, variant_id: line.variant_id, product_id: product.id, product_name: product.name, quantity: Number(line.quantity), unit_price: unit, gross: unit * Number(line.quantity), eligible: true, discount: 0, line_total: unit * Number(line.quantity) };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.gross, 0);
  const discount = Math.round(subtotal * 0.1);
  lines[0].discount = discount; lines[0].line_total -= discount;
  return { status: 200, body: { status: 'valido', code, name: 'Prueba', kind: 'porcentaje', value: 10, subtotal, eligible_subtotal: subtotal, discount_total: discount, total: subtotal - discount, lines, ends_at: null } };
}
const whatsappVisits = [];
function mockResponse(url, method, headers, postData = '') {
  const parsed = new URL(url);
  const path = parsed.pathname;
  // WhatsApp nunca se abre de verdad: se registra la URL y se responde una página vacía.
  if (/(^|\.)wa\.me$|whatsapp\.com$/.test(parsed.hostname)) { whatsappVisits.push(url); return { status: 200, body: '<!doctype html><title>WhatsApp simulado</title>', html: true }; }
  intercepted.push(`${method} ${path}`);
  if (path === '/graphql/v1') return { status: 200, body: { data: { __schema: { queryType: { fields: [{ name: 'siteSettingsCollection' }, { name: 'productsCollection' }] } } } } };
  if (path.endsWith('/rpc/search_products')) {
    const term = String(JSON.parse(postData || '{}').search_term || '').toLowerCase();
    return { status: 200, body: products.filter(item => item.status === 'published' && item.name.toLowerCase().includes(term)).map(item => ({ ...item, image_url: null, brand_name: item.brands?.name })) };
  }
  if (path.endsWith('/rpc/create_storefront_order')) return { status: 200, body: mockOrder(JSON.parse(postData || '{}').payload || {}) };
  if (path.endsWith('/rpc/validate_cart_coupon')) return mockCoupon(JSON.parse(postData || '{}'));
  if (path.endsWith('/rpc/register_visitor')) { privacyCalls.register += 1; return { status: 200, body: [{ visitor_id: crypto.randomUUID(), visitor_secret: 'a'.repeat(64) }] }; }
  if (path.endsWith('/rpc/set_visitor_consent')) return { status: 200, body: true };
  if (path.endsWith('/rpc/track_events')) { const body = JSON.parse(postData || '{}'); privacyCalls.events.push(...(body.events || [])); return { status: 200, body: [{ accepted: (body.events || []).length, rejected: 0 }] }; }
  if (path.endsWith('/rpc/request_restock_notice')) { restockCalls.push(JSON.parse(postData || '{}')); return { status: 200, body: true }; }
  if (path.endsWith('/rpc/staff_role')) return { status: 200, body: 'propietario' };
  if (path.endsWith('/rpc/plan_status')) return { status: 200, body: { status: 'sin_plan', enforcement_enabled: false, message: 'Plan no configurado por el operador del servicio.' } };
  if (path.endsWith('/rpc/crm_customer_ranking')) return { status: 200, body: [{ position_rank: 1, total_customers: 2, share_bp: 6000, kept_cents: 900000000 }] };
  if (path.endsWith('/rpc/generate_customer_tasks')) return { status: 200, body: 0 };
  if (path.endsWith('/rpc/preview_offer')) {
    const { items = [], benefit = {} } = JSON.parse(postData || '{}');
    const lines = items.map(item => ({ variant_id: item.variant_id, quantity: item.quantity, product_name: 'Producto', unit_price: 100000, regular_unit: 100000, discount: benefit.kind === 'porcentaje' ? 100000 * item.quantity * benefit.value / 100 : 0, line_total: 100000 * item.quantity * (1 - (benefit.kind === 'porcentaje' ? benefit.value / 100 : 0)), available: true }));
    const subtotal = lines.reduce((sum, line) => sum + line.unit_price * line.quantity, 0); const discount = lines.reduce((sum, line) => sum + line.discount, 0);
    return { status: 200, body: { status: 'valido', unavailable_lines: 0, subtotal, discount_total: discount, lines, margin_available: false, margin_reason: 'faltan costos' } };
  }
  if (path.endsWith('/rpc/create_customer_offer')) {
    const { payload } = JSON.parse(postData || '{}'); offerCalls.push(payload);
    const items = (payload.items || []).map(item => ({ product_name: 'Producto', quantity: item.quantity, gross: 100000 * item.quantity, discount: 10000 * item.quantity, line_total: 90000 * item.quantity }));
    return { status: 200, body: { offer: { id: 'of000000-0000-4000-8000-000000000001', items, totals: { total: items.reduce((sum, item) => sum + item.line_total, 0), discount_total: items.reduce((sum, item) => sum + item.discount, 0) } }, coupon: { code: 'OF-PRUEBA7', ends_at: payload.benefit?.ends_at } } };
  }
  if (path.endsWith('/rpc/update_customer_offer')) return { status: 200, body: { id: 'of000000-0000-4000-8000-000000000001' } };
  if (path.startsWith('/rest/v1/rpc/')) return { status: 200, body: path.endsWith('validate_cart') ? [] : [] };
  if (path.startsWith('/rest/v1/')) {
    // Filtros PostgREST básicos de nivel superior: col=eq.x, col=in.(a,b), col=is.null.
    let rows = tables[path.slice('/rest/v1/'.length)] || [];
    for (const [key, raw] of new URL(url).searchParams) {
      if (['select', 'order', 'limit', 'offset', 'or', 'and'].includes(key) || key.includes('.')) continue;
      const [op, ...rest] = raw.split('.'); const value = rest.join('.');
      if (op === 'eq') rows = rows.filter(row => String(row[key]) === value);
      else if (op === 'in') { const list = value.replace(/^\(|\)$/g, '').split(',').map(v => v.replace(/^"|"$/g, '')); rows = rows.filter(row => list.includes(String(row[key]))); }
      else if (op === 'is' && value === 'null') rows = rows.filter(row => row[key] == null);
    }
    if (method !== 'GET' && method !== 'HEAD') return { status: 201, body: rows[0] || {} };
    const wantsObject = /vnd\.pgrst\.object/.test(headers.Accept || headers.accept || '');
    return { status: 200, body: wantsObject ? rows[0] || null : rows, headers: { 'Content-Range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` } };
  }
  return { status: 200, body: {} };
}

// --- Servidor estático local -------------------------------------------------------
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const file = join(root, path);
  if (!file.startsWith(normalize(root)) || !existsSync(file)) { response.writeHead(404); response.end('404'); return; }
  response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
  response.end(await readFile(file));
}).listen(SITE_PORT);

const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(tmpdir(), `bodega-qa-profile-${Date.now()}`)}`, '--disable-web-security', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let target;
for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
  await delay(250);
  target = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then(r => r.json()).then(list => list.find(t => t.type === 'page')).catch(() => null);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let seq = 0; const pending = new Map(); const errors = [];
socket.addEventListener('message', async event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(message.error.message)) : resolve(message.result); return; }
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params;
    const mock = mockResponse(request.url, request.method, request.headers, request.postData);
    const headers = { 'Content-Type': mock.html ? 'text/html; charset=utf-8' : 'application/json', 'Access-Control-Allow-Origin': '*', ...(mock.headers || {}) };
    send('Fetch.fulfillRequest', { requestId, responseCode: mock.status, responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })), body: Buffer.from(mock.html ? mock.body : JSON.stringify(mock.body)).toString('base64') }).catch(() => {});
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(`[excepción] ${message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text}`);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(`[console.error] ${message.params.args.map(arg => arg.value ?? (arg.preview ? JSON.stringify(Object.fromEntries(arg.preview.properties.map(p => [p.name, p.value]))) : arg.description) ?? '').join(' ')}`);
});
function send(method, params = {}) { const id = ++seq; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })); }
const evaluate = async expression => { const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(`Error en la página: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`); return response.result.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: pdfOutDir, eventsEnabled: true });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Fetch.enable', { patterns: [{ urlPattern: `https://${REF}.supabase.co/*` }, { urlPattern: 'https://*.supabase.co/*' }, { urlPattern: 'https://wa.me/*' }, { urlPattern: 'https://api.whatsapp.com/*' }] });

async function visit(path, width = 390, wait = 2500) {
  if (process.env.QA_TRACE) console.log('VISIT', path, width);
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 700 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 700 });
  const before = await evaluate('performance.timeOrigin').catch(() => 0);
  await send('Page.navigate', { url: `http://localhost:${SITE_PORT}/${path}` });
  // Espera a que el documento NUEVO exista y termine de cargar (evita evaluar la página anterior).
  for (let waited = 0; waited < 10000; waited += 100) {
    await delay(100);
    const state = await evaluate('({ origin: performance.timeOrigin, ready: document.readyState })').catch(() => null);
    if (state && state.origin !== before && state.ready === 'complete') break;
  }
  await delay(wait);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
}
const results = []; const failures = [];
function expect(name, condition, detail = '') { (condition ? results : failures).push(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); }
// Si un paso aborta, se informan las verificaciones fallidas acumuladas hasta ese punto.
const reportAbort = error => { console.log(failures.join(String.fromCharCode(10))); console.log([...new Set(errors)].slice(0, 15).join(String.fromCharCode(10))); console.error(error); process.exit(1); };
process.on('uncaughtException', reportAbort); process.on('unhandledRejection', reportAbort);

// --- Vitrina -------------------------------------------------------------------------
// Datos de negocio realistas para la tienda (se restauran antes de las pruebas del panel).
const originalSettings = { ...settings };
const demoSettings = { phone: '+57 300 000 0000', email: 'demo@bodegamayorista.test', address: 'Calle 00 # 00-00 (dirección demo)', city: 'Valledupar', schedule: 'Lun a Sáb 8:00 a. m. – 6:00 p. m.', instagram: 'https://instagram.com/', warranty_text: '[DEMO] Garantía de 3 meses por defectos de fábrica.', data_policy_text: '[DEMO] Autorizo el tratamiento de mis datos.', whatsapp: '+573000000000', announcement_mode: 'carousel', announcement_messages: [{ id: 'demo-1', text: 'Semana de la tecnología: hasta 20% OFF', enabled: true, position: 1 }] };
const realSettings = { address: 'Carrera 45 # 70-12', city: 'Valledupar', schedule: 'Lunes a sábado, 8:00 a. m. a 6:00 p. m.', instagram: '@bodegaprueba', warranty_text: 'Garantía de 3 meses por defectos de fábrica.', whatsapp: '573001112233' };
Object.assign(settings, demoSettings);
await visit('index.html');
let data = await evaluate(`({ text: document.body.innerText, float: !!document.querySelector('[data-wa-float]'), footer: document.querySelector('[data-site-footer]')?.innerText || '' })`);
expect('datos demo del panel nunca se muestran al público', !/demo|00-00|300 000 0000|.test|instagram.com/i.test(data.text), (data.text.match(/.{0,30}(demo|00-00|300 000 0000).{0,30}/i) || [''])[0]);
expect('sin WhatsApp real no se muestra el botón flotante', data.float === false);
expect('el footer muestra la ubicación real confirmada', /Tienda física en Valledupar/.test(data.footer));
Object.assign(settings, originalSettings, realSettings);
await visit('index.html');
data = await evaluate(`({ cards: document.querySelectorAll('.product-card').length, brandSection: !document.querySelector('#home-brand-section')?.hidden, text: document.body.innerText })`);
expect('inicio muestra productos', data.cards > 0, `${data.cards} tarjetas`);
expect('inicio muestra “Marcas destacadas”', data.brandSection && /marcas destacadas/i.test(data.text));
expect('inicio sin textos deportivos', !/equipo|fútbol|camiseta|talla/i.test(data.text));
data = await evaluate(`({ rail: document.querySelectorAll('.category-rail__item:not(.category-rail__item--skeleton)').length, all: document.querySelector('.category-rail__item--all')?.innerText.trim(), trust: [...document.querySelectorAll('.trust-item strong')].map(n => n.textContent), wholesale: document.querySelector('#home-wholesale')?.innerText || '', institutional: document.querySelector('#store-info')?.innerText || '', text: document.body.innerText })`);
expect('inicio: rail de categorías con “Ver todas” completo', data.rail >= 2 && data.all === 'Ver todas', `${data.rail} ítems`);
expect('inicio: sin franja de confianza', data.trust.length === 0, data.trust.join(' | '));
expect('inicio: bloque mayorista con ejemplo real de tramos', /Compra al por mayor/i.test(data.wholesale) && data.wholesale.includes('12+ u') && data.wholesale.includes('19.000'), data.wholesale.replace(/\s+/g, ' ').slice(0, 160));
expect('inicio: bloque institucional sin contradicción de ubicación y sin copy técnico', /Tienda física en Valledupar · Envíos a todo el país/.test(data.institutional) && !/La solicitud se registra/.test(data.text) && !/Configuración pendiente/i.test(data.text));
expect('inicio: sin “Imagen de demostración”', !/Imagen de demostración/i.test(data.text));
await screenshot('home-390');

// --- Header, buscador, navegación inferior, footer y WhatsApp (fases 3, 8, 9 y 10)
data = await evaluate(`(() => { const header = document.querySelector('.site-header'); const fav = document.querySelector('.site-header__favorites');
  return { logo: document.querySelector('.site-header .brand-logo')?.getAttribute('src'), favHidden: getComputedStyle(fav).display === 'none', sticky: getComputedStyle(header).position,
    nav: [...document.querySelectorAll('.mobile-nav__item')].map(a => a.innerText.trim()), announce: document.querySelector('[data-announcement]')?.innerText || '',
    placeholder: document.querySelector('#mobile-search')?.placeholder, floatLabel: document.querySelector('[data-wa-float]')?.getAttribute('href') || '' }; })()`);
expect('header: logo SVG versión clara', /logo-light.svg/.test(data.logo || ''));
expect('header móvil sin corazón de favoritos', data.favHidden);
expect('header fijo (sticky)', data.sticky === 'sticky');
expect('buscador con placeholder corto', data.placeholder === 'Buscar productos o marcas');
expect('navegación inferior con 5 ítems y “Ofertas”', data.nav.join('|') === 'Inicio|Categorías|Ofertas|Favoritos|Carrito', data.nav.join('|'));
expect('WhatsApp flotante con el número real', data.floatLabel.startsWith('https://wa.me/573001112233'));
await evaluate(`document.querySelector('#mobile-search').focus()`); await delay(700);
data = await evaluate(`({ open: !document.querySelector('#mobile-search-panel').hidden, overlay: document.querySelector('.market-search--mobile').classList.contains('is-overlay'), text: document.querySelector('#mobile-search-panel').innerText })`);
expect('buscador: al enfocar abre la vista con categorías populares', data.open && data.overlay && /Categorías populares/i.test(data.text), data.text.slice(0, 80));
await screenshot('search-open-390');
await evaluate(`(() => { const input = document.querySelector('#mobile-search'); input.value = 'celular'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await delay(900);
data = await evaluate(`({ rows: [...document.querySelectorAll('#mobile-search-panel .search-result')].map(row => row.innerText.replace(/\\s+/g, ' ')) })`);
expect('buscador: resultados en vivo con nombre y precio', data.rows.some(row => /Celular de prueba/.test(row) && row.includes('$')), data.rows.join(' / '));
await evaluate(`(() => { const input = document.querySelector('#mobile-search'); input.value = 'zzqqxx'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`); await delay(900);
data = await evaluate(`document.querySelector('#mobile-search-panel').innerText`);
expect('buscador: estado sin resultados con sugerencias', /No encontramos/i.test(data) && /Categorías populares/i.test(data));
await evaluate(`document.querySelector('.market-search--mobile [data-search-close]').click()`); await delay(200);
await evaluate(`window.scrollTo(0, document.body.scrollHeight)`); await delay(500);
data = await evaluate(`(() => { const footer = document.querySelector('[data-site-footer]'); return { logo: footer.querySelector('.brand-logo')?.getAttribute('src'), bg: getComputedStyle(footer).backgroundColor, text: footer.innerText }; })()`);
expect('footer: logo versión clara sobre fondo oscuro', /logo-dark.svg/.test(data.logo || '') && data.bg === 'rgb(17, 21, 19)', data.bg);
expect('footer: Instagram como @usuario, nunca la URL', /@bodegaprueba/.test(data.text) && !/instagram.com/.test(data.text));
await screenshot('footer-390');
await visit('carrito.html');
data = await evaluate(`!!document.querySelector('[data-wa-float]')`);
expect('WhatsApp flotante oculto en carrito', data === false);

await visit('producto.html?slug=nevera-prueba');
data = await evaluate(`({ colorHidden: document.querySelector('#color-group')?.hidden, sizeHidden: document.querySelector('#size-group')?.hidden, specs: document.querySelector('.product-specs')?.textContent || '', cta: document.querySelector('#add-cart')?.textContent })`);
expect('producto sin opciones no muestra selectores', data.colorHidden === true && data.sizeHidden === true);
expect('especificaciones en la ficha', /Capacidad/.test(data.specs) && /300 litros/.test(data.specs));
await evaluate(`document.querySelector('#add-cart').click()`); await delay(400);
await visit('producto.html?slug=celular-prueba');
data = await evaluate(`({ labels: [...document.querySelectorAll('.option-group__head strong')].map(n => n.textContent) })`);
expect('producto con opciones muestra sus nombres', data.labels.includes('Color') && data.labels.includes('Almacenamiento'), data.labels.join(', '));
await screenshot('product-options-390');
await visit('producto.html?slug=juguete-agotado');
data = await evaluate(`({ cta: document.querySelector('#add-cart')?.textContent, disabled: document.querySelector('#add-cart')?.disabled })`);
expect('producto publicado agotado visible y sin compra', data.disabled === true && /Agotado/.test(data.cta), data.cta);
await visit('carrito.html');
data = await evaluate(`({ items: document.querySelectorAll('.cart-item').length, text: document.querySelector('#cart-items')?.innerText || '' })`);
expect('carrito conserva el producto sin mostrar “Única”', data.items === 1 && !/Única|Talla|Color/.test(data.text), `${data.items} línea(s)`);
await visit('checkout.html');
data = await evaluate(`({ consent: document.querySelector('#marketing-consent')?.checked, policy: !!document.querySelector('#data-policy'), deliveries: document.querySelectorAll('[name=delivery]').length })`);
expect('checkout: autorización promocional no premarcada y política visible', data.consent === false && data.policy);
expect('checkout: métodos de entrega configurables cargados', data.deliveries === 1);
await screenshot('checkout-390');

// --- Ficha de producto (fase 6)
await visit('producto.html?slug=celular-prueba');
data = await evaluate(`({ price: document.querySelector('#price-block').innerText.replace(/\\s+/g, ' '), disabled: [...document.querySelectorAll('[data-size]:disabled')].map(b => b.textContent), accordions: [...document.querySelectorAll('.accordion button')].map(b => b.innerText.trim()), ask: document.querySelector('#ask-whatsapp')?.href || '', jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent).join(' '), counter: document.querySelector('#gallery-count').textContent })`);
expect('ficha: precio actual, anterior tachado, -% y “Ahorras”', /1\.799\.000/.test(data.price) && /1\.999\.000/.test(data.price) && /-10%/.test(data.price) && /Ahorras \$\s?200\.000/.test(data.price), data.price);
expect('ficha: opción agotada deshabilitada', data.disabled.includes('256 GB'), data.disabled.join(','));
expect('ficha: acordeones Descripción y Envíos y garantía', data.accordions.includes('Descripción') && data.accordions.includes('Envíos y garantía'), data.accordions.join('|'));
expect('ficha: “Preguntar por WhatsApp” con producto, variante y URL', /Celular%20de%20prueba/.test(data.ask) && /Negro|Azul/.test(decodeURIComponent(data.ask)) && /producto\.html/.test(decodeURIComponent(data.ask)), decodeURIComponent(data.ask).slice(0, 140));
expect('ficha: datos estructurados Product/Offer y BreadcrumbList', /"@type":"Product"/.test(data.jsonld) && /"priceCurrency":"COP"/.test(data.jsonld) && /BreadcrumbList/.test(data.jsonld));
await evaluate(`document.querySelector('#gallery-zoom').click()`); await delay(400);
data = await evaluate(`!!document.querySelector('.modal--lightbox .lightbox__slide img')`);
expect('ficha: zoom a pantalla completa', data === true);
await evaluate(`document.querySelector('.modal--lightbox .modal__close').click()`); await delay(300);
await evaluate(`window.scrollTo(0, document.querySelector('#add-cart').getBoundingClientRect().bottom + scrollY + 200)`); await delay(600);
data = await evaluate(`({ sticky: !document.querySelector('#product-sticky-buy').hidden, floatHidden: getComputedStyle(document.querySelector('[data-wa-float]')).visibility === 'hidden' })`);
expect('ficha: barra CTA fija al salir el botón principal y WhatsApp oculto', data.sticky && data.floatHidden, JSON.stringify(data));
await screenshot('product-sticky-390');
await visit('producto.html?slug=cable-mayorista');
data = await evaluate(`(() => { const h1 = document.querySelector('h1'); return { fits: h1.scrollWidth <= h1.clientWidth + 1 && getComputedStyle(h1).textOverflow !== 'ellipsis', text: h1.textContent, rows: document.querySelectorAll('.tier-table__row').length }; })()`);
expect('ficha: título largo completo, sin truncar ni desbordar', data.fits && /nunca se trunca/.test(data.text), data.text.slice(0, 40));
expect('ficha: tabla de precios por mayor', data.rows === 3, data.rows + ' tramos');
await screenshot('product-wholesale-390');
await evaluate(`(() => { const input = document.querySelector('#quantity'); input.value = '6'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(300);
data = await evaluate(`({ active: document.querySelector('.tier-table__row.is-active')?.innerText.replace(/\\s+/g, ' '), total: document.querySelector('#purchase-total').innerText })`);
expect('ficha: el tramo activo se resalta y el total se actualiza', /6–11 u/.test(data.active || '') && /132\.000/.test(data.total), JSON.stringify(data));
await evaluate(`document.querySelector('#add-cart').click()`); await delay(600);
data = await evaluate(`({ toast: document.querySelector('.toast')?.innerText || '', badge: document.querySelector('.site-header .cart-badge')?.textContent })`);
expect('ficha: al agregar, toast “Ver carrito” y contador actualizado', /Agregado al carrito/.test(data.toast) && /Ver carrito/.test(data.toast) && Number(data.badge) >= 6, JSON.stringify(data));

// --- Espacio antes del footer
for (const page of ['producto.html?slug=celular-prueba', 'index.html', 'categoria.html?slug=categoria-prueba', 'carrito.html']) {
  await visit(page);
  await evaluate('window.scrollTo(0, document.body.scrollHeight)'); await delay(700);
  data = await evaluate(`(() => { const visible = [...document.querySelector('main').children].filter(el => !el.hidden && el.getBoundingClientRect().height > 0 && !el.matches('.filters, .filter-backdrop')); const last = visible.at(-1); const lastContent = [...last.querySelectorAll('*')].filter(el => el.getBoundingClientRect().height > 0).reduce((max, el) => Math.max(max, el.getBoundingClientRect().bottom), last.getBoundingClientRect().top); return Math.round(document.querySelector('[data-site-footer]').getBoundingClientRect().top - lastContent); })()`);
  expect(`espacio moderado antes del footer en ${page}`, data >= 16 && data <= 80, `${data}px`);
}

// --- Scroll sin temblor: compactar el header no cambia la altura ni mueve el scroll
await visit('categoria.html?slug=categoria-prueba');
const jitter = async y => { await evaluate(`window.scrollTo(0, ${y})`); await delay(450); return evaluate(`({ y: Math.round(scrollY), h: document.documentElement.scrollHeight, compact: document.querySelector('.site-header').classList.contains('is-compact'), barTop: Math.round(document.querySelector('.site-header__bar').getBoundingClientRect().top) })`); };
const start = await jitter(0);
const down = await jitter(700);
const smallUp = await jitter(670);
const up = await jitter(600);
const deep = await jitter(1200);
expect('scroll: al bajar el header se compacta sin cambiar la altura de la página', down.compact && down.h === start.h && down.y === 700, JSON.stringify({ start, down }));
expect('scroll: un pequeño movimiento hacia arriba no alterna el header', smallUp.compact && smallUp.y === 670, JSON.stringify(smallUp));
expect('scroll: al subir reaparece el buscador sin mover el contenido', !up.compact && up.y === 600 && up.h === start.h, JSON.stringify(up));
expect('scroll: el header queda fijo arriba al bajar', deep.compact && deep.barTop >= 0 && deep.barTop <= 2, JSON.stringify(deep));
let toggles = 0;
await evaluate(`window.__toggles = 0; new MutationObserver(() => window.__toggles++).observe(document.querySelector('.site-header'), { attributes: true, attributeFilter: ['class'] })`);
for (let y = 1200; y <= 1260; y += 4) { await evaluate(`window.scrollTo(0, ${y})`); await delay(20); }
await delay(300);
toggles = await evaluate('window.__toggles');
expect('scroll: sin parpadeo del header al desplazarse despacio', toggles <= 1, `${toggles} cambios`);

// --- Flujo completo: Inicio → Categoría → Producto → variante → carrito → cantidad → checkout → WhatsApp
await visit('index.html');
await evaluate(`localStorage.clear(); sessionStorage.clear()`);
await visit('index.html');
data = await evaluate(`[...document.querySelectorAll('a[href*="categoria.html?slug="]')].map(a => a.getAttribute('href'))`);
expect('flujo: inicio enlaza a categorías', data.length > 0, data[0] || 'sin enlaces');
await visit(data[0] || 'categoria.html?slug=categoria-prueba');
data = await evaluate(`({ cards: document.querySelectorAll('.product-card').length, link: document.querySelector('.product-card a[href*="producto.html"]')?.getAttribute('href') })`);
expect('flujo: la categoría lista productos', data.cards > 0 && Boolean(data.link), `${data.cards} tarjetas`);
await visit('producto.html?slug=celular-prueba');
await evaluate(`[...document.querySelectorAll('[data-color]')].find(b => /Azul/.test(b.textContent))?.click()`); await delay(300);
data = await evaluate(`({ size: document.querySelector('[data-size].active, [data-size][aria-pressed="true"]')?.textContent?.trim(), cta: document.querySelector('#add-cart')?.textContent })`);
expect('flujo: elegir variante actualiza la selección', /128 GB|256 GB/.test(data.size || ''), `${data.size} · ${data.cta}`);
await evaluate(`document.querySelector('#add-cart').click()`); await delay(700);
data = await evaluate(`JSON.parse(localStorage.getItem('bodega_mayorista_fc_cart_v1') || '[]')`);
expect('flujo: agregar al carrito guarda la variante elegida', data.length === 1 && data[0].color === 'Azul', JSON.stringify(data.map(item => [item.color, item.size, item.quantity])));
await visit('carrito.html');
await evaluate(`document.querySelector('.cart-item [data-action="plus"]').click()`); await delay(500);
await visit('carrito.html');
data = await evaluate(`({ qty: document.querySelector('.cart-item input')?.value, stored: JSON.parse(localStorage.getItem('bodega_mayorista_fc_cart_v1') || '[]')[0]?.quantity, continue: !!document.querySelector('a[href="checkout.html"]') })`);
expect('flujo: cambiar cantidad persiste al recargar', String(data.qty) === '2' && data.stored === 2, `input ${data.qty}, guardado ${data.stored}`);
expect('flujo: botón “Continuar pedido” disponible', data.continue);
await visit('checkout.html');
const ordersBeforeLegal = lastOrderPayload;
await evaluate(`(() => { const f = document.querySelector('#checkout-form'); f.elements.fullName.value = 'Cliente Prueba'; f.elements.phone.value = '300 123 4567';
  f.querySelector('[name="delivery"]').click(); f.querySelector('[name="payment"]').click();
  f.dispatchEvent(new Event('input', { bubbles: true })); f.requestSubmit(); })()`);
await delay(900);
data = await evaluate(`({ error: document.querySelector('#legalAccept-error')?.textContent || '', checked: document.querySelector('#legal-accept')?.checked, marketing: document.querySelector('#marketing-consent')?.checked, versions: document.querySelector('#legal-versions')?.textContent || '' })`);
expect('checkout: sin aceptar Términos y Política no se envía el pedido', lastOrderPayload === ordersBeforeLegal && /Debes aceptar/.test(data.error) && data.checked === false, JSON.stringify(data));
expect('checkout: la autorización promocional es opcional y no viene marcada', data.marketing === false && /tyc-prueba-1/.test(data.versions), JSON.stringify(data));
await evaluate(`document.querySelector('[data-legal-open="terms"]').click()`); await delay(400);
data = await evaluate(`({ title: document.querySelector('.modal--legal h2')?.textContent || '', text: document.querySelector('.modal--legal .legal-text')?.textContent || '' })`);
expect('checkout: los Términos se leen completos sin salir del pedido', /Términos y condiciones/.test(data.title) && /TÉRMINOS Y CONDICIONES DE PRUEBA/.test(data.text), data.title);
await evaluate(`document.querySelector('.modal--legal .modal__close').click()`); await delay(300);
await evaluate(`(() => { const f = document.querySelector('#checkout-form'); f.elements.legalAccept.checked = true; f.requestSubmit(); })()`);
await delay(4500);
expect('pedido: envía la aceptación con las versiones vigentes', lastOrderPayload?.legal?.accepted === true && lastOrderPayload.legal.terms_version === 'tyc-prueba-1' && lastOrderPayload.legal.data_policy_version === 'pd-prueba-1', JSON.stringify(lastOrderPayload?.legal));
const waUrl = whatsappVisits.filter(url => url.includes('text=')).at(-1) || '';
const waText = decodeURIComponent(new URL(waUrl || 'https://x.invalid/?text=').searchParams.get('text') || '');
expect('flujo: se abre WhatsApp con el número del servidor', waUrl.startsWith('https://wa.me/573001112233'), waUrl.slice(0, 60));
expect('flujo: el mensaje incluye pedido, producto, variante y total', /PED-2026-000123/.test(waText) && /Celular de prueba/.test(waText) && /Azul/.test(waText) && /\$\s?3\.598\.000/.test(waText), waText.replace(/\n/g, ' | ').slice(0, 220));
expect('flujo: el servidor recibió las líneas del carrito', lastOrderPayload?.items?.length === 1 && lastOrderPayload.items[0].quantity === 2);
await visit('carrito.html');
data = await evaluate(`JSON.parse(localStorage.getItem('bodega_mayorista_fc_cart_v1') || '[]').length`);
expect('flujo: con checkout_behavior=keep el carrito se conserva tras el pedido', data === 1);

// --- Listados (fase 5)
await visit('categoria.html?slug=categoria-prueba');
data = await evaluate(`({ h1: document.querySelector('h1').textContent, chips: [...document.querySelectorAll('#listing-subcategories .chip')].map(c => c.textContent), cards: document.querySelectorAll('#listing-products .product-card').length, count: document.querySelector('#result-count').textContent, toolbar: getComputedStyle(document.querySelector('.listing-toolbar')).position })`);
expect('categoría: título, chips de subcategoría sin “›” y conteo', data.h1 === 'Categoría Prueba' && data.chips.join('|') === 'Todos|Subcategoría Prueba' && data.cards === 4 && /4 productos/.test(data.count), JSON.stringify(data));
expect('categoría: barra Filtrar/Ordenar fija', data.toolbar === 'sticky');
await evaluate(`[...document.querySelectorAll('#listing-subcategories .chip')].find(c => c.dataset.sub).click()`); await delay(300);
data = await evaluate(`({ cards: document.querySelectorAll('#listing-products .product-card').length, active: document.querySelector('#listing-subcategories .chip.active')?.textContent, url: location.search })`);
expect('categoría: chip de subcategoría filtra y queda activo', data.cards === 1 && data.active === 'Subcategoría Prueba' && /sub=subcategoria-prueba/.test(data.url), JSON.stringify(data));
await evaluate(`document.querySelector('#listing-subcategories .chip').click()`); await delay(300);
await evaluate(`document.querySelector('#open-sort').click()`); await delay(400);
data = await evaluate(`[...document.querySelectorAll('.modal--sheet input[name="listing-sort"]')].map(i => i.closest('label').innerText.trim())`);
expect('ordenar: hoja inferior con las 5 opciones', data.join('|') === 'Relevancia|Menor precio|Mayor precio|Mayor descuento|Novedades', data.join('|'));
await screenshot('sort-sheet-390');
await evaluate(`(() => { const input = document.querySelector('.modal--sheet input[value="price-asc"]'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(500);
data = await evaluate(`[...document.querySelectorAll('#listing-products .price__now')].map(n => Number(n.textContent.replace(/\\D/g, '')))`);
expect('ordenar: menor precio primero', data.length === 4 && data.every((value, index) => !index || data[index - 1] <= value), data.join(', '));
await evaluate(`document.querySelector('#open-filters').click()`); await delay(400);
data = await evaluate(`({ open: document.querySelector('#filters').classList.contains('open'), sections: [...document.querySelectorAll('.filter-section__toggle > span:first-child')].map(n => n.textContent) })`);
expect('filtros: hoja con subcategoría, precio, disponibilidad y ofertas', data.open && ['Subcategoría', 'Precio', 'Disponibilidad', 'Ofertas'].every(name => data.sections.includes(name)), data.sections.join('|'));
await screenshot('filters-sheet-390');
await evaluate(`(() => { const toggle = [...document.querySelectorAll('.filter-section__toggle')].find(b => /Disponibilidad/.test(b.textContent)); if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click(); document.querySelector('#filters input[name="availability"]').click(); document.querySelector('.filter-submit').click(); })()`); await delay(500);
data = await evaluate(`({ chips: [...document.querySelectorAll('#active-filters [data-remove-filter]')].map(b => b.innerText.trim()), cards: document.querySelectorAll('#listing-products .product-card').length, badge: document.querySelector('#open-filters [data-filter-count]').textContent })`);
expect('filtros: chip activo removible y conteo (n)', data.chips.length === 1 && data.cards === 3 && data.badge === '1', JSON.stringify(data));
await evaluate(`document.querySelector('#active-filters .active-filter-clear').click()`); await delay(400);
data = await evaluate(`({ chips: document.querySelectorAll('#active-filters [data-remove-filter]').length, cards: document.querySelectorAll('#listing-products .product-card').length })`);
expect('filtros: “Limpiar todo” restablece el listado', data.chips === 0 && data.cards === 4, JSON.stringify(data));
await evaluate(`sessionStorage.setItem('bodega_mayorista_fc_listing_restore_v1', JSON.stringify({ url: location.href, page: 0, y: 400 }))`);
await visit(await evaluate('location.pathname.slice(1) + location.search'));
data = await evaluate('({ y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight })'); data = { ...data, expected: Math.min(400, data.max) }; data.ok = data.y > data.expected - 80 && data.y < data.expected + 40; /* el header se compacta al bajar y el navegador ancla el contenido */
expect('listado: conserva la posición al volver desde la ficha', data.ok, JSON.stringify(data));
await visit('catalogo.html?q=zzqqxx');
data = await evaluate(`document.querySelector('#listing-products .empty-state')?.innerText || ''`);
expect('búsqueda sin resultados: estado vacío con salida', /No encontramos/i.test(data) && /categorías/i.test(data), data.replace(/\s+/g, ' '));
await visit('promociones.html');
data = await evaluate(`({ h1: document.querySelector('h1').textContent, cards: document.querySelectorAll('#listing-products .product-card').length })`);
expect('ofertas: listado con productos en promoción', data.h1 === 'Ofertas' && data.cards === 1, JSON.stringify(data));
await visit('marca.html?slug=marca-prueba');
data = await evaluate(`({ h1: document.querySelector('h1').textContent, cards: document.querySelectorAll('#listing-products .product-card').length })`);
expect('marca: listado con sus productos', data.h1 === 'Marca Prueba' && data.cards === 4, JSON.stringify(data));

// --- Carrito y cierre del pedido (fase 7)
await visit('carrito.html');
data = await evaluate(`({ keep: [...document.querySelectorAll('a')].filter(a => /Seguir comprando/.test(a.textContent)).length, summary: document.querySelector('#cart-summary').innerText })`);
expect('carrito: un solo “Seguir comprando”', data.keep === 1, data.keep + ' enlaces');
expect('carrito: resumen con envío “Se calcula al confirmar” y total', /Se calcula al confirmar/.test(data.summary) && /Total/.test(data.summary));
await evaluate(`document.querySelector('.cart-item [data-action="remove"]').click()`); await delay(400);
data = await evaluate(`({ items: document.querySelectorAll('.cart-item').length, toast: document.querySelector('.toast')?.innerText || '' })`);
expect('carrito: eliminar sin diálogo, con “Deshacer”', data.items === 0 && /Deshacer/.test(data.toast), JSON.stringify(data));
await screenshot('cart-empty-390');
await evaluate(`[...document.querySelectorAll('.toast__action')].find(b => /Deshacer/.test(b.textContent)).click()`); await delay(400);
data = await evaluate(`document.querySelectorAll('.cart-item').length`);
expect('carrito: “Deshacer” recupera el producto', data === 1);
await visit('producto.html?slug=cable-mayorista');
await evaluate(`(() => { const input = document.querySelector('#quantity'); input.value = '8'; input.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#add-cart').click(); })()`); await delay(700);
await visit('carrito.html');
data = await evaluate(`({ progress: document.querySelector('.cart-progress')?.innerText || '', wholesale: document.querySelector('.cart-item__wholesale')?.innerText || '', summary: document.querySelector('#cart-summary').innerText })`);
expect('carrito: descuento por mayor aplicado y barra de progreso al siguiente tramo', /Precio por mayor aplicado/.test(data.wholesale) && /Descuento por mayor/.test(data.summary) && /Te faltan 4 unidades/.test(data.progress), JSON.stringify({ progress: data.progress, wholesale: data.wholesale }));
await screenshot('cart-wholesale-390');
await evaluate(`(() => { const row = [...document.querySelectorAll('.cart-item')].find(r => /Cable/.test(r.innerText)); const input = row.querySelector('.stepper input'); input.value = '12'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(400);
await visit('checkout.html');
data = await evaluate(`({ name: document.querySelector('#checkout-name').value, labels: [...document.querySelectorAll('.checkout-card .field__label')].map(n => n.textContent) })`);
expect('checkout: recuerda los datos de la compra anterior', data.name === 'Cliente Prueba', JSON.stringify(data));
expect('checkout: etiquetas siempre visibles', data.labels.includes('Nombre completo') && data.labels.includes('Celular (WhatsApp)'));
await evaluate(`(() => { const f = document.querySelector('#checkout-form'); f.elements.fullName.value = ''; f.requestSubmit(); })()`); await delay(400);
data = await evaluate(`document.querySelector('#fullName-error').textContent`);
expect('checkout: validación en línea con mensaje claro', /nombre completo/i.test(data), data);
const before = whatsappVisits.length;
await evaluate(`(() => { const f = document.querySelector('#checkout-form'); f.elements.fullName.value = 'Cliente Prueba'; f.querySelector('[name="delivery"]').click(); f.querySelector('[name="payment"]').click(); f.elements.legalAccept.checked = true; f.requestSubmit(); })()`);
await delay(700);
data = await evaluate(`document.querySelector('#checkout-confirmation')?.innerText || ''`);
expect('checkout: pantalla “Tu pedido PED-… está listo” con botón a WhatsApp', /Tu pedido PED-2026-000123 está listo/.test(data) && /Abrir WhatsApp/.test(data), data.slice(0, 80));
await screenshot('checkout-confirmation-390');
await delay(3500);
const mayoreo = decodeURIComponent(new URL(whatsappVisits.slice(before).filter(url => url.includes('text=')).at(-1) || 'https://x.invalid/?text=').searchParams.get('text') || '');
expect('checkout: el servidor aplica el tramo por mayor (12 × $19.000)', /12 × \$\s?19\.000 = \$\s?228\.000/.test(mayoreo), mayoreo.replace(/\n/g, ' | ').slice(0, 200));
await visit('carrito.html');
await evaluate(`localStorage.setItem('bodega_mayorista_fc_cart_v1', '[]')`);
await visit('carrito.html');
data = await evaluate(`document.querySelector('.cart-empty-state')?.innerText || ''`);
expect('carrito vacío: CTA a Ofertas y categorías populares', /Ver ofertas/.test(data) && /Categorías populares/i.test(data), data.replace(/\s+/g, ' ').slice(0, 120));

for (const width of [320, 375, 768, 1024, 1440]) {
  for (const page of ['index.html', 'producto.html?slug=celular-prueba', 'catalogo.html', 'categoria.html?slug=categoria-prueba', 'carrito.html', 'checkout.html']) {
    await visit(page, width, 1800);
    const overflow = await evaluate(`document.documentElement.scrollWidth - innerWidth`);
    expect(`sin desbordamiento horizontal ${page} @${width}`, overflow <= 1, `${overflow}px`);
  }
}

// --- Panel (sesión simulada) ------------------------------------------------------
Object.keys(settings).forEach(key => delete settings[key]); Object.assign(settings, originalSettings);
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 86400;
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: tables.admins[0].user_id, role: 'authenticated', aud: 'authenticated', exp, email: 'admin@prueba.local' })}.firma`;
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'refresco', user: { id: tables.admins[0].user_id, email: 'admin@prueba.local', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } };
await visit('robots.txt', 1440, 300);
await evaluate(`localStorage.setItem('sb-${REF}-auth-token', ${JSON.stringify(JSON.stringify(session))})`);

for (const width of [390, 1440]) {
  for (const section of ['dashboard', 'orders', 'customers', 'quotes', 'sales', 'products', 'stock', 'categories', 'brands', 'promotions', 'settings']) {
    await visit(`admin/index.html?section=${section}`, width, 2600);
    data = await evaluate(`({ title: document.querySelector('.admin-heading h1')?.textContent, error: document.querySelector('#admin-content .empty-state h1')?.textContent || '', overflow: document.documentElement.scrollWidth - innerWidth, text: document.querySelector('#admin-content')?.innerText || '' })`);
    expect(`panel ${section} @${width}`, data.title && !/No pudimos cargar/.test(data.error), data.title || data.error);
    expect(`panel ${section} sin desbordamiento @${width}`, data.overflow <= 1, `${data.overflow}px`);
    if (width === 390 && ['dashboard', 'customers', 'sales', 'quotes'].includes(section)) await screenshot(`admin-${section}-390`);
    if (width === 390 && ['sales', 'customers', 'orders'].includes(section)) { await evaluate(`document.querySelector('.sales-tabs')?.scrollIntoView()`); await delay(300); await screenshot(`admin-${section}-list-390`); }
    if (width === 1440 && ['dashboard', 'quotes', 'sales', 'customers', 'orders'].includes(section)) await screenshot(`admin-${section}-1440`);
  }
}

await visit('admin/index.html?section=dashboard', 1440, 2600);
data = await evaluate(`document.querySelector('#admin-content').innerText`);
expect('resumen muestra cumpleaños de hoy y configuración pendiente', /Cliente Prueba/i.test(data) && /Configuración pendiente/i.test(data));

await visit('admin/index.html?section=customers&view=today', 390, 2600);
data = await evaluate(`({ cards: document.querySelectorAll('[data-customer]').length, greet: !!document.querySelector('[data-greet]') })`);
expect('filtro “Cumpleaños hoy” con botón Felicitar (autorizado)', data.cards === 1 && data.greet);
await evaluate(`document.querySelector('[data-open-customer]').click()`); await delay(1200);
data = await evaluate(`(() => { const profile = document.querySelector('.customer-profile'); return { text: profile?.textContent || '', tabs: [...(profile?.querySelectorAll('[role="tab"]') || [])].map(tab => tab.dataset.tab), lines: profile?.querySelectorAll('[data-panel="sale"] .doc-line').length || 0 }; })()`);
expect('ficha de cliente con edad, historial por pestañas, productos de cada venta y autorizaciones', /años/.test(data.text) && data.tabs.join('|') === 'summary|sale|quote|order|data' && data.lines > 0 && /Autorizaciones/.test(data.text), JSON.stringify({ tabs: data.tabs, lines: data.lines }));
await screenshot('admin-customer-profile-390');

await visit('admin/index.html?section=orders', 1440, 2600);
await evaluate(`document.querySelector('[data-open-order]').click()`); await delay(800);
data = await evaluate(`document.querySelector('.modal')?.innerText || ''`);
expect('detalle de pedido marca datos distintos a la ficha', /Datos distintos a la ficha/.test(data) && /Otro Nombre/.test(data));

await visit('admin/index.html?section=quotes', 1440, 2600);
await evaluate(`document.querySelector('[data-edit-quote]').click()`); await delay(1200);
data = await evaluate(`({ lines: document.querySelectorAll('.line-row').length, totals: document.querySelector('[data-line-totals]')?.innerText || '', customerInputs: document.querySelectorAll('[data-customer-search]').length, productInputs: document.querySelectorAll('[data-line-search]').length })`);
expect('editor de cotización multi-línea con autocompletados únicos y totales', data.lines === 2 && /274\.800/.test(data.totals) && data.customerInputs === 1 && data.productInputs === 1, JSON.stringify(data));
await evaluate(`document.querySelector('[data-download-current]').click()`);
for (let waited = 0; waited < 10000 && !existsSync(examplePdfPath); waited += 200) await delay(200);
const examplePdfBuffer = existsSync(examplePdfPath) ? await readFile(examplePdfPath) : Buffer.alloc(0);
expect('cotización descarga PDF real con nombre automático', examplePdfBuffer.length > 2500 && examplePdfBuffer.subarray(0, 4).toString() === '%PDF', `${examplePdfName} · ${examplePdfBuffer.length} bytes`);
data = await evaluate(`(async () => { const change = document.querySelector('[data-change-customer]'); change.click(); const input = document.querySelector('[data-customer-search]'); input.value = 'Persona Bisiesta'; input.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return document.querySelector('[data-customer-selection]')?.innerText || ''; })()`); await delay(300);
expect('cliente se puede cambiar con teclado sin perder las líneas', /Persona Bisiesta/.test(data) && await evaluate(`document.querySelectorAll('.line-row').length`) === 2, data);
await screenshot('admin-quote-form-1440');
await evaluate(`document.querySelector('.line-row [data-field="quantity"]').value = '5'; document.querySelector('.line-row [data-field="quantity"]').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.modal__close').click();`); await delay(500);
data = await evaluate(`document.querySelector('.modal--confirm')?.innerText || ''`);
expect('cerrar con cambios pide confirmación', /cambios sin guardar/i.test(data));
await evaluate(`document.querySelector('.modal--confirm [data-cancel]').click()`); await delay(300);
data = await evaluate(`(() => { const content = document.querySelector('.modal--quote .modal__content'); return { overflowX: getComputedStyle(content).overflowX, viewportOverflow: document.documentElement.scrollWidth - innerWidth }; })()`);
expect('modal de cotización sin desplazamiento horizontal en escritorio', data.overflowX === 'hidden' && data.viewportOverflow <= 1, JSON.stringify(data));

await visit('admin/index.html?section=quotes', 390, 900);
await evaluate(`document.querySelector('[data-edit-quote]').click()`); await delay(700);
data = await evaluate(`(() => { const content = document.querySelector('.modal--quote .modal__content'); return { overflowX: getComputedStyle(content).overflowX, viewportOverflow: document.documentElement.scrollWidth - innerWidth, footer: getComputedStyle(document.querySelector('.quote-form__footer')).position, customerInputs: document.querySelectorAll('[data-customer-search]').length, productInputs: document.querySelectorAll('[data-line-search]').length }; })()`);
expect('modal de cotización compacto y sin desbordamiento en móvil', data.overflowX === 'hidden' && data.viewportOverflow <= 1 && data.footer === 'sticky' && data.customerInputs === 1 && data.productInputs === 1, JSON.stringify(data));
await screenshot('admin-quote-form-390');

await visit('admin/index.html?section=products', 1440, 2600);
await evaluate(`document.querySelector('[data-edit], [data-action="edit"], .data-row button')?.click()`); await delay(1500);
data = await evaluate(`({ modal: !!document.querySelector('.modal--product'), optionNames: !!document.querySelector('[name="option1_name"]'), specs: document.querySelectorAll('[data-spec-row]').length, personalization: /Personalización/.test(document.querySelector('.modal--product')?.innerText || '') })`);
expect('editor de producto con nombres de opción y especificaciones, sin personalización', data.modal && data.optionNames && data.specs === 2 && !data.personalization, JSON.stringify(data));
await evaluate(`document.querySelector('.modal-backdrop').dispatchEvent(new MouseEvent('click', { bubbles: true }))`); await delay(400);
data = await evaluate(`!!document.querySelector('.modal--product')`);
expect('clic fuera no cierra el editor de producto', data === true);
await screenshot('admin-product-form-1440');

// Comprobante multipágina: verifica la descarga directa y la impresión separada.
await visit('admin/index.html?section=sales', 1440, 2600);
const salePdfPath = join(outDir, 'Comprobante_CV-2026-000001_Cliente-Prueba.pdf');
await unlink(salePdfPath).catch(() => {});
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir, eventsEnabled: true });
await evaluate(`document.querySelector('[data-download-sale]').click()`);
for (let waited = 0; waited < 10000 && !existsSync(salePdfPath); waited += 200) await delay(200);
const salePdfBuffer = existsSync(salePdfPath) ? await readFile(salePdfPath) : Buffer.alloc(0);
const directPages = (salePdfBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
expect('descarga directa del comprobante soporta varias páginas', salePdfBuffer.length > 10000 && directPages >= 2, `${directPages} páginas · ${salePdfBuffer.length} bytes`);
await evaluate(`document.querySelector('[data-print-sale]').click()`);
await delay(1500);
data = await evaluate(`(async () => { const frame = document.querySelector('#document-print-frame'); const response = frame ? await fetch(frame.src) : null; const bytes = response ? (await response.arrayBuffer()).byteLength : 0; return { src: frame?.src || '', srcdoc: frame?.srcdoc || '', filename: frame?.dataset.filename || '', pages: Number(frame?.dataset.pages || 0), bytes }; })()`);
expect('Imprimir reutiliza el mismo PDF multipágina, no una plantilla HTML', data.src.startsWith('blob:') && !data.srcdoc && data.filename === 'Comprobante_CV-2026-000001_Cliente-Prueba.pdf' && data.pages === directPages && data.bytes > 10000, JSON.stringify(data));

// Cupones: tarjetas tipo ticket y formulario por secciones.
for (const width of [390, 1440]) {
  await visit('admin/index.html?section=coupons', width, 2000);
  data = await evaluate(`({ cards: document.querySelectorAll('.coupon-card').length, kpis: document.querySelectorAll('.sales-kpi').length, overflow: document.documentElement.scrollWidth - innerWidth })`);
  expect(`cupones: tarjetas e indicadores sin desbordamiento @${width}`, data.cards === 2 && data.kpis === 4 && data.overflow <= 1, JSON.stringify(data));
  await screenshot(`admin-coupons-${width}`);
  if (width === 390) { await evaluate(`document.querySelector('.sales-tabs')?.scrollIntoView()`); await delay(300); await screenshot('admin-coupons-list-390'); }
  await evaluate(`document.querySelector('#new-coupon').click()`); await delay(700);
  data = await evaluate(`(() => { const m = document.querySelector('.modal--coupon'); return m ? { overflow: m.scrollWidth - m.clientWidth, preview: m.querySelector('[data-preview-code]')?.textContent || '' } : null; })()`);
  expect(`cupones: formulario con vista previa sin desbordamiento @${width}`, data && data.overflow <= 1 && /AUTOM/.test(data.preview), JSON.stringify(data));
  await screenshot(`admin-coupon-form-${width}`);
  data = await evaluate(`(async () => {
    const picker = document.querySelector('[data-picker="include"]'); const first = () => picker.querySelector('[data-toggle]');
    const id = first().dataset.toggle; first().click(); await new Promise(r => setTimeout(r, 100));
    const afterOn = { chips: picker.querySelectorAll('[data-remove]').length, selected: picker.querySelector('[data-toggle="' + id + '"]').getAttribute('aria-selected') };
    picker.scrollIntoView({ block: 'center' }); return { id, afterOn };
  })()`);
  expect(`cupones: alcance se elige con un clic @${width}`, data.afterOn.chips === 1 && data.afterOn.selected === 'true', JSON.stringify(data));
  await delay(300); await screenshot(`admin-coupon-scope-${width}`);
  data = await evaluate(`(() => { const picker = document.querySelector('[data-picker="include"]'); picker.querySelector('[data-toggle][aria-selected="true"]').click(); return { chips: picker.querySelectorAll('[data-remove]').length, overflow: document.querySelector('.modal--coupon').scrollWidth - document.querySelector('.modal--coupon').clientWidth }; })()`);
  expect(`cupones: clic de nuevo quita la selección @${width}`, data.chips === 0 && data.overflow <= 1, JSON.stringify(data));
}

// "Atender hoy": tablero de tareas y sus modales.
for (const width of [390, 1440]) {
  await visit('admin/index.html?section=today', width, 2200);
  data = await evaluate(`({ tasks: document.querySelectorAll('.task-item').length, kpis: document.querySelectorAll('.sales-kpi').length, overflow: document.documentElement.scrollWidth - innerWidth })`);
  expect(`atender hoy: tareas con indicadores y sin desbordamiento @${width}`, data.tasks > 0 && data.kpis === 4 && data.overflow <= 1, JSON.stringify(data));
  await screenshot(`admin-today-${width}`);
  if (width === 390) { await evaluate(`document.querySelector('.sales-tabs')?.scrollIntoView()`); await delay(300); await screenshot('admin-today-list-390'); }
  for (const [label, selector] of [['mensaje', '[data-task-message]'], ['posponer', '[data-task-postpone]']]) {
    await evaluate(`document.querySelector('${selector}').click()`); await delay(700);
    data = await evaluate(`(() => { const m = document.querySelector('.modal--action'); if (!m) return null; const a = m.querySelector('.sale-action__actions').getBoundingClientRect(); return { overflow: m.scrollWidth - m.clientWidth, actionsVisible: a.bottom <= innerHeight + 1 && a.top >= 0 }; })()`);
    expect(`atender hoy: modal "${label}" sin desbordamiento @${width}`, data && data.overflow <= 1 && data.actionsVisible, JSON.stringify(data));
    await screenshot(`admin-today-${label}-${width}`);
    await evaluate(`document.querySelector('.modal--action [data-back], .modal--action .modal__close')?.click()`); await delay(400);
  }
}

// Modales de acciones de venta: pago, devolución, cancelación y confirmación.
for (const width of [390, 1440]) {
  for (const [label, selector, status] of [['pago', '[data-paid]'], ['devolucion', '[data-return]'], ['cancelar', '[data-cancel-sale]'], ['confirmar', '[data-confirm-sale]', 'solicitud']]) {
    const original = sales[0].status; if (status) sales[0].status = status;
    await visit('admin/index.html?section=sales', width, 2000);
    await evaluate(`document.querySelector('${selector}').click()`); await delay(800);
    if (label === 'pago') await evaluate(`document.querySelector('.pay-tile input')?.click()`);
    if (label === 'devolucion') await evaluate(`(() => { document.querySelector('.stepper [data-step="1"]')?.click(); document.querySelector('.choice-tile input')?.click(); })()`);
    await delay(300);
    data = await evaluate(`(() => { const m = document.querySelector('.modal--action'); if (!m) return null; const a = m.querySelector('.sale-action__actions').getBoundingClientRect(); return { overflow: m.scrollWidth - m.clientWidth, viewport: document.documentElement.scrollWidth - innerWidth, actionsVisible: a.bottom <= innerHeight + 1 && a.top >= 0, value: m.querySelector('[data-return-value]')?.textContent || '' }; })()`);
    expect(`modal de venta "${label}" sin desbordamiento y con botones visibles @${width}`, data && data.overflow <= 1 && data.viewport <= 1 && data.actionsVisible, JSON.stringify(data));
    await screenshot(`admin-sale-${label}-${width}`);
    sales[0].status = original;
  }
}

// --- CRM: ayuda/privacidad, autorización, cupón y nuevas secciones del panel ---------
for (const width of [320, 390, 1440]) {
  await visit('ayuda.html#privacidad', width, 1800);
  data = await evaluate(`({ section: !!document.querySelector('#privacidad'), text: document.querySelector('#privacidad')?.innerText || '', overflow: document.documentElement.scrollWidth - innerWidth, link: !!document.querySelector('[data-site-footer] a[href="ayuda.html#privacidad"]') })`);
  expect(`ayuda: sección de privacidad configurable @${width}`, data.section && /Responsable/.test(data.text) && /pendiente de configuración/i.test(data.text) && data.link, data.text.slice(0, 120));
  expect(`ayuda sin desbordamiento @${width}`, data.overflow <= 1, `${data.overflow}px`);
}
Object.assign(settings, { tracking_enabled: true, analytics_consent_text: 'Usamos tu navegación en esta tienda para mejorarla.', analytics_consent_version: 'an-prueba-1', privacy_controller_name: 'Tienda Prueba' });
await visit('index.html', 390, 1500);
await evaluate(`localStorage.removeItem('bm_privacy_v1'); sessionStorage.clear()`);
await visit('index.html', 390, 1800);
data = await evaluate(`({ banner: !!document.querySelector('[data-privacy-banner]'), overflow: document.documentElement.scrollWidth - innerWidth })`);
expect('aviso de privacidad visible solo con captura configurada', data.banner && data.overflow <= 1);
await screenshot('privacy-banner-390');
const visitorsBefore = privacyCalls.register;
await evaluate(`document.querySelector('[data-privacy="reject"]').click()`); await delay(500);
await visit('index.html', 390, 1500);
data = await evaluate(`({ banner: !!document.querySelector('[data-privacy-banner]'), stored: JSON.parse(localStorage.getItem('bm_privacy_v1') || '{}') })`);
expect('rechazar: sin visitante en servidor, la decisión se recuerda y se puede comprar', !data.banner && privacyCalls.register === visitorsBefore && data.stored.analytics === false);
await evaluate(`localStorage.removeItem('bm_privacy_v1')`);
await visit('producto.html?slug=celular-prueba', 390, 1800);
await evaluate(`document.querySelector('[data-privacy="accept"]').click()`); await delay(600);
expect('aceptar registra un visitante seudónimo', privacyCalls.register === visitorsBefore + 1);
await evaluate(`document.querySelector('#product-favorite').click()`); await delay(4800);
const trackedText = JSON.stringify(privacyCalls.events);
expect('eventos: favorito enviado con id único y sin datos personales', privacyCalls.events.some(event => event.type === 'favorite_added' && /^[0-9a-f-]{36}$/.test(event.event_id)) && !/Cliente Prueba|300 123 4567|phone|name/.test(trackedText), trackedText.slice(0, 160));
data = await evaluate(`({ complements: document.querySelector('#complement-section')?.innerText || '', reason: document.querySelector('#complement-section .product-card__reason')?.textContent || '' })`);
expect('ficha: complementos configurados en bloque propio y con motivo prudente', /Combina con este producto/.test(data.complements) && /Compatible con Celular de prueba/.test(data.reason), data.reason);
await evaluate(`localStorage.removeItem('bm_privacy_v1'); sessionStorage.clear()`);
Object.assign(settings, { tracking_enabled: false });

await visit('producto.html?slug=nevera-prueba', 390, 1500);
await evaluate(`document.querySelector('#add-cart').click()`); await delay(600);
await visit('carrito.html', 390, 1800);
const applyCoupon = async code => { await evaluate(`(() => { const input = document.querySelector('#coupon-code'); if (input.readOnly) document.querySelector('[data-coupon-remove]').click(); })()`); await delay(400); await evaluate(`(() => { const input = document.querySelector('#coupon-code'); input.value = '${code}'; input.form.requestSubmit(); })()`); await delay(1400); return evaluate(`({ status: document.querySelector('[data-coupon-status]')?.textContent || '', summary: document.querySelector('#cart-summary')?.innerText || '', overflow: document.documentElement.scrollWidth - innerWidth })`); };
data = await applyCoupon('VENCIDO');
expect('cupón vencido explicado sin cambiar el total', /venció/.test(data.status) && !/Código VENCIDO/.test(data.summary), data.status);
data = await applyCoupon('CAIDO');
expect('servicio de cupones no disponible: mensaje y carrito intacto', /No pudimos comprobar/.test(data.status), data.status);
data = await applyCoupon('PRUEBA10');
expect('cupón válido: ahorro y total actualizado en el carrito', /Código PRUEBA10/.test(data.summary) && /Ahorras/.test(data.status) && data.overflow <= 1, data.status);
await screenshot('cart-coupon-390');
await visit('checkout.html', 390, 2200);
data = await evaluate(`document.querySelector('#checkout-totals')?.innerText || ''`);
expect('checkout conserva y revalida el código', /Código PRUEBA10/.test(data), data.replace(/\n/g, ' | '));
await evaluate(`(() => { const f = document.querySelector('#checkout-form'); f.elements.fullName.value = 'Cliente Prueba'; f.elements.phone.value = '300 123 4567';
  f.querySelector('[name="delivery"]').click(); f.querySelector('[name="payment"]').click(); f.elements.legalAccept.checked = true; f.requestSubmit(); })()`);
await delay(4500);
expect('pedido: envía solo código y descuento visto; el servidor recalcula', lastOrderPayload?.coupon_code === 'PRUEBA10' && Number.isFinite(lastOrderPayload?.expected_discount) && !JSON.stringify(lastOrderPayload.items).includes('price'), JSON.stringify({ code: lastOrderPayload?.coupon_code, expected: lastOrderPayload?.expected_discount }));

for (const width of [390, 1440]) {
  for (const section of ['today', 'coupons', 'relationships', 'costs']) {
    await visit(`admin/index.html?section=${section}`, width, 2600);
    data = await evaluate(`({ title: document.querySelector('.admin-heading h1')?.textContent, overflow: document.documentElement.scrollWidth - innerWidth })`);
    expect(`panel ${section} @${width}`, Boolean(data.title), data.title || 'sin título');
    expect(`panel ${section} sin desbordamiento @${width}`, data.overflow <= 1, `${data.overflow}px`);
  }
  // La pantalla de carga del análisis dura unos segundos a propósito: se espera al informe.
  await visit(`admin/index.html?section=customer&id=${customerRef.id}`, width, 500);
  for (let waited = 0; waited < 12000 && !(await evaluate(`!!document.querySelector('.analysis-head')`)); waited += 250) await delay(250);
  await delay(400);
  data = await evaluate(`({ name: document.querySelector('.analysis-head h1')?.textContent, tabs: [...document.querySelectorAll('.analysis-tabs [role="tab"]')].map(tab => tab.textContent), text: document.querySelector('#admin-content')?.innerText || '', overflow: document.documentElement.scrollWidth - innerWidth })`);
  expect(`análisis con URL propia y 6 pestañas @${width}`, data.name === 'Cliente Prueba' && data.tabs.join('|') === 'Resumen|Intereses|Compras|Ofertas|Actividad|Seguimiento', data.tabs.join('|'));
  expect(`análisis: segmento, intención y plan de acción en primera pantalla @${width}`, /Segmento/i.test(data.text) && /Intención de compra/i.test(data.text) && /Plan de acción/i.test(data.text) && /Total comprado/i.test(data.text));
  expect(`análisis: recomendaciones con botón "Analizar y recomendar" @${width}`, /Analizar y recomendar/.test(data.text));
  expect(`análisis sin desbordamiento @${width}`, data.overflow <= 1, `${data.overflow}px`);
  if (width === 390) await screenshot('admin-customer-analysis-390'); else await screenshot('admin-customer-analysis-1440');
}
// Recomendaciones: escaneo animado → tarjetas con afinidad en % → oferta con código → WhatsApp.
await evaluate(`(() => { window.__opened = []; window.open = url => { const win = { closed: false, opener: null, document: { write() {} }, location: {} }; window.__opened.push(win); if (url) win.location.href = url; return win; }; })()`);
await evaluate(`document.querySelector('[data-reco-run]').click()`); await delay(700);
data = await evaluate(`({ scanning: !!document.querySelector('.reco-scan'), log: document.querySelector('.reco-log')?.innerText || '' })`);
expect('recomendaciones: animación de análisis con consola de datos reales', data.scanning && /historial/.test(data.log), data.log.slice(0, 80));
await delay(7500);
data = await evaluate(`({ items: document.querySelectorAll('.reco-item').length, score: document.querySelector('.reco-item__score b')?.innerText || '', checked: document.querySelectorAll('.reco-item input:checked').length, text: document.querySelector('[data-reco-panel]')?.innerText || '' })`);
expect('recomendaciones: tarjetas con afinidad en % y motivos', (data.items > 0 && /\d+ %/.test(data.score)) || /afinidad suficiente/.test(data.text), `${data.items} tarjetas · ${data.score}`);
await screenshot('admin-customer-reco-1440');
if (data.items > 0) {
  if (!data.checked) await evaluate(`document.querySelector('.reco-item input').click()`);
  await evaluate(`document.querySelector('[data-reco-campaign]').click()`); await delay(1200);
  data = await evaluate(`({ modal: !!document.querySelector('.modal--campaign'), totals: document.querySelector('[data-totals]')?.innerText || '', message: document.querySelector('.campaign textarea')?.value || '' })`);
  expect('oferta: totales calculados por la tienda y mensaje con espacio para el código', data.modal && /Total para/.test(data.totals) && data.message.includes('[CÓDIGO]'), data.totals.slice(0, 60));
  await screenshot('admin-customer-campaign-1440');
  await evaluate(`document.querySelector('.modal--campaign [data-go]').click()`); await delay(1500);
  data = await evaluate(`({ code: document.querySelector('.campaign__code code')?.textContent || '', url: window.__opened.at(-1)?.location?.href || '' })`);
  const sent = new URL(data.url || 'https://x.invalid/?text=').searchParams.get('text') || '';
  expect('oferta: genera el código y abre WhatsApp con el mensaje y el código', data.code === 'OF-PRUEBA7' && data.url.startsWith('https://wa.me/') && sent.includes('OF-PRUEBA7') && !sent.includes('[CÓDIGO]') && offerCalls.length === 1, `${data.code} · ${sent.slice(0, 60)}`);
  await screenshot('admin-customer-campaign-done-1440');
  await evaluate(`document.querySelector('.modal--campaign .modal__close')?.click()`); await delay(300);
}
await evaluate(`document.querySelector('[data-refresh]').click()`); await delay(2500);
data = await evaluate(`({ status: document.querySelector('.analysis-coverage')?.textContent || '' })`);
expect('"Actualizar datos" vuelve a consultar y muestra la hora y la versión', /Datos consultados/.test(data.status) && /metricas-/.test(data.status), data.status.slice(0, 120));

await visit('producto.html?slug=juguete-agotado', 390, 1800);
data = await evaluate(`({ visible: !document.querySelector('#restock-notice')?.hidden })`);
expect('ficha agotada ofrece "Avísame cuando llegue"', data.visible);
await evaluate(`document.querySelector('#restock-notice').click()`); await delay(400);
await evaluate(`(() => { const f = document.querySelector('.restock-form'); f.elements.name.value = 'Cliente Aviso'; f.elements.phone.value = '300 765 4321'; f.requestSubmit(); })()`); await delay(400);
data = await evaluate(`document.querySelector('.restock-form [data-error]')?.textContent || ''`);
expect('aviso de disponibilidad exige autorización expresa', /autorizar/.test(data) && !restockCalls.length, data);
await evaluate(`(() => { const f = document.querySelector('.restock-form'); f.elements.accepted.checked = true; f.requestSubmit(); })()`); await delay(800);
expect('aviso de disponibilidad registrado con la variante agotada', restockCalls.length === 1 && restockCalls[0].accepted === true && restockCalls[0].target_variant, JSON.stringify(restockCalls[0] || {}));

const remote = intercepted.length;
expect('todas las peticiones a Supabase fueron interceptadas (ninguna salió a la red)', remote > 0, `${remote} peticiones simuladas`);
const relevantErrors = errors.filter(line => !/favicon|robots\.txt|Failed to load resource: the server responded with a status of 404/.test(line));
expect('sin excepciones ni console.error en la interfaz', relevantErrors.length === 0, relevantErrors.slice(0, 5).join(' | '));

socket.close(); chrome.kill(); server.close();
console.log([...results, ...failures].join('\n'));
console.log(`\n${results.length} verificaciones superadas, ${failures.length} fallidas. Capturas y PDF en ${outDir}`);
if (failures.length) process.exit(1);
