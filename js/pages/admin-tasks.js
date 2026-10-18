// "A quién atender hoy": tareas persistidas (customer_tasks) generadas por reglas del
// servidor (tareas-v1) o creadas a mano. Cada tarea muestra su motivo y evidencia. Las
// acciones registran contacto preparado / declarado como enviado / respuesta; abrir
// WhatsApp no cuenta como envío. Completar, posponer o descartar no se duplica.
import { confirmIdentityVerification, createManualTask, generateCustomerTasks, getDocumentById, getOpenTasks, getPendingVerifications, recordContactAttempt, setTaskStatus } from '../lib/api.js';
import { openModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { icon } from '../components/icons.js';
import { $, debounce, escapeHtml, normalizeText, setButtonLoading } from '../lib/helpers.js';
import { bogotaTodayIso } from '../lib/crm-dates.js';
import { addDays } from '../lib/metrics.js';
import { businessName, crmSettings, dateText, dateTimeText, emptyMarkup, firstName, initials, kpiTileMarkup, openDocument, plural, requestError, waDigits, waLink } from './admin-crm.js';

let ctx = null;
export function configureTasks(context) { ctx = context; }

export const TASK_KIND = {
  pedido_pendiente: 'Pedido pendiente', cotizacion_seguimiento: 'Cotización', borrador_interno: 'Borrador interno', carrito_sin_compra: 'Carrito sin compra',
  reposicion: 'Reposición', postventa: 'Postventa', reactivar: 'Reactivación', devolucion: 'Devolución', cumpleanos: 'Cumpleaños', oferta_sin_respuesta: 'Oferta sin respuesta', disponible_de_nuevo: 'Aviso de disponibilidad', manual: 'Manual'
};
const KIND_ICON = {
  pedido_pendiente: 'bag', cotizacion_seguimiento: 'layers', borrador_interno: 'pencil', carrito_sin_compra: 'bag', reposicion: 'history', postventa: 'chat',
  reactivar: 'undo', devolucion: 'returns', cumpleanos: 'star', oferta_sin_respuesta: 'percent', disponible_de_nuevo: 'package', manual: 'check'
};
const STATUS = { pendiente: 'Pendiente', pospuesta: 'Pospuesta', completada: 'Completada', descartada: 'Descartada' };
const DISCARD_REASONS = ['Ya se resolvió por otro medio', 'El cliente no quiere ser contactado', 'No aplica / dato incorrecto', 'Duplicada', 'Otro'];
const OUTCOMES = [
  ['respondio_interesado', 'Interesado', 'Respondió y quiere avanzar', 'checkCircle'], ['respondio_no_interesado', 'No interesado', 'Respondió que no por ahora', 'x'],
  ['pidio_mas_tarde', 'Más tarde', 'Pidió hablar en otro momento', 'clock'], ['sin_respuesta', 'Sin respuesta', 'No contestó todavía', 'chat']
];
const MESSAGE = {
  pedido_pendiente: name => `Hola ${name}, te escribimos de ${businessName()} sobre tu pedido. ¿Confirmamos la entrega y la forma de pago?`,
  cotizacion_seguimiento: name => `Hola ${name}, te escribimos de ${businessName()}. ¿Pudiste revisar la cotización que te enviamos? Quedamos atentos a tus dudas.`,
  postventa: name => `Hola ${name}, te escribimos de ${businessName()}. ¿Cómo te fue con tu compra? Queremos saber si todo llegó bien.`,
  devolucion: name => `Hola ${name}, te escribimos de ${businessName()} para confirmar que tu devolución quedó resuelta. ¿Necesitas algo más?`,
  cumpleanos: name => `Hola ${name}, te deseamos un feliz cumpleaños de parte de ${businessName()}.`,
  reposicion: name => `Hola ${name}, te escribimos de ${businessName()}. ¿Te recordamos tu reposición? Confírmanos si la necesitas.`,
  disponible_de_nuevo: name => `Hola ${name}, te escribimos de ${businessName()}: el producto que nos pediste avisarte ya está disponible. ¿Quieres que te lo separemos?`,
  default: name => `Hola ${name}, te escribimos de ${businessName()}.`
};
const isDue = (task, today) => task.status === 'pendiente' || (task.status === 'pospuesta' && task.next_review_at && task.next_review_at <= today);
const isOverdue = (task, today) => Boolean(task.due_at && task.due_at < today && isDue(task, today));
const daysBetweenIso = (from, to) => Math.round((new Date(`${to}T12:00:00`) - new Date(`${from}T12:00:00`)) / 86400000);
const priorityLevel = value => value >= 80 ? ['alta', 'Alta'] : value >= 50 ? ['media', 'Media'] : ['baja', 'Baja'];

// Estado temporal legible: vencida hace N días, para hoy, para el día X o pospuesta.
function taskWhen(task, today) {
  if (task.status === 'pospuesta' && !isDue(task, today)) return ['postponed', `Pospuesta hasta ${dateText(task.next_review_at)}`];
  if (isOverdue(task, today)) { const days = daysBetweenIso(task.due_at, today); return ['overdue', `Vencida ${days === 1 ? 'ayer' : `hace ${days} días`}`]; }
  if (!task.due_at || task.due_at === today) return ['today', task.status === 'pospuesta' ? 'Retomar hoy' : 'Para hoy'];
  const days = daysBetweenIso(today, task.due_at);
  return ['upcoming', days === 1 ? 'Para mañana' : `Para el ${dateText(task.due_at)}`];
}

export function taskCardMarkup(task, { showCustomer = true, today = bogotaTodayIso() } = {}) {
  const [when, whenLabel] = taskWhen(task, today); const [level, levelLabel] = priorityLevel(Number(task.priority) || 0);
  const open = ['pendiente', 'pospuesta'].includes(task.status);
  const reasons = Object.entries(task.priority_reason || {}).map(([key, value]) => `<span class="task-reason" title="${escapeHtml(key)}">${escapeHtml(value)}</span>`).join('');
  const evidence = (task.evidence || []).map(item => `<li><span>${escapeHtml(item.label)}</span>${item.date ? `<time>${dateText(item.date)}</time>` : ''}<em>${escapeHtml(item.kind || 'observado')}</em></li>`).join('');
  const customer = task.customers;
  const hasDoc = task.source_type && ['order', 'quote', 'sale'].includes(task.source_type);
  return `<article class="task-item task-item--${when}" data-task="${task.id}" data-level="${level}">
    <div class="task-item__gauge" style="--value:${Math.max(0, Math.min(100, Number(task.priority) || 0))}" title="Prioridad explicable de 0 a 100"><span><b>${task.priority}</b><small>${levelLabel}</small></span></div>
    <div class="task-item__body">
      <div class="task-item__top"><span class="task-kind task-kind--${task.promotional ? 'promo' : 'service'}">${icon(KIND_ICON[task.kind] || 'check', { size: 13 })}${escapeHtml(TASK_KIND[task.kind] || task.kind)}</span><span class="task-tag">${task.promotional ? 'Comercial' : 'Servicio'}</span><span class="task-when task-when--${when}">${icon(when === 'postponed' ? 'history' : 'clock', { size: 13 })}${escapeHtml(whenLabel)}</span>${!open ? `<span class="status-pill status-pill--muted">${STATUS[task.status]}</span>` : ''}</div>
      <h3 class="task-item__title">${escapeHtml(task.title)}</h3>
      ${showCustomer && customer ? `<button class="task-customer" data-task-customer type="button"><span class="task-customer__avatar" aria-hidden="true">${escapeHtml(initials(customer.full_name))}</span><span><strong>${escapeHtml(customer.full_name)}</strong>${customer.phone_original ? `<small>${escapeHtml(customer.phone_original)}</small>` : ''}</span>${icon('arrowRight', { size: 14 })}</button>` : ''}
      ${task.objective ? `<p class="task-item__objective">${icon('navigation', { size: 14 })}<span>${escapeHtml(task.objective)}</span></p>` : ''}
      ${evidence || reasons ? `<details class="task-why"><summary>${icon('info', { size: 14 })}Por qué esta tarea${evidence ? ` · ${plural((task.evidence || []).length, 'evidencia')}` : ''}${icon('chevronDown', { size: 14 })}</summary><div class="task-why__body">${evidence ? `<ul class="task-evidence">${evidence}</ul>` : ''}${reasons ? `<div class="task-reasons">${reasons}</div>` : ''}<small>Regla ${escapeHtml(task.rule_version)}${task.outcome ? ` · último resultado: ${escapeHtml(task.outcome)}` : ''}</small></div></details>` : `<small class="task-item__rule">Regla ${escapeHtml(task.rule_version)}${task.outcome ? ` · último resultado: ${escapeHtml(task.outcome)}` : ''}</small>`}
    </div>
    ${open ? `<div class="task-item__actions"><button class="small-btn small-btn--primary task-item__primary" data-task-message type="button">${icon('whatsapp', { size: 16 })}<span>Preparar mensaje</span></button><button class="small-btn task-item__done" data-task-done type="button">${icon('check', { size: 16 })}<span>Completar</span></button><details class="action-menu sale-menu task-menu"><summary aria-label="Más acciones" aria-expanded="false">${icon('more', { size: 18 })}</summary><div class="action-menu__popover">${hasDoc ? `<button data-task-doc type="button">${icon('external', { size: 16 })}<span>Abrir documento</span></button>` : ''}<button data-task-response type="button">${icon('chat', { size: 16 })}<span>Registrar respuesta</span></button><button data-task-postpone type="button">${icon('history', { size: 16 })}<span>Posponer</span></button><button class="is-danger" data-task-discard type="button">${icon('x', { size: 16 })}<span>Descartar</span></button></div></details></div>` : ''}
  </article>`;
}

export function bindTaskCards(root, tasks, refresh, customerOf = task => task.customers) {
  root.querySelectorAll('[data-task]').forEach(card => {
    const task = tasks.find(item => item.id === card.dataset.task); if (!task) return;
    const customer = customerOf(task);
    const closeMenu = () => card.querySelector('details[open]')?.removeAttribute('open');
    card.querySelector('[data-task-customer]')?.addEventListener('click', () => ctx.navigateTo('customer', { id: task.customer_id, tab: 'follow' }));
    card.querySelector('[data-task-doc]')?.addEventListener('click', async event => {
      const button = event.currentTarget; setButtonLoading(button, true, 'Abriendo…');
      try { const doc = await getDocumentById(task.source_type, task.source_id); closeMenu(); if (doc) openDocument(task.source_type, doc, refresh, button); else toast('El documento ya no existe.', 'error'); }
      catch (error) { toast(requestError(error, 'No pudimos abrir el documento.'), 'error'); }
      finally { setButtonLoading(button, false); }
    });
    card.querySelector('[data-task-message]')?.addEventListener('click', event => openTaskMessage(task, customer, refresh, event.currentTarget));
    card.querySelector('[data-task-response]')?.addEventListener('click', event => { closeMenu(); openResponseForm(task, customer, refresh, event.currentTarget); });
    card.querySelector('[data-task-done]')?.addEventListener('click', event => openStatusForm(task, customer, 'completada', refresh, event.currentTarget));
    card.querySelector('[data-task-postpone]')?.addEventListener('click', event => { closeMenu(); openStatusForm(task, customer, 'pospuesta', refresh, event.currentTarget); });
    card.querySelector('[data-task-discard]')?.addEventListener('click', event => { closeMenu(); openStatusForm(task, customer, 'descartada', refresh, event.currentTarget); });
  });
}

// --- Modales: misma estructura que las acciones de venta ------------------------------
function taskTicketMarkup(task, customer) {
  return `<div class="sale-ticket task-ticket"><span class="task-ticket__icon" aria-hidden="true">${icon(KIND_ICON[task.kind] || 'check', { size: 20 })}</span><div class="sale-ticket__main"><small>${escapeHtml(TASK_KIND[task.kind] || task.kind)} · prioridad ${task.priority}</small><strong>${escapeHtml(task.title)}</strong>${customer?.full_name ? `<span>${escapeHtml(customer.full_name)}${customer.phone_original ? ` · ${escapeHtml(customer.phone_original)}` : ''}</span>` : ''}</div></div>`;
}

function taskModal({ title, iconName, tone = 'primary', head = '', body, note = '', submitLabel, submitIcon = 'check', extraAction = '', trigger, onSubmit }) {
  const form = document.createElement('form');
  form.className = 'sale-action'; form.dataset.tone = tone; form.noValidate = true;
  form.innerHTML = `${head}<div class="sale-action__body">${body}</div>${note ? `<p class="sale-action__note">${icon('info', { size: 16 })}<span>${note}</span></p>` : ''}<p class="sale-action__error" data-error role="alert" hidden></p><div class="sale-action__actions">${extraAction || '<button class="btn btn--ghost" data-back type="button">Volver</button>'}${submitLabel ? `<button class="btn ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}" type="submit">${icon(submitIcon, { size: 18 })}<span>${submitLabel}</span></button>` : ''}</div>`;
  const modal = openModal({ title, content: form, trigger, className: 'modal--action', headerIcon: `<span class="sale-action__badge" data-tone="${tone}">${icon(iconName, { size: 20 })}</span>` });
  const error = form.querySelector('[data-error]');
  const fail = message => { error.textContent = message; error.hidden = false; };
  form.querySelector('[data-back]')?.addEventListener('click', () => modal.close());
  form.addEventListener('submit', async event => { event.preventDefault(); error.hidden = true; await onSubmit({ form, button: form.querySelector('[type="submit"]'), modal, fail }); });
  return { form, modal, fail };
}

async function openTaskMessage(task, customer, refresh, trigger) {
  await crmSettings();
  const digits = waDigits(customer);
  const purpose = task.promotional ? 'comercial' : task.kind === 'postventa' ? 'postventa' : task.kind === 'cumpleanos' ? 'cumpleanos' : 'servicio';
  const text = (MESSAGE[task.kind] || MESSAGE.default)(firstName(customer?.full_name));
  const body = `<ol class="task-steps"><li><b>1</b>Revisa el mensaje</li><li><b>2</b>Ábrelo en WhatsApp y envíalo</li><li><b>3</b>Registra que lo enviaste</li></ol>
    ${task.promotional ? `<p class="sale-action__warn">${icon('alert', { size: 16 })}<span>Mensaje comercial: el cliente autorizó contacto promocional. Respeta la frecuencia configurada.</span></p>` : ''}
    <label class="sale-action__field"><span class="sale-action__label">Mensaje <small data-count></small></span><textarea name="message" rows="5" maxlength="900">${escapeHtml(text)}</textarea></label>
    ${digits ? `<button class="btn task-wa-btn" data-open-wa type="button">${icon('whatsapp', { size: 18 })}<span>Abrir WhatsApp</span></button>` : `<p class="sale-action__warn">${icon('alert', { size: 16 })}<span>Este cliente no tiene un WhatsApp válido: usa otro canal y luego registra el contacto.</span></p>`}`;
  const { form } = taskModal({
    title: 'Preparar mensaje', iconName: 'whatsapp', tone: 'success', head: taskTicketMarkup(task, customer), body, trigger, submitLabel: 'Ya lo envié', submitIcon: 'check',
    note: 'Abrir WhatsApp no envía el mensaje ni cuenta como contacto: solo queda registrado cuando confirmas "Ya lo envié".',
    async onSubmit({ button, modal, fail }) {
      setButtonLoading(button, true, 'Guardando…');
      try { await recordContactAttempt({ customer_id: task.customer_id, task_id: task.id, channel: 'whatsapp', kind: 'declarado_enviado', purpose, note: 'Declarado por el vendedor' }); toast('Envío registrado (declarado por ti)'); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos registrar el envío.')); setButtonLoading(button, false); }
    }
  });
  const textarea = form.elements.message; const count = form.querySelector('[data-count]');
  const updateCount = () => { count.textContent = `${textarea.value.length}/900`; };
  textarea.addEventListener('input', updateCount); updateCount();
  form.querySelector('[data-open-wa]')?.addEventListener('click', async event => {
    window.open(waLink(digits, textarea.value.trim()), '_blank', 'noopener');
    event.currentTarget.classList.add('is-opened'); event.currentTarget.querySelector('span').textContent = 'WhatsApp abierto · ábrelo de nuevo';
    try { await recordContactAttempt({ customer_id: task.customer_id, task_id: task.id, channel: 'whatsapp', kind: 'preparado', purpose }); } catch (error) { console.warn(error); }
  });
}

function openResponseForm(task, customer, refresh, trigger) {
  const body = `<fieldset class="choice-tiles"><legend>¿Qué respondió el cliente?</legend>${OUTCOMES.map(([value, label, detail, iconName], index) => `<label class="choice-tile"><input type="radio" name="outcome" value="${value}" ${index === 0 ? 'checked' : ''}><span class="choice-tile__icon">${icon(iconName, { size: 18 })}</span><strong>${label}</strong><small>${detail}</small></label>`).join('')}</fieldset>
    <label class="sale-action__field"><span class="sale-action__label">Nota <small>Opcional · sin datos sensibles</small></span><textarea name="note" rows="3" maxlength="500" placeholder="Qué dijo, qué quedó pendiente…"></textarea></label>`;
  taskModal({
    title: 'Registrar respuesta', iconName: 'chat', head: taskTicketMarkup(task, customer), body, trigger, submitLabel: 'Registrar respuesta',
    note: 'La tarea sigue abierta: complétala cuando el asunto quede resuelto.',
    async onSubmit({ form, button, modal, fail }) {
      setButtonLoading(button, true, 'Guardando…');
      try { await recordContactAttempt({ customer_id: task.customer_id, task_id: task.id, kind: 'respuesta', outcome: form.elements.outcome.value, note: form.elements.note.value, purpose: task.promotional ? 'comercial' : 'servicio' }); toast('Respuesta registrada'); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos registrar la respuesta.')); setButtonLoading(button, false); }
    }
  });
}

function openStatusForm(task, customer, status, refresh, trigger) {
  const today = bogotaTodayIso();
  const config = {
    completada: { title: 'Completar tarea', iconName: 'checkCircle', tone: 'success', submit: 'Completar tarea', note: 'Una tarea completada no se vuelve a generar para el mismo hecho.',
      body: `<label class="sale-action__field"><span class="sale-action__label">Resultado <small>Qué pasó · opcional</small></span><input name="outcome" maxlength="120" placeholder="Ej. Confirmó pedido, compró, resuelto"></label><div class="reason-chips" role="group" aria-label="Resultados frecuentes">${['Confirmó el pedido', 'Compró', 'Resuelto', 'No necesita nada'].map(text => `<button class="reason-chip" type="button" data-fill="outcome" data-value="${text}">${text}</button>`).join('')}</div>` },
    pospuesta: { title: 'Posponer tarea', iconName: 'history', tone: 'primary', submit: 'Posponer', note: 'Volverá a aparecer en "Para hoy" el día que elijas.',
      body: `<div class="reason-chips postpone-chips" role="group" aria-label="Posponer rápido">${[[1, 'Mañana'], [3, 'En 3 días'], [7, 'En 1 semana'], [14, 'En 2 semanas']].map(([days, label]) => `<button class="reason-chip ${days === 3 ? 'is-active' : ''}" type="button" data-fill="next_review_at" data-value="${addDays(today, days)}">${label}<small>${dateText(addDays(today, days))}</small></button>`).join('')}</div><label class="sale-action__field"><span class="sale-action__label">Revisar de nuevo el</span><input name="next_review_at" type="date" min="${addDays(today, 1)}" value="${addDays(today, 3)}" required></label>` },
    descartada: { title: 'Descartar tarea', iconName: 'x', tone: 'danger', submit: 'Descartar tarea', note: 'Una tarea descartada no se vuelve a generar para el mismo hecho.',
      body: `<fieldset class="discard-list"><legend>¿Por qué la descartas?</legend>${DISCARD_REASONS.map((reason, index) => `<label class="discard-option"><input type="radio" name="discard_reason" value="${escapeHtml(reason)}" ${index === 0 ? 'checked' : ''}><span>${escapeHtml(reason)}</span></label>`).join('')}</fieldset>` }
  }[status];
  const { form } = taskModal({
    title: config.title, iconName: config.iconName, tone: config.tone, head: taskTicketMarkup(task, customer), body: config.body, note: config.note, trigger, submitLabel: config.submit, submitIcon: config.iconName,
    async onSubmit({ form: target, button, modal, fail }) {
      const values = Object.fromEntries(new FormData(target));
      if (status === 'pospuesta' && (!values.next_review_at || values.next_review_at <= today)) { fail('Elige una fecha a partir de mañana.'); return; }
      setButtonLoading(button, true, 'Guardando…');
      try { await setTaskStatus(task.id, { status, ...values }); toast(status === 'completada' ? 'Tarea completada' : status === 'pospuesta' ? `Pospuesta hasta ${dateText(values.next_review_at)}` : 'Tarea descartada'); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos actualizar la tarea.')); setButtonLoading(button, false); }
    }
  });
  form.querySelectorAll('[data-fill]').forEach(chip => chip.addEventListener('click', () => {
    form.querySelectorAll('[data-fill]').forEach(other => other.classList.toggle('is-active', other === chip));
    form.elements[chip.dataset.fill].value = chip.dataset.value;
  }));
}

export function openManualTaskForm(customerId, refresh, trigger) {
  const today = bogotaTodayIso();
  const body = `<label class="sale-action__field"><span class="sale-action__label">Tarea</span><input name="title" required maxlength="160" placeholder="Ej. Llamar para confirmar la entrega"></label>
    <label class="sale-action__field"><span class="sale-action__label">Objetivo <small>Opcional</small></span><input name="objective" maxlength="300" placeholder="Qué debe quedar resuelto"></label>
    <div class="task-form-grid"><label class="sale-action__field"><span class="sale-action__label">Para el</span><input name="due_at" type="date" value="${today}"></label><label class="sale-action__field"><span class="sale-action__label">Prioridad <small data-priority-label>Media</small></span><input name="priority" type="range" min="0" max="100" step="5" value="50"></label></div>`;
  const { form } = taskModal({
    title: 'Nueva tarea', iconName: 'plus', body, trigger, submitLabel: 'Crear tarea', submitIcon: 'plus',
    async onSubmit({ form: target, button, modal, fail }) {
      if (target.elements.title.value.trim().length < 3) { fail('Describe la tarea.'); target.elements.title.focus(); return; }
      setButtonLoading(button, true, 'Guardando…');
      try { await createManualTask({ customer_id: customerId, ...Object.fromEntries(new FormData(target)) }); toast('Tarea creada'); modal.close(true); await refresh(); }
      catch (error) { fail(requestError(error, 'No pudimos crear la tarea.')); setButtonLoading(button, false); }
    }
  });
  const range = form.elements.priority; const label = form.querySelector('[data-priority-label]');
  const update = () => { label.textContent = `${priorityLevel(Number(range.value))[1]} · ${range.value}`; };
  range.addEventListener('input', update); update();
}

// --- Pantalla principal --------------------------------------------------------------
const FILTERS = {
  today: { label: 'Para hoy', match: (task, today) => isDue(task, today) },
  overdue: { label: 'Vencidas', match: (task, today) => isOverdue(task, today) },
  high: { label: 'Alta prioridad', match: (task, today) => isDue(task, today) && task.priority >= 80 },
  postponed: { label: 'Pospuestas', match: task => task.status === 'pospuesta' },
  all: { label: 'Todas abiertas', match: () => true }
};
const KINDS = { all: 'Todos', servicio: 'Servicio', promocional: 'Comerciales' };
const GROUPS = [['overdue', 'Vencidas', 'Atiéndelas primero'], ['today', 'Para hoy', 'Ordenadas por prioridad'], ['upcoming', 'Próximos días', 'Ya puedes adelantarlas'], ['postponed', 'Pospuestas', 'Vuelven en la fecha elegida']];

function todayKpisMarkup(tasks, today) {
  const due = tasks.filter(task => isDue(task, today)); const overdue = tasks.filter(task => isOverdue(task, today));
  const high = due.filter(task => task.priority >= 80); const postponed = tasks.filter(task => task.status === 'pospuesta');
  const oldest = overdue.reduce((min, task) => (!min || task.due_at < min ? task.due_at : min), null);
  const nextReview = postponed.filter(task => task.next_review_at > today).map(task => task.next_review_at).sort()[0];
  const service = due.filter(task => !task.promotional).length;
  return `<section class="sales-kpis" aria-label="Resumen de tareas">
    ${kpiTileMarkup({ tone: 'hero', iconName: 'checkCircle', label: 'Para atender hoy', value: due.length, detail: due.length ? `${service} de servicio · ${due.length - service} comerciales${tasks.truncated ? ' · lista incompleta' : ''}` : '¡Todo al día!' })}
    ${kpiTileMarkup({ view: 'overdue', tone: 'danger', iconName: 'alert', label: 'Vencidas', value: overdue.length, detail: overdue.length ? `La más antigua era para el ${dateText(oldest)}` : 'Ninguna atrasada' })}
    ${kpiTileMarkup({ view: 'high', tone: 'warning', iconName: 'star', label: 'Alta prioridad', value: high.length, detail: high.length ? 'Prioridad 80 o más, para hoy' : 'Sin urgencias' })}
    ${kpiTileMarkup({ view: 'postponed', tone: 'info', iconName: 'history', label: 'Pospuestas', value: postponed.length, detail: nextReview ? `Próxima vuelve el ${dateText(nextReview)}` : postponed.length ? 'Vuelven hoy' : 'Nada pospuesto' })}
  </section>`;
}

export async function renderToday() {
  const params = new URLSearchParams(location.search);
  const state = { filter: params.get('filter') || 'today', kind: params.get('kind') || 'all', type: params.get('type') || 'all', q: params.get('q') || '' };
  if (!FILTERS[state.filter]) state.filter = 'today';
  if (!KINDS[state.kind]) state.kind = 'all';
  const root = $('#admin-content');
  const today = bogotaTodayIso();
  root.innerHTML = ctx.heading('Seguimiento', 'A quién atender hoy', 'Tus tareas del día, cada una con su motivo y evidencia. Se generan por reglas explícitas y no se duplican; abrir WhatsApp no cuenta como mensaje enviado.', `<button id="generate-tasks" class="btn btn--primary" type="button">${icon('history', { size: 18 })}<span>Actualizar tareas</span></button>`)
    + '<div data-kpis></div><section class="verify-panel" data-verifications hidden></section>'
    + `<section class="admin-panel sales-panel">
      <div class="sales-toolbar">
        <div class="admin-search-wrap"><input class="admin-search" type="search" data-search value="${escapeHtml(state.q)}" placeholder="Buscar cliente, teléfono o tarea" aria-label="Buscar tareas"></div>
        <div class="segmented" role="group" aria-label="Tipo de contacto" data-kinds></div>
        <label class="sales-sort"><span>Tipo</span><select data-type aria-label="Tipo de tarea"></select></label>
      </div>
      <div class="sales-tabs" role="group" aria-label="Filtrar tareas" data-filters></div>
      <p class="results-meta" data-meta aria-live="polite"></p>
      <div class="task-board" data-list></div>
    </section>`;
  let tasks = [];
  const syncUrl = () => {
    const query = new URLSearchParams({ section: 'today' });
    if (state.filter !== 'today') query.set('filter', state.filter); if (state.kind !== 'all') query.set('kind', state.kind); if (state.type !== 'all') query.set('type', state.type); if (state.q) query.set('q', state.q);
    history.replaceState({}, '', `${location.pathname}?${query}`);
  };
  const refresh = async () => { tasks = await getOpenTasks(); render(); };
  const render = () => {
    syncUrl();
    root.querySelector('[data-kpis]').innerHTML = todayKpisMarkup(tasks, today);
    root.querySelectorAll('[data-kpi-view]').forEach(tile => tile.addEventListener('click', () => { state.filter = tile.dataset.kpiView; render(); root.querySelector('.sales-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    const kindMatch = task => state.kind === 'all' || (state.kind === 'promocional') === Boolean(task.promotional);
    const typeMatch = task => state.type === 'all' || task.kind === state.type;
    const term = normalizeText(state.q);
    const textMatch = task => !term || normalizeText(`${task.title} ${task.objective || ''} ${task.customers?.full_name || ''} ${task.customers?.phone_original || ''} ${TASK_KIND[task.kind] || ''}`).includes(term);
    const base = tasks.filter(task => kindMatch(task) && typeMatch(task) && textMatch(task));
    root.querySelector('[data-filters]').innerHTML = Object.entries(FILTERS).map(([key, filter]) => `<button class="sales-tab ${state.filter === key ? 'active' : ''}" data-filter="${key}" type="button" aria-pressed="${state.filter === key}"><span>${filter.label}</span><b>${base.filter(task => filter.match(task, today)).length}</b></button>`).join('');
    root.querySelector('[data-kinds]').innerHTML = Object.entries(KINDS).map(([key, label]) => `<button class="${state.kind === key ? 'active' : ''}" data-kind="${key}" type="button" aria-pressed="${state.kind === key}">${label}</button>`).join('');
    const present = [...new Set(tasks.map(task => task.kind))];
    root.querySelector('[data-type]').innerHTML = `<option value="all">Todos</option>${present.map(kind => `<option value="${kind}" ${state.type === kind ? 'selected' : ''}>${escapeHtml(TASK_KIND[kind] || kind)}</option>`).join('')}`;
    const visible = base.filter(task => FILTERS[state.filter].match(task, today)).sort((a, b) => b.priority - a.priority || String(a.due_at || '').localeCompare(String(b.due_at || '')));
    root.querySelector('[data-meta]').innerHTML = `<span>${plural(visible.length, 'tarea')}${tasks.truncated ? ' · lista incompleta (tope de lectura)' : ''}</span>${state.q || state.kind !== 'all' || state.type !== 'all' || state.filter !== 'today' ? '<button data-clear type="button">Ver las de hoy</button>' : ''}`;
    root.querySelector('[data-clear]')?.addEventListener('click', () => { Object.assign(state, { filter: 'today', kind: 'all', type: 'all', q: '' }); root.querySelector('[data-search]').value = ''; render(); });
    const groups = GROUPS.map(([key, title, hint]) => ({ key, title, hint, items: visible.filter(task => taskWhen(task, today)[0] === key) })).filter(group => group.items.length);
    root.querySelector('[data-list]').innerHTML = visible.length ? groups.map(group => `<section class="task-group task-group--${group.key}"><h3 class="sales-day"><span>${group.title}</span><small>${plural(group.items.length, 'tarea')} · ${group.hint}</small></h3><div class="task-list">${group.items.map(task => taskCardMarkup(task, { today })).join('')}</div></section>`).join('')
      : tasks.length ? emptyMarkup('Nada en esta vista', 'Prueba con otro filtro o búsqueda.') : `<div class="task-empty">${icon('checkCircle', { size: 34 })}<h3>¡Estás al día!</h3><p>No hay tareas abiertas. Pulsa "Actualizar tareas" para revisar pedidos, cotizaciones, devoluciones y seguimientos.</p></div>`;
    bindTaskCards(root.querySelector('[data-list]'), visible, refresh);
    root.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; render(); }));
    root.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => { state.kind = button.dataset.kind; render(); }));
  };
  root.querySelector('[data-type]').addEventListener('change', event => { state.type = event.target.value; render(); });
  root.querySelector('[data-search]').addEventListener('input', debounce(event => { state.q = event.target.value.trim(); render(); }, 250));
  $('#generate-tasks').addEventListener('click', async event => {
    const button = event.currentTarget; setButtonLoading(button, true, 'Revisando…');
    try { const created = await generateCustomerTasks(null); toast(created ? `${created} tarea${created === 1 ? '' : 's'} nueva${created === 1 ? '' : 's'}` : 'No hay tareas nuevas'); await refresh(); }
    catch (error) { toast(requestError(error, 'No pudimos actualizar las tareas.'), 'error'); }
    finally { setButtonLoading(button, false); }
  });
  await refresh();
  renderVerifications(root.querySelector('[data-verifications]'));
}

// Códigos de verificación pendientes: el vendedor confirma desde qué número llegó.
async function renderVerifications(panel) {
  let pending = [];
  try { pending = await getPendingVerifications(); } catch { return; }
  if (!pending.length) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = `<div class="verify-panel__head"><span class="verify-panel__icon" aria-hidden="true">${icon('shield', { size: 20 })}</span><div><h2>${plural(pending.length, 'verificación de número pendiente', 'verificaciones de número pendientes')}</h2><p>Confirma solo si el mensaje con el código llegó al WhatsApp de la tienda DESDE ese número. Vincula su navegación futura (no la pasada) con su ficha.</p></div></div><ul class="verify-list">${pending.map(item => `<li data-verification="${escapeHtml(item.code)}"><code>${escapeHtml(item.code)}</code><span><strong>${escapeHtml(item.phone_normalized)}</strong><small>Solicitado ${dateTimeText(item.requested_at)} · vence ${dateTimeText(item.expires_at)}</small></span><button class="small-btn small-btn--primary" data-confirm-verification type="button">${icon('check', { size: 16 })}<span>Confirmar</span></button></li>`).join('')}</ul>`;
  panel.querySelectorAll('[data-confirm-verification]').forEach(button => button.addEventListener('click', () => {
    const item = pending.find(entry => entry.code === button.closest('[data-verification]').dataset.verification);
    const body = `<div class="sale-ticket"><div class="sale-ticket__main"><small>Código ${escapeHtml(item.code)}</small><strong>${escapeHtml(item.phone_normalized)}</strong><span>Vence ${dateTimeText(item.expires_at)}</span></div></div><label class="sale-action__field"><span class="sale-action__label">Número desde el que llegó el mensaje</span><input name="phone" required inputmode="tel" placeholder="${escapeHtml(item.phone_normalized)}"></label><label class="sale-action__field"><span class="sale-action__label">Nota <small>Opcional</small></span><input name="note" maxlength="200"></label>`;
    taskModal({
      title: `Verificar ${item.code}`, iconName: 'shield', body, trigger: button, submitLabel: 'Confirmar verificación', note: `Debe coincidir con ${escapeHtml(item.phone_normalized)}.`,
      async onSubmit({ form, button: submit, modal, fail }) {
        if (!form.elements.phone.value.trim()) { fail('Escribe el número desde el que llegó el mensaje.'); return; }
        setButtonLoading(submit, true, 'Verificando…');
        try { await confirmIdentityVerification(item.code, form.elements.phone.value, form.elements.note.value); toast('Número verificado'); modal.close(true); renderVerifications(panel); }
        catch (error) { fail(requestError(error, 'No pudimos verificar.')); setButtonLoading(submit, false); }
      }
    });
  }));
}
