// Genera (y opcionalmente verifica en PGlite) el SQL para revertir las migraciones CRM
// 202610140001–0003 a la versión anterior. Las funciones previas se extraen de las
// migraciones ya entregadas, así la reversión no se desincroniza a mano.
//
//   node tools/rollback-crm.mjs > rollback.sql          (solo genera)
//   $env:PGLITE_DIR='<carpeta>'; node tools/rollback-crm.mjs --verify
//
// ADVERTENCIA: revertir después de usar cupones o eventos borra esa información
// (descuentos por línea, reservas, ofertas, tareas, vínculos y navegación). Antes de
// ejecutarlo en un proyecto real haz un respaldo (pg_dump o PITR) y revisa el SQL.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const migration = file => readFileSync(join(root, 'supabase/migrations', file), 'utf8');
function extract(file, name) {
  const sql = migration(file);
  const start = sql.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`No encontré ${name} en ${file}`);
  const end = sql.indexOf('$$;', sql.indexOf('$$', sql.indexOf(' as $$', start) + 6));
  return `${sql.slice(start, end + 3)}\n`;
}

const NEW_TABLES = ['coupon_uses', 'coupon_attempts', 'contact_attempts', 'customer_tasks', 'customer_offers', 'coupon_scopes', 'coupons', 'store_plan', 'identity_verifications', 'identity_links', 'behavior_events', 'behavior_daily_aggregates', 'visitor_sessions', 'visitor_consent_events', 'visitors', 'maintenance_runs', 'product_relationships'];
const NEW_FUNCTIONS = ['has_staff_role(text[])', 'staff_role()', 'product_relationships_validate()', 'request_fingerprint()', 'visitor_valid(uuid, text)', 'register_visitor(jsonb)', 'set_visitor_consent(uuid, text, jsonb)', 'sanitize_search_term(text)', 'track_events(uuid, text, jsonb)', 'request_identity_verification(uuid, text, text, uuid)', 'confirm_identity_verification(text, text, text)', 'unlink_identity(uuid, text)', 'link_order_session(uuid, uuid, jsonb)', 'sale_kept_cents(uuid)', 'crm_customer_ranking(uuid, date)', 'crm_peer_patterns(uuid, integer, integer)', 'crm_customer_signals(uuid)', 'public_trending_products(integer, integer)', 'purge_behavior_data()', 'export_customer_data(uuid)', 'suppress_customer_signals(uuid, text)',
  'priced_cart_lines(jsonb)', 'coupon_scope_matches(jsonb, uuid, uuid, uuid, uuid[])', 'coupon_compute(jsonb, jsonb, jsonb)', 'coupon_config(public.coupons)', 'coupon_scope_list(uuid)', 'coupon_uses_count(uuid, uuid, uuid)', 'coupon_state(public.coupons, uuid, uuid, uuid)', 'coupon_snapshot(public.coupons)', 'visitor_verified_customer(jsonb)', 'validate_cart_coupon(jsonb, text, jsonb, uuid)', 'orders_release_coupon()', 'generate_coupon_code(text)', 'save_coupon(uuid, jsonb)', 'preview_offer(jsonb, jsonb)', 'create_customer_offer(jsonb)', 'update_customer_offer(uuid, jsonb)', 'create_quote_from_offer(uuid)',
  'customer_marketing_allowed(uuid)', 'customer_contact_saturated(uuid)', 'generate_customer_tasks(uuid)', 'set_task_status(uuid, jsonb)', 'create_manual_task(jsonb)', 'record_contact_attempt(jsonb)', 'plan_status()', 'confirm_sale(uuid, boolean)'];

// Reversión SOLO de 202610150001 (aceptación legal, avisos y costos), conservando el CRM.
export function rollbackLegalSql() {
  return `-- Reversión de 202610150001 (generado por tools/rollback-crm.mjs --only-legal). Haz un respaldo antes.
begin;
drop trigger if exists customer_tasks_restock_done on public.customer_tasks;
drop function if exists public.restock_task_done() cascade;
drop function if exists public.request_restock_notice(uuid, text, text, boolean) cascade;
drop function if exists public.generate_customer_tasks(uuid) cascade;
alter function public.generate_customer_tasks_v1(uuid) rename to generate_customer_tasks;
delete from public.customer_tasks where kind = 'disponible_de_nuevo';
alter table public.customer_tasks drop constraint if exists customer_tasks_kind_check;
alter table public.customer_tasks add constraint customer_tasks_kind_check check (kind in ('pedido_pendiente','cotizacion_seguimiento','borrador_interno','carrito_sin_compra','reposicion','postventa','reactivar','devolucion','cumpleanos','oferta_sin_respuesta','manual'));
drop table if exists public.restock_requests cascade;
drop table if exists public.product_costs cascade;
-- Las autorizaciones ya registradas se conservan como evidencia (restricción NOT VALID).
alter table public.customer_consents drop constraint if exists customer_consents_purpose_check;
alter table public.customer_consents add constraint customer_consents_purpose_check check (purpose in ('order_processing','marketing_birthday')) not valid;
alter table public.orders drop column if exists terms_version, drop column if exists data_policy_version, drop column if exists legal_accepted_at;
alter table public.site_settings drop column if exists terms_text, drop column if exists terms_version, drop column if exists shipping_policy_text, drop column if exists returns_policy_text,
  drop column if exists restock_consent_text, drop column if exists legal_updated_at, drop column if exists legal_acceptance_required;
${extract('202610140002_coupons_offers.sql', 'create_storefront_order')}
${extract('202610140002_coupons_offers.sql', 'preview_offer')}
revoke execute on function public.create_storefront_order(jsonb, uuid), public.preview_offer(jsonb, jsonb), public.generate_customer_tasks(uuid) from public, anon, authenticated;
grant execute on function public.create_storefront_order(jsonb, uuid) to anon, authenticated;
grant execute on function public.preview_offer(jsonb, jsonb), public.generate_customer_tasks(uuid) to authenticated;
commit;
`;
}

export function rollbackSql() {
  return `-- Reversión de las migraciones CRM 202610140001–0003 (generado por tools/rollback-crm.mjs).
-- Haz un respaldo antes. Se pierde la información de cupones, ofertas, tareas y navegación.
-- Incluye la reversión de 202610150001 (textos legales, avisos y costos).
begin;
drop trigger if exists customer_tasks_restock_done on public.customer_tasks;
drop table if exists public.restock_requests cascade;
drop table if exists public.product_costs cascade;
drop function if exists public.restock_task_done() cascade;
drop function if exists public.request_restock_notice(uuid, text, text, boolean) cascade;
drop function if exists public.generate_customer_tasks_v1(uuid) cascade;
alter table public.customer_consents drop constraint if exists customer_consents_purpose_check;
alter table public.customer_consents add constraint customer_consents_purpose_check check (purpose in ('order_processing','marketing_birthday')) not valid;
alter table public.orders drop column if exists terms_version, drop column if exists data_policy_version, drop column if exists legal_accepted_at;
alter table public.site_settings drop column if exists terms_text, drop column if exists terms_version, drop column if exists shipping_policy_text, drop column if exists returns_policy_text,
  drop column if exists restock_consent_text, drop column if exists legal_updated_at, drop column if exists legal_acceptance_required;
drop trigger if exists orders_release_coupon on public.orders;
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' and (policyname like '%\\_seller\\_read' escape '\\' or policyname like '%\\_catalog\\_manager' escape '\\') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;
${NEW_TABLES.map(table => `drop table if exists public.${table} cascade;`).join('\n')}
${NEW_FUNCTIONS.map(signature => `drop function if exists public.${signature} cascade;`).join('\n')}
alter table public.orders drop column if exists discount_total, drop column if exists coupon_id, drop column if exists coupon_code, drop column if exists coupon_snapshot;
alter table public.order_items drop column if exists discount;
alter table public.sales drop column if exists coupon_snapshot;
alter table public.customers drop column if exists buying_context, drop column if exists buying_context_source, drop column if exists buying_context_at;
alter table public.site_settings drop column if exists privacy_controller_name, drop column if exists privacy_controller_id, drop column if exists privacy_requests_channel,
  drop column if exists analytics_consent_text, drop column if exists analytics_consent_version, drop column if exists personalization_consent_text, drop column if exists tracking_enabled,
  drop column if exists raw_event_retention_days, drop column if exists aggregate_retention_days, drop column if exists contact_cooldown_days;
drop index if exists public.orders_created_id_idx; drop index if exists public.quotes_created_id_idx; drop index if exists public.sales_created_id_idx;
drop index if exists public.sales_source_quote_idx; drop index if exists public.sale_items_product_idx;

-- Versiones anteriores de las funciones modificadas.
${extract('202609280001_bodega_mayorista_clean_base.sql', 'is_admin')}
alter table public.admins drop column if exists role;
${extract('202609280002_crm_sales_inventory.sql', 'storefront_order_result')}
${extract('202609290001_price_tiers.sql', 'create_storefront_order')}
${extract('202609280002_crm_sales_inventory.sql', 'create_sale_from_order')}
${extract('202609280002_crm_sales_inventory.sql', 'confirm_sale')}
${extract('202609280002_crm_sales_inventory.sql', 'cancel_sale')}
${extract('202609280002_crm_sales_inventory.sql', 'register_sale_return')}
revoke execute on function public.storefront_order_result(uuid), public.confirm_sale(uuid), public.cancel_sale(uuid, text), public.register_sale_return(uuid, jsonb, boolean, uuid, text),
  public.create_sale_from_order(uuid, boolean), public.create_storefront_order(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.create_storefront_order(jsonb, uuid) to anon, authenticated;
grant execute on function public.confirm_sale(uuid), public.cancel_sale(uuid, text), public.register_sale_return(uuid, jsonb, boolean, uuid, text), public.create_sale_from_order(uuid, boolean) to authenticated;
commit;
`;
}

if (process.argv.includes('--verify')) {
  const dir = join(process.env.PGLITE_DIR || '', 'node_modules/@electric-sql/pglite/dist');
  const { PGlite } = await import(pathToFileURL(join(dir, 'index.js')).href);
  const { pg_trgm } = await import(pathToFileURL(join(dir, 'contrib/pg_trgm.js')).href);
  const { unaccent } = await import(pathToFileURL(join(dir, 'contrib/unaccent.js')).href);
  const db = new PGlite({ extensions: { pg_trgm, unaccent } });
  await db.exec(readFileSync(join(root, 'tools/qa-db-bootstrap.sql'), 'utf8'));
  for (const file of readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort()) await db.exec(migration(file).replace(/^create extension if not exists pg_graphql;$/m, ''));
  const onlyLegal = process.argv.includes('--only-legal');
  await db.exec(onlyLegal ? rollbackLegalSql() : rollbackSql());
  const one = async sql => (await db.query(sql)).rows[0];
  const removed = onlyLegal ? ['restock_requests', 'product_costs'] : [...NEW_TABLES, 'restock_requests', 'product_costs'];
  const leftovers = await one(`select count(*)::int n from information_schema.tables where table_schema = 'public' and table_name in (${removed.map(t => `'${t}'`).join(',')})`);
  if (onlyLegal) {
    const crm = await one(`select count(*)::int n from pg_proc where proname in ('generate_customer_tasks','coupon_compute','track_events')`);
    if (crm.n !== 3) { console.log('✗ la reversión parcial eliminó funciones del CRM'); process.exit(1); }
  }
  const confirm = await one(`select count(*)::int n from pg_proc where proname = 'confirm_sale'`);
  await db.exec(`update public.site_settings set whatsapp = '573000000000';
    insert into public.delivery_methods(id, name) values ('10000000-0000-4000-8000-000000000001', 'Retiro');
    insert into public.payment_methods(id, name) values ('20000000-0000-4000-8000-000000000001', 'Pago');
    insert into public.products(id, name, slug, base_price, status) values ('30000000-0000-4000-8000-000000000001', 'P', 'p', 1000, 'published');
    insert into public.product_variants(id, product_id, stock) values ('60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 5);`);
  const order = await one(`select * from public.create_storefront_order('{"name":"Cliente","phone":"3001234567","delivery_method_id":"10000000-0000-4000-8000-000000000001","payment_method_id":"20000000-0000-4000-8000-000000000001","items":[{"variant_id":"60000000-0000-4000-8000-000000000001","quantity":2}]}'::jsonb, gen_random_uuid())`);
  const ok = leftovers.n === 0 && confirm.n === 1 && Number(order.total) === 2000;
  console.log(ok ? '✓ reversión verificada en PGlite: tablas nuevas eliminadas, funciones previas restauradas y checkout operativo' : `✗ reversión: ${JSON.stringify({ leftovers, confirm, total: order?.total })}`);
  process.exit(ok ? 0 : 1);
} else {
  process.stdout.write(process.argv.includes('--only-legal') ? rollbackLegalSql() : rollbackSql());
}
