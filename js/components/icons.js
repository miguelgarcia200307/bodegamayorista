// Iconos de Lucide (https://lucide.dev, licencia ISC), en línea para no depender de
// peticiones externas. Única librería de iconos de la tienda: trazo 1.75, 20/24 px.
// En modo relleno (`filled`), los elementos marcados con `f` se rellenan y los
// marcados con `c` se dibujan con el color de la superficie para conservar el detalle.
import { ICONS } from './icon-paths.js';

const ATTRS = ['cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx', 'd'];

export function icon(name, { size = 20, className = '', filled = false, label = '' } = {}) {
  const shapes = ICONS[name];
  if (!shapes) return '';
  const brand = shapes.some(([, attrs]) => attrs.brand);
  const body = shapes.map(([tag, attrs]) => {
    const values = ATTRS.filter(key => attrs[key] != null).map(key => `${key}="${attrs[key]}"`).join(' ');
    const role = attrs.brand ? ' fill="currentColor" stroke="none"' : attrs.f ? ' class="i-f"' : attrs.c ? ' class="i-c"' : '';
    return `<${tag} ${values}${role}/>`;
  }).join('');
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true" focusable="false"';
  const classes = ['icon', `icon--${name}`, filled ? 'icon--filled' : '', className].filter(Boolean).join(' ');
  const stroke = brand ? '' : ' fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="${classes}" width="${size}" height="${size}" viewBox="0 0 24 24"${stroke} ${a11y}>${body}</svg>`;
}
