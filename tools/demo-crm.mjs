// Recorrido de demostración con datos 100 % ficticios, ejecutado de verdad:
//   1) análisis del cliente (JS, mismo código del panel) con fixtures;
//   2) oferta, código, pedido, venta y resultado sobre PGlite con las migraciones reales.
// Uso: $env:PGLITE_DIR='<carpeta>'; node tools/demo-crm.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.location = { pathname: '/admin/', href: 'http://localhost/admin/' };
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const load = path => import(pathToFileURL(join(root, path)).href);
const F = await load('tools/fixtures/crm-demo.mjs');
const { analyzeCustomer } = await load('js/lib/customer-insights.js');
const { diagnoseCustomer } = await load('js/lib/customer-diagnosis.js');
const money = cents => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cents / 100);

console.log('=== 1. Análisis de Laura Demo (fecha de evaluación', F.ASOF, ') ===');
const a = analyzeCustomer(F.demoHistory, { products: F.products, categories: F.categories, asOf: F.ASOF, relationships: F.relationships, signals: F.demoSignals });
const dx = diagnoseCustomer(a, { allowed: true, digits: '573000000001', signals: F.demoSignals });
console.log(`Relación: ${dx.segment.label} — ${dx.segment.text}`);
console.log(`Interés actual: ${dx.intent.label}`);
dx.intent.reasons.forEach(reason => console.log(`  · [${reason.kind}] ${reason.text} (${reason.date})`));
console.log(`Oportunidad: ${dx.stage.label}. ${dx.headline}`);
console.log(`Evidencia del historial: ${a.metrics.evidence.label} (${a.metrics.evidence.ops} operaciones en ${a.metrics.evidence.distinctDays} días)`);
console.log('Recomendaciones (afinidad 0–100, no es probabilidad):');
a.recommendations.slice(0, 3).forEach(item => {
  console.log(`  - ${item.product.name}: afinidad ${item.affinity}/100 · ${item.evidence} · ${money(item.price.unitCents)} · ${item.reasons.map(reason => reason.text).join(' | ')}`);
});
console.log('Acciones sugeridas:'); dx.actions.forEach(action => console.log(`  - ${action.title}: ${action.reason}`));

console.log('\n=== 2. Oferta → código → carrito → pedido → venta (PGlite, migraciones reales) ===');
const dir = join(process.env.PGLITE_DIR || '', 'node_modules/@electric-sql/pglite/dist');
const { PGlite } = await import(pathToFileURL(join(dir, 'index.js')).href);
const { pg_trgm } = await import(pathToFileURL(join(dir, 'contrib/pg_trgm.js')).href);
const { unaccent } = await import(pathToFileURL(join(dir, 'contrib/unaccent.js')).href);
const db = new PGlite({ extensions: { pg_trgm, unaccent } });
await db.exec(readFileSync(join(root, 'tools/qa-db-bootstrap.sql'), 'utf8'));
for (const file of readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort()) await db.exec(readFileSync(join(root, 'supabase/migrations', file), 'utf8').replace(/^create extension if not exists pg_graphql;$/m, ''));
const ADMIN = '00000000-0000-4000-8000-0000000000aa';
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
await db.exec(`insert into auth.users(id, email) values ('${ADMIN}', 'demo@local'); insert into public.admins(user_id) values ('${ADMIN}');
  update public.site_settings set whatsapp = '573000000000', business_name = 'Tienda Demo' where id = 1;
  insert into public.delivery_methods(id, name, base_cost) values ('10000000-0000-4000-8000-000000000001', 'Envío demo', 8000);
  insert into public.payment_methods(id, name) values ('20000000-0000-4000-8000-000000000001', 'Pago demo');
  insert into public.products(id, name, slug, base_price, status) values ('30000000-0000-4000-8000-000000000001', 'Audífonos Demo', 'audifonos-demo', 200000, 'published');
  insert into public.product_variants(id, product_id, stock) values ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 10);
  insert into public.customers(id, full_name, phone_original) values ('c0000000-0000-4000-8000-000000000001', 'Laura Demo', '300 000 0001');`);
const asAdmin = () => db.exec(`reset role; select set_config('request.jwt.claim.sub', '${ADMIN}', false); set role authenticated;`);
const asAnon = () => db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); set role anon;`);
await asAdmin();
const offer = (await one(`select public.create_customer_offer($1::jsonb) r`, [JSON.stringify({ customer_id: 'c0000000-0000-4000-8000-000000000001', title: 'Audífonos para Laura', items: [{ variant_id: '60000000-0000-4000-8000-000000000001', quantity: 1 }], benefit: { kind: 'porcentaje', value: 10, ends_at: '2026-12-31T23:59:59-05:00' } })])).r;
console.log(`Oferta guardada: ${offer.offer.title} · código ${offer.coupon.code} (un uso, transferible) · total ${offer.offer.totals.total} (ahorro ${offer.offer.totals.discount_total})`);
await one(`select * from public.update_customer_offer($1, '{"status":"enviada_declarada"}'::jsonb)`, [offer.offer.id]);
console.log('El vendedor declaró que envió el mensaje (abrir WhatsApp no cuenta como envío).');
await asAnon();
const items = JSON.stringify([{ variant_id: '60000000-0000-4000-8000-000000000001', quantity: 1 }]);
const check = (await one(`select public.validate_cart_coupon($1::jsonb, $2, null, '10000000-0000-4000-8000-000000000001') r`, [items, offer.coupon.code.toLowerCase()])).r;
console.log(`Carrito: código ${check.status} · subtotal ${check.subtotal} · descuento ${check.discount_total} · envío ${check.delivery} · total ${check.total} (no consume usos)`);
const order = await one(`select * from public.create_storefront_order($1::jsonb, gen_random_uuid())`, [JSON.stringify({ name: 'Laura Demo', phone: '300 000 0001', delivery_method_id: '10000000-0000-4000-8000-000000000001', payment_method_id: '20000000-0000-4000-8000-000000000001', items: JSON.parse(items), coupon_code: offer.coupon.code, expected_discount: check.discount_total })]);
console.log(`Pedido ${order.order_number}: total ${order.total} (el uso del código queda RESERVADO).`);
await asAdmin();
const orderId = (await one(`select id from public.orders where order_number = $1`, [order.order_number])).id;
const sale = await one(`select * from public.create_sale_from_order($1)`, [orderId]);
await one(`select * from public.confirm_sale($1)`, [sale.id]);
await db.exec('reset role');
const use = await one(`select status, discount_total from public.coupon_uses where order_id = $1`, [orderId]);
console.log(`Venta ${sale.sale_number} confirmada: total ${sale.total}; uso del código ${use.status} (descuento ${use.discount_total}).`);
await asAdmin();
await one(`select * from public.update_customer_offer($1, '{"status":"aceptada","outcome":"compro","note":"Compró con el código"}'::jsonb)`, [offer.offer.id]);
await db.exec('reset role');
const final = await one(`select status, outcome from public.customer_offers where id = $1`, [offer.offer.id]);
console.log(`Resultado registrado: oferta ${final.status} · ${final.outcome}.`);
