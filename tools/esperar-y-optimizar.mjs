// Espera a que Supabase vuelva a responder y completa la optimización de imágenes sin intervención:
//   1. Cada 5 min consulta REST y Storage; sigue esperando (sin límite) mientras haya 402 o fallos.
//   2. Con ambos en 200: optimize-storage --dry-run y, si no hay errores, la ejecución real.
//   3. Verifica variantes, imágenes referenciadas, integridad de datos/originales y mide antes/después.
//   4. Solo si todo pasa: commit del manifiesto, build-deploy, push a GitHub Pages y verificación en vivo.
// Si algo falla no publica, deja el manifiesto como estaba y explica el error en el reporte.
// Log: tools/esperar-y-optimizar.log · Reporte: REPORTE-FINAL-EGRESS.md
// Uso: node tools/esperar-y-optimizar.mjs   (lo arranca la tarea programada BodegaEsperarOptimizar)
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const LOG = join(root, 'tools', 'esperar-y-optimizar.log');
const PID = join(root, 'tools', 'esperar-y-optimizar.pid');
const REPORT = join(root, 'REPORTE-FINAL-EGRESS.md');
const MANIFEST = join(root, 'js', 'lib', 'optimized-images.js');
const TASK = 'BodegaEsperarOptimizar';
const INTERVAL = 5 * 60 * 1000;
const SITE = 'https://bodegamayoristafc.shop';
const BASE_COMMIT = 'e0ea168'; // última versión publicada antes de la optimización
const BRANCH = 'bodega-main';
const REMOTE = 'bodega';
const TABLES = ['products', 'product_images', 'categories', 'brands', 'homepage_banners', 'payment_methods', 'site_settings'];
const config = readFileSync(join(root, 'js', 'config.js'), 'utf8');
const SUPABASE_URL = config.match(/SUPABASE_URL = '([^']+)'/)[1];
const ANON = config.match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const REF = new URL(SUPABASE_URL).hostname.split('.')[0];
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));

const sleep = ms => new Promise(done => setTimeout(done, ms));
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' });
function log(message) {
  const line = `[${stamp()}] ${message}`;
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (before, after) => before ? `${((1 - after / before) * 100).toFixed(1)} %` : '—';

class StageError extends Error { constructor(stage, message) { super(message); this.stage = stage; } }

// --- Utilidades ---------------------------------------------------------------------------
function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (!quiet && output) output.split(/\r?\n/).forEach(line => log(`  │ ${line}`));
  return { status: result.status, output };
}
const node = (...args) => run(process.execPath, args);
const git = (...args) => run('git', args, { quiet: true });

async function sql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query })
  });
  if (!response.ok) throw new Error(`Management API ${response.status}`);
  return response.json();
}

async function status(url, init = {}) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    return response.status;
  } catch (error) { return `error ${error.cause?.code || error.name}`; }
}

function readManifest() {
  const match = readFileSync(MANIFEST, 'utf8').match(/OPTIMIZED_IMAGES = (\{[\s\S]*?\});/);
  return match ? JSON.parse(match[1]) : {};
}
const publicUrl = (bucket, path) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
const variantPath = (path, width) => `optimized/${width}/${path.replace(/\.[^./]+$/, '')}.webp`;

// --- Navegador headless (CDP) para medir y revisar imágenes ------------------------------
function staticServer(dir, port) {
  const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
  return new Promise(done => {
    const server = createServer(async (request, response) => {
      let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = join(dir, normalize(path));
      if (!file.startsWith(dir) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
      response.end(readFileSync(file));
    }).listen(port, () => done(server));
  });
}

async function openBrowser() {
  const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  const port = 9700 + Math.floor(Math.random() * 200);
  const profile = join(tmpdir(), `bodega-medicion-${Date.now()}`);
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
    await sleep(250);
    target = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).then(list => list.find(item => item.type === 'page')).catch(() => null);
  }
  if (!target) { chrome.kill(); throw new Error('Chrome headless no respondió'); }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else listeners.forEach(listener => listener(message));
  };
  const send = (method, params = {}) => new Promise(done => { id += 1; pending.set(id, done); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Network.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  return {
    send, evaluate, on: listener => listeners.push(listener),
    async close() {
      try { socket.close(); } catch { /* cerrado */ }
      const exited = new Promise(done => chrome.once('exit', done));
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
      // El perfil temporal es prescindible: si Windows aún lo bloquea, se deja para el sistema.
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* sin efecto en el resultado */ }
    }
  };
}

// Visita típica: inicio → catálogo → 2 productos, con desplazamiento para cargar imágenes perezosas.
// Mide bytes transferidos (encodedDataLength) hacia Supabase, separando Storage del resto.
async function measureVisit(baseUrl, pages) {
  const browser = await openBrowser();
  const requests = new Map();
  const consoleErrors = [];
  browser.on(message => {
    if (message.method === 'Network.requestWillBeSent') requests.set(message.params.requestId, { url: message.params.request.url, method: message.params.request.method, bytes: 0, status: 0, done: false });
    if (message.method === 'Network.responseReceived' && requests.has(message.params.requestId)) requests.get(message.params.requestId).status = message.params.response.status;
    if (message.method === 'Network.loadingFinished' && requests.has(message.params.requestId)) Object.assign(requests.get(message.params.requestId), { bytes: message.params.encodedDataLength, done: true });
    if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(message.params.exceptionDetails.exception?.description?.split('\n')[0] || message.params.exceptionDetails.text);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(`${message.params.entry.text} ${message.params.entry.url || ''}`.trim());
  });
  const broken = [];
  let fallbacks = 0;
  try {
    for (const page of pages) {
      await browser.send('Page.navigate', { url: `${baseUrl}/${page}` });
      await sleep(5000);
      await browser.evaluate(`(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); } scrollTo(0, 0); })()`);
      await sleep(4000);
      const images = await browser.evaluate(`[...document.images].map(image => ({ src: image.currentSrc || image.src, ok: image.complete && image.naturalWidth > 0, loaded: image.complete, fallback: Boolean(image.dataset.variantFallback), placeholder: image.classList.contains('image-fallback') }))`) || [];
      images.filter(image => image.loaded && (!image.ok || image.placeholder)).forEach(image => broken.push(`${page}: ${image.src}`));
      fallbacks += images.filter(image => image.fallback).length;
    }
  } finally { await browser.close(); }
  const supabase = [...requests.values()].filter(item => /\.supabase\.co\//.test(item.url) && item.done);
  const storage = supabase.filter(item => item.url.includes('/storage/v1/'));
  const api = supabase.filter(item => !item.url.includes('/storage/v1/'));
  const sum = items => items.reduce((total, item) => total + item.bytes, 0);
  return {
    storageBytes: sum(storage), storageRequests: storage.length, apiBytes: sum(api), apiRequests: api.length,
    variantRequests: storage.filter(item => item.url.includes('/optimized/')).length,
    failedSupabase: supabase.filter(item => item.status >= 400).map(item => `${item.status} ${item.url}`),
    broken, fallbacks, consoleErrors
  };
}

// --- Etapas ---------------------------------------------------------------------------------
async function supabaseOnline() {
  const rest = await status(`${SUPABASE_URL}/rest/v1/site_settings?select=id&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
  let storage = 'sin objeto';
  try {
    const [sample] = await sql(`select bucket_id, name from storage.objects where bucket_id = 'category-images' and name not like 'optimized/%' order by created_at limit 1`);
    storage = sample ? await status(publicUrl(sample.bucket_id, sample.name), { method: 'HEAD' }) : 'sin objeto';
  } catch (error) { storage = `error ${error.message}`; }
  return { ok: rest === 200 && storage === 200, rest, storage };
}

function optimize() {
  log('Dry-run de optimize-storage…');
  const dry = node('tools/optimize-storage.mjs', '--dry-run');
  if (dry.status !== 0 || /✗/.test(dry.output)) throw new StageError('dry-run', `El dry-run terminó con errores (código ${dry.status}).`);
  log('Dry-run correcto. Ejecución real…');
  const real = node('tools/optimize-storage.mjs');
  if (real.status !== 0 || /✗/.test(real.output)) throw new StageError('optimización', `optimize-storage terminó con errores (código ${real.status}).`);
  const backupDir = real.output.match(/Respaldo en (backups[\\/][^:]+):/)?.[1];
  if (!backupDir) throw new StageError('optimización', 'No se encontró la carpeta de respaldo en la salida.');
  return join(root, backupDir.trim());
}

async function verifyVariants() {
  const manifest = readManifest();
  const entries = Object.entries(manifest);
  if (!entries.length) throw new StageError('verificación de variantes', 'El manifiesto quedó vacío.');
  const sizes = { 400: 0, 800: 0, 1200: 0 };
  const problems = [];
  for (const [key] of entries) {
    const [bucket, ...rest] = key.split('/');
    for (const width of [400, 800, 1200]) {
      const url = publicUrl(bucket, variantPath(rest.join('/'), width));
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const bytes = (await response.arrayBuffer()).byteLength;
        if (!response.ok || !bytes || !/^image\//.test(response.headers.get('content-type') || '')) problems.push(`${response.status} ${url}`);
        sizes[width] += bytes;
      } catch (error) { problems.push(`${error.name} ${url}`); }
    }
  }
  if (problems.length) throw new StageError('verificación de variantes', `${problems.length} variantes no descargan:\n${problems.slice(0, 20).join('\n')}`);
  log(`Variantes verificadas: ${entries.length} originales × 3 anchos descargan correctamente.`);
  return { count: entries.length, sizes };
}

async function verifyReferencedImages() {
  const { variantUrl } = await import(pathToFileURL(join(root, 'js', 'lib', 'image-variants.js')).href);
  const rows = await sql(`select url from product_images union all select image_url from categories union all select logo_url from brands
    union all select logo_url from payment_methods union all select desktop_image_url from homepage_banners union all select mobile_image_url from homepage_banners
    union all select size_guide_image_url from products union all select logo_url from site_settings`);
  const urls = [...new Set(rows.map(row => Object.values(row)[0]).filter(Boolean))];
  const problems = [];
  for (const url of urls) {
    if (!/^https?:/i.test(url)) { if (!existsSync(join(root, url.replace(/^\//, '')))) problems.push(`archivo local inexistente: ${url}`); continue; }
    const targets = [url, ...['thumb', 'md', 'lg'].map(size => variantUrl(url, size)).filter(target => target !== url)];
    for (const target of new Set(targets)) {
      const code = await status(target, { method: 'HEAD' });
      if (code !== 200) problems.push(`${code} ${target}`);
    }
  }
  if (problems.length) throw new StageError('imágenes referenciadas', `${problems.length} imágenes rotas:\n${problems.slice(0, 20).join('\n')}`);
  log(`Imágenes referenciadas verificadas: ${urls.length} (originales y variantes responden 200).`);
  return urls.length;
}

function verifyIntegrity(preDir) {
  const post = node('tools/optimize-storage.mjs', '--backup-only');
  const postDir = post.output.match(/Respaldo en (backups[\\/][^:]+):/)?.[1];
  if (post.status !== 0 || !postDir) throw new StageError('integridad', 'No se pudo tomar el respaldo posterior.');
  const after = join(root, postDir.trim());
  const changed = TABLES.filter(table => readFileSync(join(preDir, `${table}.json`), 'utf8') !== readFileSync(join(after, `${table}.json`), 'utf8'));
  const originals = dir => JSON.stringify(JSON.parse(readFileSync(join(dir, 'storage-inventory.json'), 'utf8')).filter(item => !item.name.startsWith('optimized/')));
  if (originals(preDir) !== originals(after)) changed.push('storage (originales)');
  if (changed.length) throw new StageError('integridad', `Cambió respecto al respaldo: ${changed.join(', ')}.`);
  log('Integridad: tablas y originales de Storage idénticos al respaldo.');
  const inventory = JSON.parse(readFileSync(join(after, 'storage-inventory.json'), 'utf8'));
  return inventory.filter(item => !item.name.startsWith('optimized/') && /^image\/(jpeg|png|webp|avif)$/.test(item.mime));
}

async function measure() {
  const products = await sql(`select p.slug, count(*) n from products p join product_images i on i.product_id = p.id
    where p.status = 'published' and i.url like '%supabase.co/storage%' group by p.slug order by n desc, p.slug limit 2`);
  const fallback = await sql(`select slug from products where status = 'published' order by created_at desc limit 2`);
  const slugs = (products.length === 2 ? products : fallback).map(row => row.slug);
  const pages = ['index.html', 'catalogo.html', ...slugs.map(slug => `producto.html?slug=${encodeURIComponent(slug)}`)];
  const baseDir = join(tmpdir(), 'bodega-egress-antes');
  if (!existsSync(join(baseDir, 'index.html'))) {
    git('worktree', 'remove', '--force', baseDir);
    const added = git('worktree', 'add', '--detach', baseDir, BASE_COMMIT);
    if (added.status !== 0) throw new StageError('medición', `No se pudo preparar la versión anterior: ${added.output}`);
  }
  const [beforeServer, afterServer] = await Promise.all([staticServer(baseDir, 8301), staticServer(root, 8302)]);
  try {
    log(`Midiendo visita típica (${pages.join(' → ')}) con la versión anterior…`);
    const before = await measureVisit('http://localhost:8301', pages);
    log(`Midiendo la misma visita con la versión optimizada…`);
    const after = await measureVisit('http://localhost:8302', pages);
    return { pages, before, after };
  } finally {
    beforeServer.close(); afterServer.close();
    git('worktree', 'remove', '--force', baseDir);
  }
}

function writeReport({ state, error, variants, originals, referenced, measurement, published }) {
  const lines = [`# Reporte final de egress`, '', `Estado: **${state}** · ${stamp()} (hora de Bogotá)`, ''];
  if (error) lines.push(`## Error`, '', `Etapa: **${error.stage || 'desconocida'}**`, '', '```', error.message, '```', '',
    'No se publicó nada. Los datos y los originales no se tocan. Si ya se subieron variantes, siguen en Storage sin uso;',
    'se revierten con `node tools/optimize-storage.mjs --revert backups/<fecha>/storage-map.json --delete-variants`.',
    'El manifiesto local se restauró a la versión publicada. Detalle completo en `tools/esperar-y-optimizar.log`.', '');
  if (measurement && variants && originals) {
    const { before, after } = measurement;
    const originalBytes = originals.reduce((total, item) => total + Number(item.size), 0);
    const variantBytes = variants.sizes[400] + variants.sizes[800] + variants.sizes[1200];
    const total = side => side.storageBytes + side.apiBytes;
    const visits = bytes => bytes ? Math.floor(5e9 / bytes).toLocaleString('es-CO') : '∞';
    const limit = side => visits(Math.max(side.storageBytes, side.apiBytes));
    lines.push('## ANTES → DESPUÉS (valores medidos)', '',
      `Visita típica medida en Chrome (móvil 390 px, DPR 2, caché vacía): ${measurement.pages.join(' → ')}.`,
      'Bytes transferidos reales (encodedDataLength) hacia Supabase; "cacheado" = Storage/CDN, "no cacheado" = REST/RPC.', '',
      '| Métrica | ANTES | DESPUÉS | Reducción |', '|---|---|---|---|',
      `| Imágenes en Storage: total | ${mb(originalBytes)} (${originals.length} originales) | ${mb(variants.sizes[400])} thumb · ${mb(variants.sizes[800])} md · ${mb(variants.sizes[1200])} lg (${variants.count} × 3 variantes, ${mb(variantBytes)}) | thumb ${pct(originalBytes, variants.sizes[400])} |`,
      `| Peso promedio por imagen | ${kb(originalBytes / originals.length)} | ${kb(variants.sizes[400] / variants.count)} thumb · ${kb(variants.sizes[800] / variants.count)} md · ${kb(variants.sizes[1200] / variants.count)} lg | thumb ${pct(originalBytes / originals.length, variants.sizes[400] / variants.count)} |`,
      `| Imágenes descargadas por visita | ${kb(before.storageBytes)} (${before.storageRequests} peticiones) | ${kb(after.storageBytes)} (${after.storageRequests} peticiones) | ${pct(before.storageBytes, after.storageBytes)} |`,
      `| Datos (REST/RPC) por visita | ${kb(before.apiBytes)} (${before.apiRequests} peticiones) | ${kb(after.apiBytes)} (${after.apiRequests} peticiones) | ${pct(before.apiBytes, after.apiBytes)} |`,
      `| Egress cacheado por 1.000 visitas | ${mb(before.storageBytes * 1000)} | ${mb(after.storageBytes * 1000)} | ${pct(before.storageBytes, after.storageBytes)} |`,
      `| Egress no cacheado por 1.000 visitas | ${mb(before.apiBytes * 1000)} | ${mb(after.apiBytes * 1000)} | ${pct(before.apiBytes, after.apiBytes)} |`,
      `| Visitas que caben en 5 GB cacheado | ${visits(before.storageBytes)} | ${visits(after.storageBytes)} | |`,
      `| Visitas que caben en 5 GB no cacheado | ${visits(before.apiBytes)} | ${visits(after.apiBytes)} | |`,
      `| Visitas al mes (límite más estricto) | ${limit(before)} | ${limit(after)} | |`,
      `| **Total por visita** | **${kb(total(before))}** | **${kb(total(after))}** | **${pct(total(before), total(after))}** |`, '',
      `Comprobaciones: ${referenced} imágenes referenciadas en la base responden (originales y variantes); imágenes rotas en la medición: ${after.broken.length}; fallbacks a original: ${after.fallbacks}.`,
      'La cuota de 5 GB es de la organización y se comparte con otro proyecto.', '');
  }
  if (published) lines.push('## Publicación', '', ...published, '');
  writeFileSync(REPORT, `${lines.join('\n')}\n`);
}

async function publish() {
  if (git('branch', '--show-current').output !== BRANCH) throw new StageError('publicación', `La rama actual no es ${BRANCH}.`);
  git('fetch', REMOTE);
  if (git('merge-base', '--is-ancestor', `${REMOTE}/main`, 'HEAD').status !== 0) throw new StageError('publicación', `${REMOTE}/main tiene commits que no están en local; no se publica para no sobrescribirlos.`);
  git('add', 'js/lib/optimized-images.js');
  const commit = git('commit', '-m', `Imágenes: activa variantes WebP de Storage (${Object.keys(readManifest()).length} originales)\n\nGenerado por tools/esperar-y-optimizar.mjs tras verificar variantes,\nimágenes referenciadas e integridad de datos.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
  if (commit.status !== 0) throw new StageError('publicación', `git commit falló: ${commit.output}`);
  const build = node('tools/build-deploy.mjs');
  if (build.status !== 0) { git('reset', '--soft', 'HEAD~1'); throw new StageError('publicación', 'build-deploy falló.'); }
  const push = git('push', REMOTE, `${BRANCH}:main`);
  if (push.status !== 0) { git('reset', '--soft', 'HEAD~1'); throw new StageError('publicación', `git push falló: ${push.output}`); }
  git('branch', '-f', 'optimizacion-egress', BRANCH);
  log(`Publicado ${git('rev-parse', '--short', 'HEAD').output} en ${REMOTE}/main.`);
}

async function verifyLive() {
  const expected = readFileSync(MANIFEST, 'utf8').replace(/\r\n/g, '\n');
  let live = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    live = await fetch(`${SITE}/js/lib/optimized-images.js?nc=${Date.now()}`).then(response => response.text()).catch(() => '');
    if (live.replace(/\r\n/g, '\n') === expected) break;
    await sleep(30000);
  }
  if (live.replace(/\r\n/g, '\n') !== expected) return [`GitHub Pages aún no sirve el manifiesto nuevo tras 20 min: revisar manualmente ${SITE}.`];
  const robots = await status(`${SITE}/robots.txt`);
  const og = await status(`${SITE}/assets/images/og-image.jpg`);
  const result = await measureVisit(SITE, ['index.html', 'catalogo.html', 'categorias.html']);
  const lines = [
    `Sitio publicado: ${SITE} sirve el manifiesto nuevo.`,
    `Visita en vivo (inicio, catálogo, categorías): ${result.storageRequests} imágenes de Storage (${result.variantRequests} variantes, ${kb(result.storageBytes)}), ${result.apiRequests} peticiones de datos (${kb(result.apiBytes)}).`,
    `Imágenes rotas: ${result.broken.length}; fallbacks a original: ${result.fallbacks}; peticiones a Supabase con error: ${result.failedSupabase.length}; errores de consola: ${result.consoleErrors.length}.`,
    `robots.txt: ${robots} · og-image.jpg: ${og}.`
  ];
  [...result.broken, ...result.failedSupabase, ...result.consoleErrors].slice(0, 10).forEach(item => lines.push(`- ${item}`));
  if (result.broken.length) {
    // Imágenes rotas en producción: se vuelve a los originales (estado verificado anterior).
    git('revert', '--no-edit', 'HEAD');
    const push = git('push', REMOTE, `${BRANCH}:main`);
    lines.push(`Se detectaron imágenes rotas en vivo: se revirtió el manifiesto (${push.status === 0 ? 'publicado' : 'push falló, revisar'}).`);
  }
  return lines;
}

function finish() {
  rmSync(PID, { force: true });
  spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { stdio: 'ignore' });
}

// --- Principal --------------------------------------------------------------------------------
async function main() {
  if (existsSync(REPORT) && /Estado: \*\*(COMPLETADO|FALLÓ)/.test(readFileSync(REPORT, 'utf8'))) { log('Ya existe un reporte final: no hay nada que hacer.'); finish(); return; }
  if (existsSync(PID)) {
    const other = Number(readFileSync(PID, 'utf8'));
    try { if (other && other !== process.pid) { process.kill(other, 0); log(`Ya hay una instancia activa (PID ${other}).`); return; } } catch { /* proceso inexistente */ }
  }
  writeFileSync(PID, String(process.pid));
  mkdirSync(join(root, 'backups'), { recursive: true });
  log(`Vigilante iniciado (PID ${process.pid}). Consulta Supabase cada 5 min.`);
  for (let check = 1; ; check += 1) {
    const online = await supabaseOnline();
    if (online.ok) { log(`Supabase disponible (REST ${online.rest}, Storage ${online.storage}).`); break; }
    log(`#${check} Supabase no disponible (REST ${online.rest}, Storage ${online.storage}). Nuevo intento en 5 min.`);
    await sleep(INTERVAL);
  }
  const committedManifest = readFileSync(MANIFEST, 'utf8');
  const context = {};
  try {
    const preDir = optimize();
    context.variants = await verifyVariants();
    context.referenced = await verifyReferencedImages();
    context.originals = verifyIntegrity(preDir);
    context.measurement = await measure();
    const { after } = context.measurement;
    if (after.broken.length) throw new StageError('medición', `Imágenes rotas en la versión optimizada:\n${after.broken.slice(0, 20).join('\n')}`);
    const failed = [...context.measurement.before.failedSupabase, ...after.failedSupabase];
    if (failed.length) throw new StageError('medición', `Supabase respondió con error durante la medición (no es válida):\n${failed.slice(0, 10).join('\n')}`);
    if (!context.measurement.before.storageRequests) throw new StageError('medición', 'La versión anterior no descargó imágenes de Storage: la medición no es válida.');
    log(`Medición: antes ${kb(context.measurement.before.storageBytes)} imágenes + ${kb(context.measurement.before.apiBytes)} datos; después ${kb(after.storageBytes)} + ${kb(after.apiBytes)}.`);
    writeReport({ state: 'PUBLICANDO', ...context });
    await publish();
    context.published = await verifyLive();
    context.published.forEach(line => log(line));
    const warnings = context.published.some(line => /no sirve el manifiesto|revirtió/.test(line) || /(rotas|con error|consola): [1-9]/.test(line));
    writeReport({ state: warnings ? 'COMPLETADO CON AVISOS' : 'COMPLETADO', ...context });
    log('Proceso completado. Reporte en REPORTE-FINAL-EGRESS.md.');
  } catch (error) {
    log(`✗ ${error.stage ? `[${error.stage}] ` : ''}${error.message}`);
    if (git('diff', '--quiet', '--', 'js/lib/optimized-images.js').status !== 0 && readFileSync(MANIFEST, 'utf8') !== committedManifest) {
      writeFileSync(MANIFEST, committedManifest);
      log('Manifiesto local restaurado: la tienda sigue usando los originales.');
    }
    writeReport({ state: 'FALLÓ', error, ...context });
    process.exitCode = 1;
  } finally {
    finish();
  }
}

main().catch(error => { log(`✗ Error inesperado: ${error.stack || error.message}`); finish(); process.exitCode = 1; });
