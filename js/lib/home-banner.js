export const BANNER_MIN = 0.5;
export const BANNER_MAX = 60;
export const BANNER_LIMIT = 5;

export function validBannerInterval(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= BANNER_MIN && number <= BANNER_MAX
    && Math.abs(number * 10 - Math.round(number * 10)) < 1e-8;
}

export function safeBannerLink(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(input)) {
    try {
      const url = new URL(input);
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  }
  if (/^[\w./?=&%#-]+$/.test(input)) return input;
  return '';
}

export function createHomeBanner(root, data, { preview = false, onEmpty = () => {} } = {}) {
  let timer;
  let transitionTimer;
  let index = 0;
  let transitioning = false;
  let hovering = false;
  let focusing = false;
  let touching = false;
  let start = null;
  let destroyed = false;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const slides = (data?.banners || []).filter(item => item.active && item.desktop_image_url);
  const interval = validBannerInterval(data?.intervalSeconds) ? Number(data.intervalSeconds) : 5;
  root.replaceChildren();
  if (!data?.enabled || !slides.length) return { stop() { root.replaceChildren(); } };
  root.classList.add('home-banner');
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', preview ? 'Vista previa de promociones destacadas' : 'Promociones destacadas');
  const track = document.createElement('div');
  track.className = 'home-banner__track';
  const dots = document.createElement('div');
  dots.className = 'home-banner__dots';
  const status = document.createElement('span');
  status.className = 'sr-only';
  status.setAttribute('aria-live', 'polite');
  const listeners = [];
  const listen = (element, type, callback, options) => {
    element.addEventListener(type, callback, options);
    listeners.push(() => element.removeEventListener(type, callback, options));
  };
  const elements = slides.map((item, slideIndex) => {
    const slide = document.createElement('div');
    slide.className = 'home-banner__slide';
    const link = safeBannerLink(item.link_url);
    const content = link && !preview ? document.createElement('a') : document.createElement('div');
    content.className = 'home-banner__image';
    if (link && !preview) {
      content.href = link;
      if (/^https?:\/\//.test(link) && new URL(link).origin !== location.origin) {
        content.target = '_blank';
        content.rel = 'noopener noreferrer';
      }
    }
    const picture = document.createElement('picture');
    if (item.mobile_image_url) {
      const source = document.createElement('source');
      source.media = '(max-width: 767px)';
      source.dataset.srcset = item.mobile_image_url;
      picture.append(source);
    }
    const img = document.createElement('img');
    img.alt = item.alt_text || 'Promoción destacada';
    img.width = 1920;
    img.height = 640;
    img.decoding = 'async';
    img.loading = slideIndex === 0 ? 'eager' : 'lazy';
    if (slideIndex === 0 && !preview) img.setAttribute('fetchpriority', 'high');
    img.dataset.src = item.desktop_image_url;
    listen(img, 'error', () => {
      console.warn('No se pudo cargar una imagen del banner', item.id || slideIndex);
      slide.remove();
      const dot = dots.querySelector(`[data-index="${slideIndex}"]`);
      dot?.remove();
      const remaining = [...track.children];
      if (!remaining.length) { root.replaceChildren(); clearTimeout(timer); onEmpty(); return; }
      if (slideIndex === index) {
        transitioning = false;
        index = -1;
        const next = elements.findIndex(entry => entry.slide.isConnected);
        show(next, false);
      } else {
        track.style.transform = `translateX(-${elements.slice(0, index).filter(entry => entry.slide.isConnected).length * 100}%)`;
      }
      if (remaining.length === 1) { root.querySelectorAll('.home-banner__arrow,.home-banner__dots').forEach(node => node.remove()); clearTimeout(timer); }
    });
    picture.append(img);
    content.append(picture);
    slide.append(content);
    track.append(slide);
    return { slide, img, source: picture.querySelector('source') };
  });
  function activate(position) {
    const entry = elements[position];
    if (!entry || !entry.slide.isConnected) return;
    if (entry.source && !entry.source.srcset) entry.source.srcset = entry.source.dataset.srcset;
    if (!entry.img.src) entry.img.src = entry.img.dataset.src;
  }
  function schedule() {
    clearTimeout(timer);
    if (destroyed || track.children.length < 2 || reduceMotion.matches || hovering || focusing || touching || document.hidden || transitioning) return;
    timer = setTimeout(() => go(1, false), interval * 1000);
  }
  function show(next, manual) {
    if (destroyed || transitioning || next === index || !elements[next]?.slide.isConnected) return;
    transitioning = true;
    activate(next);
    const previous = index;
    index = next;
    track.style.transform = `translateX(-${elements.slice(0, index).filter(entry => entry.slide.isConnected).length * 100}%)`;
    dots.querySelectorAll('button').forEach(dot => {
      if (Number(dot.dataset.index) === index) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    if (manual) status.textContent = `Banner ${index + 1} de ${slides.length}`;
    clearTimeout(timer);
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => { transitioning = false; activate((index + 1) % slides.length); schedule(); }, reduceMotion.matches ? 0 : 460);
  }
  function go(direction, manual = true) {
    if (transitioning) return;
    let next = index;
    for (let attempts = 0; attempts < slides.length; attempts += 1) {
      next = (next + direction + slides.length) % slides.length;
      if (elements[next]?.slide.isConnected) { show(next, manual); return; }
    }
  }
  root.append(track);
  if (slides.length > 1) {
    for (const [direction, label, glyph] of [[-1, 'Banner anterior', '‹'], [1, 'Banner siguiente', '›']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `home-banner__arrow home-banner__arrow--${direction < 0 ? 'prev' : 'next'}`;
      button.setAttribute('aria-label', label);
      button.textContent = glyph;
      listen(button, 'click', () => go(direction));
      root.append(button);
    }
    slides.forEach((_, dotIndex) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.dataset.index = String(dotIndex);
      dot.setAttribute('aria-label', `Ir al banner ${dotIndex + 1}`);
      if (dotIndex === 0) dot.setAttribute('aria-current', 'true');
      listen(dot, 'click', () => { if (!transitioning) show(dotIndex, true); });
      dots.append(dot);
    });
    root.append(dots, status);
    listen(root, 'mouseenter', () => { hovering = true; clearTimeout(timer); });
    listen(root, 'mouseleave', () => { hovering = false; schedule(); });
    listen(root, 'focusin', () => { focusing = true; clearTimeout(timer); });
    listen(root, 'focusout', event => { if (!root.contains(event.relatedTarget)) { focusing = false; schedule(); } });
    listen(root, 'keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); go(event.key === 'ArrowLeft' ? -1 : 1); }
    });
    listen(root, 'touchstart', event => { touching = true; clearTimeout(timer); start = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }, { passive: true });
    listen(root, 'touchend', event => {
      if (start) {
        const dx = event.changedTouches[0].clientX - start.x;
        const dy = event.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) go(dx < 0 ? 1 : -1);
      }
      start = null; touching = false; schedule();
    }, { passive: true });
    listen(document, 'visibilitychange', schedule);
    listen(reduceMotion, 'change', schedule);
  }
  activate(0);
  if (slides.length > 1) {
    track.style.transform = 'translateX(0)';
    setTimeout(() => activate(1), 250);
    schedule();
  }
  return { stop() {
    destroyed = true;
    clearTimeout(timer);
    clearTimeout(transitionTimer);
    listeners.forEach(remove => remove());
    root.replaceChildren();
    root.classList.remove('home-banner');
    root.removeAttribute('role');
    root.removeAttribute('aria-label');
  } };
}
