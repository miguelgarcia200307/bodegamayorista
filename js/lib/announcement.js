export const ANNOUNCEMENT_TEXT_LIMIT = 160;
export const ANNOUNCEMENT_INTERVAL_MIN = 2;
export const ANNOUNCEMENT_INTERVAL_MAX = 120;
export const DEFAULT_ANNOUNCEMENT_TEXT = 'Atención personalizada • Tecnología, calidad y confianza';

export const DEFAULT_ANNOUNCEMENT_MESSAGES = Object.freeze([
  Object.freeze({ id: 'whatsapp', text: 'Compra por WhatsApp', enabled: true, position: 1 }),
  Object.freeze({ id: 'personalized-service', text: 'Atención personalizada', enabled: true, position: 2 }),
  Object.freeze({ id: 'brand-promise', text: 'Tecnología, calidad y confianza', enabled: true, position: 3 })
]);

function createMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `announcement-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeAnnouncementMessage(message = {}, index = 0) {
  return {
    id: String(message.id || createMessageId()),
    text: String(message.text || '').trim().slice(0, ANNOUNCEMENT_TEXT_LIMIT),
    enabled: message.enabled !== false,
    position: index + 1
  };
}

export function normalizeAnnouncementSettings(settings = {}) {
  const rawMessages = Array.isArray(settings.announcement_messages)
    ? settings.announcement_messages
    : DEFAULT_ANNOUNCEMENT_MESSAGES;
  const messages = rawMessages
    .map((message, index) => ({ ...message, _index: index }))
    .sort((a, b) => (Number(a.position) || a._index + 1) - (Number(b.position) || b._index + 1))
    .map(normalizeAnnouncementMessage);
  const interval = Number(settings.announcement_interval_seconds);

  return {
    enabled: settings.announcement_enabled !== false,
    mode: settings.announcement_mode === 'carousel' ? 'carousel' : 'static',
    staticText: String(settings.announcement_static_text ?? DEFAULT_ANNOUNCEMENT_TEXT).trim().slice(0, ANNOUNCEMENT_TEXT_LIMIT),
    intervalSeconds: Number.isInteger(interval) && interval >= ANNOUNCEMENT_INTERVAL_MIN && interval <= ANNOUNCEMENT_INTERVAL_MAX ? interval : 5,
    messages
  };
}

export function announcementValues(config = {}) {
  const normalized = normalizeAnnouncementSettings({
    announcement_enabled: config.enabled,
    announcement_mode: config.mode,
    announcement_static_text: config.staticText,
    announcement_interval_seconds: config.intervalSeconds,
    announcement_messages: config.messages
  });
  return {
    announcement_enabled: normalized.enabled,
    announcement_mode: normalized.mode,
    announcement_static_text: normalized.staticText,
    announcement_interval_seconds: normalized.intervalSeconds,
    announcement_messages: normalized.messages.map((message, index) => ({ ...message, position: index + 1 }))
  };
}

export function validateAnnouncement(config = {}) {
  const normalized = normalizeAnnouncementSettings({
    announcement_enabled: config.enabled,
    announcement_mode: config.mode,
    announcement_static_text: config.staticText,
    announcement_interval_seconds: config.intervalSeconds,
    announcement_messages: config.messages
  });
  const messages = Array.isArray(config.messages) ? config.messages : normalized.messages;
  const rawInterval = Number(config.intervalSeconds);

  if (!Number.isInteger(rawInterval) || rawInterval < ANNOUNCEMENT_INTERVAL_MIN || rawInterval > ANNOUNCEMENT_INTERVAL_MAX) {
    return { valid: false, field: 'interval', message: `El tiempo debe ser un número entero entre ${ANNOUNCEMENT_INTERVAL_MIN} y ${ANNOUNCEMENT_INTERVAL_MAX} segundos.` };
  }
  if (messages.some(message => !String(message.text || '').trim())) {
    return { valid: false, field: 'message', message: 'Todos los mensajes deben contener texto.' };
  }
  if (messages.some(message => String(message.text || '').trim().length > ANNOUNCEMENT_TEXT_LIMIT)) {
    return { valid: false, field: 'message', message: `Cada mensaje puede tener máximo ${ANNOUNCEMENT_TEXT_LIMIT} caracteres.` };
  }
  if (normalized.enabled && normalized.mode === 'static' && !String(config.staticText || '').trim()) {
    return { valid: false, field: 'static', message: 'Escribe el texto que se mostrará en la barra.' };
  }
  if (String(config.staticText || '').trim().length > ANNOUNCEMENT_TEXT_LIMIT) {
    return { valid: false, field: 'static', message: `El texto puede tener máximo ${ANNOUNCEMENT_TEXT_LIMIT} caracteres.` };
  }
  if (normalized.enabled && normalized.mode === 'carousel' && !messages.some(message => message.enabled && String(message.text || '').trim())) {
    return { valid: false, field: 'message', message: 'Activa por lo menos un mensaje para usar el carrusel.' };
  }
  return { valid: true };
}

function paintMessage(root, text) {
  const parts = String(text || '').split(/\s*•\s*/).filter(Boolean);
  root.replaceChildren();
  (parts.length ? parts : ['']).forEach((part, index) => {
    if (index) {
      const separator = document.createElement('i');
      separator.setAttribute('aria-hidden', 'true');
      root.append(separator);
    }
    const span = document.createElement('span');
    span.textContent = part;
    root.append(span);
  });
}

export function createAnnouncementController(root, settings = {}) {
  const config = normalizeAnnouncementSettings(settings);
  let intervalId = 0;
  let transitionId = 0;
  let index = 0;
  const activeMessages = config.messages.filter(message => message.enabled && message.text);
  const texts = config.mode === 'carousel' ? activeMessages.map(message => message.text) : [config.staticText];
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const stop = () => {
    if (intervalId) clearInterval(intervalId);
    if (transitionId) clearTimeout(transitionId);
    intervalId = 0;
    transitionId = 0;
  };

  if (!root) return { stop, hasTimer: false };
  root.hidden = !config.enabled || !texts.length;
  root.setAttribute('aria-live', texts.length > 1 ? 'polite' : 'off');
  root.setAttribute('aria-atomic', 'true');
  if (root.hidden) {
    root.replaceChildren();
    return { stop, hasTimer: false };
  }

  paintMessage(root, texts[0]);
  if (texts.length > 1) {
    intervalId = setInterval(() => {
      const showNext = () => {
        index = (index + 1) % texts.length;
        paintMessage(root, texts[index]);
        root.classList.remove('is-changing');
      };
      if (reducedMotion) showNext();
      else {
        root.classList.add('is-changing');
        transitionId = setTimeout(showNext, 160);
      }
    }, config.intervalSeconds * 1000);
  }

  return { stop, hasTimer: Boolean(intervalId) };
}
