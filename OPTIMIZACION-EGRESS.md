# Optimización de egress de Supabase

## Imágenes existentes en Storage (ejecutar una vez, cuando la API responda 200)

```powershell
node tools/optimize-storage.mjs --dry-run   # descarga, procesa y muestra el ahorro; no sube nada
node tools/optimize-storage.mjs             # respalda, sube variantes y actualiza js/lib/optimized-images.js
node tools/build-deploy.mjs                 # luego commit + publicar como siempre
```

- Requiere `SUPABASE_ACCESS_TOKEN` en `.env`. La clave secreta se pide a la Management API y solo vive en memoria.
- Es idempotente: lo ya optimizado se salta (`--force` lo regenera).
- Cada ejecución deja en `backups/<fecha>/` las tablas de imágenes, el inventario de Storage y `storage-map.json` (original → variantes). Los originales descargados quedan en `backups/originals/`.
- Prueba sin red: `node tools/optimize-storage.mjs --dry-run --local assets/images/catalog/products`.

### Revertir

```powershell
node tools/optimize-storage.mjs --revert backups/<fecha>/storage-map.json                    # la tienda vuelve a usar los originales
node tools/optimize-storage.mjs --revert backups/<fecha>/storage-map.json --delete-variants  # además borra las variantes subidas
```

Los originales nunca se modifican ni se borran. La base de datos no cambia.

## Convención de rutas

```
<bucket>/<ruta-original>                               original (sin cambios)
<bucket>/optimized/400/<ruta-original-sin-ext>.webp    thumb: listados, tarjetas, carrito, logos
<bucket>/optimized/800/<ruta-original-sin-ext>.webp    md: ficha en móvil
<bucket>/optimized/1200/<ruta-original-sin-ext>.webp   lg: ficha en escritorio y zoom
```

Las tres rutas existen siempre (no se agranda: si el original es más angosto, la variante tiene su ancho; si la variante pesara más, se guarda el original). Todo con `Cache-Control: max-age=31536000`.

El frontend (`js/lib/image-variants.js`) solo usa variantes de:
1. originales listados en `js/lib/optimized-images.js` (lo genera el script), o
2. subidas nuevas cuyo nombre termina en `-w<ancho>.webp`.

Si una variante no carga, la imagen vuelve sola al original (un único listener en `js/app.js`).

## Imágenes nuevas (panel)

`uploadImage()` en `js/lib/api.js`:
- Comprime en el navegador a WebP de máximo 1600 px (~350 KB) y sube primero las variantes 400/800/1200 y luego el principal `<carpeta>/<uuid>-w<ancho>.webp`. El nombre es único, así que el caché de 1 año nunca sirve una imagen vieja.
- Si una variante falla se limpia lo subido y se pide reintentar. SVG y el logo de documentos PDF se suben sin variantes.
- Al borrar una imagen desde el panel también se borran sus variantes.
- Límites: 5 MB para logos/categorías y los del procesador para fotos de producto.

## Datos (egress no cacheado)

- Chequeo de conexión: una consulta mínima por sesión (15 min), sin GraphQL; ante 402 no reintenta; “Intentar de nuevo” espera 2, 4, 8… hasta 60 s.
- `js/lib/data-cache.js`: configuración, categorías, marcas, métodos de pago/entrega (10 min) y catálogo, fichas y búsquedas (3 min) en memoria + `localStorage`. Nunca en el panel, el carrito ni el checkout. Al abrir el panel se limpia. Un cambio del panel puede tardar hasta 10 min en verse en otros navegadores.
- Listados sin especificaciones, cuidados, guía de tallas ni plantillas.
- Medir peticiones por visita (Supabase simulado): `$env:QA_MEASURE=1; node tools/qa-ui-mock.mjs`.

## Hosting

GitHub Pages no permite configurar cabeceras de caché; sirve `robots.txt` y `assets/images/og-image.jpg` (44 KB) desde el propio sitio.
