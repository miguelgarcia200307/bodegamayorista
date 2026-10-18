// Barra lateral del panel: buscador de secciones, grupos plegables, modo compacto (solo
// escritorio), tarjeta de sesión e indicadores. La navegación y el cajón móvil viven en admin.js.
import { $, $$, normalizeText } from '../lib/helpers.js';

const RAIL_KEY = 'bm-admin-rail';
const GROUPS_KEY = 'bm-admin-nav-collapsed';
const ROLE_LABELS = { propietario: 'Propietario', vendedor: 'Ventas', catalogo: 'Catálogo' };
const desktop = matchMedia('(min-width: 900px)');
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* sin almacenamiento: solo esta visita */ } }
};

let shell; let sidebar; let nav; let search; let tip;
let railPeek = false;

const isRail = () => desktop.matches && shell.classList.contains('is-rail');
const navItems = () => $$('[data-section]', nav);
const isShown = element => element.checkVisibility?.({ visibilityProperty: true }) ?? element.offsetParent !== null;
const visibleItems = () => navItems().filter(button => !button.hidden && !button.classList.contains('is-filtered') && isShown(button));

export function setupAdminNav({ openDrawer }) {
  shell = $('#admin-shell'); sidebar = $('#admin-sidebar'); nav = $('#admin-nav'); search = $('#admin-nav-search');
  navItems().forEach(button => { button.dataset.tip = $('.admin-nav__text', button)?.textContent.trim() || ''; });
  setupGroups(); setupRail(); setupSearch(openDrawer); setupKeyboard(); setupTooltip(); setupScrollFade();
}

// Oculta los grupos que quedaron vacíos tras aplicar los permisos del rol.
export function syncNavGroups() {
  $$('.admin-nav__group', nav).forEach(group => { group.hidden = !$('[data-section]:not([hidden])', group); });
}

export function setNavUser({ email = '', role = 'propietario' }) {
  const name = email.split('@')[0] || 'Administrador';
  const initials = (name.match(/[a-z0-9]/gi) || ['A']).slice(0, 2).join('').toUpperCase();
  $('#admin-user-avatar').textContent = initials;
  $('#admin-user-email').textContent = email || 'Sesión activa';
  $('#admin-user-email').title = email;
  $('#admin-user-role').textContent = ROLE_LABELS[role] || 'Administrador';
  $('.admin-user').dataset.tip = email || 'Sesión activa';
}

export function setNavBadge(section, count, label = '') {
  const badge = $(`[data-nav-badge="${section}"]`, nav); if (!badge) return;
  badge.hidden = !count; badge.textContent = count > 99 ? '99+' : String(count || '');
  badge.title = label; badge.setAttribute('aria-label', label);
}

export function setCurrentNavSection(section) {
  const current = section === 'customer' ? 'customers' : section;
  navItems().forEach(button => { const active = button.dataset.section === current; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  const button = $(`[data-section="${current}"]`, nav);
  const label = $('#admin-current-section'); if (label && button) label.textContent = button.dataset.tip;
  // Si el grupo de la sección activa estaba plegado, se despliega para no perderla de vista.
  const group = button?.closest('.admin-nav__group');
  if (group?.classList.contains('is-collapsed')) toggleGroup(group, true);
  if (button && !isRail()) requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest' }));
}

function collapsedGroups() { try { return new Set(JSON.parse(storage.get(GROUPS_KEY) || '[]')); } catch { return new Set(); } }

function toggleGroup(group, open) {
  group.classList.toggle('is-collapsed', !open);
  $('.admin-nav__label', group).setAttribute('aria-expanded', String(open));
  const saved = collapsedGroups(); open ? saved.delete(group.dataset.navGroup) : saved.add(group.dataset.navGroup);
  storage.set(GROUPS_KEY, JSON.stringify([...saved]));
}

function setupGroups() {
  const saved = collapsedGroups();
  $$('.admin-nav__group', nav).forEach(group => { if (saved.has(group.dataset.navGroup)) { group.classList.add('is-collapsed'); $('.admin-nav__label', group).setAttribute('aria-expanded', 'false'); } });
  nav.addEventListener('click', event => {
    const label = event.target.closest('.admin-nav__label'); if (!label || isRail()) return;
    const group = label.closest('.admin-nav__group'); toggleGroup(group, group.classList.contains('is-collapsed'));
  });
}

function applyRail(rail, persist = true) {
  shell.classList.toggle('is-rail', rail);
  const toggle = $('#admin-rail-toggle');
  toggle.setAttribute('aria-pressed', String(rail)); toggle.setAttribute('aria-label', rail ? 'Expandir menú' : 'Contraer menú');
  hideTip();
  if (persist) storage.set(RAIL_KEY, rail ? '1' : '0');
}

function setupRail() {
  applyRail(storage.get(RAIL_KEY) === '1', false);
  requestAnimationFrame(() => shell.classList.add('nav-ready'));
  $('#admin-rail-toggle').addEventListener('click', () => { railPeek = false; applyRail(!shell.classList.contains('is-rail')); });
}

function filterNav(value) {
  const query = normalizeText(value);
  nav.classList.toggle('is-searching', Boolean(query));
  navItems().forEach(button => {
    const text = normalizeText(`${button.dataset.tip} ${button.dataset.keywords || ''}`);
    button.classList.toggle('is-filtered', Boolean(query) && !query.split(' ').every(word => text.includes(word)));
  });
  $$('.admin-nav__group', nav).forEach(group => group.classList.toggle('is-filtered', Boolean(query) && !$('[data-section]:not([hidden]):not(.is-filtered)', group)));
  $('#admin-nav-empty').hidden = !query || navItems().some(button => !button.hidden && !button.classList.contains('is-filtered'));
  updateScrollFade();
}

function clearSearch() { if (!search.value) return; search.value = ''; filterNav(''); }

function setupSearch(openDrawer) {
  search.addEventListener('input', () => filterNav(search.value));
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); const first = visibleItems()[0]; if (first) { first.click(); clearSearch(); search.blur(); } }
    else if (event.key === 'ArrowDown') { event.preventDefault(); visibleItems()[0]?.focus(); }
    else if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); clearSearch(); }
  });
  // En modo compacto, enfocar el buscador despliega el menú temporalmente.
  search.addEventListener('focus', () => { if (isRail()) { railPeek = true; applyRail(false, false); } });
  sidebar.addEventListener('focusout', () => setTimeout(() => {
    if (!railPeek || sidebar.contains(document.activeElement)) return;
    railPeek = false; clearSearch(); applyRail(true, false);
  }));
  nav.addEventListener('click', event => { if (!event.target.closest('[data-section]')) return; clearSearch(); if (railPeek) { railPeek = false; applyRail(true, false); } });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    if (!desktop.matches && !sidebar.classList.contains('open')) openDrawer();
    requestAnimationFrame(() => { search.focus(); search.select(); });
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $('.admin-nav-search kbd').textContent = '⌘ K';
}

// Flechas arriba/abajo, Inicio y Fin recorren las secciones visibles.
function setupKeyboard() {
  nav.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = visibleItems(); const index = items.indexOf(document.activeElement); if (!items.length) return;
    event.preventDefault();
    if (event.key === 'Home') items[0].focus();
    else if (event.key === 'End') items.at(-1).focus();
    else if (event.key === 'ArrowUp' && index <= 0) isRail() ? items.at(-1).focus() : search.focus();
    else items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });
}

function hideTip() { if (tip) tip.classList.remove('is-visible'); }

function setupTooltip() {
  tip = document.createElement('div'); tip.className = 'admin-nav-tip'; tip.setAttribute('aria-hidden', 'true'); document.body.append(tip);
  const show = target => {
    const element = target?.closest?.('[data-tip]');
    // Fuera del modo compacto solo se explica el botón de cerrar sesión cuando queda como icono.
    const iconOnly = desktop.matches && element?.matches('.admin-user__logout') && !isShown($('span', element));
    if (!element || !sidebar.contains(element) || !element.dataset.tip || !(isRail() || iconOnly)) { hideTip(); return; }
    const rect = element.getBoundingClientRect();
    const badge = $('.admin-nav__badge:not([hidden])', element);
    tip.textContent = element.dataset.tip + (badge ? ` · ${badge.title || badge.textContent}` : '');
    tip.style.top = `${rect.top + rect.height / 2}px`; tip.style.left = `${rect.right + 12}px`;
    tip.classList.add('is-visible');
  };
  sidebar.addEventListener('pointerover', event => show(event.target));
  sidebar.addEventListener('pointerleave', hideTip);
  sidebar.addEventListener('focusin', event => { if (event.target.matches(':focus-visible')) show(event.target); });
  sidebar.addEventListener('focusout', hideTip);
  nav.addEventListener('scroll', hideTip, { passive: true });
}

// Difumina los bordes de la lista cuando hay más secciones por encima o por debajo.
function updateScrollFade() {
  if (!nav) return;
  nav.classList.toggle('fade-top', nav.scrollTop > 4);
  nav.classList.toggle('fade-bottom', nav.scrollTop + nav.clientHeight < nav.scrollHeight - 4);
}

function setupScrollFade() {
  nav.addEventListener('scroll', updateScrollFade, { passive: true });
  if ('ResizeObserver' in window) new ResizeObserver(updateScrollFade).observe(nav);
  desktop.addEventListener('change', () => { hideTip(); updateScrollFade(); });
  nav.addEventListener('transitionend', updateScrollFade);
  updateScrollFade();
}
