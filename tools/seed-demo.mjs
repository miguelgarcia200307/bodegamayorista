// Carga un catálogo DEMO (marcas, categorías, productos con variantes e imágenes,
// banners, métodos de pago/entrega) en el proyecto AUTORIZADO para revisar la tienda.
// Las imágenes se descargan a assets/images/demo/ y se referencian con rutas relativas.
// Uso: node tools/seed-demo.mjs            (descarga imágenes y genera SQL, sin tocar la base)
//      node tools/seed-demo.mjs --apply    (además reemplaza el catálogo demo en la base)
// Limpieza: node tools/seed-demo.mjs --clean
// Todo lo demo se identifica por SKU `DEMO-`, los slugs listados aquí y los valores de ajustes marcados.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const AUTHORIZED_REF = 'ekepygodvciqnqkrgrsv';
const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const demoDir = join(root, 'assets/images/demo');
const rel = path => `assets/images/demo/${path}`;
const apply = process.argv.includes('--apply');
const clean = process.argv.includes('--clean');

// ---------- Catálogo ----------
const brands = [
  { slug: 'voltix', name: 'Voltix', color: '#0f62fe', mark: 'V' },
  { slug: 'sonomax', name: 'SonoMax', color: '#111827', mark: 'S' },
  { slug: 'tecnopro', name: 'TecnoPro', color: '#0e7490', mark: 'T' },
  { slug: 'kasa-viva', name: 'Kasa Viva', color: '#c2410c', mark: 'K' },
  { slug: 'nordika', name: 'Nórdika', color: '#4d7c0f', mark: 'N' },
  { slug: 'urbano-co', name: 'Urbano Co.', color: '#7c3aed', mark: 'U' },
  { slug: 'tiempo-real', name: 'Tiempo Real', color: '#a16207', mark: 'TR' },
  { slug: 'andes-sport', name: 'Andes Sport', color: '#15803d', mark: 'A' },
  { slug: 'lumen', name: 'Lumen', color: '#be185d', mark: 'L' },
  { slug: 'sabana', name: 'Sabana', color: '#b45309', mark: 'S' }
];

// [slug, nombre, descripción, id de imagen DummyJSON, subcategorías [slug, nombre, id imagen]]
const categoryTree = [
  ['tecnologia', 'Tecnología', 'Celulares, computadores, audio y accesorios.', 123, [
    ['celulares', 'Celulares', 133], ['computadores', 'Computadores', 78], ['tablets', 'Tablets', 160], ['audio', 'Audio', 100], ['accesorios-tecnologia', 'Accesorios y cargadores', 105]]],
  ['hogar-cocina', 'Hogar y cocina', 'Electrodomésticos, menaje, muebles y decoración.', 51, [
    ['electrodomesticos', 'Electrodomésticos', 66], ['menaje-cocina', 'Menaje de cocina', 52], ['muebles', 'Muebles', 12], ['decoracion', 'Decoración', 46]]],
  ['moda', 'Moda y accesorios', 'Calzado, relojes, gafas, bolsos y ropa.', 90, [
    ['calzado', 'Calzado', 90], ['relojes', 'Relojes', 93], ['gafas', 'Gafas de sol', 155], ['bolsos', 'Bolsos y morrales', 172], ['ropa', 'Ropa', 83]]],
  ['deportes', 'Deportes', 'Balones e implementos para entrenar.', 147, [
    ['balones', 'Balones', 147], ['implementos', 'Implementos', 152]]],
  ['belleza', 'Belleza y cuidado', 'Fragancias, maquillaje y cuidado personal.', 7, [
    ['fragancias', 'Fragancias', 10], ['maquillaje', 'Maquillaje', 2], ['cuidado-personal', 'Cuidado personal', 120]]],
  ['despensa', 'Despensa', 'Abarrotes al por mayor para tu negocio o tu casa.', 27, [
    ['granos-aceites', 'Granos y aceites', 38], ['bebidas', 'Bebidas', 42], ['cafe-endulzantes', 'Café y endulzantes', 34]]]
];

const colorHex = { Negro: '#111111', Blanco: '#f5f5f5', Gris: '#6b7280', Plata: '#c0c0c0', Dorado: '#d4af37', Rojo: '#dc2626', Azul: '#1d4ed8', 'Azul sierra': '#9cc3e6', 'Azul hielo': '#bfe3f5', Morado: '#6d28d9', 'Verde menta': '#b7e4c7', Café: '#8b5a2b', Degradé: '#94a3b8', Verde: '#166534', Vino: '#6d1f2f', Crema: '#f3ead7', Rosado: '#f9a8d4', Naranja: '#f97316' };

// Stock: número fijo para todas las variantes o función (colorIndex, sizeIndex) => stock.
// colors: [nombre, idImagen] (cada color tiene su galería); images: galería general.
const products = [
  // Tecnología
  { name: 'Smartphone Voltix Aura 5G', brand: 'voltix', cats: ['celulares'], price: 1899900, promo: 1599900, promoDays: 10, featured: true, model: 'AURA-5G', o1: 'Color', o2: 'Almacenamiento',
    colors: [['Negro', 133], ['Dorado', 135], ['Rojo', 136], ['Azul hielo', 134]], sizes: ['128 GB', '256 GB'], stock: (c, s) => [[12, 6], [4, 0], [2, 1], [9, 5]][c][s],
    description: 'Pantalla AMOLED de 6,5", conectividad 5G, cámara triple de 64 MP y batería de 5000 mAh con carga rápida de 33 W. Incluye cargador y estuche.',
    specs: [['Pantalla', '6,5" AMOLED 120 Hz'], ['Procesador', 'Octa-core 2,4 GHz'], ['RAM', '8 GB'], ['Cámara', '64 + 8 + 2 MP'], ['Batería', '5000 mAh'], ['Garantía', '12 meses']], created: 1 },
  { name: 'Smartphone Voltix Nova 13 Pro', brand: 'voltix', cats: ['celulares'], price: 3499900, featured: true, model: 'NOVA-13P', o1: 'Color', o2: 'Almacenamiento',
    colors: [['Azul sierra', 123], ['Negro', 124], ['Plata', 122]], sizes: ['128 GB', '256 GB', '512 GB'], stock: (c, s) => [[5, 3, 1], [8, 4, 2], [0, 2, 0]][c][s],
    description: 'Gama alta con triple cámara profesional, pantalla OLED de 6,1" y chip de última generación. Resistente al agua IP68.',
    specs: [['Pantalla', '6,1" OLED'], ['Resistencia', 'IP68'], ['Cámara', 'Triple 12 MP'], ['Conectividad', '5G, Wi‑Fi 6, NFC']], created: 3 },
  { name: 'Smartphone Voltix Wave X', brand: 'voltix', cats: ['celulares'], price: 899900, promo: 749900, o1: 'Color', o2: 'Almacenamiento',
    colors: [['Azul', 130], ['Morado', 129], ['Verde menta', 128]], sizes: ['64 GB', '128 GB'], stock: (c, s) => [[15, 10], [7, 3], [0, 6]][c][s],
    description: 'El equilibrio perfecto entre precio y rendimiento: pantalla de 6,6", cuatro cámaras y batería para todo el día.',
    specs: [['Pantalla', '6,6" IPS'], ['Batería', '5000 mAh'], ['Cámara', '48 MP cuádruple']], created: 12 },
  { name: 'Portátil TecnoPro Book 14', brand: 'tecnopro', cats: ['computadores'], price: 7899900, promo: 6999900, promoDays: 5, featured: true, model: 'TPB-14', o1: 'Color', o2: 'Configuración',
    colors: [['Gris', 78]], sizes: ['16 GB / 512 GB', '32 GB / 1 TB'], stock: (c, s) => [4, 2][s],
    description: 'Portátil profesional de 14" con pantalla Liquid Retina, hasta 18 horas de batería y teclado retroiluminado.',
    specs: [['Pantalla', '14,2" 3024×1964'], ['Procesador', '10 núcleos'], ['Batería', 'Hasta 18 h'], ['Puertos', '3× USB‑C, HDMI, SD'], ['Peso', '1,6 kg']],
    guide: 'Elige 16 GB / 512 GB para oficina y estudio. Elige 32 GB / 1 TB para edición de video, diseño o programación pesada.', created: 2 },
  { name: 'Portátil TecnoPro Dual Screen', brand: 'tecnopro', cats: ['computadores'], price: 9499900, images: [79], sizes: ['32 GB / 1 TB'], stock: 0, soldOut: true,
    description: 'Doble pantalla táctil para creadores: trabaja con la línea de tiempo abajo y el lienzo arriba.',
    specs: [['Pantalla', '15,6" OLED 4K + 14" secundaria'], ['Gráficos', 'Dedicados 8 GB']], created: 20 },
  { name: 'Portátil TecnoPro Slim X', brand: 'tecnopro', cats: ['computadores'], price: 4299900, images: [80], sizes: ['16 GB / 512 GB'], stock: 7, created: 15,
    description: 'Ultradelgado de 13,9" con pantalla táctil 3K y cuerpo de aluminio. Ideal para llevar a todas partes.', specs: [['Peso', '1,3 kg'], ['Pantalla', '13,9" táctil 3K']] },
  { name: 'Portátil TecnoPro Flex 13', brand: 'tecnopro', cats: ['computadores'], price: 3199900, promo: 2799900, o1: 'Color', colors: [['Plata', 81], ['Negro', 82]], stock: (c) => [3, 6][c], created: 25,
    description: 'Convertible 2 en 1 con bisagra de 360°: úsalo como portátil, tienda o tablet.', specs: [['Pantalla', '13,3" táctil'], ['Bisagra', '360°']] },
  { name: 'Tablet Voltix Tab 11', brand: 'voltix', cats: ['tablets'], price: 2199900, o1: 'Color', o2: 'Almacenamiento', colors: [['Gris', 160], ['Blanco', 161]], sizes: ['128 GB', '256 GB'], stock: (c, s) => [[6, 2], [3, 0]][c][s], featured: true, created: 4,
    description: 'Tablet de 11" con lápiz incluido, cuatro parlantes y batería de 10.000 mAh.', specs: [['Pantalla', '11" 120 Hz'], ['Incluye', 'Lápiz óptico']] },
  { name: 'Tablet Voltix Tab Mini', brand: 'voltix', cats: ['tablets'], price: 2599900, promo: 2349900, images: [159], sizes: ['64 GB', '256 GB'], stock: [5, 2], created: 30,
    description: 'Compacta de 8,3", cabe en una mano y en cualquier bolso.', specs: [['Pantalla', '8,3"'], ['Peso', '293 g']] },
  { name: 'Audífonos inalámbricos SonoMax Pods', brand: 'sonomax', cats: ['audio'], price: 459900, promo: 329900, promoDays: 3, featured: true, images: [100], stock: 40, created: 5,
    description: 'Audífonos true wireless con estuche de carga, emparejamiento instantáneo y hasta 24 horas de uso.', specs: [['Autonomía', '5 h + 19 h con estuche'], ['Bluetooth', '5.3']] },
  { name: 'Audífonos de diadema SonoMax Max', brand: 'sonomax', cats: ['audio'], price: 1899900, images: [101], stock: 3, lastUnits: true, created: 14,
    description: 'Cancelación activa de ruido, audio espacial y almohadillas de espuma viscoelástica.', specs: [['Cancelación de ruido', 'Activa'], ['Autonomía', '20 h']] },
  { name: 'Audífonos deportivos SonoMax Flex', brand: 'sonomax', cats: ['audio', 'deportes'], price: 249900, images: [107], stock: 22, created: 40,
    description: 'Banda flexible con imanes, resistentes al sudor y 12 horas de batería.' },
  { name: 'Parlante inteligente SonoMax Home', brand: 'sonomax', cats: ['audio'], price: 389900, promo: 299900, images: [103, 99], stock: 10, created: 22,
    description: 'Parlante con asistente de voz, sonido 360° y control del hogar inteligente.' },
  { name: 'Smartwatch Voltix Fit S4', brand: 'voltix', cats: ['accesorios-tecnologia', 'relojes'], price: 1299900, images: [106], sizes: ['40 mm', '44 mm'], o2: 'Tamaño', stock: [4, 8], featured: true, created: 6,
    description: 'Mide ritmo cardíaco, oxígeno y sueño. GPS integrado y resistencia al agua 50 m.', specs: [['Resistencia', '50 m'], ['GPS', 'Integrado']] },
  { name: 'Cargador inalámbrico Voltix Pad', brand: 'voltix', cats: ['accesorios-tecnologia'], price: 149900, images: [102], stock: 30, created: 50, description: 'Base de carga rápida de 15 W compatible con cualquier celular Qi.' },
  { name: 'Batería magnética 5000 mAh', brand: 'voltix', cats: ['accesorios-tecnologia'], price: 219900, promo: 169900, images: [105], stock: 18, created: 8, description: 'Se adhiere magnéticamente al celular y lo carga sin cables.' },
  { name: 'Cargador USB‑C 20 W', brand: 'voltix', cats: ['accesorios-tecnologia'], price: 79900, images: [104], stock: 120, created: 60, description: 'Carga rápida USB‑C Power Delivery. Ideal para reventa: consulta precio por caja.' },
  { name: 'Estuche de silicona magnético', brand: 'voltix', cats: ['accesorios-tecnologia'], price: 59900, images: [108], o2: 'Modelo compatible', sizes: ['Nova 13', 'Nova 13 Pro', 'Aura 5G'], stock: [14, 0, 9], created: 45, description: 'Silicona suave al tacto con imanes para accesorios magnéticos.' },
  { name: 'Palo selfie con trípode', brand: 'voltix', cats: ['accesorios-tecnologia'], price: 69900, images: [111, 109], stock: 2, created: 35, description: 'Extensible hasta 100 cm, trípode integrado y control Bluetooth.' },

  // Hogar y cocina
  { name: 'Licuadora Kasa Viva Power 1.5 L', brand: 'kasa-viva', cats: ['electrodomesticos'], price: 329900, promo: 259900, promoDays: 7, featured: true, images: [51], stock: 25, created: 7,
    description: 'Motor de 1200 W, vaso de vidrio de 1,5 L y 6 velocidades con pulso.', specs: [['Potencia', '1200 W'], ['Capacidad', '1,5 L'], ['Voltaje', '110 V']], care: 'Lavar el vaso con agua tibia. No sumergir la base en agua.' },
  { name: 'Horno microondas Kasa Viva 25 L', brand: 'kasa-viva', cats: ['electrodomesticos'], price: 549900, images: [66], o1: 'Color', colors: [['Negro', 66]], stock: 6, created: 18, description: 'Grill, descongelado por peso y 10 niveles de potencia.', specs: [['Capacidad', '25 L'], ['Potencia', '900 W']] },
  { name: 'Estufa eléctrica Kasa Viva 2 puestos', brand: 'kasa-viva', cats: ['electrodomesticos'], price: 239900, promo: 199900, images: [56], stock: 11, created: 28, description: 'Dos puestos de 1000 W con control de temperatura independiente.' },
  { name: 'Batidora de mano Kasa Viva', brand: 'kasa-viva', cats: ['electrodomesticos'], price: 159900, images: [61], stock: 0, created: 33, description: 'Batidora de inmersión con vaso medidor y accesorio para picar.' },
  { name: 'Wok de acero al carbono', brand: 'kasa-viva', cats: ['menaje-cocina'], price: 119900, images: [52], o2: 'Diámetro', sizes: ['28 cm', '32 cm'], stock: [9, 4], created: 38, description: 'Calentamiento rápido y uniforme. Apto para todo tipo de estufas.' },
  { name: 'Olla con tapa de vidrio', brand: 'kasa-viva', cats: ['menaje-cocina'], price: 99900, promo: 79900, images: [71], o2: 'Tamaño', sizes: ['20 cm', '24 cm', '28 cm'], stock: [12, 7, 0], created: 42,
    description: 'Acero inoxidable con fondo difusor y tapa templada.', guide: '20 cm: 2–3 porciones · 24 cm: 4–5 porciones · 28 cm: 6–8 porciones.' },
  { name: 'Tabla de picar en bambú', brand: 'nordika', cats: ['menaje-cocina'], price: 45900, images: [53], stock: 60, created: 55, description: 'Bambú natural resistente a cortes con canal para jugos.' },
  { name: 'Sofá tres puestos Nórdika', brand: 'nordika', cats: ['muebles'], price: 2899900, promo: 2399900, images: [12], o1: 'Color', colors: [['Crema', 12]], stock: 2, featured: true, created: 9,
    description: 'Estructura en madera maciza y cojines de alta densidad. Entrega e instalación en la ciudad.', delivery: 'Entrega en 5 a 8 días hábiles. Se coordina fecha y hora por WhatsApp.' },
  { name: 'Mesa de noche en madera', brand: 'nordika', cats: ['muebles'], price: 389900, images: [13], stock: 5, created: 26, description: 'Un cajón y repisa inferior, acabado en madera de cerezo.' },
  { name: 'Silla ejecutiva giratoria', brand: 'nordika', cats: ['muebles'], price: 699900, images: [14], stock: 8, created: 19, description: 'Diseño icónico con base de aluminio y tapizado rojo.' },
  { name: 'Lámpara de mesa Nórdika', brand: 'nordika', cats: ['decoracion'], price: 129900, images: [47], stock: 14, created: 31, description: 'Pantalla en tela y base metálica. Bombillo E27 no incluido.' },
  { name: 'Matera decorativa', brand: 'nordika', cats: ['decoracion'], price: 49900, images: [46], o2: 'Tamaño', sizes: ['Pequeña', 'Mediana', 'Grande'], stock: [20, 12, 3], created: 48, description: 'Cerámica con acabado mate y orificio de drenaje.' },
  { name: 'Planta decorativa artificial', brand: 'nordika', cats: ['decoracion'], price: 89900, images: [45], stock: 9, created: 52, description: 'Luce natural todo el año sin riego.' },

  // Moda
  { name: 'Tenis Urbano Runner', brand: 'urbano-co', cats: ['calzado'], price: 289900, promo: 219900, featured: true, images: [90], o2: 'Talla', sizes: ['37', '38', '39', '40', '41', '42', '43'], stock: [2, 5, 8, 10, 6, 0, 1], created: 10,
    description: 'Suela liviana con amortiguación y capellada transpirable.', guide: 'Horma normal. Si estás entre dos tallas, elige la mayor.', material: 'Capellada textil y sintético. Suela en EVA.' },
  { name: 'Tenis Urbano Retro Alto', brand: 'urbano-co', cats: ['calzado'], price: 349900, images: [88], o2: 'Talla', sizes: ['38', '39', '40', '41', '42'], stock: [3, 4, 7, 5, 2], created: 16, description: 'Clásico de caña alta en cuero sintético rojo y negro.' },
  { name: 'Tenis Urbano Street', brand: 'urbano-co', cats: ['calzado'], price: 259900, o1: 'Color', colors: [['Blanco', 91], ['Rojo', 92]], o2: 'Talla', sizes: ['38', '39', '40', '41', '42'], stock: (c, s) => (c + s) % 3 === 0 ? 0 : 4 + s, created: 11, description: 'Diseño urbano con detalles en contraste.' },
  { name: 'Guayos Andes Pro FG', brand: 'andes-sport', cats: ['calzado', 'deportes'], price: 279900, promo: 239900, images: [89], o2: 'Talla', sizes: ['38', '39', '40', '41', '42', '43'], stock: [3, 6, 9, 9, 4, 2], created: 13, description: 'Tacos para césped natural con ajuste de velocidad.' },
  { name: 'Camisa manga larga a cuadros', brand: 'urbano-co', cats: ['ropa'], price: 129900, o1: 'Estampado', colors: [['Azul', 83], ['Rojo', 85], ['Gris', 87]], o2: 'Talla', sizes: ['S', 'M', 'L', 'XL'], stock: (c, s) => [[4, 8, 6, 2], [0, 5, 7, 3], [3, 3, 0, 1]][c][s], created: 17,
    description: 'Algodón 100% con corte regular.', material: '100% algodón', care: 'Lavar a máquina en ciclo delicado, no usar blanqueador.', guide: 'S: pecho 92 cm · M: 98 cm · L: 104 cm · XL: 110 cm.' },
  { name: 'Reloj Tiempo Real Classic', brand: 'tiempo-real', cats: ['relojes'], price: 459900, promo: 389900, o1: 'Color', colors: [['Dorado', 193], ['Plata', 194]], stock: (c) => [6, 4][c], featured: true, created: 21, description: 'Caja en acero inoxidable, cristal mineral y resistencia al agua 30 m.' },
  { name: 'Reloj cronógrafo correa de cuero', brand: 'tiempo-real', cats: ['relojes'], price: 699900, images: [93], stock: 1, created: 29, description: 'Cronógrafo con fases lunares y correa de cuero café.' },
  { name: 'Gafas de sol aviador', brand: 'urbano-co', cats: ['gafas'], price: 149900, o1: 'Lente', colors: [['Degradé', 155], ['Verde', 156]], stock: (c) => [10, 5][c], created: 24, description: 'Protección UV400 y marco metálico liviano.' },
  { name: 'Gafas de sol clásicas', brand: 'urbano-co', cats: ['gafas'], price: 119900, promo: 89900, images: [154], stock: 16, created: 36, description: 'Montura acetato con lentes polarizados.' },
  { name: 'Bolso de mano Urbano', brand: 'urbano-co', cats: ['bolsos'], price: 219900, o1: 'Color', colors: [['Azul', 172], ['Café', 173], ['Negro', 176]], stock: (c) => [4, 2, 7][c], created: 23, description: 'Cuero sintético con bolsillo interno con cremallera.' },
  { name: 'Morral blanco en cuero sintético', brand: 'urbano-co', cats: ['bolsos'], price: 179900, images: [175], stock: 9, created: 41, description: 'Compartimento acolchado para tablet de hasta 11".' },

  // Deportes
  { name: 'Balón de fútbol Andes Match', brand: 'andes-sport', cats: ['balones'], price: 119900, promo: 94900, featured: true, images: [147], o2: 'Tamaño', sizes: ['N.º 4', 'N.º 5'], stock: [25, 40], created: 3,
    description: 'Balón termosellado de competencia, aprobado para césped natural y sintético.', guide: 'N.º 4: niños de 8 a 12 años. N.º 5: juveniles y adultos.' },
  { name: 'Balón de baloncesto Andes', brand: 'andes-sport', cats: ['balones'], price: 99900, images: [140], stock: 15, created: 27, description: 'Caucho de alto agarre para interior y exterior.' },
  { name: 'Balón de voleibol Andes', brand: 'andes-sport', cats: ['balones'], price: 89900, images: [153], stock: 0, created: 44, description: 'Cuero sintético suave al tacto.' },
  { name: 'Raqueta de tenis Andes Pro', brand: 'andes-sport', cats: ['implementos'], price: 399900, images: [152], stock: 4, created: 37, description: 'Marco de grafito, 300 g, encordada de fábrica.' },
  { name: 'Guante de béisbol', brand: 'andes-sport', cats: ['implementos'], price: 189900, images: [139], stock: 6, created: 46, description: 'Cuero genuino, 12 pulgadas.' },

  // Belleza
  { name: 'Perfume Lumen Noir', brand: 'lumen', cats: ['fragancias'], price: 389900, promo: 329900, images: [7], o2: 'Presentación', sizes: ['50 ml', '100 ml'], stock: [8, 3], featured: true, created: 8, description: 'Eau de parfum oriental con notas de rosa, pachulí y vainilla.' },
  { name: 'Perfume Lumen Bloom', brand: 'lumen', cats: ['fragancias'], price: 349900, images: [10], o2: 'Presentación', sizes: ['50 ml', '100 ml'], stock: [6, 6], created: 32, description: 'Floral blanco con tuberosa y jazmín.' },
  { name: 'Perfume Lumen Fresh Unisex', brand: 'lumen', cats: ['fragancias'], price: 229900, images: [6], stock: 12, created: 54, description: 'Cítrico fresco para el día a día.' },
  { name: 'Paleta de sombras con espejo', brand: 'lumen', cats: ['maquillaje'], price: 79900, images: [2], stock: 20, created: 39, description: '16 tonos mate y metalizados de alta pigmentación.' },
  { name: 'Labial mate larga duración', brand: 'lumen', cats: ['maquillaje'], price: 39900, promo: 29900, images: [4], o1: 'Tono', colors: [['Rojo', 4], ['Vino', 4], ['Rosado', 4]], stock: (c) => [30, 12, 0][c], created: 43, description: 'Hasta 12 horas sin transferir.' },
  { name: 'Crema corporal hidratante', brand: 'lumen', cats: ['cuidado-personal'], price: 34900, images: [120], stock: 45, created: 51, description: 'Absorción rápida para rostro y cuerpo.' },
  { name: 'Jabón líquido de manos', brand: 'lumen', cats: ['cuidado-personal'], price: 24900, images: [118], o2: 'Presentación', sizes: ['500 ml', 'Galón 3,8 L'], stock: [50, 15], created: 57, description: 'Fórmula vegetal biodegradable.' },

  // Despensa (mayorista)
  { name: 'Aceite vegetal Sabana', brand: 'sabana', cats: ['granos-aceites'], price: 12900, images: [20], o2: 'Presentación', sizes: ['1 L', '3 L', 'Caja x 12 L'], stock: [200, 80, 25], created: 2, description: 'Aceite 100% vegetal. Precio mayorista por caja.' },
  { name: 'Arroz blanco Sabana', brand: 'sabana', cats: ['granos-aceites'], price: 5900, promo: 4900, images: [38], o2: 'Presentación', sizes: ['1 kg', '5 kg', 'Bulto 25 kg'], stock: [300, 90, 20], created: 5, description: 'Grano largo seleccionado.' },
  { name: 'Agua mineral Sabana', brand: 'sabana', cats: ['bebidas'], price: 2500, images: [42], o2: 'Presentación', sizes: ['Unidad 600 ml', 'Paca x 12', 'Paca x 24'], stock: [500, 60, 30], created: 34, description: 'Agua de manantial sin gas.' },
  { name: 'Jugo de naranja Sabana', brand: 'sabana', cats: ['bebidas'], price: 7900, images: [29], stock: 70, created: 47, description: 'Jugo natural sin azúcar añadida, 1 L.' },
  { name: 'Café instantáneo Sabana', brand: 'sabana', cats: ['cafe-endulzantes'], price: 18900, promo: 15900, images: [34], o2: 'Presentación', sizes: ['85 g', '170 g'], stock: [40, 25], created: 12, description: 'Café liofilizado de sabor intenso.' },
  { name: 'Miel de abejas pura', brand: 'sabana', cats: ['cafe-endulzantes'], price: 21900, images: [27], stock: 3, created: 49, description: 'Miel 100% natural de apiarios colombianos, 500 g.' },

  // Estados especiales para ver el panel
  { name: 'Parlante SonoMax Echo (borrador)', brand: 'sonomax', cats: ['audio'], price: 299900, images: [99], stock: 5, status: 'draft', created: 1, description: 'Producto en borrador: no aparece en la tienda.' },
  { name: 'Smartphone Voltix Classic (oculto)', brand: 'voltix', cats: ['celulares'], price: 499900, images: [121], stock: 3, status: 'hidden', created: 70, description: 'Producto oculto: no aparece en la tienda.' },
  { name: 'Perfume Lumen Dolce (promo programada)', brand: 'lumen', cats: ['fragancias'], price: 299900, promo: 249900, promoFuture: true, images: [9], stock: 7, created: 58, description: 'Tiene una promoción que empieza en 5 días.' }
];

const banners = [
  { key: 'tecnologia', link: 'categoria.html?slug=tecnologia', alt: 'Semana de la tecnología: hasta 20% en celulares y portátiles',
    kicker: 'Semana de la tecnología', title: 'Hasta 20% OFF', text: 'Celulares, portátiles y audio', bg: 'linear-gradient(120deg,#0b1f4d,#0f62fe)', imgs: [133, 78, 100] },
  { key: 'hogar', link: 'categoria.html?slug=hogar-cocina', alt: 'Renueva tu cocina con precios de bodega',
    kicker: 'Hogar y cocina', title: 'Precios de bodega', text: 'Licuadoras, microondas, ollas y más', bg: 'linear-gradient(120deg,#7c2d12,#f97316)', imgs: [51, 66, 71] },
  { key: 'futbol', link: 'categoria.html?slug=deportes', alt: 'Todo para el fútbol: balones y guayos',
    kicker: 'Bodega Mayorista F.C.', title: 'Vive el fútbol', text: 'Balones, guayos y accesorios', bg: 'linear-gradient(120deg,#052e16,#16a34a)', imgs: [147, 89, 107] }
];

const settingsDemo = {
  whatsapp: '+573000000000', phone: '+57 300 000 0000', email: 'demo@bodegamayorista.test',
  address: 'Calle 00 # 00-00 (dirección demo)', city: 'Valledupar', schedule: 'Lun a Sáb 8:00 a. m. – 6:00 p. m.',
  instagram: 'https://instagram.com/', data_policy_text: '[DEMO] Autorizo el tratamiento de mis datos para gestionar mi pedido.', data_policy_version: 'demo-1',
  marketing_consent_text: '[DEMO] Acepto recibir promociones y un saludo de cumpleaños.', marketing_consent_version: 'demo-1',
  quote_terms: '[DEMO] Cotización válida por 8 días.', sale_terms: '[DEMO] Precios con IVA incluido.', warranty_text: '[DEMO] Garantía de 3 meses por defectos de fábrica.'
};
const payments = [['Transferencia bancaria (demo)', 'Te enviaremos los datos de la cuenta por WhatsApp.'], ['Efectivo contra entrega (demo)', 'Paga al recibir tu pedido.'], ['Nequi / Daviplata (demo)', 'Número de pago enviado al confirmar.']];
const deliveries = [['Recoger en bodega (demo)', 'Te avisamos cuando esté listo.', false, false, 0], ['Domicilio en la ciudad (demo)', 'Entrega en 24 a 48 horas.', true, true, 8000], ['Envío nacional (demo)', 'Transportadora, 3 a 5 días hábiles.', true, true, 18000]];

// ---------- Utilidades ----------
const slugify = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lit = value => value == null ? 'null' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const env = Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${AUTHORIZED_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

let catalog;
async function source(id) {
  catalog ??= (await (await fetch('https://dummyjson.com/products?limit=0&select=images,thumbnail')).json()).products;
  return catalog.find(item => item.id === id);
}
async function download(url, file) {
  if (existsSync(file)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}
// Descarga todas las fotos de un producto de DummyJSON y devuelve sus rutas relativas.
async function photos(id) {
  const item = await source(id);
  const paths = [];
  for (const [index, url] of item.images.entries()) {
    const name = `products/${id}-${index + 1}.webp`;
    await download(url, join(demoDir, name));
    paths.push(rel(name));
  }
  return paths;
}

function brandLogo(brand) {
  const size = brand.mark.length > 1 ? 34 : 44;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="28" fill="${brand.color}"/><circle cx="60" cy="50" r="30" fill="#fff" opacity=".14"/><text x="60" y="${brand.mark.length > 1 ? 62 : 66}" font-family="Arial,Helvetica,sans-serif" font-size="${size}" font-weight="800" fill="#fff" text-anchor="middle">${brand.mark}</text><text x="60" y="100" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700" fill="#fff" text-anchor="middle" letter-spacing=".5">${brand.name.toUpperCase().replace('&', '&amp;')}</text></svg>`;
}

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
async function renderBanner(banner, variant) {
  const [width, height] = variant === 'mobile' ? [1080, 600] : [1920, 640];
  const file = join(demoDir, `banners/${banner.key}-${variant}.png`);
  if (existsSync(file)) return rel(`banners/${banner.key}-${variant}.png`);
  const imgs = await Promise.all(banner.imgs.map(async id => (await source(id)).images[0]));
  const mobile = variant === 'mobile';
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}body{width:${width}px;height:${height}px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif;background:${banner.bg};color:#fff;position:relative}
    .copy{position:absolute;left:${mobile ? 64 : 140}px;top:50%;transform:translateY(-50%);max-width:${mobile ? 520 : 780}px}
    .k{font-size:${mobile ? 26 : 30}px;font-weight:700;letter-spacing:3px;text-transform:uppercase;opacity:.85}
    h1{font-size:${mobile ? 84 : 100}px;line-height:1;font-weight:900;margin:18px 0}p{font-size:${mobile ? 30 : 36}px;opacity:.92}
    .cta{display:inline-block;margin-top:34px;background:#fff;color:#111;font-weight:800;font-size:${mobile ? 26 : 30}px;padding:18px 40px;border-radius:999px}
    .imgs{position:absolute;right:${mobile ? 10 : 70}px;top:0;bottom:0;display:flex;align-items:center;gap:${mobile ? 0 : 20}px}
    .imgs div{width:${mobile ? 250 : 280}px;height:${mobile ? 250 : 280}px;border-radius:50%;background:rgba(255,255,255,.95);display:grid;place-items:center;box-shadow:0 30px 60px rgba(0,0,0,.35)}
    .imgs div:nth-child(2){transform:translateY(${mobile ? 120 : 60}px)}.imgs div:nth-child(3){${mobile ? 'display:none' : ''}}
    ${mobile ? '.imgs{flex-direction:column;justify-content:center;gap:0}.imgs div:nth-child(2){transform:translate(-120px,-20px)}' : ''}
    img{width:80%;height:80%;object-fit:contain}.tag{position:absolute;left:${mobile ? 64 : 140}px;bottom:${mobile ? 26 : 34}px;font-size:20px;opacity:.6}</style>
    <div class="copy"><div class="k">${banner.kicker}</div><h1>${banner.title}</h1><p>${banner.text}</p><span class="cta">Comprar ahora</span></div>
    <div class="imgs">${imgs.map(src => `<div><img src="${src}"></div>`).join('')}</div>`;
  const htmlFile = join(demoDir, `banners/${banner.key}-${variant}.html`);
  writeFileSync(htmlFile, html);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, '--virtual-time-budget=15000', `--screenshot=${file}`, `file:///${htmlFile.replaceAll('\\', '/')}`], { stdio: 'ignore' });
  const { unlinkSync } = await import('node:fs'); unlinkSync(htmlFile);
  return rel(`banners/${banner.key}-${variant}.png`);
}

// ---------- SQL ----------
const categorySlugs = categoryTree.flatMap(([slug, , , , children]) => [slug, ...children.map(([child]) => child)]);
const brandSlugs = brands.map(brand => brand.slug);
const cleanupSql = `
-- Elimina solo el catálogo DEMO creado por tools/seed-demo.mjs
delete from public.product_images where product_id in (select id from public.products where sku like 'DEMO-%');
delete from public.products where sku like 'DEMO-%';
delete from public.categories where parent_id is not null and slug in (${categorySlugs.map(lit).join(',')});
delete from public.categories where slug in (${categorySlugs.map(lit).join(',')});
delete from public.brands where slug in (${brandSlugs.map(lit).join(',')});
delete from public.homepage_banners where desktop_image_url like 'assets/images/demo/%';
delete from public.payment_methods where name like '%(demo)';
delete from public.delivery_methods where name like '%(demo)';
update public.site_settings set ${Object.entries(settingsDemo).map(([key, value]) => `${key} = case when ${key} = ${lit(value)} then null else ${key} end`).join(', ')}, updated_at = now() where id = 1;
`;

async function buildSeedSql() {
  const sql = [cleanupSql];
  const brandIds = {};
  for (const [index, brand] of brands.entries()) {
    brandIds[brand.slug] = randomUUID();
    writeFileSync(join(demoDir, `brands/${brand.slug}.svg`), brandLogo(brand));
    sql.push(`insert into public.brands(id,name,slug,logo_url,sort_order) values(${lit(brandIds[brand.slug])},${lit(brand.name)},${lit(brand.slug)},${lit(rel(`brands/${brand.slug}.svg`))},${index});`);
  }
  const categoryIds = {};
  for (const [index, [slug, name, description, image, children]] of categoryTree.entries()) {
    categoryIds[slug] = randomUUID();
    sql.push(`insert into public.categories(id,name,slug,description,image_url,sort_order) values(${lit(categoryIds[slug])},${lit(name)},${lit(slug)},${lit(description)},${lit((await photos(image))[0])},${index});`);
    for (const [childIndex, [childSlug, childName, childImage]] of children.entries()) {
      categoryIds[childSlug] = randomUUID();
      sql.push(`insert into public.categories(id,parent_id,name,slug,image_url,sort_order) values(${lit(categoryIds[childSlug])},${lit(categoryIds[slug])},${lit(childName)},${lit(childSlug)},${lit((await photos(childImage))[0])},${childIndex});`);
    }
  }
  const parentOf = Object.fromEntries(categoryTree.flatMap(([slug, , , , children]) => children.map(([child]) => [child, slug])));

  for (const [index, product] of products.entries()) {
    const id = randomUUID();
    const slug = slugify(product.name.replace(/\(.*\)/, ''));
    const sku = `DEMO-${String(index + 1).padStart(3, '0')}`;
    const promoStart = product.promoFuture ? `now() + interval '5 days'` : product.promo ? `now() - interval '1 day'` : 'null';
    const promoEnd = product.promoFuture ? `now() + interval '20 days'` : product.promoDays ? `now() + interval '${product.promoDays} days'` : 'null';
    const specs = product.specs ? { items: product.specs.map(([label, value]) => ({ label, value })) } : {};
    const delivery = product.delivery || 'Despachamos en 24 a 48 horas hábiles. Envíos a todo el país. Compras al por mayor con precio especial: escríbenos.';
    sql.push(`insert into public.products(id,name,slug,sku,model,description,material,care_instructions,purchase_delivery_info,specifications,base_price,promo_price,promo_start,promo_end,status,brand_id,featured,low_stock_threshold,force_last_units,force_sold_out,option1_name,option2_name,size_guide_text,created_at,updated_at) values(${[
      lit(id), lit(product.name), lit(slug), lit(sku), lit(product.model || null), lit(product.description), lit(product.material || null), lit(product.care || null), lit(delivery),
      `${lit(JSON.stringify(specs))}::jsonb`, product.price, product.promo ?? 'null', promoStart, promoEnd, lit(product.status || 'published'), lit(brandIds[product.brand]),
      Boolean(product.featured), 3, Boolean(product.lastUnits), Boolean(product.soldOut), lit(product.o1 || null), lit(product.o2 || null), lit(product.guide || null),
      `now() - interval '${product.created * 6} hours'`, 'now()'
    ].join(',')});`);
    const cats = new Set(product.cats.flatMap(cat => [cat, parentOf[cat]].filter(Boolean)));
    for (const cat of cats) sql.push(`insert into public.product_categories(product_id,category_id) values(${lit(id)},${lit(categoryIds[cat])});`);

    const colors = (product.colors || [['Única', null]]).map(([name, image], order) => ({ id: randomUUID(), name, image, order }));
    const sizes = (product.sizes || ['Única']).map((name, order) => ({ id: randomUUID(), name, order }));
    for (const color of colors) sql.push(`insert into public.product_colors(id,product_id,name,hex_code,sort_order) values(${lit(color.id)},${lit(id)},${lit(color.name)},${lit(color.name === 'Única' ? null : colorHex[color.name] || null)},${color.order});`);
    for (const size of sizes) sql.push(`insert into public.product_sizes(id,product_id,name,sort_order) values(${lit(size.id)},${lit(id)},${lit(size.name)},${size.order});`);
    for (const color of colors) for (const size of sizes) {
      const stock = typeof product.stock === 'function' ? product.stock(color.order, size.order) : Array.isArray(product.stock) ? product.stock[size.order] : product.stock;
      const suffix = [color.name, size.name].filter(value => value !== 'Única').map(value => slugify(value).toUpperCase()).join('-');
      sql.push(`insert into public.product_variants(product_id,color_id,size_id,sku,stock) values(${lit(id)},${lit(color.id)},${lit(size.id)},${lit(suffix ? `${sku}-${suffix}` : sku)},${stock});`);
    }

    // Galería: fotos por color (si las tiene) y galería general.
    const rows = [];
    const seen = new Set();
    for (const color of colors.filter(item => item.image)) {
      if (seen.has(color.image)) continue; // mismo archivo para varios tonos: queda como galería general
      if (colors.filter(item => item.image === color.image).length > 1) continue;
      seen.add(color.image);
      for (const url of await photos(color.image)) rows.push({ url, colorId: color.id, alt: `${product.name} ${color.name}` });
    }
    for (const image of [...(product.images || []), ...colors.filter(item => item.image && !seen.has(item.image)).map(item => item.image)]) {
      if (seen.has(image)) continue;
      seen.add(image);
      for (const url of await photos(image)) rows.push({ url, colorId: null, alt: product.name });
    }
    rows.forEach((row, order) => sql.push(`insert into public.product_images(product_id,color_id,url,alt_text,is_primary,sort_order) values(${lit(id)},${lit(row.colorId)},${lit(row.url)},${lit(row.alt)},${order === 0},${order});`));
  }

  for (const [index, banner] of banners.entries()) {
    const desktop = await renderBanner(banner, 'desktop');
    const mobile = await renderBanner(banner, 'mobile');
    sql.push(`insert into public.homepage_banners(desktop_image_url,mobile_image_url,alt_text,link_url,sort_order) values(${lit(desktop)},${lit(mobile)},${lit(banner.alt)},${lit(banner.link)},${index + 1});`);
  }
  payments.forEach(([name, instructions], index) => sql.push(`insert into public.payment_methods(name,instructions,sort_order) values(${lit(name)},${lit(instructions)},${index});`));
  deliveries.forEach(([name, instructions, city, address, cost], index) => sql.push(`insert into public.delivery_methods(name,instructions,requires_city,requires_address,base_cost,sort_order) values(${lit(name)},${lit(instructions)},${city},${address},${cost},${index});`));
  // Solo completa ajustes vacíos: nunca pisa datos reales del negocio.
  sql.push(`update public.site_settings set ${Object.entries(settingsDemo).map(([key, value]) => `${key} = coalesce(${key}, ${lit(value)})`).join(', ')}, banner_enabled = true, announcement_mode = 'carousel', announcement_messages = ${lit(JSON.stringify([
    { id: 'demo-1', text: 'Envíos a todo el país · Precios especiales por mayor', enabled: true, position: 1 },
    { id: 'demo-2', text: 'Semana de la tecnología: hasta 20% OFF en celulares', enabled: true, position: 2 },
    { id: 'demo-3', text: 'Paga contra entrega en la ciudad', enabled: true, position: 3 }
  ]))}::jsonb, updated_at = now() where id = 1;`);
  return sql.join('\n');
}

// ---------- Ejecución ----------
for (const folder of ['products', 'brands', 'banners']) mkdirSync(join(demoDir, folder), { recursive: true });
const config = readFileSync(join(root, 'js/config.js'), 'utf8');
if (!config.includes(`https://${AUTHORIZED_REF}.supabase.co`)) throw new Error('El frontend no apunta al proyecto autorizado.');

if (clean) {
  await query(`begin;\n${cleanupSql}\ncommit;`);
  console.log('Catálogo demo eliminado de la base (las imágenes locales siguen en assets/images/demo/).');
} else {
  const sql = await buildSeedSql();
  const out = join(demoDir, 'seed-demo.sql');
  writeFileSync(out, sql);
  console.log(`SQL generado: ${out} (${sql.split('\n').length} líneas)`);
  if (apply) {
    await query(`begin;\n${sql}\ncommit;`);
    const [counts] = await query(`select (select count(*) from products where sku like 'DEMO-%') productos, (select count(*) from product_variants v join products p on p.id=v.product_id where p.sku like 'DEMO-%') variantes, (select count(*) from product_images i join products p on p.id=i.product_id where p.sku like 'DEMO-%') imagenes, (select count(*) from categories) categorias, (select count(*) from brands) marcas, (select count(*) from homepage_banners) banners`);
    console.log('Aplicado:', counts);
  } else console.log('Simulación: usa --apply para cargarlo en la base.');
}
