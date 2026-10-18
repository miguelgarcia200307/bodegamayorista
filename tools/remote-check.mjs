// Verificación remota de SOLO LECTURA del proyecto autorizado (Management API, token en
// .env). Compara las migraciones registradas con los archivos locales y revisa objetos y
// privilegios clave. No escribe nada.
// Uso: node tools/remote-check.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const project = await (await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}`, { headers })).json();
if (project.id !== AUTHORIZED_REF) throw new Error('Destino no verificado');
export async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query?read_only=true`, { method: 'POST', headers, body: JSON.stringify({ query: sql, read_only: true }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}
const sha = text => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
const applied = await query('select version, name, statements[1] as sql from supabase_migrations.schema_migrations order by version');
const local = new Map(readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).map(name => [name.split('_')[0], readFileSync(join(root, 'supabase/migrations', name), 'utf8')]));
for (const row of applied) console.log(`${row.version} ${row.name}: remoto ${sha(row.sql)} · local ${local.has(row.version) ? sha(local.get(row.version)) : 'NO EXISTE'}${local.has(row.version) && sha(row.sql) === sha(local.get(row.version)) ? ' ✓ idéntica' : ' ✗ DIFERENTE'}`);
const checks = await query(`select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('coupon_compute','track_events','generate_customer_tasks','validate_cart_coupon','crm_customer_ranking')) as funciones_crm,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and (p.proacl is null or p.proacl::text ~ '(^|[{,])=X') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')) as funciones_publicas,
  (select tracking_enabled from public.site_settings where id = 1) as tracking,
  (select count(*) from public.products) as productos, (select count(*) from public.orders) as pedidos, (select count(*) from public.customers) as clientes,
  (select count(*) from public.admins) as admins, (select string_agg(extname, ',') from pg_extension where extname in ('pg_cron','pg_net')) as extensiones,
  (select count(*) from pg_available_extensions where name = 'pg_cron') as pg_cron_disponible`);
console.log(JSON.stringify(checks[0], null, 2));
