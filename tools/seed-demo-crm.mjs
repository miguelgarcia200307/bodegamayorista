// Clientes DEMO con historial completo para mostrar el CRM y la analítica: pedidos,
// cotizaciones, ventas, autorizaciones, navegación (vistas, búsquedas, favoritos,
// carrito) vinculada a cada cliente e intentos de contacto, repartidos en ~14 meses.
// Usa productos y métodos REALES del catálogo (por SKU) y fechas relativas a hoy.
//
//   node tools/seed-demo-crm.mjs           (simulación: genera el SQL y muestra el resumen)
//   node tools/seed-demo-crm.mjs --check   (ejecuta en la base dentro de una transacción y la revierte)
//   node tools/seed-demo-crm.mjs --apply   (borra la demo anterior y la vuelve a cargar)
//   node tools/seed-demo-crm.mjs --clean   (borra todo lo demo, incluido lo creado después sobre esos clientes)
//
// Todo lo demo tiene id con prefijo `dede` (clientes, documentos, visitantes, eventos…).
// No toca inventario: las ventas quedan confirmadas sin descontar stock (stock_applied_at nulo)
// y no consumen los consecutivos reales (2025 → PED-2025-…; 2026 → rango 9xxxxx).
// La navegación se guarda dentro de los últimos 80 días: la purga diaria borra eventos de
// más de 90 días, así que conviene volver a cargar la demo antes de una presentación.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const mode = ['--apply', '--check', '--clean'].find(flag => process.argv.includes(flag)) || 'simulacion';

const project = await (await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}`, { headers })).json();
if (project.id !== AUTHORIZED_REF) throw new Error('Destino no verificado');
async function query(sql, readOnly = true) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query${readOnly ? '?read_only=true' : ''}`, { method: 'POST', headers, body: JSON.stringify({ query: sql, ...(readOnly ? { read_only: true } : {}) }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

// ---------- Identificadores demo ----------
const TYPES = { customer: '01', order: '02', orderItem: '03', quote: '04', quoteItem: '05', sale: '06', saleItem: '07', visitor: '08', session: '09', event: '0a', link: '0b', consent: '0c', contact: '0d' };
const counters = {};
const demoId = type => { counters[type] = (counters[type] || 0) + 1; return `dede${TYPES[type]}00-0000-4000-8000-${String(counters[type]).padStart(12, '0')}`; };
const DEMO = `like 'dede%'`;

const CLEAN_SQL = `
create temp table demo_customers on commit drop as select id from public.customers where id::text ${DEMO};
delete from public.behavior_events where visitor_id::text ${DEMO};
delete from public.identity_verifications where visitor_id::text ${DEMO};
delete from public.identity_links where visitor_id::text ${DEMO} or customer_id in (select id from demo_customers);
delete from public.visitor_sessions where visitor_id::text ${DEMO};
delete from public.visitor_consent_events where visitor_id::text ${DEMO};
delete from public.visitors where id::text ${DEMO};
delete from public.contact_attempts where customer_id in (select id from demo_customers);
delete from public.customer_tasks where customer_id in (select id from demo_customers);
delete from public.coupon_uses where customer_id in (select id from demo_customers) or coupon_id in (select id from public.coupons where customer_id in (select id from demo_customers));
delete from public.customer_offers where customer_id in (select id from demo_customers);
delete from public.coupon_scopes where coupon_id in (select id from public.coupons where customer_id in (select id from demo_customers));
delete from public.coupons where customer_id in (select id from demo_customers);
delete from public.restock_requests where customer_id in (select id from demo_customers);
update public.quotes set converted_sale_id = null where customer_id in (select id from demo_customers);
delete from public.stock_movements where sale_id in (select id from public.sales where customer_id in (select id from demo_customers));
delete from public.sale_returns where sale_id in (select id from public.sales where customer_id in (select id from demo_customers));
delete from public.sale_items where sale_id in (select id from public.sales where customer_id in (select id from demo_customers));
delete from public.sales where customer_id in (select id from demo_customers);
delete from public.quote_items where quote_id in (select id from public.quotes where customer_id in (select id from demo_customers));
delete from public.quotes where customer_id in (select id from demo_customers);
delete from public.order_items where order_id in (select id from public.orders where customer_id in (select id from demo_customers));
delete from public.orders where customer_id in (select id from demo_customers);
delete from public.birthday_contacts where customer_id in (select id from demo_customers);
delete from public.customer_consents where customer_id in (select id from demo_customers);
delete from public.customers where id in (select id from demo_customers);`;

if (mode === '--clean') {
  const [before] = await query(`select count(*)::int as clientes from public.customers where id::text ${DEMO}`);
  await query(`begin;${CLEAN_SQL}\ncommit;`, false);
  const [after] = await query(`select count(*)::int as clientes from public.customers where id::text ${DEMO}`);
  console.log(`Demo eliminada: ${before.clientes} clientes demo antes, ${after.clientes} ahora.`);
  process.exit(0);
}

// ---------- Datos reales de referencia (catálogo, métodos, versiones) ----------
const catalog = await query(`select v.sku, v.id as variant_id, p.id as product_id, p.name, p.base_price::float as base, p.promo_price::float as promo
  from public.product_variants v join public.products p on p.id = v.product_id where v.sku like 'BM-%' and p.status = 'published'`);
const bySku = Object.fromEntries(catalog.map(row => [row.sku, row]));
const methods = await query(`select 'delivery' as kind, id, name, base_cost::float as cost from public.delivery_methods where active union all select 'payment', id, name, null from public.payment_methods where active`);
const method = (kind, name) => { const found = methods.find(item => item.kind === kind && item.name === name); if (!found) throw new Error(`Método no encontrado: ${name}`); return found; };
const [settings] = await query('select business_name, analytics_consent_version, marketing_consent_version, terms_version, data_policy_version from public.site_settings where id = 1');
const product = sku => { const found = bySku[sku]; if (!found) throw new Error(`SKU no encontrado en el catálogo: ${sku}`); return found; };

// ---------- Fechas (hora de Bogotá, relativas a hoy) ----------
const NOW = Date.now();
const at = (daysAgo, hour = 10, minute = 0) => {
  const bogotaMidnight = new Date(new Date(NOW - 5 * 3600e3).toISOString().slice(0, 10) + 'T00:00:00-05:00').getTime();
  const time = bogotaMidnight - daysAgo * 86400e3 + (hour * 60 + minute) * 60e3;
  return new Date(Math.min(time, NOW - 60e3));
};
const iso = date => date.toISOString();
const plus = (date, minutes) => new Date(Math.min(date.getTime() + minutes * 60e3, NOW - 60e3));
const day = date => new Date(date.getTime() - 5 * 3600e3).toISOString().slice(0, 10);

// ---------- SQL ----------
const lit = value => value === null || value === undefined ? 'null' : typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(value) : value instanceof Date ? `'${iso(value)}'` : typeof value === 'object' ? `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb` : `'${String(value).replace(/'/g, "''")}'`;
const statements = [];
const insert = (table, row) => { const cols = Object.keys(row).filter(col => row[col] !== undefined); statements.push(`insert into public.${table}(${cols.join(', ')}) values (${cols.map(col => lit(row[col])).join(', ')});`); };

const numbers = { PED: { 2025: 0, 2026: 900000 }, COT: { 2025: 0, 2026: 900000 }, CV: { 2025: 0, 2026: 900000 } };
const docNumber = (prefix, date) => { const year = Number(day(date).slice(0, 4)); numbers[prefix][year] = (numbers[prefix][year] ?? 0) + 1; return `${prefix}-${year}-${String(numbers[prefix][year]).padStart(6, '0')}`; };
const business = { business_name: settings.business_name || 'Bodega Mayorista F.C.' };
const summary = [];

function lines(items) {
  return items.map(([sku, quantity, unit, discount = 0], index) => {
    const p = product(sku);
    const price = unit ?? p.promo ?? p.base;
    return { p, quantity, price, discount, total: price * quantity - discount };
  });
}
const sum = list => list.reduce((acc, line) => acc + line.total, 0);

// Documentos se crean en orden cronológico global para que los consecutivos sean coherentes.
const docs = [];
const customers = [];

function customer(data) {
  const id = demoId('customer');
  const record = { id, ...data };
  customers.push(record);
  return record;
}

function addOrder(c, { daysAgo, hour = 11, items, delivery, payment, status = 'confirmado', source = 'tienda', notes = null, sale = null }) {
  docs.push({ kind: 'order', c, date: at(daysAgo, hour, 17), items, delivery, payment, status, source, notes, sale });
}
function addQuote(c, { daysAgo, hour = 15, items, status, validDays = 8, delivery = 0, notes = null, sale = null }) {
  docs.push({ kind: 'quote', c, date: at(daysAgo, hour, 40), items, status, validDays, delivery, notes, sale });
}
function addSale(c, { daysAgo, hour = 16, items, source = 'WhatsApp', status = 'entregada', payment, delivery = 0, notes = null, cancelReason = null }) {
  docs.push({ kind: 'sale', c, date: at(daysAgo, hour, 5), items, source, status, payment, delivery, notes, cancelReason });
}

function writeSale(c, { date, items, source, status, payment, delivery, notes, cancelReason, orderId = null, quoteId = null }) {
  const id = demoId('sale');
  const list = lines(items);
  const subtotal = sum(list);
  const confirmed = status !== 'solicitud' && status !== 'cancelada' ? plus(date, 35) : null;
  insert('sales', {
    id, sale_number: docNumber('CV', date), customer_id: c.id, source, source_order_id: orderId, source_quote_id: quoteId, status, payment_method: payment,
    subtotal, discount_total: 0, delivery_cost: delivery, total: subtotal + delivery, notes,
    customer_snapshot: { full_name: c.full_name, phone: c.phone_original, city: c.city }, business_snapshot: business,
    confirmed_at: confirmed, paid_at: ['pagada', 'entregada'].includes(status) ? plus(date, 90) : null,
    delivered_at: status === 'entregada' ? plus(date, (c.city === 'Valledupar' ? 1 : 3) * 1440) : null,
    cancelled_at: status === 'cancelada' ? plus(date, 1440) : null, cancel_reason: cancelReason,
    created_at: date, updated_at: status === 'entregada' ? plus(date, 3 * 1440) : plus(date, 90)
  });
  list.forEach(line => insert('sale_items', { id: demoId('saleItem'), sale_id: id, product_id: line.p.product_id, variant_id: line.p.variant_id, product_name: line.p.name, sku: line.p.sku, quantity: line.quantity, unit_price: line.price, discount: line.discount, line_total: line.total }));
  summary.push(`  ${day(date)}  venta ${status.padEnd(9)} ${c.full_name.padEnd(28)} $${(subtotal + delivery).toLocaleString('es-CO')}`);
  return id;
}

function writeDocs() {
  docs.sort((a, b) => a.date - b.date).forEach(doc => {
    const { c, date } = doc;
    if (doc.kind === 'order') {
      const id = demoId('order');
      const list = lines(doc.items);
      const delivery = method('delivery', doc.delivery); const payment = method('payment', doc.payment);
      const subtotal = sum(list);
      insert('orders', {
        id, order_number: docNumber('PED', date), customer_id: c.id, status: doc.status, source: doc.source,
        delivery_method_id: delivery.id, delivery_name: delivery.name, payment_method_id: payment.id, payment_name: payment.name,
        shipping_city: delivery.cost ? c.city : null, shipping_address: delivery.cost ? c.address : null, notes: doc.notes,
        subtotal, delivery_cost: delivery.cost, discount_total: 0, total: subtotal + delivery.cost, idempotency_key: randomUUID(),
        whatsapp_opened_at: plus(date, 1), terms_version: settings.terms_version, data_policy_version: settings.data_policy_version, legal_accepted_at: date,
        created_at: date, updated_at: plus(date, doc.status === 'pendiente' ? 1 : 60)
      });
      list.forEach(line => insert('order_items', { id: demoId('orderItem'), order_id: id, product_id: line.p.product_id, variant_id: line.p.variant_id, product_name: line.p.name, sku: line.p.sku, quantity: line.quantity, unit_price: line.price, discount: 0, line_total: line.total }));
      summary.push(`  ${day(date)}  pedido ${doc.status.padEnd(10)}${c.full_name.padEnd(28)} $${(subtotal + delivery.cost).toLocaleString('es-CO')}`);
      if (doc.sale) writeSale(c, { date: plus(date, 50), items: doc.items, source: 'pedido', status: doc.sale, payment: payment.name, delivery: delivery.cost, notes: null, orderId: id });
    } else if (doc.kind === 'quote') {
      const id = demoId('quote');
      const list = lines(doc.items);
      const subtotal = list.reduce((acc, line) => acc + line.price * line.quantity, 0);
      const discount = list.reduce((acc, line) => acc + line.discount, 0);
      let saleId = null;
      if (doc.sale) saleId = writeSale(c, { date: plus(date, 3 * 1440), items: doc.items, source: 'cotizacion', status: doc.sale, payment: 'Transferencia bancaria', delivery: doc.delivery, notes: null, quoteId: null });
      insert('quotes', {
        id, quote_number: docNumber('COT', date), customer_id: c.id, status: doc.status, valid_until: day(plus(date, doc.validDays * 1440)),
        subtotal, discount_total: discount, delivery_cost: doc.delivery, total: subtotal - discount + doc.delivery, notes: doc.notes,
        terms_snapshot: 'Precios sujetos a disponibilidad de inventario. Cotización válida hasta la fecha indicada.',
        customer_snapshot: { full_name: c.full_name, phone: c.phone_original, city: c.city }, business_snapshot: business,
        sent_at: doc.status === 'borrador' ? null : plus(date, 20), converted_sale_id: saleId, created_at: date, updated_at: plus(date, 60)
      });
      if (saleId) statements.push(`update public.sales set source_quote_id = '${id}' where id = '${saleId}';`);
      list.forEach(line => insert('quote_items', { id: demoId('quoteItem'), quote_id: id, product_id: line.p.product_id, variant_id: line.p.variant_id, product_name: line.p.name, sku: line.p.sku, quantity: line.quantity, unit_price: line.price, discount: line.discount, line_total: line.total }));
      summary.push(`  ${day(date)}  cotización ${doc.status.padEnd(10)}${c.full_name.padEnd(24)} $${(subtotal - discount + doc.delivery).toLocaleString('es-CO')}`);
    } else {
      writeSale(c, doc);
    }
  });
}

// ---------- Navegación ----------
const sessionsOf = new Map();
function browse(c, { link = 'verificado', method: linkMethod = 'whatsapp_entrante', since = 70, sessions }) {
  sessionsOf.set(c.id, { link, linkMethod, since, sessions });
}
function writeBrowsing() {
  for (const c of customers) {
    const plan = sessionsOf.get(c.id);
    if (!plan) continue;
    const visitorId = demoId('visitor');
    const consentAt = at(Math.max(plan.since, ...plan.sessions.map(s => s.daysAgo)), 9, 2);
    insert('visitors', { id: visitorId, secret_hash: createHash('sha256').update(randomBytes(32)).digest('hex'), consent_analytics: true, consent_personalization: true, consent_version: settings.analytics_consent_version, consent_at: consentAt, created_at: consentAt, last_seen_at: at(Math.min(...plan.sessions.map(s => s.daysAgo)), 21, 0) });
    insert('visitor_consent_events', { visitor_id: visitorId, analytics: true, personalization: true, text_version: settings.analytics_consent_version, action: 'otorgado', recorded_at: consentAt });
    let linkSession = null;
    let eventsCount = 0;
    for (const s of plan.sessions) {
      const sessionId = demoId('session');
      let time = at(s.daysAgo, s.hour ?? 19, s.minute ?? 10);
      const started = time;
      if (s.order) linkSession = { id: sessionId, from: started };
      const campaign = s.utm ? { utm_source: s.utm, utm_medium: 'social', utm_campaign: s.campaign || 'temporada' } : {};
      const events = [];
      const push = (type, sku = null, properties = {}) => {
        const p = sku ? product(sku) : null;
        time = plus(time, 1 + Math.round(Math.random() * 3));
        events.push({ event_id: demoId('event'), visitor_id: visitorId, session_id: sessionId, event_type: type, product_id: p?.product_id ?? null, variant_id: p && ['select_variant', 'cart_item_added', 'cart_item_updated', 'cart_item_removed', 'favorite_added', 'favorite_removed'].includes(type) ? p.variant_id : null, properties, occurred_at: time, received_at: plus(time, 0.05), consent_version: settings.analytics_consent_version });
      };
      if (s.utm) push('campaign_landing', null, campaign);
      for (const step of s.steps) {
        const [kind, value, extra] = step;
        if (kind === 'search') push('search_submitted', null, { term: value, results: extra ?? 4 });
        else if (kind === 'view') push('view_product', value, { active_ms: extra ?? 9000 + Math.round(Math.random() * 80000) });
        else if (kind === 'fav') push('favorite_added', value);
        else if (kind === 'unfav') push('favorite_removed', value);
        else if (kind === 'cart') push('cart_item_added', value, { quantity: extra ?? 1 });
        else if (kind === 'uncart') push('cart_item_removed', value, { quantity: 0 });
        else if (kind === 'checkout') push('checkout_started', null, { items: value });
        else if (kind === 'whatsapp') push('whatsapp_link_clicked', null, { context: value });
      }
      insert('visitor_sessions', { id: sessionId, visitor_id: visitorId, started_at: started, last_event_at: time, campaign });
      events.forEach(event => insert('behavior_events', event));
      eventsCount += events.length;
    }
    const scoped = plan.link === 'declarado' && linkSession;
    insert('identity_links', {
      id: demoId('link'), visitor_id: visitorId, customer_id: c.id, level: plan.link, method: plan.link === 'declarado' ? 'telefono_en_pedido' : plan.linkMethod,
      evidence: plan.link === 'declarado' ? { origen: 'pedido en la tienda' } : { origen: plan.linkMethod === 'whatsapp_entrante' ? 'código enviado desde su WhatsApp' : 'verificado por el vendedor' },
      session_id: scoped ? linkSession.id : null, scope_from: scoped ? linkSession.from : consentAt, created_at: scoped ? linkSession.from : consentAt
    });
    summary.push(`  navegación ${c.full_name.padEnd(28)} ${plan.sessions.length} sesiones · ${eventsCount} eventos · identidad ${plan.link}`);
  }
}

// =====================================================================================
// Clientes
// =====================================================================================
const T = { recoger: 'Recoger en bodega', domicilio: 'Domicilio en la ciudad', nacional: 'Envío nacional', transferencia: 'Transferencia bancaria', efectivo: 'Efectivo contra entrega', nequi: 'Nequi / Daviplata' };
const birthdaySoon = `1988-${day(new Date(NOW + 6 * 86400e3)).slice(5)}`; // cumple en 6 días

// 1. Cliente fiel de cocina y hogar en Valledupar, cumpleaños la próxima semana.
const carolina = customer({ full_name: 'Carolina Mejía Ortiz', phone_original: '301 482 7395', city: 'Valledupar', address: 'Calle 16 # 12-45, barrio Novalito', birth_date: birthdaySoon, source: 'tienda', buying_context: 'consumo', buying_context_source: 'historial de compras', created_at: at(342, 10, 5), notes: 'Prefiere entregas en la tarde. Paga por Nequi.' });
addOrder(carolina, { daysAgo: 342, hour: 10, items: [['BM-037', 1, 192900]], delivery: T.domicilio, payment: T.nequi, sale: 'entregada' });
addSale(carolina, { daysAgo: 251, hour: 17, items: [['BM-032', 1, 158900], ['BM-035', 1, 99900]], payment: 'Efectivo', delivery: 8000, notes: 'Pedido por WhatsApp. Entrega en casa.' });
addOrder(carolina, { daysAgo: 118, hour: 20, items: [['BM-031', 1, 269900]], delivery: T.domicilio, payment: T.nequi, sale: 'entregada' });
addOrder(carolina, { daysAgo: 22, hour: 19, items: [['BM-033', 1]], delivery: T.domicilio, payment: T.nequi, sale: 'entregada' });
browse(carolina, { sessions: [
  { daysAgo: 16, hour: 21, steps: [['search', 'microondas', 2], ['view', 'BM-026'], ['view', 'BM-027'], ['view', 'BM-026', 64000]] },
  { daysAgo: 11, hour: 20, utm: 'instagram', campaign: 'semana-cocina', steps: [['view', 'BM-036'], ['view', 'BM-026'], ['fav', 'BM-026']] },
  { daysAgo: 6, hour: 13, steps: [['search', 'bateria de cocina', 1], ['view', 'BM-036', 92000], ['view', 'BM-037']] },
  { daysAgo: 2, hour: 21, minute: 40, steps: [['view', 'BM-026'], ['view', 'BM-036'], ['cart', 'BM-036', 1]] }
] });

// 2. Comprador de tecnología en Bogotá con alta intención: cotización de MacBook enviada.
const andres = customer({ full_name: 'Andrés Felipe Rincón Gómez', phone_original: '315 760 2148', city: 'Bogotá D.C.', address: 'Carrera 7 # 72-41, apto 802', birth_date: '1992-03-14', source: 'tienda', buying_context: 'consumo', created_at: at(268, 22, 10) });
addOrder(andres, { daysAgo: 268, hour: 22, items: [['BM-003', 1, 1399900]], delivery: T.nacional, payment: T.transferencia, sale: 'entregada' });
addOrder(andres, { daysAgo: 94, hour: 12, items: [['BM-011', 1, 239900]], delivery: T.nacional, payment: T.transferencia, sale: 'entregada' });
addQuote(andres, { daysAgo: 6, hour: 11, status: 'enviada', items: [['BM-005', 1, 5199900, 150000], ['BM-012', 1, 439900]], delivery: 0, notes: 'Envío nacional sin costo por compra superior a $5.000.000. Factura a nombre de la empresa.' });
browse(andres, { sessions: [
  { daysAgo: 19, hour: 22, steps: [['search', 'portatil core i5', 3], ['view', 'BM-006'], ['view', 'BM-007'], ['view', 'BM-005']] },
  { daysAgo: 14, hour: 23, steps: [['view', 'BM-005', 140000], ['view', 'BM-006'], ['fav', 'BM-005']] },
  { daysAgo: 11, hour: 7, minute: 30, steps: [['search', 'macbook air', 1], ['view', 'BM-005'], ['view', 'BM-008'], ['fav', 'BM-008']] },
  { daysAgo: 8, hour: 21, steps: [['view', 'BM-005'], ['view', 'BM-012'], ['cart', 'BM-005', 1], ['whatsapp', 'producto']] },
  { daysAgo: 4, hour: 22, steps: [['view', 'BM-005', 75000], ['view', 'BM-006']] },
  { daysAgo: 3, hour: 22, minute: 30, steps: [['view', 'BM-005'], ['checkout', 1]] },
  { daysAgo: 1, hour: 8, steps: [['search', 'ipad', 1], ['view', 'BM-008'], ['view', 'BM-005']] }
] });

// 3. Revendedora mayorista (Bosconia): compras por cantidad cada 6–10 semanas.
const yesenia = customer({ full_name: 'Yesenia Peralta Montero', phone_original: '300 917 4462', city: 'Bosconia (Cesar)', address: 'Calle 5 # 3-18, local 2', identification: 'NIT 1.065.432.118-4', source: 'WhatsApp', buying_context: 'reventa', buying_context_source: 'declarado por la cliente', created_at: at(402, 9, 30), notes: 'Tienda Variedades Yesi. Compra por cantidad; pide precio mayorista y envío por transportadora.' });
addSale(yesenia, { daysAgo: 402, hour: 9, items: [['BM-030', 6, 99900], ['BM-035', 8, 82900]], payment: 'Transferencia', delivery: 25000, notes: 'Despacho por transportadora a Bosconia.' });
addSale(yesenia, { daysAgo: 331, hour: 10, items: [['BM-030', 8, 97900], ['BM-011', 3, 249900]], payment: 'Transferencia', delivery: 25000 });
addQuote(yesenia, { daysAgo: 268, hour: 9, status: 'convertida', items: [['BM-034', 10, 149900], ['BM-035', 10, 77900]], delivery: 30000, sale: 'entregada', notes: 'Precio por cantidad (10 unidades o más).' });
addSale(yesenia, { daysAgo: 189, hour: 11, items: [['BM-030', 10, 94900], ['BM-032', 4, 126900]], payment: 'Transferencia', delivery: 25000 });
addSale(yesenia, { daysAgo: 121, hour: 10, source: 'presencial', items: [['BM-034', 6, 152900], ['BM-036', 3, 185900]], payment: 'Efectivo', notes: 'Recogió en bodega.' });
addSale(yesenia, { daysAgo: 57, hour: 9, items: [['BM-030', 12, 92900], ['BM-035', 6, 77900]], payment: 'Transferencia', delivery: 25000 });
addOrder(yesenia, { daysAgo: 1, hour: 8, status: 'pendiente', items: [['BM-030', 10, 94900], ['BM-029', 2]], delivery: T.nacional, payment: T.transferencia, notes: 'Si hay descuento por las 10 unidades, avisarme.' });
browse(yesenia, { sessions: [
  { daysAgo: 30, hour: 8, steps: [['view', 'BM-030'], ['view', 'BM-029']] },
  { daysAgo: 3, hour: 7, minute: 45, steps: [['search', 'ventilador', 2], ['view', 'BM-029', 52000], ['view', 'BM-030']] },
  { daysAgo: 1, hour: 7, minute: 50, order: true, steps: [['view', 'BM-030'], ['cart', 'BM-030', 10], ['cart', 'BM-029', 2], ['checkout', 2], ['whatsapp', 'checkout']] }
] });

// 4. Compra grande hace 10 meses y luego silencio; ahora mira televisores (reactivación).
const jorge = customer({ full_name: 'Jorge Luis Araújo Pumarejo', phone_original: '318 245 9031', city: 'Valledupar', address: 'Carrera 9 # 8-120, Los Mayales', birth_date: '1979-07-02', source: 'presencial', buying_context: 'consumo', created_at: at(301, 11, 0) });
addSale(jorge, { daysAgo: 301, hour: 11, source: 'presencial', items: [['BM-017', 1, 3388900], ['BM-022', 1, 1502900]], payment: 'Transferencia', notes: 'Entrega e instalación coordinada para el sábado.' });
addQuote(jorge, { daysAgo: 162, hour: 16, status: 'rechazada', items: [['BM-028', 2, 1401900, 60000]], delivery: 0, notes: 'Dos aires para habitaciones. Instalación cotizada aparte.' });
browse(jorge, { method: 'verificacion_comercial', sessions: [
  { daysAgo: 9, hour: 20, steps: [['search', 'televisor 55', 3], ['view', 'BM-015'], ['view', 'BM-016'], ['view', 'BM-014']] },
  { daysAgo: 5, hour: 21, utm: 'facebook', campaign: 'futbol-tv', steps: [['view', 'BM-015', 110000], ['fav', 'BM-015'], ['view', 'BM-014']] },
  { daysAgo: 2, hour: 20, minute: 30, steps: [['view', 'BM-015'], ['view', 'BM-016']] }
] });

// 5. Cliente nueva: primera compra hace 9 días y ya mira audio y relojes.
const maria = customer({ full_name: 'María Fernanda Quintero Ospina', phone_original: '312 638 0917', city: 'Valledupar', address: 'Manzana 12 casa 7, urbanización Villa Taxi', birth_date: '1999-01-27', source: 'tienda', created_at: at(9, 18, 30) });
addOrder(maria, { daysAgo: 9, hour: 18, items: [['BM-004', 1]], delivery: T.domicilio, payment: T.nequi, sale: 'entregada' });
browse(maria, { sessions: [
  { daysAgo: 12, hour: 21, steps: [['search', 'xiaomi', 1], ['view', 'BM-004'], ['view', 'BM-003']] },
  { daysAgo: 9, hour: 18, order: true, steps: [['view', 'BM-004', 61000], ['cart', 'BM-004', 1], ['checkout', 1]] },
  { daysAgo: 4, hour: 22, steps: [['view', 'BM-012'], ['view', 'BM-013'], ['fav', 'BM-012']] },
  { daysAgo: 1, hour: 19, steps: [['view', 'BM-012', 48000], ['view', 'BM-011'], ['cart', 'BM-011', 1]] }
] });

// 6. Pedido abandonado de aire acondicionado; solo identidad DECLARADA (sesión del pedido).
const luis = customer({ full_name: 'Luis Carlos Daza Mendoza', phone_original: '311 904 2573', city: 'Aguachica (Cesar)', address: 'Calle 7 # 24-60, barrio San Eduardo', source: 'WhatsApp', created_at: at(205, 15, 0) });
addSale(luis, { daysAgo: 205, hour: 15, status: 'cancelada', items: [['BM-025', 1, 849900]], payment: null, delivery: 35000, cancelReason: 'El cliente desistió por el costo del envío a Aguachica.' });
addSale(luis, { daysAgo: 183, hour: 10, items: [['BM-027', 1, 460900]], payment: 'Transferencia', delivery: 18000 });
addQuote(luis, { daysAgo: 37, hour: 16, status: 'vencida', validDays: 5, items: [['BM-028', 1], ['BM-029', 1]], delivery: 18000 });
addOrder(luis, { daysAgo: 35, hour: 14, status: 'abandonado', items: [['BM-028', 1]], delivery: T.nacional, payment: T.efectivo });
browse(luis, { link: 'declarado', sessions: [
  { daysAgo: 36, hour: 13, steps: [['view', 'BM-028'], ['view', 'BM-029']] },
  { daysAgo: 35, hour: 14, order: true, steps: [['search', 'aire acondicionado', 1], ['view', 'BM-028', 83000], ['cart', 'BM-028', 1], ['checkout', 1]] }
] });

// 7. Compra para regalar en fechas especiales (Navidad, Día de la Madre).
const daniela = customer({ full_name: 'Daniela Castro Brito', phone_original: '316 470 8852', city: 'Santa Marta (Magdalena)', address: 'Calle 22 # 4-35, edificio Bahía, apto 301', birth_date: '1995-11-03', source: 'tienda', buying_context: 'regalo', buying_context_source: 'declarado por la cliente', created_at: at(297, 20, 15), notes: 'Compra para regalar. Pide empaque de regalo.' });
addOrder(daniela, { daysAgo: 297, hour: 20, items: [['BM-010', 1, 649900]], delivery: T.nacional, payment: T.transferencia, sale: 'entregada', notes: 'Es un regalo de Navidad, por favor empacar.' });
addOrder(daniela, { daysAgo: 156, hour: 19, items: [['BM-013', 1, 1589900]], delivery: T.nacional, payment: T.transferencia, sale: 'entregada', notes: 'Regalo Día de la Madre.' });
addOrder(daniela, { daysAgo: 61, hour: 21, items: [['BM-009', 1]], delivery: T.nacional, payment: T.nequi, sale: 'entregada' });
browse(daniela, { sessions: [
  { daysAgo: 20, hour: 22, steps: [['search', 'iphone 15', 1], ['view', 'BM-001'], ['view', 'BM-002']] },
  { daysAgo: 13, hour: 21, utm: 'instagram', campaign: 'temporada-regalos', steps: [['view', 'BM-001', 98000], ['fav', 'BM-001'], ['view', 'BM-010']] },
  { daysAgo: 8, hour: 12, steps: [['search', 'airpods', 1], ['view', 'BM-010'], ['view', 'BM-001']] },
  { daysAgo: 4, hour: 22, steps: [['view', 'BM-001'], ['cart', 'BM-001', 1], ['whatsapp', 'producto']] }
] });

// ---------- Escritura ----------
customers.forEach(c => insert('customers', { ...c, updated_at: c.created_at }));
writeDocs();
writeBrowsing();
// Autorizaciones registradas (texto y versión vigentes).
const consent = (c, purpose, daysAgo, source = 'pedido en la tienda') => insert('customer_consents', { id: demoId('consent'), customer_id: c.id, purpose, granted: true, text_version: purpose === 'marketing_birthday' ? settings.marketing_consent_version : purpose === 'terms_conditions' ? settings.terms_version : settings.data_policy_version, source, recorded_at: at(daysAgo, 12) });
for (const [c, first] of [[carolina, 342], [andres, 268], [maria, 9], [luis, 35], [daniela, 297], [yesenia, 1]]) { consent(c, 'order_processing', first); consent(c, 'terms_conditions', first); }
consent(carolina, 'marketing_birthday', 342); consent(yesenia, 'marketing_birthday', 400, 'WhatsApp'); consent(daniela, 'marketing_birthday', 297); consent(andres, 'marketing_birthday', 94);
// Contactos registrados por el vendedor.
const contact = (c, daysAgo, purpose, kind, outcome, note) => insert('contact_attempts', { id: demoId('contact'), customer_id: c.id, channel: 'whatsapp', kind, purpose, outcome, note, created_at: at(daysAgo, 10, 30) });
contact(jorge, 160, 'comercial', 'declarado_enviado', null, 'Se envió la cotización de los aires.');
contact(jorge, 158, 'comercial', 'resultado', 'no_compro', 'Dijo que por ahora no; quizá más adelante.');
contact(luis, 34, 'comercial', 'declarado_enviado', null, 'Se le escribió por el pedido sin terminar del aire.');
contact(andres, 6, 'comercial', 'declarado_enviado', null, 'Se envió la cotización del MacBook con envío gratis.');
contact(carolina, 20, 'postventa', 'respuesta', null, 'Confirmó que la freidora llegó bien. Muy contenta.');

const sql = `begin;${CLEAN_SQL}\n${statements.join('\n')}\n`;
const file = join(tmpdir(), 'bodega-demo-crm.sql');
writeFileSync(file, `${sql}commit;\n`);
console.log(`Clientes demo: ${customers.length} · sentencias: ${statements.length} · SQL en ${file}\n`);
console.log(summary.join('\n'));

if (mode === '--check') {
  await query(`${sql}rollback;`, false);
  console.log('\nComprobación correcta: el SQL se ejecutó en la base y se revirtió (no quedó nada guardado).');
} else if (mode === '--apply') {
  await query(`${sql}commit;`, false);
  const [count] = await query(`select (select count(*) from public.customers where id::text ${DEMO})::int clientes, (select count(*) from public.sales s where s.customer_id::text ${DEMO})::int ventas, (select count(*) from public.orders o where o.customer_id::text ${DEMO})::int pedidos, (select count(*) from public.quotes q where q.customer_id::text ${DEMO})::int cotizaciones, (select count(*) from public.behavior_events where visitor_id::text ${DEMO})::int eventos`);
  console.log(`\nDemo cargada: ${JSON.stringify(count)}`);
} else {
  console.log('\nSimulación: no se escribió nada. Usa --check para validar en la base o --apply para cargar.');
}
