import { icon } from './icons.js';

let openModalCount = 0;

// beforeClose: función (puede ser async) que devuelve false para impedir el cierre
// manual, por ejemplo cuando hay cambios sin guardar. close(true) la omite.
export function openModal({ title, content, onClose, beforeClose = null, className = '', description = '', trigger = null, headerIcon = '', initialFocus = '', closeOnBackdrop = true, closeOnEscape = true } = {}) {
  const root = document.querySelector('#modal-root') || document.body;
  const previousFocus = trigger || document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  if (className.includes('modal--customizer')) backdrop.classList.add('modal-backdrop--customizer');
  if (className.includes('modal--lightbox')) backdrop.classList.add('modal-backdrop--lightbox');
  if (className.includes('modal--confirm')) backdrop.classList.add('modal-backdrop--confirm');
  if (className.includes('modal--cart-remove')) backdrop.classList.add('modal-backdrop--cart-remove');
  if (className.includes('modal--sheet')) backdrop.classList.add('modal-backdrop--sheet');
  const modalId = `modal-title-${crypto.randomUUID()}`;
  const descriptionId = `modal-description-${crypto.randomUUID()}`;
  backdrop.innerHTML = `<section class="modal ${className}" role="dialog" aria-modal="true" aria-labelledby="${modalId}" ${description ? `aria-describedby="${descriptionId}"` : ''}><header class="modal__head"><div class="modal__title">${headerIcon ? `<span class="modal__title-icon" aria-hidden="true">${headerIcon}</span>` : ''}<div><h2 id="${modalId}"></h2>${description ? `<p id="${descriptionId}" class="sr-only"></p>` : ''}</div></div><button class="modal__close" type="button" aria-label="Cerrar">${icon('x', { size: 20 })}</button></header><div class="modal__content"></div></section>`;
  backdrop.querySelector(`#${modalId}`).textContent = title || '';
  if (description) backdrop.querySelector(`#${descriptionId}`).textContent = description;
  const contentRoot = backdrop.querySelector('.modal__content');
  if (typeof content === 'string') contentRoot.innerHTML = content;
  else if (content) contentRoot.append(content);
  let keyHandler;
  let closed = false;
  let dismissible = true;
  let checking = false;
  const close = async (force = false) => {
    if (closed || checking || (!dismissible && !force)) return;
    if (!force && beforeClose) {
      checking = true;
      const allowed = await beforeClose();
      checking = false;
      if (!allowed || closed) return;
    }
    closed = true;
    document.removeEventListener('keydown', keyHandler);
    backdrop.classList.add('is-closing');
    const finalize = () => {
      backdrop.remove();
      openModalCount = Math.max(0, openModalCount - 1);
      if (!openModalCount) document.body.classList.remove('no-scroll');
      onClose?.();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) finalize();
    else setTimeout(finalize, 140);
  };
  backdrop.querySelector('.modal__close').addEventListener('click', () => close());
  if (closeOnBackdrop) backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  keyHandler = event => {
    const visibleModals = [...document.querySelectorAll('.modal-backdrop:not(.is-closing)')];
    if (visibleModals.at(-1) !== backdrop) return;
    if (event.key === 'Escape') { event.preventDefault(); if (closeOnEscape) close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...backdrop.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.hidden && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', keyHandler);
  root.append(backdrop);
  openModalCount += 1;
  document.body.classList.add('no-scroll');
  const firstFocus = initialFocus ? backdrop.querySelector(initialFocus) : null;
  (firstFocus || backdrop.querySelector('.modal__close')).focus();
  return {
    element: backdrop,
    contentRoot,
    close,
    setDismissible(value) {
      dismissible = Boolean(value);
      backdrop.querySelector('.modal__close').disabled = !dismissible;
    }
  };
}

export function confirmAction(message, title = 'Confirmar', { confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', trigger = null, tone = 'danger' } = {}) {
  return new Promise(resolve => {
    const wrapper = document.createElement('div');
    const isPrimary = tone === 'primary';
    wrapper.className = 'confirm-dialog';
    wrapper.dataset.tone = isPrimary ? 'primary' : 'danger';
    wrapper.innerHTML = `<div class="confirm-dialog__message"><span class="confirm-dialog__icon" aria-hidden="true">${isPrimary ? '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.2c0 4.6 3.2 8.1 7.5 9.8 4.3-1.7 7.5-5.2 7.5-9.8V6L12 3Z"></path><path d="m9.2 12 1.8 1.8 3.9-4"></path></svg>' : '<svg viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>'}</span><p></p></div><div class="confirm-dialog__actions"><button class="btn ${isPrimary ? 'btn--primary' : 'btn--danger'}" data-confirm type="button">Confirmar</button><button class="btn btn--ghost" data-cancel type="button">Cancelar</button></div>`;
    wrapper.querySelector('p').textContent = message;
    wrapper.querySelector('[data-confirm]').textContent = confirmLabel;
    wrapper.querySelector('[data-cancel]').textContent = cancelLabel;
    const modal = openModal({ title, content: wrapper, className: 'modal--confirm', initialFocus: '[data-cancel]', trigger, onClose: () => resolve(false) });
    wrapper.querySelector('[data-confirm]').addEventListener('click', () => { resolve(true); modal.close(); });
    wrapper.querySelector('[data-cancel]').addEventListener('click', () => { resolve(false); modal.close(); });
  });
}

export function chooseAction(message, title, actions, { trigger = null } = {}) {
  return new Promise(resolve => {
    const wrapper = document.createElement('div');
    wrapper.className = 'confirm-dialog';
    wrapper.innerHTML = '<div class="confirm-dialog__message"><span class="confirm-dialog__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 19h18.4L12 3Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg></span><p></p></div><div class="confirm-dialog__actions confirm-dialog__actions--stacked"></div>';
    wrapper.querySelector('p').textContent = message;
    const actionsRoot = wrapper.querySelector('.confirm-dialog__actions');
    let settled = false;
    const modal = openModal({ title, content: wrapper, className: 'modal--confirm', trigger, onClose: () => { if (!settled) resolve(null); } });
    actions.forEach(({ value, label, tone = 'ghost' }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn btn--${tone}`;
      button.textContent = label;
      button.addEventListener('click', () => { settled = true; resolve(value); modal.close(); });
      actionsRoot.append(button);
    });
  });
}

// Hoja inferior reutilizable (filtros, ordenar, variantes, guías). En móvil sube desde
// abajo; en escritorio se muestra como diálogo centrado. Usa el mismo foco y cierre que openModal.
export function openSheet({ className = '', ...options } = {}) {
  return openModal({ ...options, className: `modal--sheet ${className}`.trim() });
}
