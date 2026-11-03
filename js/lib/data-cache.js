// Caché de lecturas PÚBLICAS de Supabase (catálogo, categorías, marcas, configuración):
// memoria + localStorage con caducidad, para que navegar entre páginas no repita las
// mismas consultas. Nunca se usa en el panel, el carrito ni el checkout (siempre frescos),
// nunca guarda errores y cada lectura devuelve una copia (los llamadores pueden mutarla).
const PREFIX = 'bm_data_v1:';
const MAX_ENTRY_CHARS = 400_000;
const memory = new Map();

export const MINUTE = 60 * 1000;

function bypassed() {
  if (typeof document === 'undefined') return true;
  const page = document.body?.dataset.page || '';
  return location.pathname.includes('/admin/') || page.startsWith('admin') || page === 'cart' || page === 'checkout';
}

function storage() {
  try { return window.localStorage; } catch { return null; }
}

function readStored(key, now) {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || entry.expires <= now) { storage()?.removeItem(PREFIX + key); return null; }
    return entry;
  } catch { return null; }
}

function writeStored(key, value, expires) {
  const store = storage();
  if (!store) return;
  let raw;
  try { raw = JSON.stringify({ expires, value }); } catch { return; }
  if (raw.length > MAX_ENTRY_CHARS) return;
  try { store.setItem(PREFIX + key, raw); }
  catch {
    clearDataCache();
    try { store.setItem(PREFIX + key, raw); } catch { /* sin espacio: solo memoria */ }
  }
}

function pruneExpired() {
  const store = storage();
  if (!store) return;
  try {
    const now = Date.now();
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const name = store.key(index);
      if (!name?.startsWith(PREFIX)) continue;
      try { if (JSON.parse(store.getItem(name))?.expires <= now) store.removeItem(name); }
      catch { store.removeItem(name); }
    }
  } catch { /* almacenamiento no disponible */ }
}

export function clearDataCache() {
  memory.clear();
  const store = storage();
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const name = store.key(index);
      if (name?.startsWith(PREFIX)) store.removeItem(name);
    }
  } catch { /* almacenamiento no disponible */ }
}

const copy = value => (value == null ? value : structuredClone(value));

export function cachedRead(key, ttl, loader) {
  if (bypassed()) return loader();
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.expires > now) return hit.promise.then(copy);
  const stored = readStored(key, now);
  if (stored) {
    const promise = Promise.resolve(stored.value);
    memory.set(key, { promise, expires: stored.expires });
    return promise.then(copy);
  }
  const expires = now + ttl;
  const promise = Promise.resolve().then(loader).then(value => {
    writeStored(key, value, expires);
    return value;
  });
  memory.set(key, { promise, expires });
  promise.catch(() => { if (memory.get(key)?.promise === promise) memory.delete(key); });
  return promise.then(copy);
}

// El panel modifica el catálogo: al abrirlo se descarta lo guardado para que la tienda,
// en este mismo navegador, muestre enseguida los cambios.
if (typeof location !== 'undefined' && location.pathname.includes('/admin/')) clearDataCache();
else pruneExpired();
