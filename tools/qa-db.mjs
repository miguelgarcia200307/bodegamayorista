// Pruebas de base de datos en un Postgres local (PGlite, en memoria).
// Aplica las migraciones activas sobre un entorno que imita Supabase y verifica
// RLS, privilegios, checkout, stock, documentos y cumpleaños. No se conecta a
// ningún proyecto remoto.
//
// Uso:
//   npm install --no-save --prefix <carpeta> @electric-sql/pglite
//   $env:PGLITE_DIR='<carpeta>'; node tools/qa-db.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const pgliteDir = process.env.PGLITE_DIR ? join(process.env.PGLITE_DIR, 'node_modules/@electric-sql/pglite/dist') : null;
const load = async (bare, file) => pgliteDir ? import(pathToFileURL(join(pgliteDir, file)).href) : import(bare);
const { PGlite } = await load('@electric-sql/pglite', 'index.js');
const { pg_trgm } = await load('@electric-sql/pglite/contrib/pg_trgm', 'contrib/pg_trgm.js');
const { unaccent } = await load('@electric-sql/pglite/contrib/unaccent', 'contrib/unaccent.js');

const db = new PGlite({ extensions: { pg_trgm, unaccent } });
const ADMIN = '00000000-0000-4000-8000-00000000000a';
const INTRUDER = '00000000-0000-4000-8000-00000000000b';
let passed = 0; const failures = [];

const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await rows(sql, params))[0];
async function as(role, uid = '') {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false);${role === 'postgres' ? '' : ` set role ${role};`}`);
}
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
  finally { await db.exec('reset role'); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) { if (String(actual) !== String(expected)) throw new Error(`${label}: esperado ${expected}, obtenido ${actual}`); }
async function rejects(promise, pattern, label) {
  try { await promise; } catch (error) {
    if (pattern && !pattern.test(`${error.message} ${error.code || ''}`)) throw new Error(`${label}: error inesperado «${error.message}»`);
    return error;
  }
  throw new Error(`${label}: se esperaba un error`);
}

// --- Migraciones -----------------------------------------------------------
await db.exec(readFileSync(join(root, 'tools/qa-db-bootstrap.sql'), 'utf8'));
const migrations = readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort();
for (const file of migrations) {
  const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8').replace(/^create extension if not exists pg_graphql;$/m, '');
  await db.exec(sql);
}
console.log(`Migraciones aplicadas: ${migrations.join(', ')}`);

console.log('\nEstado inicial');
await test('base vacía salvo configuración técnica', async () => {
  for (const table of ['products','categories','brands','product_variants','product_images','homepage_banners','payment_methods','delivery_methods','customers','orders','quotes','sales','stock_movements','admins'])
    equal((await one(`select count(*)::int as n from public.${table}`)).n, 0, table);
  equal((await one('select count(*)::int as n from public.site_settings')).n, 1, 'site_settings');
  equal((await one('select count(*)::int as n from public.document_sequences')).n, 3, 'document_sequences');
  equal((await one('select whatsapp from public.site_settings')).whatsapp, null, 'whatsapp pendiente');
});

// --- Datos de prueba (solo en memoria) ---------------------------------------
await db.exec(`
  insert into auth.users(id, email) values ('${ADMIN}', 'admin@prueba.local'), ('${INTRUDER}', 'intruso@prueba.local');
  insert into public.admins(user_id) values ('${ADMIN}');
  update public.site_settings set whatsapp = '573000000000' where id = 1;
  insert into public.delivery_methods(id, name, requires_city, requires_address, base_cost) values
    ('10000000-0000-4000-8000-000000000001', 'Retiro prueba', false, false, 0),
    ('10000000-0000-4000-8000-000000000002', 'Domicilio prueba', true, true, 12000.50);
  insert into public.payment_methods(id, name) values ('20000000-0000-4000-8000-000000000001', 'Pago prueba');
  insert into public.products(id, name, slug, base_price, status, option1_name, option2_name) values
    ('30000000-0000-4000-8000-000000000001', 'Nevera prueba', 'nevera-prueba', 1500000, 'published', null, null),
    ('30000000-0000-4000-8000-000000000002', 'Celular prueba', 'celular-prueba', 1999.99, 'published', 'Color', 'Almacenamiento'),
    ('30000000-0000-4000-8000-000000000003', 'Agotado prueba', 'agotado-prueba', 5000, 'published', null, null),
    ('30000000-0000-4000-8000-000000000004', 'Borrador prueba', 'borrador-prueba', 7000, 'draft', null, null);
  update public.products set promo_price = 1499.99 where id = '30000000-0000-4000-8000-000000000002';
  insert into public.product_colors(id, product_id, name) values
    ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Única'),
    ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Negro'),
    ('40000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'Única'),
    ('40000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004', 'Única');
  insert into public.product_sizes(id, product_id, name) values
    ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Única'),
    ('50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '128 GB'),
    ('50000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'Única'),
    ('50000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004', 'Única');
  insert into public.product_variants(id, product_id, color_id, size_id, stock) values
    ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 3),
    ('60000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 5),
    ('60000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003', '50000000-0000-4000-8000-000000000003', 0),
    ('60000000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000004', '50000000-0000-4000-8000-000000000004', 5);
`);
const FRIDGE = '60000000-0000-4000-8000-000000000001', PHONE_V = '60000000-0000-4000-8000-000000000002', SOLD = '60000000-0000-4000-8000-000000000003', DRAFT = '60000000-0000-4000-8000-000000000004';
const payload = (extra = {}) => JSON.stringify({ name: 'Cliente Prueba', phone: '300 123 4567', delivery_method_id: '10000000-0000-4000-8000-000000000001',
  payment_method_id: '20000000-0000-4000-8000-000000000001', items: [{ variant_id: FRIDGE, quantity: 1 }], ...extra });
const stockOf = async id => Number((await one('select stock from public.product_variants where id = $1', [id])).stock);
const order = async (body, key = crypto.randomUUID()) => one('select * from public.create_storefront_order($1::jsonb, $2::uuid)', [body, key]);

console.log('\nVisitante anónimo');
await test('ve publicados (incluido agotado) y no borradores', async () => {
  await as('anon');
  const names = (await rows('select name from public.products order by name')).map(r => r.name);
  assert(names.includes('Agotado prueba') && names.includes('Nevera prueba'), 'faltan publicados');
  assert(!names.includes('Borrador prueba'), 'borrador visible');
});
for (const table of ['customers','orders','order_items','quotes','sales','sale_items','stock_movements','customer_consents','birthday_contacts','document_sequences','sale_returns'])
  await test(`no puede leer ${table}`, async () => { await as('anon'); await rejects(rows(`select * from public.${table}`), /permission denied/, table); });
await test('no puede escribir clientes ni catálogo', async () => {
  await as('anon');
  await rejects(rows(`insert into public.customers(full_name, phone_original, phone_normalized) values ('X', '3000000000', '+573000000000')`), /permission denied/, 'insert customers');
  await rejects(rows(`update public.products set base_price = 1`), /permission denied/, 'update products');
});
await test('no puede ejecutar funciones internas ni administrativas', async () => {
  await as('anon');
  await rejects(rows(`select public.next_document_number('order')`), /permission denied/, 'next_document_number');
  await rejects(rows(`select public.confirm_sale(gen_random_uuid())`), /permission denied/, 'confirm_sale');
  await rejects(rows(`select public.variant_option_snapshot(gen_random_uuid())`), /permission denied/, 'variant_option_snapshot');
});

console.log('\nCheckout seguro');
let firstOrder;
await test('crea pedido con total calculado en servidor e ignora precio manipulado', async () => {
  await as('anon');
  firstOrder = await order(payload({ items: [{ variant_id: FRIDGE, quantity: 2, price: 1, unit_price: 1 }], total: 1 }));
  equal(Number(firstOrder.total), 3000000, 'total');
  assert(/^PED-\d{4}-000001$/.test(firstOrder.order_number), `número ${firstOrder.order_number}`);
  equal(firstOrder.whatsapp, '573000000000', 'whatsapp');
  assert(!('customer_id' in firstOrder) && !JSON.stringify(firstOrder).includes('Cliente Prueba'), 'devuelve datos del cliente');
});
await test('no descuenta inventario al registrar pedido', async () => equal(await stockOf(FRIDGE), 3, 'stock nevera'));
await test('mismo teléfono en otro formato: un cliente, dos pedidos, diferencias marcadas', async () => {
  await as('anon');
  const second = await order(payload({ name: 'Otro Nombre', phone: '+57 300 123 4567', items: [{ variant_id: PHONE_V, quantity: 1 }] }));
  equal(Number(second.total), 1499.99, 'precio promocional vigente');
  await as('postgres');
  equal((await one('select count(*)::int n from public.customers')).n, 1, 'clientes');
  equal((await one('select count(*)::int n from public.orders')).n, 2, 'pedidos');
  const customer = await one('select full_name, phone_normalized from public.customers');
  equal(customer.full_name, 'Cliente Prueba', 'nombre no sobrescrito');
  equal(customer.phone_normalized, '+573001234567', 'teléfono normalizado');
  const conflicts = (await one(`select customer_conflicts from public.orders where order_number = $1`, [second.order_number])).customer_conflicts;
  equal(conflicts.full_name, 'Otro Nombre', 'conflicto de nombre');
});
await test('snapshot de opciones sin “Única” y con nombres de opción', async () => {
  const items = await rows('select product_name, option_snapshot from public.order_items order by product_name');
  equal(JSON.stringify(items.find(i => i.product_name === 'Nevera prueba').option_snapshot), '{}', 'nevera sin opciones');
  equal(JSON.stringify(items.find(i => i.product_name === 'Celular prueba').option_snapshot), JSON.stringify({ Color: 'Negro', Almacenamiento: '128 GB' }), 'celular');
});
await test('reintento con la misma clave devuelve el mismo pedido', async () => {
  await as('anon');
  const key = crypto.randomUUID();
  const a = await order(payload({ phone: '3109998877' }), key);
  const b = await order(payload({ phone: '3109998877' }), key);
  equal(a.order_number, b.order_number, 'número');
  await as('postgres');
  equal((await one(`select count(*)::int n from public.orders where idempotency_key = $1`, [key])).n, 1, 'pedidos con la clave');
});
await test('rechaza stock insuficiente, agotado, borrador, cantidad 0 y teléfono inválido', async () => {
  await as('anon');
  await rejects(order(payload({ items: [{ variant_id: FRIDGE, quantity: 4 }] })), /Stock insuficiente/, 'stock');
  await rejects(order(payload({ items: [{ variant_id: FRIDGE, quantity: 2 }, { variant_id: FRIDGE, quantity: 2 }] })), /Stock insuficiente/, 'líneas duplicadas');
  await rejects(order(payload({ items: [{ variant_id: SOLD, quantity: 1 }] })), /Stock insuficiente/, 'agotado');
  await rejects(order(payload({ items: [{ variant_id: DRAFT, quantity: 1 }] })), /no está disponible/, 'borrador');
  await rejects(order(payload({ items: [{ variant_id: FRIDGE, quantity: 0 }] })), /no es válido/, 'cantidad 0');
  await rejects(order(payload({ phone: '12' })), /teléfono no válido/i, 'teléfono');
  await rejects(order(payload({ birth_date: '2999-01-01' })), /nacimiento/, 'nacimiento futuro');
});
await test('entrega a domicilio exige ciudad y dirección', async () => {
  await as('anon');
  await rejects(order(payload({ phone: '3150000001', delivery_method_id: '10000000-0000-4000-8000-000000000002' })), /ciudad/i, 'ciudad');
  const withAddress = await order(payload({ phone: '3150000001', delivery_method_id: '10000000-0000-4000-8000-000000000002', city: 'Ciudad', address: 'Dirección 123' }));
  equal(Number(withAddress.total), 1512000.50, 'total con entrega decimal');
});
await test('límite de solicitudes por teléfono', async () => {
  await as('anon');
  for (let i = 0; i < 5; i += 1) await order(payload({ phone: '3201112233' }));
  await rejects(order(payload({ phone: '3201112233' })), /varias solicitudes/, 'sexto intento');
});
await test('marca apertura de WhatsApp sin convertirla en venta', async () => {
  await as('anon');
  const key = crypto.randomUUID();
  await order(payload({ phone: '3162223344' }), key);
  equal((await one('select public.mark_order_whatsapp_opened($1) as ok', [key])).ok, true, 'marcado');
  await as('postgres');
  assert((await one('select whatsapp_opened_at from public.orders where idempotency_key = $1', [key])).whatsapp_opened_at, 'sin fecha');
  equal((await one('select count(*)::int n from public.sales')).n, 0, 'ventas');
});

console.log('\nUsuario autenticado que no es administrador');
await test('no lee CRM ni ejecuta acciones administrativas', async () => {
  await as('authenticated', INTRUDER);
  equal((await rows('select * from public.customers')).length, 0, 'clientes visibles');
  equal((await rows('select * from public.orders')).length, 0, 'pedidos visibles');
  await rejects(rows(`select public.create_manual_sale('{}'::jsonb)`), /Sin permiso/, 'venta manual');
  await rejects(rows(`insert into public.categories(name, slug) values ('X', 'x')`), /row-level security/, 'insert categoría');
  equal((await rows(`update public.products set base_price = 1 returning id`)).length, 0, 'update productos');
  await rejects(rows(`insert into public.admins(user_id) values ('${INTRUDER}')`), /permission denied/, 'autopromoción');
});

console.log('\nVentas e inventario');
let saleA, saleB;
await test('pedido → venta → confirmar descuenta una sola vez', async () => {
  await as('authenticated', ADMIN);
  const orderId = (await one(`select id from public.orders where order_number = $1`, [firstOrder.order_number])).id;
  saleA = await one('select * from public.create_sale_from_order($1)', [orderId]);
  assert(/^CV-\d{4}-000001$/.test(saleA.sale_number), `número ${saleA.sale_number}`);
  equal((await one('select * from public.create_sale_from_order($1)', [orderId])).id, saleA.id, 'idempotente');
  await one('select * from public.confirm_sale($1)', [saleA.id]);
  await one('select * from public.confirm_sale($1)', [saleA.id]);
  equal(await stockOf(FRIDGE), 1, 'stock tras confirmar dos veces');
  equal((await one(`select count(*)::int n from public.stock_movements where sale_id = $1`, [saleA.id])).n, 1, 'movimientos');
});
await test('una segunda venta que excede el stock falla sin dejarlo negativo', async () => {
  await as('authenticated', ADMIN);
  const customer = (await one('select id from public.customers limit 1')).id;
  saleB = await one('select * from public.create_manual_sale($1::jsonb)', [JSON.stringify({ customer_id: customer, source: 'presencial', items: [{ variant_id: FRIDGE, quantity: 2 }] })]);
  await rejects(one('select * from public.confirm_sale($1)', [saleB.id]), /Stock insuficiente/, 'confirmación');
  equal(await stockOf(FRIDGE), 1, 'stock intacto');
  equal((await one('select status from public.sales where id = $1', [saleB.id])).status, 'solicitud', 'estado');
});
await test('el administrador no puede cambiar estado ni importes directamente', async () => {
  await as('authenticated', ADMIN);
  await rejects(rows(`update public.sales set status = 'confirmada' where id = '${saleB.id}'`), /permission denied/, 'status');
  await rejects(rows(`update public.sales set total = 1 where id = '${saleB.id}'`), /permission denied/, 'total');
  await rejects(rows(`delete from public.sales where id = '${saleB.id}'`), /permission denied/, 'delete');
  await rejects(rows(`update public.product_variants set stock = -1 where id = '${FRIDGE}'`), /check constraint/, 'stock negativo');
});
await test('transiciones pagada/entregada y bloqueo de transiciones inválidas', async () => {
  await as('authenticated', ADMIN);
  await rejects(one(`select * from public.set_sale_status($1, 'pagada')`, [saleB.id]), /Primero confirma/, 'sin confirmar');
  equal((await one(`select * from public.set_sale_status($1, 'pagada', 'Transferencia declarada')`, [saleA.id])).status, 'pagada', 'pagada');
  equal((await one(`select * from public.set_sale_status($1, 'entregada')`, [saleA.id])).status, 'entregada', 'entregada');
  await rejects(one(`select * from public.set_sale_status($1, 'confirmada')`, [saleA.id]), /no permitida/, 'retroceso');
});
await test('devolución parcial con reintegro, idempotente y con tope', async () => {
  await as('authenticated', ADMIN);
  const item = (await one('select id from public.sale_items where sale_id = $1', [saleA.id])).id;
  const key = crypto.randomUUID();
  const lines = JSON.stringify([{ sale_item_id: item, quantity: 1 }]);
  await one('select * from public.register_sale_return($1, $2::jsonb, true, $3, $4)', [saleA.id, lines, key, 'Prueba']);
  await one('select * from public.register_sale_return($1, $2::jsonb, true, $3, $4)', [saleA.id, lines, key, 'Prueba']);
  equal(await stockOf(FRIDGE), 2, 'stock tras devolución');
  await rejects(one('select * from public.register_sale_return($1, $2::jsonb, true, $3)', [saleA.id, JSON.stringify([{ sale_item_id: item, quantity: 5 }]), crypto.randomUUID()]), /no válida/, 'exceso');
  const done = await one('select * from public.register_sale_return($1, $2::jsonb, false, $3)', [saleA.id, lines, crypto.randomUUID()]);
  equal(done.status, 'devuelta', 'estado final');
  equal(await stockOf(FRIDGE), 2, 'sin reintegro');
});
await test('cancelar restaura una sola vez', async () => {
  await as('authenticated', ADMIN);
  const customer = (await one('select id from public.customers limit 1')).id;
  const sale = await one('select * from public.create_manual_sale($1::jsonb)', [JSON.stringify({ customer_id: customer, source: 'WhatsApp', items: [{ variant_id: PHONE_V, quantity: 2 }] })]);
  await one('select * from public.confirm_sale($1)', [sale.id]);
  equal(await stockOf(PHONE_V), 3, 'tras confirmar');
  await one(`select * from public.cancel_sale($1, 'Cliente desistió')`, [sale.id]);
  await one('select * from public.cancel_sale($1)', [sale.id]);
  equal(await stockOf(PHONE_V), 5, 'tras cancelar dos veces');
});
await test('ajuste manual de stock queda registrado', async () => {
  await as('authenticated', ADMIN);
  await rows(`update public.product_variants set stock = 9 where id = '${PHONE_V}'`);
  const movement = await one(`select quantity_delta, reason from public.stock_movements where variant_id = $1 order by created_at desc, reason limit 1`, [PHONE_V]);
  equal(movement.reason, 'ajuste', 'motivo'); equal(movement.quantity_delta, 4, 'delta');
});
await test('guardar variantes conserva su id y el historial', async () => {
  await as('authenticated', ADMIN);
  await rows(`select * from public.save_product_variants('30000000-0000-4000-8000-000000000001', $1::jsonb)`,
    [JSON.stringify([{ color_id: '40000000-0000-4000-8000-000000000001', size_id: '50000000-0000-4000-8000-000000000001', stock: 7 }])]);
  equal(await stockOf(FRIDGE), 7, 'misma variante actualizada');
});

console.log('\nCotizaciones');
let quote;
await test('multi-línea con descuento y entrega, sin tocar stock', async () => {
  await as('authenticated', ADMIN);
  const customer = (await one('select id from public.customers limit 1')).id;
  const before = await stockOf(PHONE_V);
  quote = await one('select * from public.save_admin_quote(null, $1::jsonb)', [JSON.stringify({ customer_id: customer, delivery_cost: 10000, items: [
    { variant_id: FRIDGE, quantity: 1, unit_price: 1450000, discount: 50000 }, { variant_id: PHONE_V, quantity: 3, discount: 0.03 }] })]);
  equal(Number(quote.subtotal), 1450000 + 1499.99 * 3, 'subtotal');
  equal(Number(quote.discount_total), 50000.03, 'descuento');
  equal(Number(quote.total), 1450000 + 4499.97 - 50000.03 + 10000, 'total');
  assert(/^COT-\d{4}-000001$/.test(quote.quote_number), quote.quote_number);
  equal(await stockOf(PHONE_V), before, 'stock');
  equal(quote.customer_snapshot.full_name, 'Cliente Prueba', 'snapshot cliente');
});
await test('convertir exige revisión si el precio pactado difiere del vigente', async () => {
  await as('authenticated', ADMIN);
  await one(`select * from public.set_quote_status($1, 'aceptada')`, [quote.id]);
  const error = await rejects(one('select * from public.convert_quote_to_sale($1)', [quote.id]), /BM001/, 'revisión');
  assert(/Nevera prueba/.test(error.detail || ''), 'detalle sin la línea');
  const sale = await one('select * from public.convert_quote_to_sale($1, true)', [quote.id]);
  equal(Number(sale.total), Number(quote.total), 'importe pactado conservado');
  equal((await one('select status from public.quotes where id = $1', [quote.id])).status, 'convertida', 'estado');
  await rejects(one(`select * from public.set_quote_status($1, 'enviada')`, [quote.id]), /convertida/, 'reabrir');
});

console.log('\nClientes y cumpleaños');
await test('alta manual normaliza teléfono y evita duplicados equivalentes', async () => {
  await as('authenticated', ADMIN);
  const c = await one(`insert into public.customers(full_name, phone_original, phone_normalized, source) values ('  Ana   Pérez ', '0 300 555 6677', 'x', 'WhatsApp') returning *`);
  equal(c.phone_normalized, '+573005556677', 'normalizado'); equal(c.full_name, 'Ana Pérez', 'nombre');
  await rejects(rows(`insert into public.customers(full_name, phone_original, phone_normalized) values ('Ana', '+57 300 555 6677', 'x')`), /duplicate key|unique/, 'duplicado');
  await rejects(rows(`delete from public.customers where id = '${c.id}'`), /permission denied/, 'borrado físico');
});
await test('fusión conserva pedidos y ventas en la ficha principal', async () => {
  await as('authenticated', ADMIN);
  const keep = (await one(`select id from public.customers where phone_normalized = '+573001234567'`)).id;
  const dup = (await one(`select id from public.customers where phone_normalized = '+573005556677'`)).id;
  const dupOrders = (await one(`select count(*)::int n from public.orders where customer_id = $1`, [keep])).n;
  await one('select * from public.create_admin_order($1::jsonb)', [JSON.stringify({ customer_id: dup, items: [{ variant_id: FRIDGE, quantity: 1 }] })]);
  await one('select * from public.merge_customers($1, $2)', [keep, dup]);
  equal((await one(`select count(*)::int n from public.orders where customer_id = $1`, [keep])).n, dupOrders + 1, 'pedidos');
  const archived = await one('select archived_at, merged_into from public.customers where id = $1', [dup]);
  assert(archived.archived_at && archived.merged_into === keep, 'duplicado no archivado');
});
await test('29 de febrero, edad y cruce de año (America/Bogota)', async () => {
  await as('authenticated', ADMIN);
  const r = await one(`select public.birthday_in_year('2000-02-29', 2027) a, public.birthday_in_year('2000-02-29', 2028) b,
    public.customer_age('2000-02-29', '2027-02-27') c, public.customer_age('2000-02-29', '2027-02-28') d,
    public.next_birthday('1990-01-02', '2026-12-30') e, public.customer_age('1990-01-02', '2026-12-30') f`);
  const iso = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  equal(iso(r.a), '2027-02-28', 'no bisiesto'); equal(iso(r.b), '2028-02-29', 'bisiesto');
  equal(r.c, 26, 'edad víspera'); equal(r.d, 27, 'edad día'); equal(iso(r.e), '2027-01-02', 'cruce de año'); equal(r.f, 36, 'edad antes');
});
await test('un solo registro de felicitación por cliente y año', async () => {
  await as('authenticated', ADMIN);
  const id = (await one('select id from public.customers where merged_into is null limit 1')).id;
  await rows(`insert into public.birthday_contacts(customer_id, contact_year, status) values ('${id}', 2026, 'contactado')`);
  await rejects(rows(`insert into public.birthday_contacts(customer_id, contact_year) values ('${id}', 2026)`), /duplicate key|unique/, 'duplicado');
});
await test('consecutivos únicos y correlativos', async () => {
  const numbers = (await rows('select order_number from public.orders order by order_number')).map(r => r.order_number);
  equal(new Set(numbers).size, numbers.length, 'únicos');
  equal(numbers.at(-1).slice(-6), String(numbers.length).padStart(6, '0'), 'correlativo');
});

console.log(`\n${passed} pruebas superadas, ${failures.length} fallidas.`);
console.log('Nota: PGlite usa una sola conexión; la concurrencia real se garantiza con UPDATE condicional + bloqueo de fila y debe observarse también en el proyecto remoto.');
if (failures.length) process.exit(1);
