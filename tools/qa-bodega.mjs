// Verificaciones estáticas y unitarias del frontend (sin red). Las pruebas de base de
// datos están en tools/qa-db.mjs.
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const text = async path => readFile(join(root, path), 'utf8');
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`  ✓ ${name}`); };

async function files(dir, extensions) {
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path, extensions));
    else if (extensions.some(ext => entry.name.endsWith(ext))) found.push(path);
  }
  return found;
}

await check('configuración apunta solo al proyecto nuevo y sin secretos', async () => {
  const config = await text('js/config.js');
  assert.match(config, /ekepygodvciqnqkrgrsv\.supabase\.co/);
  assert.doesNotMatch(config, /sb_secret_|service_role|gacqqaimdfvkmznsglpg/);
});

await check('cadena de migraciones activa y sin datos heredados', async () => {
  const migrationFiles = (await readdir(join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(migrationFiles, ['202609280001_bodega_mayorista_clean_base.sql', '202609280002_crm_sales_inventory.sql', '202609290001_price_tiers.sql']);
  const sql = (await Promise.all(migrationFiles.map(file => text(`supabase/migrations/${file}`)))).join('\n');
  for (const required of ['enable row level security', 'create_storefront_order', 'idempotency_key uuid not null unique', 'confirm_sale', 'cancel_sale', 'register_sale_return', 'save_product_variants', 'merge_customers', 'birthday_in_year', 'private-documents', 'revoke all on all tables in schema public from anon'])
    assert.ok(sql.includes(required), `Falta ${required}`);
  for (const forbidden of ['Fuera de Lugar', 'Real Madrid', '573023031112', 'Calle 17 No. 8', 'Valledupar'])
    assert.ok(!sql.includes(forbidden), `Dato heredado: ${forbidden}`);
  // Solo se permiten inserciones de nivel superior técnicas (configuración, consecutivos y buckets).
  const seeds = [...sql.matchAll(/^insert into ([\w.]+)/gim)].map(match => match[1]);
  assert.deepEqual([...new Set(seeds)].sort(), ['public.document_sequences', 'public.site_settings', 'storage.buckets']);
});

await check('sintaxis válida en todos los módulos JavaScript', async () => {
  for (const file of await files('js', ['.js'])) execFileSync(process.execPath, ['--check', join(root, file)]);
});

await check('sin equipos, personalización de uniformes ni textos deportivos en código activo', async () => {
  const active = [...await files('js', ['.js']), ...(await readdir(root)).filter(name => name.endsWith('.html')).filter(name => !['equipo.html', 'equipos.html'].includes(name)), 'admin/index.html'];
  for (const file of active) {
    const source = await text(file);
    assert.doesNotMatch(source, /getTeams|initTeams|team_id|product\.teams|createProductCustomizer|personalization_price|Valledupar|fútbol|camiseta|⚽/, relative(root, join(root, file)));
  }
});

await check('checkout registra el pedido en servidor antes de WhatsApp', async () => {
  const checkout = await text('js/pages/checkout.js');
  assert.match(checkout, /createStorefrontOrder/);
  assert.match(checkout, /crypto\.randomUUID/);
  assert.match(checkout, /markOrderWhatsappOpened/);
  assert.ok(checkout.indexOf('createStorefrontOrder(') < checkout.indexOf('const url = `https://wa.me/'), 'WhatsApp se abre antes de registrar');
  const html = await text('checkout.html');
  assert.match(html, /id="marketing-consent" name="marketingConsent" type="checkbox">/, 'la autorización promocional no debe venir marcada');
});

await check('menú del panel sin Equipos', async () => {
  const admin = await text('admin/index.html');
  for (const section of ['dashboard', 'orders', 'customers', 'quotes', 'sales', 'products', 'stock', 'categories', 'brands', 'promotions', 'settings']) assert.match(admin, new RegExp(`data-section="${section}"`));
  assert.doesNotMatch(admin, /data-section="teams"/);
});

await check('comprobante con leyenda fiscal obligatoria y sin datos DIAN', async () => {
  const documents = await text('js/lib/documents.js');
  assert.ok(documents.includes('Comprobante comercial interno. No es factura electrónica ni documento equivalente validado por la DIAN.'));
  assert.doesNotMatch(documents, /CUFE|[Rr]esoluci[oó]n de facturaci[oó]n|\bIVA\b/);
});

await check('fechas de cumpleaños: 29 de febrero, cruce de año y validaciones', async () => {
  const { birthdayInYear, birthdayInfo, isValidBirthDate, bogotaTodayIso } = await import(pathToFileURL(join(root, 'js/lib/crm-dates.js')).href);
  assert.equal(birthdayInYear('2000-02-29', 2027), '2027-02-28');
  assert.equal(birthdayInYear('2000-02-29', 2028), '2028-02-29');
  assert.equal(birthdayInfo('2000-02-29', '2027-02-27').age, 26);
  assert.equal(birthdayInfo('2000-02-29', '2027-02-28').age, 27);
  assert.equal(birthdayInfo('2000-02-29', '2027-02-28').days, 0);
  const crossing = birthdayInfo('1990-01-02', '2026-12-30');
  assert.equal(crossing.next, '2027-01-02'); assert.equal(crossing.days, 3); assert.equal(crossing.turning, 37); assert.equal(crossing.age, 36);
  assert.equal(birthdayInfo('1990-12-31', '2026-12-31').days, 0);
  assert.equal(isValidBirthDate('2999-01-01', '2026-09-28'), false);
  assert.equal(isValidBirthDate('2023-02-29', '2026-09-28'), false);
  assert.equal(isValidBirthDate('2024-02-29', '2026-09-28'), true);
  // 04:30 UTC del 1 de enero todavía es 31 de diciembre en Bogotá.
  assert.equal(bogotaTodayIso(new Date('2027-01-01T04:30:00Z')), '2026-12-31');
});

await check('normalización de teléfonos equivalente a la base de datos', async () => {
  const normalize = value => {
    const digits = String(value).replace(/\D/g, '');
    if (/^0?3\d{9}$/.test(digits)) return `+57${digits.slice(-10)}`;
    if (/^573\d{9}$/.test(digits)) return `+${digits}`;
    if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
    throw new Error('invalid');
  };
  const sql = await text('supabase/migrations/202609280001_bodega_mayorista_clean_base.sql');
  assert.ok(sql.includes("digits ~ '^0?3[0-9]{9}$'") && sql.includes("digits ~ '^57(3[0-9]{9})$'"), 'la regla SQL cambió; actualiza esta prueba');
  assert.equal(normalize('300 123 4567'), '+573001234567');
  assert.equal(normalize('+57 300 123 4567'), '+573001234567');
  assert.equal(normalize('+1 202 555 0199'), '+12025550199');
});

await check('PDF directo con nombre automatico e impresion separada', async () => {
  const { commercialDocumentFilename } = await import(pathToFileURL(join(root, 'js/lib/documents.js')).href);
  assert.equal(commercialDocumentFilename({ kind: 'quote', doc: { quote_number: 'COT-2026-000001', customer_snapshot: { full_name: 'Miguel García / Norte' } } }), 'Cotizacion_COT-2026-000001_Miguel-Garcia-Norte.pdf');
  assert.equal(commercialDocumentFilename({ kind: 'sale', doc: { sale_number: 'CV-2026-000007', customers: { full_name: 'Cliente: Prueba' } } }), 'Comprobante_CV-2026-000007_Cliente-Prueba.pdf');
  const documents = await text('js/lib/documents.js'); const crm = await text('js/pages/admin-crm.js'); const admin = await text('admin/index.html');
  assert.match(documents, /pdf\.save\(filename\)/); assert.match(crm, /data-download-quote/); assert.match(crm, /data-print-quote/);
  assert.match(documents, /printCommercialDocument[\s\S]*buildCommercialPdf/); assert.match(documents, /pdf\.autoPrint\(\)/); assert.doesNotMatch(documents, /frame\.srcdoc/);
  assert.match(admin, /jspdf\.umd\.min\.js/); assert.match(admin, /jspdf\.plugin\.autotable\.min\.js/);
});

console.log(JSON.stringify({ ok: true, checks }, null, 2));
