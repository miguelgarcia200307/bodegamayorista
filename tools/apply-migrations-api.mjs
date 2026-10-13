// Aplica supabase/migrations al proyecto AUTORIZADO mediante la Management API
// (SUPABASE_ACCESS_TOKEN en .env). Cada migración corre en una transacción y se
// registra en supabase_migrations.schema_migrations, igual que `supabase db push`.
// Uso: node tools/apply-migrations-api.mjs [--apply]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) throw new Error('Falta SUPABASE_ACCESS_TOKEN en .env');
const config = readFileSync(join(root, 'js/config.js'), 'utf8');
if (!config.includes(`https://${AUTHORIZED_REF}.supabase.co`) || config.includes('gacqqaimdfvkmznsglpg')) throw new Error('El frontend no apunta al proyecto autorizado.');

async function assertTarget() {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}`, { headers: { Authorization: `Bearer ${token}` } });
  const project = await response.json();
  if (!response.ok || project.id !== AUTHORIZED_REF) throw new Error(`Destino no verificado: ${project.message || project.id}`);
  return project;
}
async function query(sql) {
  await assertTarget();
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

const project = await assertTarget();
console.log(`Destino verificado: ${project.id} (${project.name}, ${project.status})`);
await query('create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);');
const applied = new Set((await query('select version from supabase_migrations.schema_migrations')).map(row => row.version));
const files = readdirSync(join(root, 'supabase/migrations')).filter(name => name.endsWith('.sql')).sort();
for (const file of files) {
  const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
  if (applied.has(version)) { console.log(`= ${file} ya aplicada`); continue; }
  if (!process.argv.includes('--apply')) { console.log(`+ ${file} pendiente (usa --apply)`); continue; }
  const sql = readFileSync(join(root, 'supabase/migrations', file), 'utf8');
  await query(`begin;\n${sql}\ninsert into supabase_migrations.schema_migrations(version, name, statements) values (${literal(version)}, ${literal(rest.join('_'))}, array[${literal(sql)}]);\ncommit;`);
  console.log(`✓ ${file} aplicada`);
}
