// Prueba 21 con concurrencia REAL: dos conexiones compiten por el último uso de un cupón
// y por confirmar la misma venta. Requiere un Postgres desechable (local o rama de
// pruebas) con las migraciones aplicadas. NUNCA ejecutar contra producción.
//
// Uso:
//   npm install --no-save --prefix <carpeta> pg
//   $env:PG_DIR='<carpeta>'; $env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:54322/postgres'; node tools/qa-concurrency.mjs
// El script se niega a correr si la URL apunta a supabase.co.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) { console.log('DATABASE_URL no definido: prueba de concurrencia NO ejecutada (pendiente).'); process.exit(2); }
if (/supabase\.co|pooler\.supabase/i.test(url)) { console.error('Rechazado: no se ejecuta contra proyectos remotos.'); process.exit(3); }
const { default: pg } = await import(process.env.PG_DIR ? pathToFileURL(join(process.env.PG_DIR, 'node_modules/pg/lib/index.js')).href : 'pg');
const admin = new pg.Client({ connectionString: url }); const a = new pg.Client({ connectionString: url }); const b = new pg.Client({ connectionString: url });
await Promise.all([admin.connect(), a.connect(), b.connect()]);
const tag = Date.now().toString(36).toUpperCase();
const variant = (await admin.query(`select v.id from public.product_variants v join public.products p on p.id = v.product_id where p.status = 'published' and v.active and v.stock >= 5 and not p.force_sold_out limit 1`)).rows[0]?.id;
const delivery = (await admin.query(`select id from public.delivery_methods where active limit 1`)).rows[0]?.id;
const payment = (await admin.query(`select id from public.payment_methods where active limit 1`)).rows[0]?.id;
if (!variant || !delivery || !payment) throw new Error('La base de prueba necesita un producto con stock, un método de entrega y uno de pago.');
const code = `CONC-${tag}`.slice(0, 24);
await admin.query(`insert into public.coupons(code, name, kind, value, max_uses_total) values ($1, 'Concurrencia', 'valor_fijo', 1000, 1)`, [code]);
const body = phone => JSON.stringify({ name: 'Prueba concurrencia', phone, delivery_method_id: delivery, payment_method_id: payment, items: [{ variant_id: variant, quantity: 1 }], coupon_code: code });
const attempt = async (client, phone) => {
  await client.query('begin');
  try {
    await client.query('select * from public.create_storefront_order($1::jsonb, gen_random_uuid())', [body(phone)]);
    await new Promise(resolve => setTimeout(resolve, 300)); // mantiene el bloqueo mientras compite la otra
    await client.query('commit'); return 'ok';
  } catch (error) { await client.query('rollback'); return error.code || error.message; }
};
const results = await Promise.all([attempt(a, '3009990001'), attempt(b, '3009990002')]);
const uses = (await admin.query(`select count(*)::int n from public.coupon_uses u join public.coupons c on c.id = u.coupon_id where c.code = $1`, [code])).rows[0].n;
console.log({ results, uses });
const ok = results.filter(r => r === 'ok').length === 1 && results.includes('BM010') && uses === 1;
console.log(ok ? '✓ 21. solo una transacción obtuvo el último uso' : '✗ 21. resultado inesperado');
await Promise.all([admin.end(), a.end(), b.end()]);
process.exit(ok ? 0 : 1);
