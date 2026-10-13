// Estructura común de la tienda: barra de anuncios, header, navegación inferior,
// footer y botón flotante de WhatsApp. Todos los datos del negocio salen de site-config.
import { getSiteData, loadSettings as loadSiteSettings } from '../site-config.js';
import { getCategories } from '../lib/api.js';
import { cartCount, getFavorites } from '../lib/store.js';
import { escapeHtml, getCategoryUrl, localAsset } from '../lib/helpers.js';
import { createAnnouncementController } from '../lib/announcement.js';
import { icon } from './icons.js';
import { bindSearch, searchBox } from './search.js';

// Compatibilidad: checkout y otras páginas siguen importando loadSettings desde aquí.
export const loadSettings = loadSiteSettings;

const WA_TIP_KEY = 'bodega_mayorista_fc_wa_tip_v1';
const page = () => document.body.dataset.page || '';

function logo({ dark = false, className = '' } = {}) {
  return `<img class="brand-logo ${className}" src="${localAsset(`assets/images/logo-${dark ? 'dark' : 'light'}.svg`)}" width="356" height="57" alt="Bodega Mayorista F.C. · By Francisney Castaño">`;
}

function headerMarkup() {
  return `<header class="site-header" data-site-header>
    <div class="container site-header__bar">
      <a class="site-header__brand" href="index.html" aria-label="Bodega Mayorista F.C., ir al inicio">${logo()}</a>
      <div class="site-header__search site-header__search--desktop">${searchBox('desktop-search')}</div>
      <div class="site-header__actions">
        <button class="icon-button site-header__search-toggle" type="button" data-search-toggle aria-label="Buscar productos" aria-controls="mobile-search">${icon('search', { size: 22 })}</button>
        <a class="icon-button site-header__favorites" href="favoritos.html" aria-label="Favoritos" data-favorites-link>${icon('heart', { size: 22 })}<span class="count-badge favorite-badge" hidden>0</span></a>
        <a class="icon-button site-header__cart" href="carrito.html" aria-label="Carrito" data-cart-link>${icon('bag', { size: 22 })}<span class="count-badge cart-badge" hidden>0</span></a>
      </div>
    </div>
    <div class="container site-header__search site-header__search--mobile">${searchBox('mobile-search', true)}</div>
    <nav class="site-header__nav" aria-label="Categorías de la tienda"><div class="container site-header__nav-inner" data-category-nav>
      <a href="categorias.html">Todas las categorías</a><a href="promociones.html" class="is-accent">Ofertas</a>
    </div></nav>
  </header>`;
}

function mobileNavMarkup() {
  const current = page();
  const items = [
    ['index.html', 'home', 'Inicio', current === 'home'],
    ['categorias.html', 'grid', 'Categorías', ['categories', 'listing', 'catalog'].includes(current)],
    ['promociones.html', 'percent', 'Ofertas', current === 'promotions'],
    ['favoritos.html', 'heart', 'Favoritos', current === 'favorites', 'favorite-badge'],
    ['carrito.html', 'bag', 'Carrito', ['cart', 'checkout'].includes(current), 'cart-badge']
  ];
  return `<nav class="mobile-nav" aria-label="Navegación principal">${items.map(([href, name, label, active, badge]) => `<a href="${href}" class="mobile-nav__item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}${badge === 'cart-badge' ? ' data-cart-link' : ''}><span class="mobile-nav__icon">${icon(name, { size: 24, filled: active })}${badge ? `<span class="count-badge ${badge}" hidden>0</span>` : ''}</span><span class="mobile-nav__label">${label}</span></a>`).join('')}</nav>`;
}

function footerMarkup(site) {
  // Todas las vías de contacto y redes comparten la misma tarjeta; solo cambia el color del ícono.
  const channel = (kind, href, title, text, external = true) => `<a class="footer-channel footer-channel--${kind}" href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener"' : ''}><span class="footer-channel__icon">${icon(kind, { size: 18 })}</span><span class="footer-channel__text"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(text)}</small></span></a>`;
  const contact = [
    site.whatsapp ? channel('whatsapp', site.whatsapp.url, 'WhatsApp', 'Escríbenos, te respondemos') : '',
    site.instagram ? channel('instagram', site.instagram.url, 'Instagram', site.instagram.handle) : '',
    site.tiktok ? channel('tiktok', site.tiktok.url, 'TikTok', site.tiktok.handle) : '',
    site.facebook ? channel('facebook', site.facebook, 'Facebook', 'Síguenos en Facebook') : '',
    site.phone ? channel('phone', site.phone.href, 'Llámanos', site.phone.display, false) : '',
    site.email ? channel('mail', `mailto:${site.email}`, 'Correo', site.email, false) : ''
  ].filter(Boolean);
  const visit = [
    site.address ? `<p class="footer__detail">${icon('pin')}<span>${escapeHtml(site.address)}${site.city ? `<br>${escapeHtml(site.city)}` : ''}</span></p>` : site.hasPhysicalStore ? `<p class="footer__detail">${icon('store')}<span>Tienda física en ${escapeHtml(site.city)}</span></p>` : '',
    site.schedule ? `<p class="footer__detail">${icon('clock')}<span>${escapeHtml(site.schedule)}</span></p>` : '',
    site.mapsUrl ? `<a class="btn btn--secondary btn--sm footer__maps" href="${escapeHtml(site.mapsUrl)}" target="_blank" rel="noopener">${icon('navigation', { size: 18 })}<span>Cómo llegar</span></a>` : ''
  ].filter(Boolean);
  const help = site.helpTopics.map(topic => `<a href="ayuda.html#${topic.slug}">${escapeHtml(topic.title)}</a>`);
  const legal = [site.legalName, site.taxId ? `NIT ${site.taxId}` : ''].filter(Boolean).join(' · ');
  return `<footer class="site-footer" data-site-footer>
    <div class="container footer__grid">
      <section class="footer__brand">
        <a href="index.html" class="footer__logo" aria-label="Ir al inicio">${logo({ dark: true })}</a>
        ${site.locationLine ? `<p>${escapeHtml(site.locationLine)}</p>` : ''}
      </section>
      ${contact.length ? `<section class="footer__col" aria-labelledby="footer-contact"><h2 id="footer-contact">Hablemos</h2><div class="footer__stack">${contact.join('')}</div></section>` : ''}
      <nav class="footer__col" aria-labelledby="footer-explore"><h2 id="footer-explore">Explora</h2><div class="footer__links"><a href="catalogo.html">Todos los productos</a><a href="categorias.html">Categorías</a><a href="promociones.html">Ofertas</a><a href="catalogo.html?sort=newest">Novedades</a><a href="favoritos.html">Mis favoritos</a></div></nav>
      ${help.length ? `<nav class="footer__col" aria-labelledby="footer-help"><h2 id="footer-help">Ayuda</h2><div class="footer__links">${help.join('')}</div></nav>` : ''}
      ${visit.length ? `<section class="footer__col" aria-labelledby="footer-visit"><h2 id="footer-visit">Visítanos</h2><div class="footer__stack">${visit.join('')}</div></section>` : ''}
    </div>
    ${site.payments.length ? `<div class="container footer__payments"><span>Medios de pago</span><ul>${site.payments.map(method => `<li>${method.logo ? `<img src="${escapeHtml(localAsset(method.logo))}" alt="${escapeHtml(method.name)}" width="48" height="24" loading="lazy">` : escapeHtml(method.name)}</li>`).join('')}</ul></div>` : ''}
    <div class="footer__bottom"><div class="container"><span>© ${new Date().getFullYear()} ${escapeHtml(site.businessName)}${legal ? ` · ${escapeHtml(legal)}` : ''}</span><a href="admin/login.html">Administrar</a></div></div>
  </footer>`;
}

function whatsappFloatMarkup(site) {
  if (!site.whatsapp || ['cart', 'checkout'].includes(page())) return '';
  return `<a class="wa-float" href="${escapeHtml(site.whatsapp.url)}" target="_blank" rel="noopener" data-wa-float aria-label="Escríbenos por WhatsApp">
    <span class="wa-float__icon">${icon('whatsapp', { size: 26 })}</span><span class="wa-float__label">Escríbenos</span>
  </a><div class="wa-tip" data-wa-tip role="status" hidden>¿Te ayudamos?</div>`;
}

// Header que se compacta al bajar y reaparece completo al subir; botón de WhatsApp que se contrae.
function bindScrollBehavior() {
  const header = document.querySelector('[data-site-header]');
  const float = document.querySelector('[data-wa-float]');
  let anchorY = scrollY;
  let compact = false;
  let ticking = false;
  const setCompact = value => {
    if (value === compact) return;
    compact = value;
    header?.classList.toggle('is-compact', value);
    document.body.classList.toggle('header-compact', value);
  };
  const update = () => {
    ticking = false;
    const y = Math.max(0, scrollY);
    float?.classList.toggle('is-collapsed', y > 240);
    if (y < 120) { setCompact(false); anchorY = y; return; }
    // Compacta tras bajar 12 px seguidos; se expande tras subir 48 px seguidos.
    if (y > anchorY + 12) { setCompact(true); anchorY = y; }
    else if (y < anchorY - 48) { setCompact(false); anchorY = y; }
    else if (compact ? y > anchorY : y < anchorY) anchorY = y;
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
}

function bindSearchToggle() {
  document.querySelector('[data-search-toggle]')?.addEventListener('click', () => {
    const header = document.querySelector('[data-site-header]');
    header?.classList.remove('is-compact');
    document.body.classList.remove('header-compact');
    document.querySelector('#mobile-search')?.focus();
  });
}

function bindWhatsappTip() {
  const tip = document.querySelector('[data-wa-tip]');
  if (!tip) return;
  let seen = false;
  try { seen = localStorage.getItem(WA_TIP_KEY) === '1'; } catch { seen = true; }
  if (seen) return;
  setTimeout(() => {
    tip.hidden = false;
    try { localStorage.setItem(WA_TIP_KEY, '1'); } catch { /* sin almacenamiento */ }
    setTimeout(() => { tip.classList.add('is-leaving'); setTimeout(() => { tip.hidden = true; }, 220); }, 5000);
  }, 2500);
}

// El botón flotante no debe tapar contenido ni la barra de compra de la ficha.
function bindFloatVisibility() {
  const float = document.querySelector('[data-wa-float]');
  const footer = document.querySelector('[data-site-footer]');
  if (!float || !footer || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => float.classList.toggle('is-hidden', entry.isIntersecting), { rootMargin: '0px 0px -40px 0px' }).observe(footer);
}

async function renderCategoryNav() {
  const root = document.querySelector('[data-category-nav]');
  if (!root) return;
  try {
    const categories = (await getCategories()).filter(category => !category.parent_id && category.slug !== 'promo').slice(0, 7);
    root.innerHTML = `<a href="categorias.html">Todas las categorías</a>${categories.map(category => `<a href="${getCategoryUrl(category.slug)}">${escapeHtml(category.name)}</a>`).join('')}<a href="promociones.html" class="is-accent">Ofertas</a>`;
    const current = new URLSearchParams(location.search).get('slug');
    root.querySelectorAll('a').forEach(link => { if (current && link.getAttribute('href') === getCategoryUrl(current)) link.setAttribute('aria-current', 'page'); });
  } catch { /* el menú conserva los enlaces básicos */ }
}

export async function renderLayout() {
  const site = await getSiteData();
  const headerRoot = document.querySelector('#site-header');
  if (headerRoot) {
    headerRoot.innerHTML = `${site.announcements.length ? '<aside class="announcement" data-announcement aria-label="Anuncios de la tienda"></aside>' : ''}${headerMarkup()}`;
    const controller = createAnnouncementController(headerRoot.querySelector('[data-announcement]'), {
      announcement_enabled: true,
      announcement_mode: site.announcements.length > 1 ? 'carousel' : 'static',
      announcement_static_text: site.announcements[0] || '',
      announcement_messages: site.announcements.map((text, index) => ({ id: `m${index}`, text, enabled: true, position: index + 1 })),
      announcement_interval_seconds: Math.min(120, Math.max(3, Math.round(site.announcementSeconds)))
    });
    addEventListener('pagehide', controller.stop, { once: true });
  }
  const footerRoot = document.querySelector('#site-footer');
  if (footerRoot) footerRoot.innerHTML = `${footerMarkup(site)}${whatsappFloatMarkup(site)}`;
  document.body.classList.toggle('has-wa-float', Boolean(document.querySelector('[data-wa-float]')));
  const mobileRoot = document.querySelector('#mobile-nav');
  if (mobileRoot) mobileRoot.innerHTML = mobileNavMarkup();

  bindSearch();
  bindSearchToggle();
  bindScrollBehavior();
  bindWhatsappTip();
  bindFloatVisibility();
  bindImageFallbacks();
  updateBadges();
  addEventListener('store:changed', updateBadges);
  addEventListener('storage', updateBadges);
  addEventListener('cart:added', () => document.querySelectorAll('[data-cart-link] .icon').forEach(element => {
    element.classList.remove('is-bumping');
    void element.getBoundingClientRect();
    element.classList.add('is-bumping');
  }));
  renderCategoryNav();
  return site.raw;
}

function updateBadges() {
  const count = cartCount();
  document.querySelectorAll('.cart-badge').forEach(element => { element.textContent = count > 99 ? '99+' : count; element.hidden = !count; });
  document.querySelectorAll('[data-cart-link]').forEach(link => link.setAttribute('aria-label', count ? `Carrito, ${count} producto${count === 1 ? '' : 's'}` : 'Carrito'));
  const favorites = getFavorites();
  document.querySelectorAll('.favorite-badge').forEach(element => { element.textContent = favorites.length; element.hidden = !favorites.length; });
  document.querySelectorAll('[data-favorite]').forEach(button => {
    const active = favorites.includes(button.dataset.favorite);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function bindImageFallbacks() {
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || image.dataset.fallbackApplied || image.classList.contains('brand-logo')) return;
    image.dataset.fallbackApplied = 'true';
    if (image.matches('[data-team-crest-image], [data-brand-logo]')) {
      const holder = image.closest('[data-initials]');
      if (holder) { holder.textContent = holder.dataset.initials || '•'; holder.classList.add('is-fallback'); }
      return;
    }
    image.src = localAsset('assets/images/product-white.svg');
    image.classList.add('image-fallback');
  }, true);
}
