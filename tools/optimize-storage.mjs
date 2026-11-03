// Genera variantes WebP livianas de las imágenes de Supabase Storage SIN tocar los originales.
// Convención: <bucket>/optimized/<ancho>/<ruta-original-sin-extensión>.webp  (anchos 400, 800, 1200).
// Las tres rutas existen siempre: si el original es más angosto no se agranda, y si la
// variante pesaría más que el original se sube el original (se conserva la más liviana).
// El frontend solo usa variantes de los originales listados en js/lib/optimized-images.js,
// que este script actualiza al terminar; con fallback automático al original si algo falla.
//
// Sin dependencias: Node + Chrome/Edge headless (canvas → WebP) como tools/qa-ui-mock.mjs.
// La clave secreta del proyecto se pide a la Management API (SUPABASE_ACCESS_TOKEN en .env)
// y solo vive en memoria durante la ejecución: nunca se escribe en disco ni en el repositorio.
//
// Uso:
//   node tools/optimize-storage.mjs --backup-only            respaldo de tablas + inventario de Storage
//   node tools/optimize-storage.mjs --dry-run                descarga y procesa, NO sube nada
//   node tools/optimize-storage.mjs --dry-run --local <dir>  prueba sin red con imágenes locales
//   node tools/optimize-storage.mjs                          respalda, sube variantes y actualiza el manifiesto
//   node tools/optimize-storage.mjs --force                  vuelve a generar variantes ya existentes
//   node tools/optimize-storage.mjs --revert backups/<ts>/storage-map.json [--delete-variants]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const REF = 'ekepygodvciqnqkrgrsv';
const SUPABASE_URL = `https://${REF}.supabase.co`;
const BUCKETS = ['product-images', 'brand-assets', 'category-images', 'site-assets', 'banner-images'];
const WIDTHS = [400, 800, 1200];
const QUALITY = 0.78;
const RASTER = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
const BACKUP_TABLES = ['products', 'product_images', 'categories', 'brands', 'homepage_banners', 'payment_methods', 'site_settings'];

const root = resolve(new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const manifestPath = join(root, 'js', 'lib', 'optimized-images.js');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const dryRun = flag('--dry-run');
const localDir = option('--local');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(root, 'backups', stamp);
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;

function readEnv() {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
}
const token = readEnv().SUPABASE_ACCESS_TOKEN;

// --- Management API (lectura SQL e inventario) ------------------------------------------
async function management(path, init = {}) {
  if (!token) throw new Error('Falta SUPABASE_ACCESS_TOKEN en .env');
  const response = await fetch(`https://api.supabase.com/v1/projects/${REF}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Management API ${path}: ${body.message || response.status}`);
  return body;
}
const sql = query => management('/database/query', { method: 'POST', body: JSON.stringify({ query }) });

async function assertTarget() {
  const config = readFileSync(join(root, 'js', 'config.js'), 'utf8');
  if (!config.includes(SUPABASE_URL)) throw new Error('js/config.js no apunta al proyecto autorizado.');
  const project = await management('');
  if (project.id !== REF) throw new Error('Destino no verificado.');
  return project;
}

async function storageInventory() {
  return sql(`select bucket_id, name, (metadata->>'size')::bigint as size, metadata->>'mimetype' as mime, metadata->>'cacheControl' as cache_control, created_at
    from storage.objects where bucket_id in (${BUCKETS.map(bucket => `'${bucket}'`).join(',')}) order by bucket_id, name`);
}

async function backup() {
  mkdirSync(backupDir, { recursive: true });
  for (const table of BACKUP_TABLES) {
    const rows = await sql(`select coalesce(json_agg(t), '[]'::json) as rows from public.${table} t`);
    writeFileSync(join(backupDir, `${table}.json`), JSON.stringify(rows[0].rows, null, 1));
  }
  const inventory = await storageInventory();
  writeFileSync(join(backupDir, 'storage-inventory.json'), JSON.stringify(inventory, null, 1));
  const originals = inventory.filter(item => !item.name.startsWith('optimized/'));
  const total = originals.reduce((sum, item) => sum + Number(item.size || 0), 0);
  console.log(`Respaldo en ${relative(root, backupDir)}: ${BACKUP_TABLES.length} tablas, ${originals.length} objetos originales (${kb(total)}).`);
  return inventory;
}

// --- Storage (requiere que la API responda 200) -----------------------------------------
async function secretKey() {
  const keys = await management('/api-keys?reveal=true');
  const key = keys.find(item => item.type === 'secret' && item.api_key && !item.api_key.includes('·'))
    || keys.find(item => item.name === 'service_role' && item.api_key);
  if (!key?.api_key) throw new Error('No se pudo obtener la clave secreta del proyecto.');
  return key.api_key;
}

async function assertStorageOnline(sample) {
  const url = sample ? publicUrl(sample.bucket_id, sample.name) : `${SUPABASE_URL}/storage/v1/version`;
  const response = await fetch(url, { method: 'HEAD' });
  if (response.status === 402) throw new Error('Supabase sigue respondiendo 402 (organización restringida). Vuelve a ejecutar cuando responda 200.');
  if (!response.ok && response.status !== 404) throw new Error(`Storage respondió ${response.status}.`);
}

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const publicUrl = (bucket, path) => `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodePath(path)}`;
const variantPath = (path, width) => `optimized/${width}/${path.replace(/\.[^./]+$/, '')}.webp`;

async function download(bucket, path) {
  const response = await fetch(publicUrl(bucket, path));
  if (!response.ok) throw new Error(`Descarga ${bucket}/${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function upload(key, bucket, path, bytes, contentType, upsert) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': contentType, 'Cache-Control': 'max-age=31536000', 'x-upsert': String(upsert) },
    body: bytes
  });
  if (response.status === 409 || (response.status === 400 && /exists/i.test(await response.clone().text()))) return 'exists';
  if (!response.ok) throw new Error(`Subida ${bucket}/${path}: HTTP ${response.status} ${await response.text()}`);
  return 'uploaded';
}

async function removeObjects(key, bucket, paths) {
  const safe = paths.filter(path => path.startsWith('optimized/'));
  if (!safe.length) return;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: safe })
  });
  if (!response.ok) throw new Error(`Borrado de variantes en ${bucket}: HTTP ${response.status}`);
}

// --- Chrome headless como codificador WebP ----------------------------------------------
async function startEncoder() {
  const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
  if (!chromePath) throw new Error('No se encontró Chrome ni Edge para codificar WebP.');
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = join(tmpdir(), `bodega-optimize-${Date.now()}`);
  const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let attempt = 0; attempt < 50 && !targets; attempt += 1) {
    await new Promise(done => setTimeout(done, 200));
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => null);
  }
  const page = targets?.find(target => target.type === 'page');
  if (!page) { chrome.kill(); throw new Error('Chrome headless no respondió.'); }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  };
  const send = (method, params = {}) => new Promise(done => { id += 1; pending.set(id, done); socket.send(JSON.stringify({ id, method, params })); });
  const encoderSource = `async (b64, mime, widths, quality) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
    const variants = [];
    for (const target of widths) {
      const scale = Math.min(1, target / bitmap.width);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
      const out = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
      variants.push({ target, width, height, type: blob.type, b64: btoa(binary) });
    }
    const result = { width: bitmap.width, height: bitmap.height, variants };
    bitmap.close();
    return JSON.stringify(result);
  }`;
  return {
    async encode(bytes, mime) {
      const expression = `(${encoderSource})(${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(mime)}, ${JSON.stringify(WIDTHS)}, ${QUALITY})`;
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.result?.exceptionDetails || !response.result?.result?.value) throw new Error(response.result?.exceptionDetails?.exception?.description || 'No se pudo decodificar la imagen.');
      const parsed = JSON.parse(response.result.result.value);
      if (parsed.variants.some(variant => variant.type !== 'image/webp')) throw new Error('El navegador no generó WebP.');
      parsed.variants.forEach(variant => { variant.bytes = Buffer.from(variant.b64, 'base64'); delete variant.b64; });
      return parsed;
    },
    close() { try { socket.close(); } catch { /* ya cerrado */ } chrome.kill(); }
  };
}

// Para cada ancho elige la versión más liviana entre la variante WebP y el original.
function chooseVariants(original, mime, encoded) {
  return encoded.variants.map(variant => {
    const keepOriginal = variant.bytes.length >= original.length && encoded.width <= variant.target;
    return keepOriginal
      ? { target: variant.target, width: encoded.width, height: encoded.height, bytes: original, contentType: mime, source: 'original' }
      : { target: variant.target, width: variant.width, height: variant.height, bytes: variant.bytes, contentType: 'image/webp', source: 'webp' };
  });
}

// --- Manifiesto del frontend --------------------------------------------------------------
function readManifest() {
  if (!existsSync(manifestPath)) return {};
  const match = readFileSync(manifestPath, 'utf8').match(/OPTIMIZED_IMAGES = (\{[\s\S]*?\});/);
  return match ? JSON.parse(match[1]) : {};
}

function writeManifest(entries) {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath, `// Generado por tools/optimize-storage.mjs: no editar a mano.
// Originales de Supabase Storage que ya tienen variantes en optimized/<400|800|1200>/…webp,
// con el ancho real del original (para no anunciar en srcset anchos que no existen).
export const OPTIMIZED_IMAGES = ${JSON.stringify(sorted, null, 2)};
`);
}

// --- Modos --------------------------------------------------------------------------------
async function runLocal(dir) {
  const source = resolve(root, dir);
  const files = readdirSync(source).filter(name => Object.values(RASTER).includes(extname(name).slice(1).toLowerCase().replace('jpeg', 'jpg')));
  const outDir = join(backupDir, 'dry-run');
  const encoder = await startEncoder();
  let before = 0; const after = { 400: 0, 800: 0, 1200: 0 };
  try {
    for (const name of files) {
      const bytes = readFileSync(join(source, name));
      const mime = Object.entries(RASTER).find(([, ext]) => ext === extname(name).slice(1).toLowerCase().replace('jpeg', 'jpg'))[0];
      const chosen = chooseVariants(bytes, mime, await encoder.encode(bytes, mime));
      before += bytes.length;
      for (const variant of chosen) {
        after[variant.target] += variant.bytes.length;
        const target = join(outDir, variantPath(name, variant.target));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, variant.bytes);
      }
    }
  } finally { encoder.close(); }
  console.log(`[dry-run local] ${files.length} imágenes de ${relative(root, source)}: originales ${kb(before)} (promedio ${kb(before / Math.max(1, files.length))}).`);
  WIDTHS.forEach(width => console.log(`  ${width}px → ${kb(after[width])} (promedio ${kb(after[width] / Math.max(1, files.length))}, ${(100 - after[width] / before * 100).toFixed(1)} % menos)`));
  console.log(`  Variantes escritas en ${relative(root, outDir)} (no se subió nada).`);
}

async function runRemote() {
  const project = await assertTarget();
  console.log(`Destino verificado: ${project.id} (${project.name})`);
  const inventory = await backup();
  const originals = inventory.filter(item => !item.name.startsWith('optimized/') && RASTER[item.mime]);
  const existing = new Set(inventory.filter(item => item.name.startsWith('optimized/')).map(item => `${item.bucket_id}/${item.name}`));
  await assertStorageOnline(originals[0]);
  const key = dryRun ? null : await secretKey();
  const manifest = readManifest();
  const map = [];
  const encoder = await startEncoder();
  const cacheDir = join(root, 'backups', 'originals');
  let before = 0; const after = { 400: 0, 800: 0, 1200: 0 };
  // Mapeo y manifiesto se guardan tras cada subida: si la ejecución se interrumpe, todo lo
  // subido queda registrado (para revertir) y lo completo ya figura en el manifiesto.
  const persist = () => {
    writeFileSync(join(backupDir, 'storage-map.json'), JSON.stringify(map, null, 1));
    if (!dryRun) writeManifest(manifest);
  };
  try {
    for (const item of originals) {
      const id = `${item.bucket_id}/${item.name}`;
      const paths = WIDTHS.map(width => variantPath(item.name, width));
      const complete = paths.every(path => existing.has(`${item.bucket_id}/${path}`));
      if (complete && manifest[id] && !flag('--force')) { console.log(`= ${id} ya optimizada`); continue; }
      const cached = join(cacheDir, item.bucket_id, item.name);
      const bytes = existsSync(cached) && statSync(cached).size === Number(item.size) ? readFileSync(cached) : await download(item.bucket_id, item.name);
      mkdirSync(dirname(cached), { recursive: true });
      writeFileSync(cached, bytes);
      const encoded = await encoder.encode(bytes, item.mime);
      const chosen = chooseVariants(bytes, item.mime, encoded);
      before += bytes.length;
      const entry = { bucket: item.bucket_id, original: item.name, originalBytes: bytes.length, width: encoded.width, height: encoded.height, variants: [] };
      map.push(entry);
      for (const [index, variant] of chosen.entries()) {
        after[variant.target] += variant.bytes.length;
        const result = dryRun ? 'dry-run' : await upload(key, item.bucket_id, paths[index], variant.bytes, variant.contentType, flag('--force'));
        entry.variants.push({ width: variant.target, path: paths[index], bytes: variant.bytes.length, contentType: variant.contentType, source: variant.source, result });
        persist();
      }
      if (!dryRun) manifest[id] = encoded.width;
      persist();
      console.log(`${dryRun ? '~' : '✓'} ${id}: ${kb(bytes.length)} → ${chosen.map(variant => `${variant.target}:${kb(variant.bytes.length)}`).join(' ')}`);
    }
  } finally { encoder.close(); persist(); }
  console.log(`\n${map.length} originales procesados (${kb(before)}).`);
  WIDTHS.forEach(width => console.log(`  ${width}px → ${kb(after[width])}`));
  console.log(`Mapeo original → variantes: ${relative(root, join(backupDir, 'storage-map.json'))}`);
  if (dryRun) console.log('Modo --dry-run: no se subió nada ni se cambió el manifiesto.');
  else console.log('Manifiesto actualizado: js/lib/optimized-images.js (haz commit y publica el sitio).');
}

async function runRevert(mapFile) {
  const map = JSON.parse(readFileSync(resolve(root, mapFile), 'utf8'));
  const manifest = readManifest();
  map.forEach(entry => { delete manifest[`${entry.bucket}/${entry.original}`]; });
  if (dryRun) { console.log(`[dry-run] Se quitarían ${map.length} entradas del manifiesto.`); return; }
  writeManifest(manifest);
  console.log(`Manifiesto revertido: ${map.length} originales vuelven a servirse sin variantes.`);
  if (!flag('--delete-variants')) { console.log('Las variantes siguen en Storage (sin uso). Añade --delete-variants para borrarlas.'); return; }
  await assertTarget();
  const key = await secretKey();
  for (const bucket of new Set(map.map(entry => entry.bucket))) {
    const paths = map.filter(entry => entry.bucket === bucket).flatMap(entry => entry.variants.filter(variant => variant.result === 'uploaded').map(variant => variant.path));
    await removeObjects(key, bucket, paths);
    console.log(`✓ ${paths.length} variantes borradas de ${bucket} (los originales no se tocan).`);
  }
}

try {
  if (option('--revert')) await runRevert(option('--revert'));
  else if (localDir) await runLocal(localDir);
  else if (flag('--backup-only')) { await assertTarget(); await backup(); }
  else await runRemote();
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
