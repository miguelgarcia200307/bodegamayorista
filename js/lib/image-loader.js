const imageCache = new Map();
const MAX_CACHE_ENTRIES = 48;

function touch(url, entry) {
  entry.lastUsed = Date.now();
  imageCache.delete(url);
  imageCache.set(url, entry);
}

function pruneCache() {
  if (imageCache.size <= MAX_CACHE_ENTRIES) return;
  for (const [url, entry] of imageCache) {
    if (imageCache.size <= MAX_CACHE_ENTRIES) break;
    if (entry.status !== 'pending') imageCache.delete(url);
  }
}

async function decodeSafely(image) {
  if (typeof image.decode !== 'function') return;
  try { await image.decode(); }
  catch (error) {
    if (!image.complete || !image.naturalWidth) throw error;
  }
}

function cachePromise(url, executor) {
  const entry = { status: 'pending', promise: null, error: null, lastUsed: Date.now() };
  entry.promise = executor().then(async image => {
    await decodeSafely(image);
    entry.status = 'loaded';
    touch(url, entry);
    pruneCache();
    return url;
  }).catch(error => {
    entry.status = 'failed';
    entry.error = error;
    touch(url, entry);
    pruneCache();
    throw error;
  });
  imageCache.set(url, entry);
  return entry.promise;
}

function imageLoadPromise(image) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(image); };
    const failed = () => { cleanup(); reject(new Error('No se pudo cargar la imagen.')); };
    image.addEventListener('load', loaded, { once: true });
    image.addEventListener('error', failed, { once: true });
  });
}

export function imageLoadStatus(url) {
  return imageCache.get(url)?.status || 'idle';
}

export function observeImageElement(image, url = image.currentSrc || image.src) {
  if (!image || !url) return Promise.reject(new Error('Imagen no válida.'));
  const cached = imageCache.get(url);
  if (cached) {
    touch(url, cached);
    return cached.promise;
  }
  return cachePromise(url, async () => {
    if (image.complete) {
      if (image.naturalWidth) return image;
      throw new Error('No se pudo cargar la imagen.');
    }
    return imageLoadPromise(image);
  });
}

export function loadImage(url, { priority = 'auto', retry = false } = {}) {
  if (!url) return Promise.reject(new Error('La imagen no tiene URL.'));
  const cached = imageCache.get(url);
  if (cached && !(retry && cached.status === 'failed')) {
    touch(url, cached);
    return cached.promise;
  }
  if (cached) imageCache.delete(url);
  return cachePromise(url, async () => {
    const image = new Image();
    image.decoding = 'async';
    if ('fetchPriority' in image) image.fetchPriority = priority;
    const pending = imageLoadPromise(image);
    image.src = url;
    return pending;
  });
}

export function isConstrainedConnection() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;
  return Boolean(connection.saveData || /(^|-)2g$/.test(connection.effectiveType || ''));
}

export async function preloadImages(urls, { concurrency = 2, priority = 'low' } = {}) {
  const queue = [...new Set(urls.filter(Boolean))];
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
    while (queue.length) {
      const url = queue.shift();
      try { await loadImage(url, { priority }); }
      catch { /* A speculative failure must not interrupt the remaining queue. */ }
    }
  });
  await Promise.all(workers);
}

export function scheduleImagePreload(urls, options = {}) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (!uniqueUrls.length || (options.respectConnection !== false && isConstrainedConnection())) return () => {};
  let cancelled = false;
  const run = () => { if (!cancelled) preloadImages(uniqueUrls, options); };
  if ('requestIdleCallback' in window) {
    const id = requestIdleCallback(run, { timeout: options.timeout || 1800 });
    return () => { cancelled = true; cancelIdleCallback(id); };
  }
  const id = setTimeout(run, options.delay || 700);
  return () => { cancelled = true; clearTimeout(id); };
}
