// Aplica tools/remote-ops.sql en el proyecto AUTORIZADO (Management API, token en .env).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const headers = { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const project = await (await fetch(`https://api.supabase.com/v1/projects/${REF}`, { headers })).json();
if (project.id !== REF) throw new Error('Destino no verificado');
const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: 'POST', headers, body: JSON.stringify({ query: readFileSync(join(root, 'tools/remote-ops.sql'), 'utf8') }) });
console.log(response.ok ? 'Operación aplicada:' : 'Error:', JSON.stringify(await response.json()));
