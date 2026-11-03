// Variantes livianas de las imágenes de Supabase Storage (ver OPTIMIZACION-EGRESS.md).
// Convención: <bucket>/optimized/<400|800|1200>/<ruta-original-sin-extensión>.webp
// Solo se usan si existen: originales listados en optimized-images.js (procesados por
// tools/optimize-storage.mjs) o subidas nuevas cuyo nombre termina en -w<ancho>.webp.
// Si una variante falla al cargar, installVariantFallback() vuelve al original.
import { OPTIMIZED_IMAGES } from './optimized-images.js';

export const IMAGE_SIZES = Object.freeze({ thumb: 400, md: 800, lg: 1200 });
const STORAGE_PATH = /^(https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/)([^/?#]+)\/([^?#]+)$/i;
const VARIANT_PATH = /^(https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/)([^/?#]+)\/optimized\/\d+\/([^?#]+)\.webp$/i;
const UPLOAD_WIDTH = /-w(\d+)\.webp$/i;
let withoutExtension;

const decode = path => { try { return decodeURIComponent(path); } catch { return path; } };
const stripExtension = path => path.replace(/\.[^./]+$/, '');

function sourceInfo(url) {
  const match = STORAGE_PATH.exec(String(url || ''));
  if (!match || /^optimized\//.test(match[3])) return null;
  const [, base, bucket, path] = match;
  const width = Number(OPTIMIZED_IMAGES[`${bucket}/${decode(path)}`] || UPLOAD_WIDTH.exec(path)?.[1] || 0);
  return width ? { base, bucket, path, width } : null;
}

const variantFor = (info, width) => `${info.base}${info.bucket}/optimized/${width}/${stripExtension(info.path)}.webp`;

// URL de la variante (thumb | md | lg) o la URL original si no hay variantes.
export function variantUrl(url, size = 'thumb') {
  const info = sourceInfo(url);
  return info ? variantFor(info, IMAGE_SIZES[size] || IMAGE_SIZES.thumb) : url;
}

// srcset con los anchos reales disponibles; cadena vacía si la imagen no tiene variantes.
export function variantSrcset(url, sizes = ['thumb', 'md', 'lg']) {
  const info = sourceInfo(url);
  if (!info) return '';
  const seen = new Set();
  return sizes.map(size => IMAGE_SIZES[size]).filter(Boolean).map(width => {
    const actual = Math.min(width, info.width);
    if (seen.has(actual)) return '';
    seen.add(actual);
    return `${variantFor(info, width)} ${actual}w`;
  }).filter(Boolean).join(', ');
}

// Original a partir de una variante (para el fallback); null si no es una variante conocida.
export function originalFromVariant(url) {
  const match = VARIANT_PATH.exec(String(url || '').split('?')[0]);
  if (!match) return null;
  const [, base, bucket, rest] = match;
  if (/-w\d+$/i.test(rest)) return `${base}${bucket}/${rest}.webp`;
  withoutExtension ??= new Map(Object.keys(OPTIMIZED_IMAGES).map(key => [stripExtension(key), key]));
  const original = withoutExtension.get(`${bucket}/${decode(rest)}`);
  return original ? `${base}${original.split('/').map(encodeURIComponent).join('/')}` : null;
}

// Un solo listener (fase de captura) para toda la página: si una variante no carga,
// se reintenta UNA vez con el original antes de cualquier otro respaldo visual.
export function installVariantFallback(target = document) {
  target.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.variantFallback) return;
    const original = originalFromVariant(image.currentSrc || image.src);
    if (!original) return;
    event.stopImmediatePropagation();
    image.dataset.variantFallback = 'true';
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.src = original;
  }, true);
}
