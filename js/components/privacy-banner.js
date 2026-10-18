// Aviso de privacidad no bloqueante y panel de preferencias. Solo aparece si el
// propietario habilitó la analítica y configuró texto y versión. Rechazar es igual de
// fácil que aceptar y no impide comprar.
import { decideConsent, getConsent, needsDecision, privacyConfig, requestIdentityVerification } from '../lib/privacy.js';
import { escapeHtml, setButtonLoading } from '../lib/helpers.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

export function renderPrivacyBanner() {
  document.querySelector('[data-privacy-banner]')?.remove();
  if (!needsDecision()) return;
  const cfg = privacyConfig();
  const banner = document.createElement('section');
  banner.className = 'privacy-banner';
  banner.dataset.privacyBanner = '';
  banner.setAttribute('aria-labelledby', 'privacy-banner-title');
  banner.innerHTML = `<span class="privacy-banner__icon" aria-hidden="true">${icon('shield', { size: 22 })}</span>
    <div class="privacy-banner__body"><h2 class="privacy-banner__title" id="privacy-banner-title">Tu privacidad</h2>
      <p class="privacy-banner__text is-clamped" id="privacy-banner-text">${escapeHtml(cfg.analyticsText)}</p>
      <div class="privacy-banner__links"><button class="privacy-banner__more" type="button" aria-controls="privacy-banner-text" aria-expanded="false" data-privacy="more" hidden>Ver más</button><a href="ayuda.html#privacidad">Política de privacidad</a></div></div>
    <div class="privacy-banner__actions"><button class="btn btn--secondary btn--sm" data-privacy="reject" type="button">Rechazar</button><button class="btn btn--secondary btn--sm" data-privacy="custom" type="button">Personalizar</button><button class="btn btn--primary btn--sm" data-privacy="accept" type="button">Aceptar</button></div>`;
  document.body.append(banner);
  // "Ver más" solo si el texto no cabe en las líneas visibles.
  const text = banner.querySelector('.privacy-banner__text');
  const more = banner.querySelector('[data-privacy="more"]');
  const syncMore = () => {
    if (!banner.isConnected) { window.removeEventListener('resize', syncMore); return; }
    if (text.classList.contains('is-clamped')) more.hidden = text.scrollHeight <= text.clientHeight + 1;
  };
  syncMore();
  window.addEventListener('resize', syncMore, { passive: true });
  requestAnimationFrame(() => banner.classList.add('is-visible'));
  banner.addEventListener('click', async event => {
    const action = event.target.closest('[data-privacy]')?.dataset.privacy;
    if (!action) return;
    if (action === 'more') { const open = text.classList.toggle('is-clamped') === false; more.setAttribute('aria-expanded', String(open)); more.textContent = open ? 'Ver menos' : 'Ver más'; return; }
    if (action === 'custom') { openPrivacyPreferences(event.target); return; }
    // Mientras se guarda: spinner en el botón pulsado y el resto bloqueado (sin doble envío).
    const button = event.target.closest('[data-privacy]');
    const actions = [...banner.querySelectorAll('.privacy-banner__actions .btn')];
    actions.forEach(item => { item.disabled = true; });
    setButtonLoading(button, true, 'Guardando…');
    banner.setAttribute('aria-busy', 'true');
    try { await decideConsent({ analytics: action === 'accept', personalization: action === 'accept' }); banner.remove(); toast(action === 'accept' ? 'Preferencias guardadas' : 'No usaremos tu navegación'); }
    catch { toast('No pudimos guardar tu preferencia. La tienda funciona igual.', 'error'); banner.remove(); }
  });
}

export function openPrivacyPreferences(trigger = null) {
  const cfg = privacyConfig();
  const consent = getConsent();
  const form = document.createElement('form');
  form.className = 'privacy-form';
  form.innerHTML = cfg.enabled ? `<p class="form-help">Elige para qué podemos usar tu navegación en esta tienda. Tus pedidos se gestionan igual con cualquier opción.</p>
    <label class="check-field"><input type="checkbox" name="analytics" ${consent.analytics ? 'checked' : ''}><span><strong>Analítica de la tienda</strong><small>${escapeHtml(cfg.analyticsText)}</small></span></label>
    <label class="check-field"><input type="checkbox" name="personalization" ${consent.personalization ? 'checked' : ''}><span><strong>Recomendaciones personalizadas</strong><small>${escapeHtml(cfg.personalizationText || 'Usar los productos que ves para sugerirte otros y, si verificas tu número, para que la tienda te atienda mejor.')}</small></span></label>
    <p class="field__hint">Versión del texto: ${escapeHtml(cfg.version)}. Puedes cambiar o retirar tu autorización cuando quieras; al retirarla eliminamos los eventos de navegación asociados.</p>
    <div class="form-actions"><button class="btn btn--primary" type="submit">Guardar preferencias</button></div>
    ${consent.personalization ? `<details class="privacy-verify"><summary>Vincular mis compras con mi número</summary><p class="field__hint">Para recibir ofertas personales necesitamos comprobar que el número es tuyo: te daremos un código para enviarlo desde tu WhatsApp. Escribir un número no basta.</p><label class="field"><span class="field__label">Tu celular</span><input name="verify_phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel"></label><button class="btn btn--secondary" data-verify type="button">Obtener código</button><p data-verify-result role="status"></p></details>` : ''}`
    : '<p>Esta tienda no registra tu navegación. Solo usamos los datos que escribes al hacer un pedido para gestionarlo.</p>';
  const modal = openModal({ title: 'Preferencias de privacidad', content: form, trigger });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const analytics = form.elements.analytics.checked;
    const submit = form.querySelector('[type="submit"]');
    const fields = [...form.querySelectorAll('input[type="checkbox"]')];
    setButtonLoading(submit, true, 'Guardando…');
    fields.forEach(field => { field.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    try { await decideConsent({ analytics, personalization: analytics && form.elements.personalization.checked }); document.querySelector('[data-privacy-banner]')?.remove(); toast('Preferencias guardadas'); modal.close(true); }
    catch {
      toast('No pudimos guardar tu preferencia. Intenta de nuevo.', 'error');
      setButtonLoading(submit, false);
      fields.forEach(field => { field.disabled = false; });
      form.removeAttribute('aria-busy');
    }
  });
  form.elements.personalization?.addEventListener('change', () => { if (form.elements.personalization.checked) form.elements.analytics.checked = true; });
  form.querySelector('[data-verify]')?.addEventListener('click', async () => {
    const output = form.querySelector('[data-verify-result]');
    try {
      const result = await requestIdentityVerification(form.elements.verify_phone.value);
      const digits = String(result.whatsapp || '').replace(/\D/g, '');
      output.innerHTML = `Envía <strong>${escapeHtml(result.code)}</strong> desde ese número ${digits ? `<a href="https://wa.me/${digits}?text=${encodeURIComponent(`Mi código de verificación es ${result.code}`)}" target="_blank" rel="noopener">por WhatsApp</a>` : 'al WhatsApp de la tienda'} antes de 30 minutos. La tienda lo confirmará al recibirlo.`;
    } catch (error) { output.textContent = error?.message || 'No pudimos generar el código.'; }
  });
}
