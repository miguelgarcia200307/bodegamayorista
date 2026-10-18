// Ayuda y privacidad. Todo sale de la configuración real del panel (site_settings,
// métodos de pago/entrega y site-config). Si falta un texto se dice que está pendiente:
// esta página no inventa textos legales ni condiciones.
import { getSiteData } from '../site-config.js';
import { $, $$, escapeHtml, localAsset, paymentInitials } from '../lib/helpers.js';
import { formatLegal, legalVersionLine } from '../lib/legal-format.js';
import { CONSENT_EVENT, getConsent, privacyConfig } from '../lib/privacy.js';
import { icon } from '../components/icons.js';
import { openPrivacyPreferences } from '../components/privacy-banner.js';

const LONG_DOCUMENT = 1800; // caracteres a partir de los cuales el documento se muestra plegado
const pending = what => `<p class="notice notice--info">${escapeHtml(what)} pendiente de configuración por la tienda.</p>`;

function sectionHead(slug, title, iconName, subtitle = '') {
  return `<header class="help-section__head"><span class="help-section__icon" aria-hidden="true">${icon(iconName, { size: 22 })}</span>
    <div><h2 id="${slug}-title">${escapeHtml(title)}</h2>${subtitle ? `<p class="help-section__sub">${escapeHtml(subtitle)}</p>` : ''}</div></header>`;
}

function cards(items = [], withLogo = false) {
  if (!items.length) return '';
  return `<ul class="help-cards">${items.map(item => `<li class="help-card">
    ${withLogo ? `<span class="help-card__logo" aria-hidden="true">${item.logo ? `<img src="${escapeHtml(localAsset(item.logo))}" alt="" loading="lazy">` : escapeHtml(paymentInitials(item.title))}</span>` : ''}
    <div class="help-card__body"><strong>${escapeHtml(item.title)}</strong>${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}</div></li>`).join('')}</ul>`;
}

// Documento legal largo: se muestra plegado con un botón para leerlo completo.
function legalDocument(slug, text) {
  const html = formatLegal(text, { dropVersion: true });
  if (text.length < LONG_DOCUMENT) return html;
  return `<div class="legal-doc is-collapsed" id="${slug}-doc" data-legal-doc>${html}</div>
    <button class="btn btn--secondary btn--sm legal-doc__toggle" type="button" aria-expanded="false" aria-controls="${slug}-doc" data-legal-toggle>${icon('chevronDown', { size: 18 })}<span>Leer documento completo</span></button>`;
}

function topicSection(topic) {
  const subtitle = topic.document ? (legalVersionLine(topic.text) || topic.subtitle) : topic.subtitle;
  let body = '';
  if (topic.faq) body = `<div class="help-faqs">${topic.faq.map(item => `<details class="help-faq"><summary>${escapeHtml(item.question)}${icon('chevronDown', { size: 18 })}</summary><div class="help-faq__answer">${formatLegal(item.answer, { dropTitle: false })}</div></details>`).join('')}</div>`;
  else if (topic.document) body = legalDocument(topic.slug, topic.text);
  else body = `${topic.text ? formatLegal(topic.text) : ''}${cards(topic.items, topic.slug === 'pagos')}`;
  return `<section id="${topic.slug}" class="help-section" aria-labelledby="${topic.slug}-title">${sectionHead(topic.slug, topic.title, topic.icon || 'info', subtitle)}${body}</section>`;
}

// Estado actual de las autorizaciones; se vuelve a pintar cuando cambia la decisión.
function consentState() {
  const cfg = privacyConfig();
  if (!cfg.enabled) return '<p>Esta tienda no registra tu navegación.</p>';
  const consent = getConsent();
  const choice = state => `<span class="help-status ${state ? 'is-on' : ''}">${!consent.decided ? 'Sin decidir' : state ? 'Autorizada' : 'No autorizada'}</span>`;
  return `<dl class="help-consent__state"><div><dt>Analítica</dt><dd>${choice(consent.analytics)}</dd></div><div><dt>Personalización</dt><dd>${choice(consent.personalization)}</dd></div></dl>`;
}

function privacySection(site) {
  const raw = site.raw || {};
  const cfg = privacyConfig();
  const controller = [raw.privacy_controller_name || site.businessName, raw.privacy_controller_id ? `Identificación: ${raw.privacy_controller_id}` : ''].filter(Boolean).join(' · ');
  const channel = raw.privacy_requests_channel || [site.email ? `Correo: ${site.email}` : '', site.whatsapp ? `WhatsApp: +${site.whatsapp.number.replace(/\D/g, '')}` : ''].filter(Boolean).join(' · ');
  const purposes = [
    ['Gestión de tu pedido', 'Usamos nombre, celular y datos de entrega para registrar y atender tu pedido. Es necesario para comprar.'],
    cfg.enabled ? ['Analítica de la tienda (opcional)', cfg.analyticsText] : ['Analítica de la tienda', 'Esta tienda no registra tu navegación.'],
    cfg.enabled ? ['Recomendaciones personalizadas (opcional)', cfg.personalizationText || 'Usar los productos que ves para sugerirte otros. Solo se vincula a tu ficha si verificas tu número.'] : null,
    ['Contacto promocional y cumpleaños (opcional)', raw.marketing_consent_text || 'Solo si lo autorizas en el pedido. Texto pendiente de configuración por la tienda.']
  ].filter(Boolean);
  const policyVersion = raw.data_policy_version ? `Versión ${raw.data_policy_version}` : '';
  return `<section id="privacidad" class="help-section" aria-labelledby="privacidad-title">
    ${sectionHead('privacidad', 'Privacidad y datos personales', 'shield', 'Tratamiento de datos personales conforme a la Ley 1581 de 2012.')}
    <dl class="help-facts"><div><dt>Responsable</dt><dd>${escapeHtml(controller || 'Pendiente de configuración')}</dd></div><div><dt>Solicitudes (consultar, corregir, suprimir o retirar autorizaciones)</dt><dd>${escapeHtml(channel || 'Pendiente de configuración')}</dd></div></dl>
    <h3 class="help-section__title">Para qué usamos tus datos</h3>
    ${cards(purposes.map(([title, text]) => ({ title, text })))}
    <p class="help-note">No vendemos tus datos ni deducimos información sensible. Rechazar la analítica o la personalización no impide comprar.</p>
    <div class="help-consent">
      <div class="help-consent__current" data-consent-state aria-live="polite">${consentState()}</div>
      <button class="btn btn--secondary btn--sm" type="button" data-open-privacy>${icon('sliders', { size: 18 })}<span>Cambiar mis preferencias</span></button>
    </div>
    <h3 class="help-section__title">Política de tratamiento de datos${policyVersion ? ` <span class="help-section__version">${escapeHtml(policyVersion)}</span>` : ''}</h3>
    ${site.dataPolicyText ? legalDocument('privacidad', site.dataPolicyText) : pending('El texto de la política de tratamiento de datos está')}
  </section>`;
}

function contactCard(site) {
  if (!site.whatsapp) return '';
  return `<div class="help-contact"><strong>¿No encuentras lo que buscas?</strong><p>Escríbenos y te respondemos por WhatsApp.</p>
    <a class="btn btn--primary btn--sm" href="${escapeHtml(site.whatsapp.url)}" target="_blank" rel="noopener">${icon('whatsapp', { size: 18 })}<span>Escribir por WhatsApp</span></a></div>`;
}

function expandDocument(button, open = true) {
  const doc = document.getElementById(button.getAttribute('aria-controls'));
  if (!doc) return;
  doc.classList.toggle('is-collapsed', !open);
  button.setAttribute('aria-expanded', String(open));
  button.querySelector('span').textContent = open ? 'Mostrar menos' : 'Leer documento completo';
}

// Resalta en el índice la sección que se está leyendo.
function watchSections(links) {
  if (!('IntersectionObserver' in window)) return;
  const byId = new Map(links.map(link => [link.hash.slice(1), link]));
  const visible = new Set();
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id));
    const current = [...byId.keys()].find(id => visible.has(id));
    if (!current) return;
    links.forEach(link => link.toggleAttribute('aria-current', link === byId.get(current)));
    const active = byId.get(current);
    const index = active.parentElement;
    if (index.scrollWidth > index.clientWidth) index.scrollTo({ left: active.offsetLeft - 16, behavior: 'smooth' });
  }, { rootMargin: '-30% 0px -60% 0px' });
  byId.forEach((_, id) => { const section = document.getElementById(id); if (section) observer.observe(section); });
}

export async function initHelp() {
  const site = await getSiteData();
  const topics = site.helpTopics.filter(topic => topic.slug !== 'privacidad');
  const index = [...topics.map(topic => ({ slug: topic.slug, title: topic.title, icon: topic.icon || 'info' })), { slug: 'privacidad', title: 'Privacidad', icon: 'shield' }];
  $('#help-index').innerHTML = `<p class="help-index__label">En esta página</p><div class="help-index__links">${index.map(item => `<a href="#${item.slug}">${icon(item.icon, { size: 18 })}<span>${escapeHtml(item.title)}</span></a>`).join('')}</div>${contactCard(site)}`;
  $('#help-content').innerHTML = `${topics.map(topicSection).join('')}
    ${topics.length ? '' : pending('La información de envíos, pagos y garantía está')}
    ${privacySection(site)}`;

  document.querySelector('[data-open-privacy]')?.addEventListener('click', event => openPrivacyPreferences(event.currentTarget));
  window.addEventListener(CONSENT_EVENT, () => {
    const state = document.querySelector('[data-consent-state]');
    if (!state) return;
    state.innerHTML = consentState();
    state.classList.remove('is-updated'); void state.offsetWidth; state.classList.add('is-updated');
  });
  $$('[data-legal-toggle]').forEach(button => button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    expandDocument(button, open);
    if (!open) button.closest('.help-section')?.scrollIntoView({ block: 'start' });
  }));
  watchSections($$('#help-index .help-index__links a'));

  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target) {
    const toggle = target.querySelector('[data-legal-toggle]');
    if (toggle) expandDocument(toggle);
    target.setAttribute('tabindex', '-1'); target.scrollIntoView(); target.focus({ preventScroll: true });
  }
}
