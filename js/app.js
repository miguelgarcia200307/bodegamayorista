import { renderLayout } from './components/layout.js';
import { getBackendStatus } from './lib/backend-status.js';

const page = document.body.dataset.page;

function applyBrandAssets() {
  const prefix = location.pathname.includes('/admin/') ? '../' : '';
  const iconUrl = `${prefix}assets/images/favicon.svg`;
  const icons = [...document.querySelectorAll('link[rel~="icon"]')];
  if (icons.length) icons.forEach(icon => { icon.href = iconUrl; icon.type = 'image/svg+xml'; icon.removeAttribute('sizes'); });
  else document.head.insertAdjacentHTML('beforeend', `<link rel="icon" type="image/svg+xml" href="${iconUrl}">`);
  let touchIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (!touchIcon) { touchIcon = document.createElement('link'); touchIcon.rel = 'apple-touch-icon'; document.head.append(touchIcon); }
  touchIcon.href = iconUrl;
}

applyBrandAssets();

function renderBackendUnavailable(status) {
  document.documentElement.dataset.backendStatus = status.reason || 'unavailable';
  const isAdmin = page.startsWith('admin');
  const title = status.reason === 'schema' ? 'Base de datos pendiente de instalación' : 'Servicio temporalmente no disponible';
  const text = status.reason === 'schema'
    ? 'El proyecto de Supabase está conectado, pero todavía no tiene instalado el esquema de Bodega Mayorista F.C.'
    : status.reason === 'configuration'
      ? 'La configuración de acceso a Supabase no es válida. Revisa la URL y la clave publicable.'
      : 'No fue posible comunicarse con la base de datos. Revisa la conexión e intenta nuevamente.';
  const markup = `<div class="empty-state backend-status" role="status">
    <span class="empty-state__icon" aria-hidden="true">!</span>
    <h1>${title}</h1><p>${text}</p>
    <button id="retry-backend" class="btn btn--primary" type="button">Intentar de nuevo</button>
  </div>`;

  if (isAdmin) {
    const target = document.querySelector('#admin-content') || document.querySelector('main');
    if (target) target.innerHTML = markup;
  } else {
    document.querySelector('#site-header')?.replaceChildren();
    document.querySelector('#site-footer')?.replaceChildren();
    const main = document.querySelector('main');
    if (main) main.innerHTML = `<div class="container page">${markup}</div>`;
  }
  document.querySelector('#retry-backend')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Comprobando…';
    const nextStatus = await getBackendStatus({ refresh: true });
    if (nextStatus.ready) location.reload();
    else renderBackendUnavailable(nextStatus);
  });
}

async function start() {
  try {
    const backendStatus = await getBackendStatus();
    if (!backendStatus.ready) {
      renderBackendUnavailable(backendStatus);
      return;
    }
    if (!page.startsWith('admin')) await renderLayout();
    const routes = {
      home: () => import('./pages/public.js').then(module => module.initHome()),
      catalog: () => import('./pages/listing.js').then(module => module.initListingPage('catalog')),
      listing: () => import('./pages/listing.js').then(module => module.initListingPage(document.body.dataset.listingType === 'category' ? 'category' : 'brand')),
      promotions: () => import('./pages/listing.js').then(module => module.initListingPage('promotions')),
      help: () => import('./pages/help.js').then(module => module.initHelp()),
      categories: () => import('./pages/categories.js').then(module => module.initCategories()),
      product: () => import('./pages/product.js').then(module => module.initProduct()),
      favorites: () => import('./pages/public.js').then(module => module.initFavorites()),
      cart: () => import('./pages/cart.js').then(module => module.initCart()),
      checkout: () => import('./pages/checkout.js').then(module => module.initCheckout()),
      'admin-login': () => import('./pages/auth.js').then(module => module.initLogin()),
      'admin-reset': () => import('./pages/auth.js').then(module => module.initReset()),
      admin: () => import('./pages/admin.js').then(module => module.initAdmin())
    };
    await routes[page]?.();
  } catch (error) {
    console.error(error);
    const main = document.querySelector('main');
    if (main && !page.startsWith('admin')) {
      main.innerHTML = `<div class="container page"><div class="empty-state"><span class="empty-state__icon">!</span><h1>No pudimos cargar esta página</h1><p>Revisa tu conexión e intenta nuevamente.</p><button id="retry-page" class="btn btn--primary" type="button">Intentar de nuevo</button></div></div>`;
      document.querySelector('#retry-page').addEventListener('click', () => location.reload());
    }
  }
}

start();
