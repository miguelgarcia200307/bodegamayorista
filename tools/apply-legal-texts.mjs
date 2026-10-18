// Publica los textos legales de legal/*.txt en site_settings del proyecto AUTORIZADO.
// Rellena los datos del negocio desde la configuración real; una línea que dependa de un
// dato inexistente (correo, dirección, identificación…) se omite en lugar de inventarlo.
// Cada texto queda versionado (fecha + huella) y se guarda una copia en legal/publicado/.
//
//   node tools/apply-legal-texts.mjs                 (simulación: genera y muestra)
//   node tools/apply-legal-texts.mjs --apply         (escribe en la base remota)
//   opciones: --responsable "Nombre, …"  --identificacion "C.C./NIT …"  --require (exigir aceptación en servidor)
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const SITE = 'https://bodegamayoristafc.shop';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
const apply = process.argv.includes('--apply');

const project = await (await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}`, { headers })).json();
if (project.id !== AUTHORIZED_REF) throw new Error('Destino no verificado');
async function query(sql, readOnly = true) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query${readOnly ? '?read_only=true' : ''}`, { method: 'POST', headers, body: JSON.stringify({ query: sql, ...(readOnly ? { read_only: true } : {}) }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

// Valores de demostración que nunca deben llegar a textos legales ni comprobantes.
const isPlaceholder = value => {
  const text = String(value ?? '').trim();
  if (!text) return true;
  if (/\bdemo\b|\(demo\)|\[demo\]|00\s*#\s*00-00|@[\w.-]+\.test\b|example\.(com|org|net)|lorem ipsum|pendiente/i.test(text)) return true;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && /^(57)?3\d{2}0{7}$/.test(digits);
};
const clean = value => (isPlaceholder(value) ? '' : String(value).trim());
const formatPhone = digits => { const d = String(digits || '').replace(/\D/g, ''); return d.length === 12 && d.startsWith('57') ? `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : d ? `+${d}` : ''; };
const REGIONS = { 'ca-central-1': 'Canadá', 'us-east-1': 'Estados Unidos', 'us-west-1': 'Estados Unidos', 'sa-east-1': 'Brasil', 'eu-west-1': 'Irlanda', 'eu-central-1': 'Alemania' };

const [settings] = await query('select * from public.site_settings where id = 1');
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
const vigencia = new Date(`${today}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const business = clean(settings.business_name) || 'Bodega Mayorista F.C.';
const data = {
  negocio: business,
  responsable: arg('--responsable') || clean(settings.privacy_controller_name) || `Francisney Castaño, propietario del establecimiento de comercio ${business}`,
  identificacion: arg('--identificacion') || clean(settings.privacy_controller_id) || clean(settings.tax_id),
  ciudad: clean(settings.city) ? `${clean(settings.city)}${/valledupar/i.test(settings.city) ? ' (Cesar)' : ''}` : '',
  direccion: clean(settings.address), correo: clean(settings.email), telefono: clean(settings.phone),
  whatsapp: formatPhone(clean(settings.whatsapp)), sitio: SITE, vigencia, region_datos: REGIONS[project.region] || project.region
};
for (const required of ['responsable', 'ciudad', 'whatsapp']) if (!data[required]) throw new Error(`Falta un dato obligatorio para los textos: ${required}`);

// Sustituye tokens; las líneas con un dato vacío se omiten completas.
function render(template, extra = {}) {
  const values = { ...data, ...extra };
  return template.split(/\r?\n/).filter(line => [...line.matchAll(/\{\{(\w+)\}\}/g)].every(([, key]) => values[key])).map(line => line.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key])).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const stamp = (prefix, text) => `${prefix}-${today}-${createHash('sha256').update(text).digest('hex').slice(0, 6)}`;
const withVersion = (prefix, template, token) => {
  const draft = render(template, { [token]: 'VERSION' });
  const version = stamp(prefix, draft);
  return { version, text: draft.replace('VERSION', version) };
};
const terms = withVersion('tyc', readFileSync(join(root, 'legal/terminos.txt'), 'utf8'), 'version_terminos');
const policy = withVersion('pd', readFileSync(join(root, 'legal/politica-datos.txt'), 'utf8'), 'version_datos');
const short = Object.fromEntries(readFileSync(join(root, 'legal/textos-cortos.txt'), 'utf8').split(/^### /m).filter(Boolean).map(block => { const [key, ...body] = block.split(/\r?\n/); return [key.trim(), render(body.join('\n'))]; }));
const values = {
  terms_text: terms.text, terms_version: terms.version,
  data_policy_text: policy.text, data_policy_version: policy.version,
  marketing_consent_text: short.marketing_consent_text, marketing_consent_version: stamp('mk', short.marketing_consent_text),
  analytics_consent_text: short.analytics_consent_text, analytics_consent_version: stamp('an', short.analytics_consent_text),
  personalization_consent_text: short.personalization_consent_text, restock_consent_text: short.restock_consent_text,
  shipping_policy_text: short.shipping_policy_text, returns_policy_text: short.returns_policy_text,
  warranty_text: short.warranty_text, quote_terms: short.quote_terms, sale_terms: short.sale_terms,
  privacy_controller_name: data.responsable, privacy_controller_id: data.identificacion || null,
  privacy_requests_channel: [`WhatsApp ${data.whatsapp}`, data.correo ? `correo ${data.correo}` : ''].filter(Boolean).join(' · ')
};
const out = join(root, 'legal/publicado'); mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${terms.version}_terminos.txt`), terms.text);
writeFileSync(join(out, `${policy.version}_politica-datos.txt`), policy.text);
writeFileSync(join(out, `${today}_textos-cortos.json`), JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key]) => !['terms_text', 'data_policy_text'].includes(key))), null, 2));
const missing = ['identificacion', 'direccion', 'correo', 'telefono'].filter(key => !data[key]);
console.log(`Destino: ${project.id} (${project.name}) · datos en ${data.region_datos}`);
console.log(`Términos ${terms.version} (${terms.text.length} caracteres) · Política ${policy.version} (${policy.text.length} caracteres)`);
console.log(`Responsable: ${data.responsable} · WhatsApp ${data.whatsapp} · ciudad ${data.ciudad}`);
if (missing.length) console.log(`Datos sin publicar (sus líneas se omitieron; complétalos en Configuración y vuelve a ejecutar): ${missing.join(', ')}`);
const demo = ['phone', 'email', 'address', 'tax_id', 'schedule'].filter(key => settings[key] && isPlaceholder(settings[key]));
if (demo.length) console.log(`Valores de demostración que se limpiarán: ${demo.join(', ')}`);
if (!apply) { console.log('Simulación: revisa legal/publicado/ y ejecuta con --apply para publicar.'); process.exit(0); }

const literal = value => (value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`);
const assignments = [...Object.entries(values).map(([key, value]) => `${key} = ${literal(value)}`), ...demo.map(key => `${key} = null`),
  'tracking_enabled = true', 'legal_updated_at = now()', ...(process.argv.includes('--require') ? ['legal_acceptance_required = true'] : [])];
await query(`update public.site_settings set ${assignments.join(', ')} where id = 1`, false);
const [check] = await query('select terms_version, data_policy_version, marketing_consent_version, analytics_consent_version, tracking_enabled, legal_acceptance_required, phone, email, address from public.site_settings where id = 1');
console.log('Publicado:', JSON.stringify(check));
