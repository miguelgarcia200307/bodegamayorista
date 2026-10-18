// Pruebas SQL de la evolución CRM (cupones, ofertas, eventos, identidad, tareas y
// permisos) sobre PGlite en memoria. Datos ficticios; no se conecta a ningún proyecto.
// Uso: $env:PGLITE_DIR='<carpeta>'; node tools/qa-db-crm.mjs
// Limitación: PGlite tiene UNA conexión. La competencia real por el último uso de un
// cupón (prueba 21) está preparada en tools/qa-concurrency.mjs para un Postgres real.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const pgliteDir = process.env.PGLITE_DIR ? join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist') : null;
const load = async (bare, file) => pgliteDir ? import(pathToFileURL(join(pgliteDir, file)).href) : import(bare);
const { PGlite } = await load('@electric-sql/pglite', 'index.js');
const { pg_trgm } = await load('@electric-sql/pglite/contrib/pg_trgm', 'contrib/pg_trgm.js');
const { unaccent } = await load('@electric-sql/pglite/contrib/unaccent', 'contrib/unaccent.js');
globalThis.location = { pathname: '/admin/', href: 'http://localhost/admin/' };
const M = await import(pathToFileURL(join(root, 'js/lib/metrics.js')).href);

const db = new PGlite({ extensions: { pg_trgm, unaccent } });
const ADMIN = '00000000-0000-4000-8000-00000000000a', INTRUDER = '00000000-0000-4000-8000-00000000000b', SELLER = '00000000-0000-4000-8000-00000000000c';
let passed = 0; const failures = [];
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
async function as(role, uid = '') { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false);${role === 'postgres' ? '' : ` set role ${role};`}`); }
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
  finally { await db.exec('reset role'); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) { if (String(actual) !== String(expected)) throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`); }
async function rejects(promise, pattern, label) {
  try { await promise; } catch (error) { if (pattern && !pattern.test(`${error.message} ${error.code || ''} ${error.detail || ''}`)) throw new Error(`${label}: error inesperado «${error.message}» (${error.code})`); return error; }
  throw new Error(`${label}: se esperaba un error`);
}

await db.exec(readFileSync(join(root, 'tools/qa-db-bootstrap.sql'), 'utf8'));
for (const file of readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort())
  await db.exec(readFileSync(join(root, 'supabase/migrations', file), 'utf8').replace(/^create extension if not exists pg_graphql;$/m, ''));

// --- Catálogo y negocio ficticios -------------------------------------------------
const P = n => `30000000-0000-4000-8000-00000000000${n}`, V = n => `60000000-0000-4000-8000-00000000000${n}`;
const CAT_A = 'c0000000-0000-4000-8000-000000000001', CAT_B = 'c0000000-0000-4000-8000-000000000002', BRAND = 'b0000000-0000-4000-8000-000000000001';
const DELIVERY = '10000000-0000-4000-8000-000000000001', PICKUP = '10000000-0000-4000-8000-000000000002', PAY = '20000000-0000-4000-8000-000000000001';
await db.exec(`
  insert into auth.users(id, email) values ('${ADMIN}', 'a@x.local'), ('${INTRUDER}', 'i@x.local'), ('${SELLER}', 's@x.local');
  insert into public.admins(user_id) values ('${ADMIN}');
  insert into public.admins(user_id, role) values ('${SELLER}', 'vendedor');
  update public.site_settings set whatsapp = '573000000000', analytics_consent_version = 'an-1', tracking_enabled = false where id = 1;
  insert into public.delivery_methods(id, name, base_cost) values ('${DELIVERY}', 'Envío prueba', 8000), ('${PICKUP}', 'Retiro prueba', 0);
  insert into public.payment_methods(id, name) values ('${PAY}', 'Pago prueba');
  insert into public.categories(id, name, slug) values ('${CAT_A}', 'Cat A', 'cat-a'), ('${CAT_B}', 'Cat B', 'cat-b');
  insert into public.brands(id, name, slug) values ('${BRAND}', 'Marca', 'marca');
  insert into public.products(id, name, slug, base_price, status, brand_id) values
    ('${P(1)}', 'Producto 100k', 'p100', 100000, 'published', '${BRAND}'),
    ('${P(2)}', 'Producto 50k', 'p50', 50000, 'published', null),
    ('${P(3)}', 'Cable tramos', 'cable', 25000, 'published', null),
    ('${P(4)}', 'Promo', 'promo', 80000, 'published', null);
  update public.products set promo_price = 60000 where id = '${P(4)}';
  insert into public.product_categories values ('${P(1)}', '${CAT_A}'), ('${P(2)}', '${CAT_B}'), ('${P(3)}', '${CAT_B}'), ('${P(4)}', '${CAT_A}');
  insert into public.product_variants(id, product_id, stock) values ('${V(1)}', '${P(1)}', 50), ('${V(2)}', '${P(2)}', 50), ('${V(3)}', '${P(3)}', 200), ('${V(4)}', '${P(4)}', 50);
  insert into public.product_price_tiers(product_id, min_quantity, unit_price) values ('${P(3)}', 6, 22000), ('${P(3)}', 12, 19000);
`);
const cart = (...lines) => JSON.stringify(lines.map(([variant, quantity]) => ({ variant_id: variant, quantity })));
let phoneSeq = 1000;
const orderPayload = (items, extra = {}) => JSON.stringify({ name: 'Cliente Demo', phone: `300 555 ${String(phoneSeq++).padStart(4, '0')}`, delivery_method_id: DELIVERY, payment_method_id: PAY, items: JSON.parse(items), ...extra });
const createOrder = async (body, key = crypto.randomUUID()) => one('select * from public.create_storefront_order($1::jsonb, $2::uuid)', [body, key]);
const validate = async (items, code, visitor = null, delivery = DELIVERY) => (await one('select public.validate_cart_coupon($1::jsonb, $2, $3::jsonb, $4::uuid) as r', [items, code, visitor ? JSON.stringify(visitor) : null, delivery])).r;
async function coupon(payload) { await as('authenticated', ADMIN); const c = await one('select * from public.save_coupon(null, $1::jsonb)', [JSON.stringify(payload)]); await as('postgres'); return c; }

console.log('Cupones y dinero');
await test('17. 100.000 + 50.000, 10 % solo al primero, envío 8.000 → descuento 10.000 y total 148.000', async () => {
  const c = await coupon({ code: 'DIEZ-A', name: 'Diez A', kind: 'porcentaje', value: 10, scopes: [{ scope_type: 'product', target_id: P(1), mode: 'incluir' }] });
  await as('anon');
  const r = await validate(cart([V(1), 1], [V(2), 1]), 'diez-a');
  equal(r.status, 'valido', 'estado'); equal(Number(r.discount_total), 10000, 'descuento'); equal(Number(r.total), 148000, 'total');
  equal(r.lines.find(l => l.variant_id === V(2)).eligible, false, 'segundo no elegible');
  const o = await createOrder(orderPayload(cart([V(1), 1], [V(2), 1]), { coupon_code: 'DIEZ-A', expected_discount: 10000 }));
  equal(Number(o.total), 148000, 'total del pedido');
  const line = o.items.find(item => item.name === 'Producto 100k'); equal(Number(line.discount), 10000, 'descuento de línea'); equal(Number(line.line_total), 90000, 'neto de línea');
  await as('postgres');
  equal((await one(`select count(*)::int n from public.coupon_uses where coupon_id = $1 and status = 'reservada'`, [c.id])).n, 1, 'reserva creada');
});
await test('18. quitar el elegible o bajar del mínimo recalcula y explica', async () => {
  await coupon({ code: 'MIN-200', name: 'Mínimo', kind: 'valor_fijo', value: 20000, min_eligible: 200000 });
  await as('anon');
  equal((await validate(cart([V(2), 1]), 'DIEZ-A')).status, 'sin_productos_elegibles', 'sin el producto elegible');
  const r = await validate(cart([V(1), 1]), 'MIN-200');
  equal(r.status, 'minimo_no_alcanzado', 'mínimo'); equal(Number(r.missing_for_minimum), 100000, 'faltante');
  equal(Number((await validate(cart([V(1), 2]), 'MIN-200')).discount_total), 20000, 'al alcanzar el mínimo');
});
await test('19. tramo, promoción y política de acumulación explícita', async () => {
  await coupon({ code: 'ACUM-SI', name: 'Acumula', kind: 'porcentaje', value: 10 });
  await coupon({ code: 'ACUM-NO', name: 'Solo regular', kind: 'porcentaje', value: 10, stacking: 'solo_precio_regular' });
  await as('anon');
  const tier = await validate(cart([V(3), 12]), 'ACUM-SI');
  equal(Number(tier.subtotal), 228000, 'tramo 12 × 19.000'); equal(Number(tier.discount_total), 22800, '10 % sobre precio elegible');
  equal((await validate(cart([V(3), 12]), 'ACUM-NO')).status, 'sin_productos_elegibles', 'tramo excluido en solo_precio_regular');
  const mixed = await validate(cart([V(4), 1], [V(2), 1]), 'ACUM-NO');
  equal(Number(mixed.discount_total), 5000, 'solo la línea sin promoción'); equal(Number(mixed.subtotal), 110000, 'promo 60.000 + 50.000');
});
await test('20. vencido, inactivo, sin usos, audiencia, payload manipulado', async () => {
  const exp = await coupon({ code: 'VENCIDO', name: 'Vencido', kind: 'porcentaje', value: 5, ends_at: '2026-01-02T00:00:00Z', starts_at: '2026-01-01T00:00:00Z' });
  await coupon({ code: 'APAGADO', name: 'Apagado', kind: 'porcentaje', value: 5, active: false });
  await as('anon');
  equal((await validate(cart([V(1), 1]), 'VENCIDO')).status, 'vencido', 'vencido');
  equal((await validate(cart([V(1), 1]), 'APAGADO')).status, 'no_valido', 'inactivo no se distingue de inexistente');
  equal((await validate(cart([V(1), 1]), 'NOEXISTE')).status, 'no_valido', 'inexistente');
  equal((await validate(cart([V(1), 1]), '')).status, 'vacio', 'vacío');
  await rejects(createOrder(orderPayload(cart([V(1), 1]), { coupon_code: 'ACUM-SI', expected_discount: 50000 })), /BM011|cambió/, 'descuento esperado manipulado');
  const priced = await createOrder(orderPayload(JSON.stringify([{ variant_id: V(1), quantity: 1, unit_price: 1, discount: 99999 }]), { coupon_code: 'ACUM-SI', discount_total: 99999, total: 1 }));
  equal(Number(priced.total), 98000, 'el servidor ignora precios y descuentos del navegador (100.000 − 10.000 + 8.000)');
  await rejects(createOrder(orderPayload(cart([V(1), 1]), { coupon_code: 'VENCIDO' })), /BM010|ya no aplica/, 'cupón vencido en pedido');
  void exp;
});
let lastUse;
await test('21. último uso: la segunda reserva se rechaza; reintento idempotente no duplica (concurrencia real: ver qa-concurrency)', async () => {
  const c = await coupon({ code: 'UNO-SOLO', name: 'Uno', kind: 'valor_fijo', value: 5000, max_uses_total: 1 });
  await as('anon');
  const key = crypto.randomUUID(); const body = orderPayload(cart([V(2), 1]), { coupon_code: 'UNO-SOLO' });
  const a = await createOrder(body, key); const again = await createOrder(body, key);
  equal(a.order_number, again.order_number, 'mismo pedido');
  await rejects(createOrder(orderPayload(cart([V(2), 1]), { coupon_code: 'UNO-SOLO' })), /BM010|ya no aplica/, 'sin usos');
  await as('postgres');
  equal((await one('select count(*)::int n from public.coupon_uses where coupon_id = $1', [c.id])).n, 1, 'un único uso');
  lastUse = { coupon: c, order: a };
});
await test('22. validar no consume; reserva vencida exige revisión; cancelar libera una vez; devolución no reactiva', async () => {
  const c = lastUse.coupon;
  await as('anon'); await validate(cart([V(2), 1]), 'UNO-SOLO'); await as('postgres');
  equal((await one('select count(*)::int n from public.coupon_uses where coupon_id = $1', [c.id])).n, 1, 'validar no crea usos');
  const orderRow = await one('select id from public.orders where order_number = $1', [lastUse.order.order_number]);
  await as('authenticated', ADMIN);
  const sale = await one('select * from public.create_sale_from_order($1)', [orderRow.id]);
  equal(Number(sale.discount_total), 5000, 'la venta conserva el descuento'); equal(Number(sale.total), 53000, 'total de la venta');
  await as('postgres'); await db.query(`update public.coupon_uses set expires_at = now() - interval '1 minute' where coupon_id = $1`, [c.id]);
  await as('authenticated', ADMIN);
  await rejects(one('select * from public.confirm_sale($1)', [sale.id]), /BM002|venció/, 'reserva vencida');
  await one('select * from public.confirm_sale($1, true)', [sale.id]);
  await as('postgres');
  const used = await one('select status, honored_after_review from public.coupon_uses where coupon_id = $1', [c.id]);
  equal(used.status, 'consumida', 'consumido'); equal(used.honored_after_review, true, 'marcado como revisado');
  await as('authenticated', ADMIN);
  await one(`select * from public.cancel_sale($1, 'prueba')`, [sale.id]); await one(`select * from public.cancel_sale($1)`, [sale.id]);
  await as('postgres');
  const released = await one('select status, release_reason from public.coupon_uses where coupon_id = $1', [c.id]);
  equal(released.status, 'liberada', 'liberado'); equal(released.release_reason, 'venta_cancelada', 'motivo');
  equal((await one('select count(*)::int n from public.coupon_uses where coupon_id = $1', [c.id])).n, 1, 'sin dobles restauraciones');
  // Devolución total sin política de liberación: el uso sigue consumido.
  await coupon({ code: 'DEVOL', name: 'Devol', kind: 'valor_fijo', value: 1000 });
  await as('anon'); const o2 = await createOrder(orderPayload(cart([V(2), 1]), { coupon_code: 'DEVOL' })); await as('postgres');
  const id2 = (await one('select id from public.orders where order_number = $1', [o2.order_number])).id;
  await as('authenticated', ADMIN);
  const s2 = await one('select * from public.create_sale_from_order($1)', [id2]); await one('select * from public.confirm_sale($1)', [s2.id]);
  const item = (await one('select id from public.sale_items where sale_id = $1', [s2.id])).id;
  await one('select * from public.register_sale_return($1, $2::jsonb, true, $3)', [s2.id, JSON.stringify([{ sale_item_id: item, quantity: 1 }]), crypto.randomUUID()]);
  await as('postgres');
  equal((await one(`select u.status from public.coupon_uses u join public.coupons c on c.id = u.coupon_id where c.code = 'DEVOL'`)).status, 'consumida', 'devolución no libera por defecto');
  equal((await one('select public.sale_kept_cents($1) c', [s2.id])).c, 0, 'neto conservado 0 tras devolución total');
  // Pedido cancelado libera la reserva; reabrirlo no la reactiva.
  await as('anon'); const o3 = await createOrder(orderPayload(cart([V(2), 1]), { coupon_code: 'DEVOL' })); await as('postgres');
  const id3 = (await one('select id from public.orders where order_number = $1', [o3.order_number])).id;
  await as('authenticated', ADMIN);
  await db.query(`update public.orders set status = 'cancelado' where id = $1`, [id3]); await db.query(`update public.orders set status = 'pendiente' where id = $1`, [id3]);
  await as('postgres');
  equal((await one('select status from public.coupon_uses where order_id = $1', [id3])).status, 'liberada', 'no se reactiva');
});
await test('23. reparto por línea exacto y coherente en pedido, venta y devolución parcial', async () => {
  await coupon({ code: 'TRES', name: 'Tres', kind: 'valor_fijo', value: 10000 });
  await as('anon');
  const r = await validate(cart([V(1), 1], [V(2), 1], [V(4), 1]), 'TRES');
  const parts = r.lines.map(l => Number(l.discount));
  equal(parts.reduce((a, b) => a + b, 0), 10000, 'suma de líneas'); assert(parts.every(Number.isInteger), 'pesos enteros');
  // Esperado independiente: 10.000 × (100k, 50k, 60k)/210k = 4761,9 / 2380,9 / 2857,1 → 4762, 2381, 2857.
  equal(JSON.stringify(r.lines.map(l => [Number(l.gross), Number(l.discount)]).sort((a, b) => b[0] - a[0])), JSON.stringify([[100000, 4762], [60000, 2857], [50000, 2381]]), 'reparto');
  const o = await createOrder(orderPayload(cart([V(1), 1], [V(2), 1], [V(4), 1]), { coupon_code: 'TRES', expected_discount: 10000 }));
  await as('postgres');
  const id = (await one('select id from public.orders where order_number = $1', [o.order_number])).id;
  await as('authenticated', ADMIN);
  const sale = await one('select * from public.create_sale_from_order($1)', [id]);
  await as('postgres');
  const saleRow = await one(`select s.*, (select jsonb_agg(to_jsonb(i)) from public.sale_items i where i.sale_id = s.id) as sale_items, '[]'::jsonb as sale_returns from public.sales s where s.id = $1`, [sale.id]);
  const eco = M.saleEconomics({ ...saleRow, sale_items: saleRow.sale_items, sale_returns: [] });
  equal(eco.discountCents, 1000000, 'descuento en venta (JS)'); equal(Number(saleRow.total), 208000, 'total venta = pedido');
  equal(Number(o.total), 208000, 'total pedido');
});
await test('24. una oferta privada no altera precios ni promoción pública', async () => {
  const CUST = (await one(`select id from public.customers limit 1`)).id;
  const before = await one(`select base_price, promo_price from public.products where id = $1`, [P(4)]);
  await as('authenticated', ADMIN);
  const created = (await one(`select public.create_customer_offer($1::jsonb) r`, [JSON.stringify({ customer_id: CUST, title: 'Oferta demo', items: [{ variant_id: V(4), quantity: 2 }], benefit: { kind: 'porcentaje', value: 15 } })])).r;
  assert(/^OF-[A-Z0-9]{8}$/.test(created.coupon.code), `código ${created.coupon.code}`);
  equal(Number(created.offer.totals.discount_total), 18000, '15 % de 2 × 60.000');
  await as('postgres');
  const after = await one(`select base_price, promo_price from public.products where id = $1`, [P(4)]);
  equal(JSON.stringify(after), JSON.stringify(before), 'precios públicos');
  equal((await one(`select count(*)::int n from public.contact_attempts where offer_id = $1 and kind = 'preparado'`, [created.offer.id])).n, 1, 'contacto preparado ≠ enviado');
  await as('authenticated', ADMIN);
  const quote = await one(`select * from public.create_quote_from_offer($1)`, [created.offer.id]);
  equal(Number(quote.total), 102000, 'cotización vinculada con el mismo neto');
});

console.log('\nEventos, consentimiento e identidad');
let visitor; let session = crypto.randomUUID();
const ev = (type, extra = {}) => ({ event_id: crypto.randomUUID(), type, session_id: session, occurred_at: new Date().toISOString(), ...extra });
const track = async (events, v = visitor) => one('select * from public.track_events($1, $2, $3::jsonb)', [v.visitor_id, v.visitor_secret, JSON.stringify(events)]);
await test('11. con la captura desactivada o sin autorización no se crea perfil ni se guarda nada', async () => {
  await as('anon');
  await rejects(one(`select * from public.register_visitor('{"analytics": true, "version": "an-1"}')`), /BM020|no está habilitada/, 'captura desactivada');
  await as('postgres'); await db.exec(`update public.site_settings set tracking_enabled = true where id = 1`);
  await as('anon');
  await rejects(one(`select * from public.register_visitor('{"analytics": false, "version": "an-1"}')`), /autorización/, 'rechazo');
  await rejects(one(`select * from public.register_visitor('{"analytics": true, "version": "otra"}')`), /versión/, 'versión distinta');
  await as('postgres'); equal((await one('select count(*)::int n from public.visitors')).n, 0, 'sin visitantes');
});
await test('15. lotes malformados, duplicados, recargas y tipos falsos no inflan señales', async () => {
  await as('anon');
  visitor = await one(`select * from public.register_visitor('{"analytics": true, "personalization": true, "version": "an-1"}')`);
  const view = ev('view_product', { product_id: P(1), properties: { active_ms: 8000 } });
  let r = await track([view, view, ev('view_product', { product_id: P(1), properties: { active_ms: 1000 } }), ev('order_created', { product_id: P(1) }), ev('sale_confirmed'), ev('view_product', { product_id: P(1), variant_id: V(2), properties: { active_ms: 9000 } })]);
  equal(r.accepted, 1, 'aceptados'); equal(r.rejected, 5, 'rechazados (duplicado, breve, tipos de servidor, variante ajena)');
  for (let k = 0; k < 8; k += 1) await track([ev('view_product', { product_id: P(1), properties: { active_ms: 5000 } })]);
  await as('postgres');
  equal((await one(`select count(*)::int n from public.behavior_events where event_type = 'view_product'`)).n, 5, 'tope de 5 visitas por producto y día');
  equal((await one(`select count(*)::int n from public.sales`)).n >= 0, true, 'n/a');
  await as('anon');
  r = await track([ev('search_submitted', { properties: { term: 'Audífonos 300 123 4567 juan@correo.com', name: 'Juan' } })]);
  await as('postgres');
  const search = await one(`select properties from public.behavior_events where event_type = 'search_submitted'`);
  equal(JSON.stringify(search.properties), JSON.stringify({ term: 'audífonos' }), 'búsqueda saneada');
  await as('anon');
  r = await track([ev('cart_item_added', { product_id: P(1) })], { visitor_id: visitor.visitor_id, visitor_secret: 'x'.repeat(40) });
  equal(r.accepted, 0, 'secreto incorrecto');
  await rejects(track(Array.from({ length: 30 }, () => ev('favorite_added', { product_id: P(1) }))), /Lote/, 'lote demasiado grande');
});
await test('16. la sesión de otro visitante no se puede usar; el colector no concede lectura', async () => {
  await as('anon');
  const other = await one(`select * from public.register_visitor('{"analytics": true, "version": "an-1"}')`);
  const r = await one('select * from public.track_events($1, $2, $3::jsonb)', [other.visitor_id, other.visitor_secret, JSON.stringify([ev('favorite_added', { product_id: P(2) })])]);
  equal(r.accepted, 0, 'sesión ajena');
  await rejects(rows('select * from public.behavior_events'), /permission denied/, 'lectura anónima');
  await rejects(rows('select * from public.identity_links'), /permission denied/, 'lectura de vínculos');
});
let customerId;
await test('13. el pedido con teléfono solo vincula la SESIÓN del pedido como "declarado"', async () => {
  await as('anon');
  const earlier = session; session = crypto.randomUUID();
  await track([ev('view_product', { product_id: P(2), properties: { active_ms: 6000 } }), ev('cart_item_added', { product_id: P(2), properties: { quantity: 1 } })]);
  const o = await createOrder(orderPayload(cart([V(2), 1]), { phone: '311 222 3344', visitor: { id: visitor.visitor_id, secret: visitor.visitor_secret, session_id: session }, customer_id: '00000000-0000-4000-8000-000000000999' }));
  await as('postgres');
  customerId = (await one(`select customer_id from public.orders where order_number = $1`, [o.order_number])).customer_id;
  assert(customerId !== '00000000-0000-4000-8000-000000000999', 'customer_id del navegador ignorado');
  const link = await one(`select level, method, session_id from public.identity_links where customer_id = $1`, [customerId]);
  equal(link.level, 'declarado', 'nivel'); equal(link.session_id, session, 'solo la sesión del pedido');
  await as('authenticated', ADMIN);
  const signals = await rows('select * from public.crm_customer_signals($1)', [customerId]);
  equal(signals.length, 1, 'solo el producto visto en esa sesión'); equal(signals[0].product_id, P(2), 'producto'); equal(signals[0].identity_level, 'declarada', 'nivel');
  void earlier;
});
await test('13b. teléfono declarado no habilita cupón personal; verificación por WhatsApp entrante sí', async () => {
  await as('authenticated', ADMIN);
  const created = (await one(`select public.create_customer_offer($1::jsonb) r`, [JSON.stringify({ customer_id: customerId, title: 'Personal', audience: 'cliente_verificado', items: [{ variant_id: V(2), quantity: 1 }], benefit: { kind: 'valor_fijo', value: 3000 } })])).r;
  await as('anon');
  const vis = { id: visitor.visitor_id, secret: visitor.visitor_secret };
  equal((await validate(cart([V(2), 1]), created.coupon.code, vis)).status, 'requiere_verificacion', 'declarado no basta');
  const req = await one('select * from public.request_identity_verification($1, $2, $3, $4)', [visitor.visitor_id, visitor.visitor_secret, '+57 311 222 3344', session]);
  assert(/^V-[A-Z0-9]{6}$/.test(req.code), 'código');
  const ghost = await one('select * from public.request_identity_verification($1, $2, $3)', [visitor.visitor_id, visitor.visitor_secret, '320 999 0000']);
  equal(Object.keys(ghost).sort().join(), 'code,expires_at,whatsapp', 'misma respuesta exista o no el cliente');
  await as('authenticated', ADMIN);
  await rejects(one('select * from public.confirm_identity_verification($1, $2)', [req.code, '320 000 0000']), /no coincide/, 'número distinto');
  await as('anon');
  const req2 = await one('select * from public.request_identity_verification($1, $2, $3, $4)', [visitor.visitor_id, visitor.visitor_secret, '3112223344', session]);
  await as('authenticated', ADMIN);
  const link = await one('select * from public.confirm_identity_verification($1, $2, $3)', [req2.code, '+573112223344', 'Mensaje recibido']);
  equal(link.level, 'verificado', 'verificado'); equal(link.method, 'whatsapp_entrante', 'método');
  await as('anon');
  equal((await validate(cart([V(2), 1]), created.coupon.code, vis)).status, 'valido', 'cupón personal habilitado');
});
await test('14. dispositivo compartido: verificar a otra persona termina el vínculo anterior', async () => {
  // El límite de 3 códigos por hora por visitante ya se ejerció arriba; se simula el paso del tiempo.
  await as('postgres'); await db.exec(`update public.identity_verifications set requested_at = now() - interval '2 hours'`);
  await as('anon');
  await createOrder(orderPayload(cart([V(1), 1]), { phone: '315 444 5566' }));
  const req = await one('select * from public.request_identity_verification($1, $2, $3)', [visitor.visitor_id, visitor.visitor_secret, '315 444 5566']);
  await as('authenticated', ADMIN);
  await one('select * from public.confirm_identity_verification($1, $2)', [req.code, '3154445566']);
  await as('postgres');
  const prev = await rows(`select level, ended_reason from public.identity_links where customer_id = $1 and level = 'verificado'`, [customerId]);
  equal(prev.length, 0, 'el vínculo verificado anterior terminó');
});
await test('12. retirar la autorización borra eventos crudos, termina vínculos y detiene la captura', async () => {
  await as('anon');
  await one('select public.set_visitor_consent($1, $2, $3::jsonb)', [visitor.visitor_id, visitor.visitor_secret, JSON.stringify({ analytics: false })]);
  const r = await track([ev('favorite_added', { product_id: P(1) })]).catch(() => ({ accepted: 0 }));
  equal(r.accepted, 0, 'sin captura tras el retiro');
  // Un borrador local antiguo que vuelve a enviar "true" no reactiva: el visitante quedó revocado.
  equal((await one('select public.set_visitor_consent($1, $2, $3::jsonb) ok', [visitor.visitor_id, visitor.visitor_secret, JSON.stringify({ analytics: true })])).ok, false, 'no se reactiva');
  await as('postgres');
  equal((await one('select count(*)::int n from public.behavior_events where visitor_id = $1', [visitor.visitor_id])).n, 0, 'eventos borrados');
  equal((await one(`select count(*)::int n from public.identity_links where visitor_id = $1 and level <> 'desvinculado'`, [visitor.visitor_id])).n, 0, 'vínculos terminados');
  equal((await one(`select count(*)::int n from public.visitor_consent_events where visitor_id = $1 and action = 'retirado'`, [visitor.visitor_id])).n, 1, 'prueba del retiro conservada');
});
await test('Retención: la depuración agrega y borra crudos vencidos', async () => {
  await as('anon');
  const v2 = await one(`select * from public.register_visitor('{"analytics": true, "version": "an-1"}')`); session = crypto.randomUUID();
  await one('select * from public.track_events($1, $2, $3::jsonb)', [v2.visitor_id, v2.visitor_secret, JSON.stringify([ev('view_product', { product_id: P(3), properties: { active_ms: 4000 } })])]);
  await as('postgres'); await db.exec(`update public.behavior_events set received_at = now() - interval '120 days'`);
  await as('authenticated', ADMIN);
  const res = (await one('select public.purge_behavior_data() r')).r;
  assert(res.eventos_borrados >= 1, 'borra crudos');
  await as('postgres');
  equal((await one('select count(*)::int n from public.behavior_events')).n, 0, 'sin crudos vencidos');
  assert((await one(`select sum(events)::int n from public.behavior_daily_aggregates where product_id = $1`, [P(3)])).n >= 1, 'agregado minimizado sin visitante');
});

console.log('\nMétricas en servidor');
await test('1 (SQL). ranking neto igual al contrato JS: devolución parcial ubica a B sobre A', async () => {
  await as('postgres');
  const A = (await one(`insert into public.customers(full_name, phone_original) values ('Cliente A', '3201110001') returning id`)).id;
  const B = (await one(`insert into public.customers(full_name, phone_original) values ('Cliente B', '3201110002') returning id`)).id;
  await as('authenticated', ADMIN);
  const sa = await one(`select * from public.create_manual_sale($1::jsonb)`, [JSON.stringify({ customer_id: A, items: [{ variant_id: V(1), quantity: 10, unit_price: 10 }] })]);
  const sb = await one(`select * from public.create_manual_sale($1::jsonb)`, [JSON.stringify({ customer_id: B, items: [{ variant_id: V(1), quantity: 1, unit_price: 50 }] })]);
  await one('select * from public.confirm_sale($1)', [sa.id]); await one('select * from public.confirm_sale($1)', [sb.id]);
  const item = (await one('select id from public.sale_items where sale_id = $1', [sa.id])).id;
  await one('select * from public.register_sale_return($1, $2::jsonb, true, $3)', [sa.id, JSON.stringify([{ sale_item_id: item, quantity: 9 }]), crypto.randomUUID()]);
  const rankA = await one('select * from public.crm_customer_ranking($1)', [A]); const rankB = await one('select * from public.crm_customer_ranking($1)', [B]);
  assert(rankB.position_rank < rankA.position_rank, `B (${rankB.position_rank}) debe ir antes que A (${rankA.position_rank})`);
  equal(rankA.kept_cents, 1000, 'A neto 10'); equal(rankB.kept_cents, 5000, 'B neto 50');
});

console.log('\nTareas y permisos');
await test('27. tareas sin duplicados; completada/pospuesta no reaparece; respeta permisos de contacto', async () => {
  await as('authenticated', ADMIN);
  const first = (await one('select public.generate_customer_tasks() n')).n;
  const second = (await one('select public.generate_customer_tasks() n')).n;
  assert(first > 0, 'genera tareas'); equal(second, 0, 'segunda corrida sin duplicados');
  const task = await one(`select * from public.customer_tasks where status = 'pendiente' order by priority desc limit 1`);
  await rejects(one(`select * from public.set_task_status($1, '{"status":"descartada"}'::jsonb)`, [task.id]), /motivo/, 'descartar exige motivo');
  await rejects(one(`select * from public.set_task_status($1, '{"status":"pospuesta","next_review_at":"2020-01-01"}'::jsonb)`, [task.id]), /futura/, 'posponer exige fecha futura');
  await one(`select * from public.set_task_status($1, '{"status":"completada","outcome":"contactado"}'::jsonb)`, [task.id]);
  equal((await one('select public.generate_customer_tasks() n')).n, 0, 'no se regenera la completada');
  await as('postgres');
  equal((await one(`select count(*)::int n from public.customer_tasks where promotional`)).n, 0, 'sin autorización promocional no hay tareas promocionales');
  equal((await one(`select count(*)::int n from public.customer_tasks where kind = 'devolucion'`)).n >= 1, true, 'devolución por resolver');
});
await test('25/26. visitante, autenticado sin rol, vendedor y propietario', async () => {
  await as('anon');
  for (const table of ['coupons','coupon_uses','customer_offers','customer_tasks','contact_attempts','visitors','store_plan'])
    await rejects(rows(`select * from public.${table}`), /permission denied/, `anon ${table}`);
  await rejects(rows('select public.crm_customer_ranking(gen_random_uuid())'), /permission denied/, 'anon ranking');
  await as('authenticated', INTRUDER);
  equal((await rows('select * from public.coupons')).length, 0, 'intruso no ve cupones (RLS)');
  equal((await rows('select * from public.customers')).length, 0, 'intruso no ve clientes');
  await rejects(rows('select * from public.crm_customer_ranking(gen_random_uuid())'), /Sin permiso/, 'intruso ranking');
  await rejects(rows(`select * from public.save_coupon(null, '{"name":"x","kind":"porcentaje","value":50}'::jsonb)`), /Sin permiso/, 'intruso cupón');
  await as('authenticated', SELLER);
  assert((await rows('select * from public.customers')).length > 0, 'vendedor lee clientes');
  equal((await one('select public.generate_customer_tasks() n')).n >= 0, true, 'vendedor genera tareas');
  await rejects(rows(`select * from public.save_coupon(null, '{"name":"x","kind":"porcentaje","value":50}'::jsonb)`), /Sin permiso/, 'vendedor no crea cupones públicos');
  await rejects(rows('select * from public.confirm_sale(gen_random_uuid())'), /Sin permiso/, 'vendedor no confirma ventas');
  const offer = (await one(`select public.create_customer_offer($1::jsonb) r`, [JSON.stringify({ customer_id: customerId, items: [{ variant_id: V(1), quantity: 1 }], benefit: { kind: 'porcentaje', value: 5 } })])).r;
  equal(offer.coupon.audience, 'portador', 'vendedor crea oferta personal de un uso');
  await rejects(rows('select public.plan_status()'), /Sin permiso/, 'plan solo para el propietario');
  await as('authenticated', ADMIN);
  equal((await one('select public.plan_status() p')).p.status, 'sin_plan', 'plan no configurado');
  await rejects(rows(`insert into public.store_plan(plan_code, status) values ('anual', 'activo')`), /permission denied/, 'el comerciante no activa su plan');
});
console.log('\nAceptación legal, avisos de disponibilidad y costos');
await test('L1. con la exigencia activa no se registra pedido sin aceptar Términos y Política', async () => {
  await as('postgres'); await db.exec(`update public.site_settings set terms_version = 'tyc-1', data_policy_version = 'pd-1', legal_acceptance_required = true where id = 1`);
  await as('anon');
  await rejects(createOrder(orderPayload(cart([V(2), 1]))), /BM030|debes aceptar/i, 'sin aceptación');
  await rejects(createOrder(orderPayload(cart([V(2), 1]), { legal: { accepted: true, terms_version: 'tyc-0', data_policy_version: 'pd-1' } })), /BM031|actualizaron/, 'versión vieja');
  const o = await createOrder(orderPayload(cart([V(2), 1]), { legal: { accepted: true, terms_version: 'tyc-1', data_policy_version: 'pd-1' } }));
  await as('postgres');
  const row = await one(`select terms_version, data_policy_version, legal_accepted_at, customer_id from public.orders where order_number = $1`, [o.order_number]);
  equal(row.terms_version, 'tyc-1', 'versión de términos'); equal(row.data_policy_version, 'pd-1', 'versión de política'); assert(row.legal_accepted_at, 'fecha de aceptación');
  equal((await one(`select count(*)::int n from public.customer_consents where customer_id = $1 and purpose = 'terms_conditions' and text_version = 'tyc-1'`, [row.customer_id])).n, 1, 'prueba de aceptación');
  await db.exec(`update public.site_settings set legal_acceptance_required = false where id = 1`);
});
await test('L2. "avísame cuando llegue": exige autorización, no revela clientes y crea la tarea al haber stock', async () => {
  await as('postgres'); await db.exec(`update public.product_variants set stock = 0 where id = '${V(4)}'`);
  await as('anon');
  await rejects(one(`select public.request_restock_notice($1, 'Cliente Aviso', '3207778899', false) ok`, [V(4)]), /autorizar/, 'sin autorización');
  equal((await one(`select public.request_restock_notice($1, 'Cliente Aviso', '3207778899', true) ok`, [V(4)])).ok, true, 'registrado');
  equal((await one(`select public.request_restock_notice($1, 'Otro Nombre', '+57 320 777 8899', true) ok`, [V(4)])).ok, true, 'duplicado no falla ni revela');
  await rejects(rows('select * from public.restock_requests'), /permission denied/, 'anon no lee avisos');
  await as('postgres');
  equal((await one(`select count(*)::int n from public.restock_requests where status = 'pendiente'`)).n, 1, 'un aviso por variante y teléfono');
  equal((await one(`select full_name from public.customers where phone_normalized = '+573207778899'`)).full_name, 'Cliente Aviso', 'no sobrescribe la ficha');
  await as('authenticated', ADMIN);
  await one('select public.generate_customer_tasks() n');
  await as('postgres');
  equal((await one(`select count(*)::int n from public.customer_tasks where kind = 'disponible_de_nuevo'`)).n, 0, 'sin stock no hay tarea');
  await db.exec(`update public.product_variants set stock = 5 where id = '${V(4)}'`);
  await as('authenticated', ADMIN);
  await one('select public.generate_customer_tasks() n'); await one('select public.generate_customer_tasks() n');
  await as('postgres');
  const task = await one(`select id from public.customer_tasks where kind = 'disponible_de_nuevo'`);
  equal((await one(`select count(*)::int n from public.customer_tasks where kind = 'disponible_de_nuevo'`)).n, 1, 'una sola tarea');
  await as('authenticated', ADMIN);
  await one(`select * from public.set_task_status($1, '{"status":"completada","outcome":"avisado"}'::jsonb)`, [task.id]);
  await as('postgres');
  equal((await one(`select status from public.restock_requests limit 1`)).status, 'avisado', 'aviso marcado');
});
await test('L3. costos privados: el margen solo lo ve el propietario y nunca el público', async () => {
  await as('postgres'); await db.exec(`insert into public.product_costs(product_id, unit_cost) values ('${P(1)}', 70000)`);
  await as('anon'); await rejects(rows('select * from public.product_costs'), /permission denied/, 'anon');
  await as('authenticated', SELLER);
  equal((await rows('select * from public.product_costs')).length, 0, 'vendedor no ve costos');
  const seller = (await one(`select public.preview_offer($1::jsonb, '{"kind":"porcentaje","value":10}'::jsonb) r`, [cart([V(1), 1])])).r;
  equal(seller.margin_available, false, 'vendedor sin margen');
  await as('authenticated', ADMIN);
  const owner = (await one(`select public.preview_offer($1::jsonb, '{"kind":"porcentaje","value":10}'::jsonb) r`, [cart([V(1), 1])])).r;
  equal(Number(owner.margin_total), 20000, 'margen 90.000 − 70.000');
  const partial = (await one(`select public.preview_offer($1::jsonb, '{"kind":"porcentaje","value":10}'::jsonb) r`, [cart([V(1), 1], [V(2), 1])])).r;
  equal(partial.margin_available, false, 'sin costo en una línea: margen no disponible');
});

await test('Ninguna función pública queda ejecutable por PUBLIC por omisión', async () => {
  await as('postgres');
  const exposed = await rows(`select p.oid::regprocedure::text f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and (p.proacl is null or p.proacl::text ~ '(^|[{,])=X') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`);
  equal(exposed.map(r => r.f).join(', '), '', 'funciones con EXECUTE para PUBLIC');
});

console.log(`\n${passed} pruebas superadas, ${failures.length} fallidas.`);
console.log('Pendiente fuera de PGlite: concurrencia real del último uso (tools/qa-concurrency.mjs con DATABASE_URL de un Postgres local).');
if (failures.length) process.exit(1);
