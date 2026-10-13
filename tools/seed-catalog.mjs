// Carga el catálogo REAL de la tienda (marcas, categorías, productos e imágenes, banners)
// y elimina el catálogo demo genérico creado por tools/seed-demo.mjs.
// Las fotos oficiales de cada producto se descargan del catálogo público de Olímpica (VTEX)
// a assets/images/catalog/ y los logos ya están en assets/images/catalog/brands/.
// Uso: node tools/seed-catalog.mjs           (descarga imágenes y genera SQL, sin tocar la base)
//      node tools/seed-catalog.mjs --apply   (además reemplaza el catálogo en la base)
// Todo lo cargado aquí se identifica por SKU `BM-`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const catalogDir = join(root, 'assets/images/catalog');
const rel = path => `assets/images/catalog/${path}`;
const apply = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

// ---------- Marcas (logos oficiales en assets/images/catalog/brands) ----------
const brands = [
  ['apple', 'Apple', 'apple.svg'], ['samsung', 'Samsung', 'samsung.svg'], ['lg', 'LG', 'lg.svg'], ['xiaomi', 'Xiaomi', 'xiaomi.svg'],
  ['lenovo', 'Lenovo', 'lenovo.svg'], ['hp', 'HP', 'hp.svg'], ['jbl', 'JBL', 'jbl.svg'], ['challenger', 'Challenger', 'challenger.svg'],
  ['kalley', 'Kalley', 'kalley.svg'], ['electrolux', 'Electrolux', 'electrolux.svg'], ['haceb', 'Haceb', 'haceb.png'], ['mabe', 'Mabe', 'mabe.svg'],
  ['whirlpool', 'Whirlpool', 'whirlpool.svg'], ['oster', 'Oster', 'oster.svg'], ['samurai', 'Samurai', 'samurai.svg'], ['imusa', 'Imusa', 'imusa.svg'],
  ['home-elements', 'Home Elements', null]
];

// [slug, nombre, descripción, subcategorías [slug, nombre]]
const categoryTree = [
  ['tecnologia', 'Tecnología', 'Celulares, computadores, tablets, audio y relojes inteligentes.', [
    ['celulares', 'Celulares'], ['computadores', 'Computadores'], ['tablets', 'Tablets'], ['audio', 'Audio'], ['smartwatches', 'Relojes inteligentes']]],
  ['televisores', 'Televisores', 'Smart TV 4K y Full HD de las mejores marcas.', []],
  ['electrodomesticos', 'Electrodomésticos', 'Neveras, lavadoras, estufas, hornos y climatización.', [
    ['neveras', 'Neveras'], ['lavadoras', 'Lavadoras'], ['estufas-hornos', 'Estufas y hornos'], ['climatizacion', 'Aires y ventiladores']]],
  ['cocina-hogar', 'Cocina y hogar', 'Pequeños electrodomésticos, ollas y menaje.', [
    ['pequenos-electrodomesticos', 'Pequeños electrodomésticos'], ['menaje', 'Ollas y menaje']]]
];
// Producto (índice en `products`) cuya foto representa cada categoría.
const categoryCover = { tecnologia: 4, celulares: 0, computadores: 4, tablets: 7, audio: 10, smartwatches: 12, televisores: 13, electrodomesticos: 16,
  neveras: 16, lavadoras: 20, 'estufas-hornos': 24, climatizacion: 27, 'cocina-hogar': 30, 'pequenos-electrodomesticos': 30, menaje: 35 };

// id = productId en Olímpica (fuente de fotos y precio de referencia).
// promo: true usa el precio de lista como precio normal y el precio actual como promoción.
const products = [
  // Celulares
  { id: 1002413850, name: 'Apple iPhone 15 128 GB Azul', brand: 'apple', cats: ['celulares'], featured: true, promo: true, stock: 8, model: 'iPhone 15',
    description: 'iPhone 15 con Isla Dinámica, cámara principal de 48 MP con teleobjetivo 2x, chip A16 Bionic y puerto USB‑C. Diseño en aluminio con vidrio teñido.',
    specs: [['Pantalla', '6,1" Super Retina XDR'], ['Almacenamiento', '128 GB'], ['Cámara', '48 MP + 12 MP'], ['Conectividad', '5G, USB‑C'], ['Garantía', '12 meses']] },
  { id: 1002413724, name: 'Samsung Galaxy A56 5G 256 GB Gris', brand: 'samsung', cats: ['celulares'], featured: true, stock: 12, model: 'SM-A566',
    description: 'Galaxy A56 5G con pantalla Super AMOLED de 6,7" a 120 Hz, cámara de 50 MP, funciones Galaxy AI y batería de 5000 mAh con carga rápida de 45 W.',
    specs: [['Pantalla', '6,7" Super AMOLED 120 Hz'], ['Almacenamiento', '256 GB'], ['RAM', '8 GB'], ['Batería', '5000 mAh'], ['Garantía', '12 meses']] },
  { id: 1002382903, name: 'Samsung Galaxy A26 5G 256 GB Negro', brand: 'samsung', cats: ['celulares'], promo: true, stock: 15, model: 'SM-A266',
    description: 'Galaxy A26 5G con pantalla de 6,7" a 120 Hz, resistencia IP67, cámara de 50 MP y batería de 5000 mAh para todo el día.',
    specs: [['Pantalla', '6,7" Super AMOLED'], ['Almacenamiento', '256 GB'], ['RAM', '8 GB'], ['Resistencia', 'IP67'], ['Garantía', '12 meses']] },
  { id: 1002414601, name: 'Xiaomi Redmi Note 17 128 GB Negro', brand: 'xiaomi', cats: ['celulares'], promo: true, stock: 20,
    description: 'Redmi Note con pantalla AMOLED, cámara de alta resolución y batería de larga duración. El mejor equilibrio entre precio y rendimiento.',
    specs: [['Almacenamiento', '128 GB'], ['RAM', '4 GB'], ['Pantalla', 'AMOLED'], ['Garantía', '12 meses']] },
  // Computadores
  { id: 1002413225, name: 'Apple MacBook Air 13" M4 16 GB 256 GB Azul', brand: 'apple', cats: ['computadores'], featured: true, promo: true, stock: 5, model: 'MacBook Air M4',
    description: 'MacBook Air con chip M4, 16 GB de memoria unificada y pantalla Liquid Retina de 13,6". Hasta 18 horas de batería en un diseño delgado y silencioso.',
    specs: [['Procesador', 'Apple M4'], ['Memoria', '16 GB'], ['Almacenamiento', '256 GB SSD'], ['Pantalla', '13,6" Liquid Retina'], ['Batería', 'Hasta 18 h']] },
  { id: 1002402260, name: 'Portátil Lenovo IdeaPad Slim 3 Core i5 24 GB 512 GB 15"', brand: 'lenovo', cats: ['computadores'], promo: true, stock: 6, model: '15IRH10',
    description: 'Portátil IdeaPad Slim 3 con procesador Intel Core i5 de 13.ª generación, 24 GB de RAM y SSD de 512 GB. Ideal para trabajo, estudio y multitarea.',
    specs: [['Procesador', 'Intel Core i5-13420H'], ['RAM', '24 GB'], ['Almacenamiento', '512 GB SSD'], ['Pantalla', '15,3"']] },
  { id: 1002399877, name: 'Portátil HP 15 Ryzen 5 16 GB 512 GB 15,6" FHD', brand: 'hp', cats: ['computadores'], stock: 9, model: '15-fc0256la',
    description: 'Portátil HP 15 con AMD Ryzen 5 7520U, 16 GB de RAM LPDDR5 y pantalla Full HD de 15,6". Rápido y liviano para el día a día.',
    specs: [['Procesador', 'AMD Ryzen 5 7520U'], ['RAM', '16 GB'], ['Almacenamiento', '512 GB SSD'], ['Pantalla', '15,6" Full HD']] },
  // Tablets
  { id: 1002408891, name: 'Apple iPad 11" A16 128 GB Plata', brand: 'apple', cats: ['tablets'], featured: true, stock: 7, model: 'iPad A16',
    description: 'iPad de 11" con chip A16, pantalla Liquid Retina, Touch ID y USB‑C. Compatible con Apple Pencil (USB‑C) y Magic Keyboard Folio.',
    specs: [['Pantalla', '11" Liquid Retina'], ['Chip', 'A16'], ['Almacenamiento', '128 GB'], ['Conectividad', 'Wi‑Fi 6']] },
  { id: 1002411896, name: 'Samsung Galaxy Tab A11 128 GB Gris', brand: 'samsung', cats: ['tablets'], promo: true, stock: 10,
    description: 'Galaxy Tab A11 con 8 GB de RAM y 128 GB de almacenamiento. Perfecta para clases, series y videollamadas.',
    specs: [['Almacenamiento', '128 GB'], ['RAM', '8 GB'], ['Conectividad', 'Wi‑Fi']] },
  // Audio
  { id: 1002411059, name: 'Apple AirPods 4', brand: 'apple', cats: ['audio'], promo: true, stock: 14,
    description: 'AirPods 4 con audio espacial personalizado, nuevo diseño más cómodo y estuche de carga USB‑C.',
    specs: [['Tipo', 'Inalámbricos in‑ear'], ['Carga', 'USB‑C'], ['Batería', 'Hasta 30 h con estuche']] },
  { id: 1002414392, name: 'Parlante JBL Grip Azul', brand: 'jbl', cats: ['audio'], promo: true, stock: 18,
    description: 'Parlante Bluetooth JBL Grip con sonido JBL Pro, resistencia al agua y al polvo IP67 y diseño compacto para llevar a todas partes.',
    specs: [['Conectividad', 'Bluetooth'], ['Resistencia', 'IP67'], ['Batería', 'Hasta 12 h']] },
  { id: 1002413023, name: 'Audífonos JBL Live 670 Negro', brand: 'jbl', cats: ['audio'], promo: true, stock: 6,
    description: 'Audífonos on‑ear inalámbricos JBL Live 670NC con cancelación de ruido adaptativa y sonido JBL Signature.',
    specs: [['Tipo', 'On‑ear inalámbricos'], ['Cancelación de ruido', 'Adaptativa'], ['Batería', 'Hasta 65 h']] },
  // Relojes
  { id: 1002411057, name: 'Apple Watch SE 3 44 mm Negro', brand: 'apple', cats: ['smartwatches'], promo: true, stock: 6,
    description: 'Apple Watch SE con detección de caídas y choques, monitoreo de frecuencia cardiaca y seguimiento de actividad. Caja de aluminio de 44 mm.',
    specs: [['Caja', '44 mm aluminio'], ['Resistencia', 'Al agua 50 m'], ['Garantía', '12 meses']] },
  // Televisores
  { id: 2331727, name: 'Televisor Samsung 50" Crystal UHD 4K Smart TV', brand: 'samsung', cats: ['televisores'], featured: true, promo: true, stock: 8, model: 'UN50U8000F',
    description: 'Smart TV Samsung Crystal UHD 4K de 50" con procesador Crystal 4K, HDR y Tizen OS con las principales apps de streaming.',
    specs: [['Tamaño', '50"'], ['Resolución', '4K UHD'], ['Sistema', 'Tizen'], ['Garantía', '12 meses']] },
  { id: 1002391077, name: 'Televisor LG 55" UHD 4K Smart TV', brand: 'lg', cats: ['televisores'], promo: true, stock: 6, model: '55UA7500',
    description: 'Smart TV LG UHD 4K de 55" con webOS, ThinQ AI y HDR10. Imagen nítida y acceso a tus apps favoritas.',
    specs: [['Tamaño', '55"'], ['Resolución', '4K UHD'], ['Sistema', 'webOS'], ['Garantía', '12 meses']] },
  { id: 2343806, name: 'Televisor Challenger 55" UHD 4K Google TV', brand: 'challenger', cats: ['televisores'], stock: 10, model: '55TG2771',
    description: 'Televisor Challenger 4K de 55" con Google TV, Chromecast integrado y control por voz. Incluye TDT2.',
    specs: [['Tamaño', '55"'], ['Resolución', '4K UHD'], ['Sistema', 'Google TV'], ['TDT', 'DVB‑T2']] },
  // Neveras
  { id: 2338519, name: 'Nevera Samsung 427 L Congelador Inferior Gris', brand: 'samsung', cats: ['neveras'], featured: true, promo: true, stock: 4, model: 'RB43DG6005S9',
    description: 'Nevera Samsung de 427 L con congelador inferior, AI Energy para controlar el consumo desde el celular y All Around Cooling para un frío uniforme.',
    specs: [['Capacidad', '427 L'], ['Tipo', 'Congelador inferior'], ['Tecnología', 'No Frost, Inverter'], ['Garantía', '12 meses + 10 años compresor']] },
  { id: 2333858, name: 'Nevera LG 217 L No Frost Top Mount', brand: 'lg', cats: ['neveras'], promo: true, stock: 7, model: 'VT22BPY',
    description: 'Nevera LG de 217 L No Frost con compresor Smart Inverter, ideal para espacios compactos y bajo consumo de energía.',
    specs: [['Capacidad', '217 L'], ['Tipo', 'Congelador superior'], ['Tecnología', 'No Frost, Smart Inverter']] },
  { id: 2332482, name: 'Nevera Haceb 311 L No Frost Inverter Negra', brand: 'haceb', cats: ['neveras'], promo: true, stock: 6,
    description: 'Nevera Haceb de 311 L No Frost con tecnología Inverter. Fabricada en Colombia, con garantía y servicio técnico nacional.',
    specs: [['Capacidad', '311 L'], ['Tecnología', 'No Frost, Inverter'], ['Color', 'Negro']] },
  { id: 2344578, name: 'Nevera Mabe 267 L No Frost', brand: 'mabe', cats: ['neveras'], promo: true, stock: 5, model: 'RMA267FXCG',
    description: 'Nevera Mabe de 267 L No Frost con diseño moderno, cajón de verduras amplio y bandejas de vidrio templado.',
    specs: [['Capacidad', '267 L'], ['Tecnología', 'No Frost'], ['Tipo', 'Congelador superior']] },
  // Lavadoras
  { id: 2341403, name: 'Lavadora LG 13 kg Carga Superior Negra', brand: 'lg', cats: ['lavadoras'], featured: true, promo: true, stock: 6, model: 'WT13NVTB',
    description: 'Lavadora LG automática de 13 kg con motor Smart Inverter, TurboDrum y ciclos inteligentes para el cuidado de la ropa.',
    specs: [['Capacidad', '13 kg'], ['Carga', 'Superior'], ['Motor', 'Smart Inverter']] },
  { id: 2343799, name: 'Lavadora Samsung 13 kg EcoBubble Carga Superior', brand: 'samsung', cats: ['lavadoras'], promo: true, stock: 5,
    description: 'Lavadora Samsung de 13 kg con tecnología EcoBubble que lava a fondo incluso en agua fría, y control desde el celular con SmartThings.',
    specs: [['Capacidad', '13 kg'], ['Carga', 'Superior'], ['Tecnología', 'EcoBubble, SmartThings']] },
  { id: 5161318, name: 'Lavadora Electrolux 12 kg Carga Superior Gris', brand: 'electrolux', cats: ['lavadoras'], promo: true, stock: 7, model: 'EWIW12F6USVS',
    description: 'Lavadora Electrolux de 12 kg con impeller y panel digital, programas especiales y diseño en color gris.',
    specs: [['Capacidad', '12 kg'], ['Carga', 'Superior'], ['Panel', 'Digital']] },
  { id: 5012657, name: 'Lavadora Whirlpool 12 kg Carga Superior', brand: 'whirlpool', cats: ['lavadoras'], promo: true, stock: 4, model: 'WWI12ASHLS',
    description: 'Lavadora Whirlpool automática de 12 kg con impeller, múltiples niveles de agua y programas para cada tipo de prenda.',
    specs: [['Capacidad', '12 kg'], ['Carga', 'Superior'], ['Tipo', 'Automática']] },
  // Estufas y hornos
  { id: 1002382539, name: 'Estufa de Torre Haceb Romero 50 cm 4 Puestos Gas Natural', brand: 'haceb', cats: ['estufas-hornos'], promo: true, stock: 4,
    description: 'Estufa de piso Haceb Romero de 50 cm con 4 quemadores y horno a gas natural. Color negro.',
    specs: [['Puestos', '4'], ['Gas', 'Natural'], ['Ancho', '50 cm'], ['Horno', 'Sí']] },
  { id: 5298281, name: 'Horno Microondas LG 20 L EasyClean Negro', brand: 'lg', cats: ['estufas-hornos'], promo: true, stock: 9, model: 'MS2032GAS',
    description: 'Microondas LG de 20 L y 700 W con interior EasyClean antibacterial, fácil de limpiar.',
    specs: [['Capacidad', '20 L'], ['Potencia', '700 W'], ['Interior', 'EasyClean']] },
  { id: 2322865, name: 'Horno Microondas Haceb 0,9 pies Grill Negro', brand: 'haceb', cats: ['estufas-hornos'], stock: 5,
    description: 'Microondas Haceb con función grill para gratinar y dorar, menús automáticos y diseño en negro.',
    specs: [['Capacidad', '0,9 pies³'], ['Función', 'Grill']] },
  // Climatización
  { id: 2339765, name: 'Aire Acondicionado Haceb Inverter 12.000 BTU 115 V', brand: 'haceb', cats: ['climatizacion'], featured: true, promo: true, stock: 4,
    description: 'Aire acondicionado mini split Haceb Inverter de 12.000 BTU con refrigerante ecológico R32, bajo consumo y funcionamiento silencioso.',
    specs: [['Capacidad', '12.000 BTU'], ['Voltaje', '115 V'], ['Tecnología', 'Inverter, R32']] },
  { id: 2323956, name: 'Ventilador de Pedestal Samurai Air Pro 22"', brand: 'samurai', cats: ['climatizacion'], stock: 12,
    description: 'Ventilador de pedestal Samurai Air Pro de 22" con mallas metálicas, gran caudal de aire y altura ajustable.',
    specs: [['Tamaño', '22"'], ['Tipo', 'Pedestal'], ['Color', 'Negro']] },
  { id: 1002387122, name: 'Ventilador de Mesa y Pared Kalley 3 Velocidades', brand: 'kalley', cats: ['climatizacion'], promo: true, stock: 15, model: 'K-VM8N02',
    description: 'Ventilador Kalley 2 en 1 para mesa o pared, con 3 velocidades y oscilación. Compacto y eficiente.',
    specs: [['Velocidades', '3'], ['Instalación', 'Mesa o pared']] },
  // Pequeños electrodomésticos
  { id: 1002413654, name: 'Licuadora Oster Vaso de Vidrio 6 Velocidades', brand: 'oster', cats: ['pequenos-electrodomesticos'], featured: true, stock: 20, model: 'BLSTPEG-BPB',
    description: 'Licuadora Oster con vaso de vidrio refractario Boroclass, cuchilla de acero inoxidable y 6 velocidades más pulso.',
    specs: [['Velocidades', '6 + pulso'], ['Vaso', 'Vidrio'], ['Garantía', '12 meses']] },
  { id: 1002405713, name: 'Cafetera Oster 12 Tazas Jarra Refractaria', brand: 'oster', cats: ['pequenos-electrodomesticos'], promo: true, stock: 14, model: 'BVSTDCS121B',
    description: 'Cafetera Oster de 12 tazas con jarra refractaria, filtro permanente y función de pausa para servir.',
    specs: [['Capacidad', '12 tazas'], ['Jarra', 'Refractaria']] },
  { id: 1002330131, name: 'Freidora de Aire Home Elements 3,2 L Negra', brand: 'home-elements', cats: ['pequenos-electrodomesticos'], featured: true, promo: true, stock: 10,
    description: 'Freidora de aire Home Elements de 3,2 L: cocina crocante sin aceite, con temporizador y control de temperatura.',
    specs: [['Capacidad', '3,2 L'], ['Color', 'Negro']] },
  { id: 1002327460, name: 'Olla Arrocera Home Elements 1 L Negra', brand: 'home-elements', cats: ['pequenos-electrodomesticos'], stock: 18,
    description: 'Olla arrocera Home Elements de 1 L con olla interna antiadherente y función de mantener caliente.',
    specs: [['Capacidad', '1 L'], ['Recubrimiento', 'Antiadherente']] },
  { id: 1002413099, name: 'Sanduchera Home Elements 2 Puestos', brand: 'home-elements', cats: ['pequenos-electrodomesticos'], promo: true, stock: 16,
    description: 'Sanduchera Home Elements de 2 puestos con placas antiadherentes y acabado cobre y negro.',
    specs: [['Puestos', '2'], ['Placas', 'Antiadherentes']] },
  // Menaje
  { id: 1002388068, name: 'Batería de Cocina Imusa Talent 7 Piezas', brand: 'imusa', cats: ['menaje'], featured: true, promo: true, stock: 8,
    description: 'Batería de cocina Imusa Talent de 7 piezas con recubrimiento antiadherente y tapas de vidrio.',
    specs: [['Piezas', '7'], ['Recubrimiento', 'Antiadherente']] },
  { id: 1002396081, name: 'Olla a Presión Home Elements 5,6 L', brand: 'home-elements', cats: ['menaje'], promo: true, stock: 11, model: 'HEPC56LLSS',
    description: 'Olla a presión Home Elements de 5,6 L en acero inoxidable, con válvula de seguridad. Cocina en menos tiempo.',
    specs: [['Capacidad', '5,6 L'], ['Material', 'Acero inoxidable']] }
];

// Banners: productos (índices) cuyas fotos aparecen en cada uno.
const banners = [
  { key: 'tecnologia', link: 'categoria.html?slug=tecnologia', alt: 'Tecnología de las mejores marcas: Apple, Samsung, Xiaomi y más',
    kicker: 'Tecnología', title: 'Lo último en tecnología', text: 'Apple, Samsung, Xiaomi y más', bg: 'linear-gradient(120deg,#0b1f4d,#1d4ed8)', imgs: [0, 4, 1] },
  { key: 'electrodomesticos', link: 'categoria.html?slug=electrodomesticos', alt: 'Electrodomésticos a precio de bodega: neveras, lavadoras y televisores',
    kicker: 'Electrodomésticos', title: 'Precio de bodega', text: 'Neveras, lavadoras y TV de LG, Samsung y Haceb', bg: 'linear-gradient(120deg,#0f3d3e,#0f766e)', imgs: [16, 20, 13] },
  { key: 'cocina', link: 'categoria.html?slug=cocina-hogar', alt: 'Equipa tu cocina con Oster, Imusa y Home Elements',
    kicker: 'Cocina y hogar', title: 'Equipa tu cocina', text: 'Oster, Imusa y Home Elements', bg: 'linear-gradient(120deg,#7c2d12,#ea580c)', imgs: [30, 32, 35] }
];

// Catálogo demo anterior (tools/seed-demo.mjs) que se elimina.
const legacyCategorySlugs = ['tecnologia', 'celulares', 'computadores', 'tablets', 'audio', 'accesorios-tecnologia', 'hogar-cocina', 'electrodomesticos', 'menaje-cocina', 'muebles', 'decoracion',
  'moda', 'calzado', 'relojes', 'gafas', 'bolsos', 'ropa', 'deportes', 'balones', 'implementos', 'belleza', 'fragancias', 'maquillaje', 'cuidado-personal', 'despensa', 'granos-aceites', 'bebidas', 'cafe-endulzantes'];
const legacyBrandSlugs = ['voltix', 'sonomax', 'tecnopro', 'kasa-viva', 'nordika', 'urbano-co', 'tiempo-real', 'andes-sport', 'lumen', 'sabana'];

// ---------- Utilidades ----------
const slugify = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lit = value => value == null ? 'null' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
// Precio comercial: redondea a miles y termina en 900.
const commercial = value => Math.max(900, Math.round(value / 1000) * 1000 - 100);

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

// Precios y fotos de la fuente; se guardan en caché para que una nueva ejecución sea estable.
const cacheFile = join(catalogDir, 'source-cache.json');
const sourceCache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function source(id) {
  if (sourceCache[id]) return sourceCache[id];
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://www.olimpica.com/api/catalog_system/pub/products/search?fq=productId:${id}`, { headers: { 'User-Agent': UA } });
    const text = await response.text();
    let item;
    try { [item] = JSON.parse(text); }
    catch {
      if (attempt >= 6) throw new Error(`La fuente no respondió para ${id}: ${text.slice(0, 60)}`);
      await wait(attempt * 5000);
      continue;
    }
    if (!item) throw new Error(`Producto ${id} no encontrado en la fuente.`);
    const sku = item.items[0];
    const offer = sku.sellers[0].commertialOffer;
    sourceCache[id] = { price: offer.Price, listPrice: offer.ListPrice, images: sku.images.map(image => image.imageUrl) };
    writeFileSync(cacheFile, JSON.stringify(sourceCache, null, 1));
    await wait(1500);
    return sourceCache[id];
  }
}

// Descarga hasta 4 fotos oficiales a 800×800 y devuelve sus rutas relativas.
async function photos(product, slug, urls) {
  const paths = [];
  for (const [index, url] of urls.slice(0, 4).entries()) {
    const name = `products/${slug}-${index + 1}.jpg`;
    const file = join(catalogDir, name);
    if (!existsSync(file)) {
      const resized = url.replace(/\/arquivos\/ids\/(\d+)\//, '/arquivos/ids/$1-800-800/');
      const response = await fetch(resized, { headers: { 'User-Agent': UA } });
      if (!response.ok) throw new Error(`No se pudo descargar ${resized}: ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    paths.push(rel(name));
  }
  return paths;
}

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
function renderBanner(banner, variant, images) {
  const [width, height] = variant === 'mobile' ? [1080, 600] : [1920, 640];
  const name = `banners/${banner.key}-${variant}.png`;
  const file = join(catalogDir, name);
  if (existsSync(file)) return rel(name);
  const mobile = variant === 'mobile';
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}body{width:${width}px;height:${height}px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;background:${banner.bg};color:#fff;position:relative}
    .copy{position:absolute;left:${mobile ? 64 : 140}px;top:50%;transform:translateY(-50%);max-width:${mobile ? 520 : 760}px}
    .k{font-size:${mobile ? 26 : 30}px;font-weight:700;letter-spacing:3px;text-transform:uppercase;opacity:.85}
    h1{font-size:${mobile ? 72 : 92}px;line-height:1;font-weight:900;margin:18px 0}p{font-size:${mobile ? 28 : 34}px;opacity:.92}
    .cta{display:inline-block;margin-top:34px;background:#fff;color:#111;font-weight:800;font-size:${mobile ? 26 : 30}px;padding:18px 40px;border-radius:999px}
    .imgs{position:absolute;right:${mobile ? 10 : 70}px;top:0;bottom:0;display:flex;align-items:center;gap:${mobile ? 0 : 20}px}
    .imgs div{width:${mobile ? 250 : 280}px;height:${mobile ? 250 : 280}px;border-radius:50%;background:#fff;display:grid;place-items:center;box-shadow:0 30px 60px rgba(0,0,0,.35);overflow:hidden}
    .imgs div:nth-child(2){transform:translateY(${mobile ? 120 : 60}px)}.imgs div:nth-child(3){${mobile ? 'display:none' : ''}}
    ${mobile ? '.imgs{flex-direction:column;justify-content:center;gap:0}.imgs div:nth-child(2){transform:translate(-120px,-20px)}' : ''}
    img{width:74%;height:74%;object-fit:contain}</style>
    <div class="copy"><div class="k">${banner.kicker}</div><h1>${banner.title}</h1><p>${banner.text}</p><span class="cta">Comprar ahora</span></div>
    <div class="imgs">${images.map(src => `<div><img src="file:///${join(root, src).replaceAll('\\', '/')}"></div>`).join('')}</div>`;
  const htmlFile = join(catalogDir, `banners/${banner.key}-${variant}.html`);
  writeFileSync(htmlFile, html);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${width},${height}`, '--virtual-time-budget=10000', `--screenshot=${file}`, `file:///${htmlFile.replaceAll('\\', '/')}`], { stdio: 'ignore' });
  unlinkSync(htmlFile);
  return rel(name);
}

// ---------- SQL ----------
const allCategorySlugs = [...new Set([...legacyCategorySlugs, ...categoryTree.flatMap(([slug, , , children]) => [slug, ...children.map(([child]) => child)])])];
const allBrandSlugs = [...legacyBrandSlugs, ...brands.map(([slug]) => slug)];
const cleanupSql = `
-- Catálogo demo anterior y carga previa de este script
delete from public.product_images where product_id in (select id from public.products where sku like 'DEMO-%' or sku like 'BM-%');
delete from public.products where sku like 'DEMO-%' or sku like 'BM-%';
delete from public.categories where parent_id is not null and slug in (${allCategorySlugs.map(lit).join(',')});
delete from public.categories where slug in (${allCategorySlugs.map(lit).join(',')});
delete from public.brands where slug in (${allBrandSlugs.map(lit).join(',')});
delete from public.homepage_banners where desktop_image_url like 'assets/images/demo/%' or desktop_image_url like 'assets/images/catalog/%';
-- Textos sin marcas de demostración
update public.payment_methods set name = replace(name, ' (demo)', '') where name like '% (demo)';
update public.delivery_methods set name = replace(name, ' (demo)', '') where name like '% (demo)';
update public.site_settings set
  data_policy_text = replace(data_policy_text, '[DEMO] ', ''), marketing_consent_text = replace(marketing_consent_text, '[DEMO] ', ''),
  quote_terms = replace(quote_terms, '[DEMO] ', ''), sale_terms = replace(sale_terms, '[DEMO] ', ''), warranty_text = replace(warranty_text, '[DEMO] ', ''),
  announcement_messages = ${lit(JSON.stringify([
    { id: 'msg-1', text: 'Envíos a todo el país · Precios especiales por mayor', enabled: true, position: 1 },
    { id: 'msg-2', text: 'Tecnología y electrodomésticos de las mejores marcas', enabled: true, position: 2 },
    { id: 'msg-3', text: 'Paga contra entrega en Barranquilla', enabled: true, position: 3 }
  ]))}::jsonb,
  updated_at = now() where id = 1;
`;

async function buildSql() {
  const sql = [cleanupSql];
  const brandIds = {};
  for (const [index, [slug, name, logo]] of brands.entries()) {
    brandIds[slug] = randomUUID();
    sql.push(`insert into public.brands(id,name,slug,logo_url,sort_order) values(${lit(brandIds[slug])},${lit(name)},${lit(slug)},${lit(logo ? rel(`brands/${logo}`) : null)},${index});`);
  }

  // Productos primero: sus fotos dan imagen a las categorías y banners.
  const prepared = [];
  for (const [index, product] of products.entries()) {
    const slug = slugify(product.name);
    const data = await source(product.id);
    const images = await photos(product, slug, data.images);
    const hasDiscount = product.promo && data.listPrice > data.price * 1.05;
    // Descuentos de más del 35% no son creíbles: se muestra un 20%.
    const listPrice = data.listPrice > data.price / 0.65 ? data.price / 0.8 : data.listPrice;
    const base = commercial(hasDiscount ? listPrice : data.price);
    const promo = hasDiscount ? commercial(data.price) : null;
    prepared.push({ ...product, uuid: randomUUID(), slug, sku: `BM-${String(index + 1).padStart(3, '0')}`, images, base, promoPrice: promo });
    console.log(`  ${product.name}: $${base}${promo ? ` → $${promo}` : ''} (${images.length} fotos)`);
  }

  const categoryIds = {};
  for (const [index, [slug, name, description, children]] of categoryTree.entries()) {
    categoryIds[slug] = randomUUID();
    sql.push(`insert into public.categories(id,name,slug,description,image_url,sort_order) values(${lit(categoryIds[slug])},${lit(name)},${lit(slug)},${lit(description)},${lit(prepared[categoryCover[slug]].images[0])},${index});`);
    for (const [childIndex, [childSlug, childName]] of children.entries()) {
      categoryIds[childSlug] = randomUUID();
      sql.push(`insert into public.categories(id,parent_id,name,slug,image_url,sort_order) values(${lit(categoryIds[childSlug])},${lit(categoryIds[slug])},${lit(childName)},${lit(childSlug)},${lit(prepared[categoryCover[childSlug]].images[0])},${childIndex});`);
    }
  }
  const parentOf = Object.fromEntries(categoryTree.flatMap(([slug, , , children]) => children.map(([child]) => [child, slug])));

  const delivery = 'Despachamos en 24 a 48 horas hábiles. Envíos a todo el país. Producto nuevo con garantía de fábrica. Compras al por mayor con precio especial: escríbenos.';
  for (const [index, product] of prepared.entries()) {
    const specs = { items: product.specs.map(([label, value]) => ({ label, value })) };
    sql.push(`insert into public.products(id,name,slug,sku,model,description,purchase_delivery_info,specifications,base_price,promo_price,promo_start,promo_end,status,brand_id,featured,low_stock_threshold,created_at,updated_at) values(${[
      lit(product.uuid), lit(product.name), lit(product.slug), lit(product.sku), lit(product.model || null), lit(product.description), lit(delivery),
      `${lit(JSON.stringify(specs))}::jsonb`, product.base, product.promoPrice ?? 'null', product.promoPrice ? `now() - interval '1 day'` : 'null', 'null',
      lit('published'), lit(brandIds[product.brand]), Boolean(product.featured), 3, `now() - interval '${index * 5} hours'`, 'now()'
    ].join(',')});`);
    const cats = new Set(product.cats.flatMap(cat => [cat, parentOf[cat]].filter(Boolean)));
    for (const cat of cats) sql.push(`insert into public.product_categories(product_id,category_id) values(${lit(product.uuid)},${lit(categoryIds[cat])});`);
    const colorId = randomUUID(), sizeId = randomUUID();
    sql.push(`insert into public.product_colors(id,product_id,name,sort_order) values(${lit(colorId)},${lit(product.uuid)},'Única',0);`);
    sql.push(`insert into public.product_sizes(id,product_id,name,sort_order) values(${lit(sizeId)},${lit(product.uuid)},'Única',0);`);
    sql.push(`insert into public.product_variants(product_id,color_id,size_id,sku,stock) values(${lit(product.uuid)},${lit(colorId)},${lit(sizeId)},${lit(product.sku)},${product.stock});`);
    product.images.forEach((url, order) => sql.push(`insert into public.product_images(product_id,url,alt_text,is_primary,sort_order) values(${lit(product.uuid)},${lit(url)},${lit(product.name)},${order === 0},${order});`));
  }

  for (const [index, banner] of banners.entries()) {
    const images = banner.imgs.map(item => prepared[item].images[0]);
    const desktop = renderBanner(banner, 'desktop', images);
    const mobile = renderBanner(banner, 'mobile', images);
    sql.push(`insert into public.homepage_banners(desktop_image_url,mobile_image_url,alt_text,link_url,sort_order) values(${lit(desktop)},${lit(mobile)},${lit(banner.alt)},${lit(banner.link)},${index + 1});`);
  }
  return sql.join('\n');
}

// ---------- Ejecución ----------
for (const folder of ['products', 'brands', 'banners']) mkdirSync(join(catalogDir, folder), { recursive: true });
const config = readFileSync(join(root, 'js/config.js'), 'utf8');
if (!config.includes(`https://${AUTHORIZED_REF}.supabase.co`)) throw new Error('El frontend no apunta al proyecto autorizado.');

const sql = await buildSql();
const out = join(catalogDir, 'seed-catalog.sql');
writeFileSync(out, sql);
console.log(`SQL generado: ${out} (${sql.split('\n').length} líneas)`);
if (apply) {
  await query(`begin;\n${sql}\ncommit;`);
  const [counts] = await query(`select (select count(*) from products) productos, (select count(*) from products where sku like 'DEMO-%') demo, (select count(*) from product_images) imagenes, (select count(*) from categories) categorias, (select count(*) from brands) marcas, (select count(*) from homepage_banners) banners`);
  console.log('Aplicado:', counts);
} else console.log('Simulación: usa --apply para cargarlo en la base.');
