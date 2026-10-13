import { escapeHtml, getBrandUrl, localAsset } from '../lib/helpers.js';

const initials = name => String(name || '').split(/\s+/).filter(Boolean).map(word => word[0]).join('').slice(0, 2).toUpperCase() || '•';

// La tarjeta muestra únicamente el logo que sube el administrador. Si la marca
// aún no tiene logo, se muestran sus iniciales como respaldo.
export function brandCard(brand) {
  const logo = brand.logo_url
    ? `<img src="${escapeHtml(localAsset(brand.logo_url))}" alt="Logo de ${escapeHtml(brand.name)}" width="240" height="180" loading="lazy" decoding="async" data-brand-logo>`
    : escapeHtml(initials(brand.name));
  const media = `<span class="brand-card__media brand-card__media--logo"><span class="brand-card__logo brand-card__logo--large${brand.logo_url ? '' : ' is-fallback'}" data-initials="${escapeHtml(initials(brand.name))}">${logo}</span></span>`;

  return `<a class="brand-card" data-brand="${escapeHtml(brand.slug)}" href="${getBrandUrl(brand.slug)}">${media}<span class="brand-card__name">${escapeHtml(brand.name)}</span></a>`;
}
