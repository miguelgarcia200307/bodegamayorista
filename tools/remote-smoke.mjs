// Ejecuta tools/remote-smoke.sql en el proyecto AUTORIZADO. El script termina con un
// error intencional para revertir todo; aquí se muestra el resultado y se comprueba
// que no quedó ningún rastro (clientes de prueba ni consecutivos consumidos).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const project = await (await fetch(`https://api.supabase.com/v1/projects/${REF}`, { headers })).json();
if (project.id !== REF) throw new Error('Destino no verificado');
const run = async sql => { const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers, body: JSON.stringify({ query: sql }) }); return { ok: response.ok, body: await response.json().catch(() => ({})) }; };
const before = (await run("select last_value from public.document_sequences where kind = 'order'")).body[0];
const result = await run(readFileSync(join(root, 'tools/remote-smoke.sql'), 'utf8'));
const message = result.body.message || JSON.stringify(result.body);
console.log(message.match(/RESULTADO[^"]*/)?.[0] || message);
const after = (await run("select last_value from public.document_sequences where kind = 'order'")).body[0];
const leftovers = (await run("select count(*)::int n from public.customers where full_name = 'Prueba Humo'")).body[0];
const flag = (await run('select legal_acceptance_required from public.site_settings where id = 1')).body[0];
console.log(`Sin rastro: consecutivo ${before.last_value} → ${after.last_value}, clientes de prueba ${leftovers.n}, exigencia ${flag.legal_acceptance_required}`);
