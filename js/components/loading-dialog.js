// Ventana de carga para acciones que consultan datos antes de abrir un formulario.
// Solo aparece si la espera supera SHOW_DELAY (los datos en caché no la muestran) y, una
// vez visible, se mantiene MIN_VISIBLE para no parpadear. Si la consulta falla, la misma
// ventana ofrece Reintentar o Cerrar. Devuelve el resultado de `task`, o null si el usuario
// cierra/cancela o si ya hay otra carga en curso (evita abrir el formulario dos veces).
import { icon } from './icons.js';
import { escapeHtml } from '../lib/helpers.js';

const SHOW_DELAY = 160;
const MIN_VISIBLE = 450;
const STEP_EVERY = 1500;
const SLOW_AFTER = 8000;

let busy = false;
const CANCELLED = Symbol('cancelled');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function withLoading(task, { title = 'Cargando…', steps = [], trigger = null, errorTitle = 'No pudimos cargar la información' } = {}) {
  if (busy) return null;
  busy = true;
  const origin = trigger instanceof HTMLElement ? trigger : document.activeElement;
  origin?.setAttribute?.('aria-busy', 'true');
  let root = null; let shownAt = 0; let stepTimer = 0; let slowTimer = 0;
  let cancel = () => {};
  let onEscape = () => {};
  // Mientras la ventana está visible, el teclado no llega a lo que hay detrás (Tab queda dentro y Escape no cierra el modal de abajo).
  const onKey = event => {
    if (!root) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape(); return; }
    if (event.key !== 'Tab') return;
    const card = root.querySelector('.loading-dialog__card');
    const focusable = [...card.querySelectorAll('button')].filter(button => button.offsetParent !== null);
    event.preventDefault(); event.stopPropagation();
    if (!focusable.length) { card.focus(); return; }
    const index = focusable.indexOf(document.activeElement);
    focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length].focus();
  };
  const cancelled = new Promise(resolve => { cancel = () => resolve(CANCELLED); });

  const show = () => {
    root = document.createElement('div');
    root.className = 'loading-dialog';
    root.innerHTML = `<div class="loading-dialog__card" role="status" aria-live="polite" aria-busy="true" tabindex="-1">
      <span class="loading-dialog__orbit" aria-hidden="true"><span class="loading-dialog__ring"></span><span class="loading-dialog__mark">BM</span></span>
      <strong class="loading-dialog__title">${escapeHtml(title)}</strong>
      <p class="loading-dialog__step" data-step>${escapeHtml(steps[0] || 'Un momento, por favor…')}</p>
      <span class="loading-dialog__bar" aria-hidden="true"><span></span></span>
      ${steps.length > 1 ? `<span class="loading-dialog__dots" aria-hidden="true">${steps.map((_, index) => `<i class="${index ? '' : 'is-active'}"></i>`).join('')}</span>` : ''}
      <div class="loading-dialog__slow" data-slow hidden><small>Está tardando más de lo normal. Revisa tu conexión; seguimos intentando.</small><button class="btn btn--ghost" data-cancel type="button">Cancelar</button></div>
    </div>`;
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    onEscape = () => { if (!root.querySelector('[data-slow]').hidden) cancel(); };
    shownAt = performance.now();
    root.querySelector('.loading-dialog__card').focus({ preventScroll: true });
    root.querySelector('[data-cancel]').addEventListener('click', () => cancel());
    let index = 0;
    if (steps.length > 1) stepTimer = setInterval(() => {
      index = Math.min(index + 1, steps.length - 1);
      root.querySelector('[data-step]').textContent = steps[index];
      root.querySelectorAll('.loading-dialog__dots i').forEach((dot, dotIndex) => dot.classList.toggle('is-active', dotIndex <= index));
      if (index === steps.length - 1) clearInterval(stepTimer);
    }, STEP_EVERY);
    slowTimer = setTimeout(() => { root.querySelector('[data-slow]').hidden = false; }, SLOW_AFTER);
  };

  const hide = async () => {
    clearInterval(stepTimer); clearTimeout(slowTimer);
    if (!root) return;
    const remaining = MIN_VISIBLE - (performance.now() - shownAt);
    if (remaining > 0) await wait(remaining);
    document.removeEventListener('keydown', onKey, true);
    root.classList.add('is-closing');
    const element = root; root = null;
    await wait(matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
    element.remove();
  };

  // En error, la ventana pasa a estado de error y espera la decisión del usuario.
  const askRetry = error => new Promise(resolve => {
    console.error(error);
    if (!root) show();
    clearInterval(stepTimer); clearTimeout(slowTimer);
    const card = root.querySelector('.loading-dialog__card');
    card.classList.add('is-error'); card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-busy', 'false');
    card.innerHTML = `<span class="loading-dialog__error-icon" aria-hidden="true">${icon('alert', { size: 26 })}</span><strong class="loading-dialog__title">${escapeHtml(errorTitle)}</strong><p class="loading-dialog__step">Revisa tu conexión a internet e intenta de nuevo. No se perdió ningún dato.</p><div class="loading-dialog__actions"><button class="btn btn--ghost" data-close type="button">Cerrar</button><button class="btn btn--primary" data-retry type="button">Reintentar</button></div>`;
    const finish = value => resolve(value);
    onEscape = () => finish(false);
    card.querySelector('[data-close]').addEventListener('click', () => finish(false));
    card.querySelector('[data-retry]').addEventListener('click', () => finish(true));
    card.querySelector('[data-retry]').focus();
  });

  const showTimer = setTimeout(show, SHOW_DELAY);
  try {
    for (;;) {
      try {
        const result = await Promise.race([Promise.resolve().then(task), cancelled]);
        clearTimeout(showTimer); await hide();
        return result === CANCELLED ? null : result;
      } catch (error) {
        clearTimeout(showTimer);
        if (!(await askRetry(error))) { await hide(); return null; }
        document.removeEventListener('keydown', onKey, true); root.remove(); root = null; show();
      }
    }
  } finally {
    busy = false;
    origin?.removeAttribute?.('aria-busy');
    // Si la ventana tenía el foco, se devuelve al botón que la abrió (el formulario siguiente lo tomará después).
    if (origin instanceof HTMLElement && origin.isConnected && (!document.activeElement || document.activeElement === document.body)) origin.focus({ preventScroll: true });
  }
}
