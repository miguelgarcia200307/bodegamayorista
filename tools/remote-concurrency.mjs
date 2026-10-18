// Prueba 21 con concurrencia REAL en el proyecto remoto, sin dejar pedidos:
//  1) crea un cupón temporal de un solo uso;
//  2) T1 crea un pedido con el cupón (reserva el último uso), espera 4 s y se revierte;
//  3) T2 empieza 1 s después con lock_timeout de 1,5 s: debe quedar bloqueada (55P03),
//     es decir, no puede leer un conteo viejo ni reservar el mismo último uso. La espera
//     puede ocurrir primero en el bloqueo del consecutivo de pedidos (que también serializa);
//  4) borra el cupón temporal y comprueba que no quedó rastro.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const project = await (await fetch(`https://api.supabase.com/v1/projects/${REF}`, { headers })).json();
if (project.id !== REF) throw new Error('Destino no verificado');
const run = async sql => { const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }) }); return { ok: response.ok, body: await response.json().catch(() => ({})) }; };
const code = `CONC-${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
const created = await run(`insert into public.coupons(code, name, kind, value, max_uses_total) values ('${code}', 'Prueba de concurrencia (temporal)', 'valor_fijo', 1000, 1) returning id`);
if (!created.ok) throw new Error(JSON.stringify(created.body));
const order = phone => `do $$ declare v uuid; d uuid; p uuid; r record; begin
  select pv.id into v from public.product_variants pv join public.products pr on pr.id = pv.product_id where pr.status = 'published' and pv.active and pv.stock > 0 and not pr.force_sold_out order by pv.id limit 1;
  select id into d from public.delivery_methods where active and not requires_address and not requires_city limit 1;
  select id into p from public.payment_methods where active limit 1;
  select * into r from public.create_storefront_order(jsonb_build_object('name', 'Prueba Concurrencia', 'phone', '${phone}', 'delivery_method_id', d, 'payment_method_id', p, 'coupon_code', '${code}', 'items', jsonb_build_array(jsonb_build_object('variant_id', v, 'quantity', 1))), gen_random_uuid());
  perform set_config('bm.r', r.order_number, true); end $$;`;
const t1 = run(`begin; ${order('3009990021')} select pg_sleep(4); do $$ begin raise exception 'T1 revertida tras reservar %', current_setting('bm.r', true); end $$;`);
await new Promise(resolve => setTimeout(resolve, 1000));
const started = Date.now();
const t2 = await run(`begin; set local lock_timeout = '1500ms'; ${order('3009990022')} do $$ begin raise exception 'T2 reservó % (no debía)', current_setting('bm.r', true); end $$;`);
const waited = Date.now() - started;
const r1 = await t1;
const text = value => value.body.message || JSON.stringify(value.body);
console.log('T1:', text(r1).split('\n')[0]);
console.log(`T2 (${waited} ms):`, text(t2).split('\n')[0]);
await run(`delete from public.coupons where code = '${code}'`);
const trace = (await run(`select (select count(*) from public.coupons where code = '${code}')::int c, (select count(*) from public.customers where full_name = 'Prueba Concurrencia')::int k, (select count(*) from public.orders where notes is null and created_at > now() - interval '2 minutes' and customer_id in (select id from public.customers where full_name = 'Prueba Concurrencia'))::int o`)).body[0];
const blocked = /lock timeout|55P03|canceling statement due to lock/i.test(text(t2));
console.log(blocked && /T1 revertida/.test(text(r1)) ? '✓ 21. Las reservas quedan serializadas: la segunda transacción esperó a la primera (bloqueo del consecutivo de pedidos y del cupón) y no pudo reservar el mismo último uso; tras un COMMIT vería la reserva (probado en PGlite, caso 21)' : '✗ 21. Resultado inesperado');
console.log(`Sin rastro: cupón ${trace.c}, clientes ${trace.k}, pedidos ${trace.o}`);
