# Reporte final de egress

Estado: **COMPLETADO** · 2026-11-03 20:02:48 (hora de Bogotá)

## ANTES → DESPUÉS (valores medidos)

Visita típica medida en Chrome (móvil 390 px, DPR 2, caché vacía): index.html → catalogo.html → producto.html?slug=nevera-minibar-kalley-frost-una-puerta-gris-oscuro-gris-plata → producto.html?slug=aire-acondicionado-milexus-12000btu-220v.
Bytes transferidos reales (encodedDataLength) hacia Supabase; "cacheado" = Storage/CDN, "no cacheado" = REST/RPC.

| Métrica | ANTES | DESPUÉS | Reducción |
|---|---|---|---|
| Espacio ocupado en Storage | 10.12 MB (47 originales) | 13.76 MB (47 originales intactos + 141 variantes = 3.64 MB) | +36 % (sube: no se borra nada) |
| Peso que se sirve de las 47 imágenes | 10.12 MB (siempre el original) | 0.63 MB thumb · 1.29 MB md · 1.73 MB lg | thumb 93.8 % · md 87.3 % · lg 82.9 % |
| Peso promedio por imagen | 220.5 KB | 13.6 KB thumb · 28.0 KB md · 37.6 KB lg | thumb 93.8 % |
| Imágenes descargadas por visita | 3970.6 KB (33 peticiones) | 462.5 KB (38 peticiones) | 88.4 % |
| Datos (REST/RPC) por visita | 229.1 KB (80 peticiones) | 93.0 KB (55 peticiones) | 59.4 % |
| Egress cacheado por 1.000 visitas | 3877.59 MB | 451.67 MB | 88.4 % |
| Egress no cacheado por 1.000 visitas | 223.71 MB | 90.86 MB | 59.4 % |
| Visitas que caben en 5 GB cacheado | 1.229 | 10.557 | |
| Visitas que caben en 5 GB no cacheado | 21.315 | 52.479 | |
| Visitas al mes (límite más estricto) | 1.229 | 10.557 | |
| **Total por visita** | **4199.7 KB** | **555.6 KB** | **86.8 %** |

Comprobaciones: 88 imágenes referenciadas en la base responden (originales y variantes); imágenes rotas en la medición: 0; fallbacks a original: 0.
La cuota de 5 GB es de la organización y se comparte con otro proyecto.

Notas para leer la tabla sin engaños:
- "5 GB" se calcula como 5.000.000.000 bytes; KB/MB son de 1024.
- La medición es una primera visita con caché vacía (el peor caso). Las visitas repetidas descargan menos por la caché del navegador (imágenes con max-age de 1 año) y la caché local de datos (3–10 min).
- Los 15 GB ya consumidos este ciclo no se pueden revertir; la reducción aplica desde ahora.
- Objetivo < 1 GB/mes: con 462.5 KB cacheados por visita, se cumple hasta ≈ 2.100 primeras visitas al mes (≈ 10.500 para el egress no cacheado). No se conoce el tráfico real, así que no se puede afirmar que se cumpla.
- La visita en vivo de la sección "Publicación" recorre otras páginas y no es comparable con la tabla.

## Publicación

Sitio publicado: https://bodegamayoristafc.shop sirve el manifiesto nuevo.
Visita en vivo (inicio, catálogo, categorías): 26 imágenes de Storage (26 variantes, 250.5 KB), 34 peticiones de datos (67.8 KB).
Imágenes rotas: 0; fallbacks a original: 0; peticiones a Supabase con error: 0; errores de consola: 0.
robots.txt: 200 · og-image.jpg: 200.

