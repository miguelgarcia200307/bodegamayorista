// Prepara la carpeta deploy/sitio con SOLO los archivos públicos del sitio (HTML, admin,
// assets y js) para subirlos al repositorio de GitHub Pages que publica el dominio.
// Nunca incluye .env, herramientas, migraciones, respaldos ni documentos internos.
// Uso: node tools/build-deploy.mjs   →  deploy/sitio  (y luego comprimir o copiar)
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const out = join(root, 'deploy', 'sitio');
rmSync(out, { recursive: true, force: true });
const files = readdirSync(root).filter(name => name.endsWith('.html') || ['robots.txt', 'sitemap.xml', 'manifest.webmanifest'].includes(name));
for (const name of files) cpSync(join(root, name), join(out, name));
for (const dir of ['admin', 'assets', 'js']) cpSync(join(root, dir), join(out, dir), { recursive: true, filter: source => !/\.(md|map|log)$/i.test(source) });
writeFileSync(join(out, 'CNAME'), 'bodegamayoristafc.shop\n');
writeFileSync(join(out, '.nojekyll'), '');
// Comprobaciones de seguridad del paquete.
const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const all = walk(out);
const forbidden = all.filter(path => /\.env|service_role|sb_secret_/i.test(path) || (/\.(js|html)$/.test(path) && /sb_secret_|service_role/.test(readFileSync(path, 'utf8'))));
if (forbidden.length) throw new Error(`El paquete contiene material sensible: ${forbidden.join(', ')}`);
if (!existsSync(join(out, 'ayuda.html'))) throw new Error('Falta ayuda.html');
const manifest = all.map(path => `${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)}  ${path.slice(out.length + 1).replace(/\\/g, '/')}`).sort((a, b) => a.slice(14).localeCompare(b.slice(14)));
writeFileSync(join(root, 'deploy', 'MANIFIESTO.txt'), `${manifest.join('\n')}\n`);
console.log(`deploy/sitio listo: ${all.length} archivos (sin secretos). Manifiesto en deploy/MANIFIESTO.txt`);
