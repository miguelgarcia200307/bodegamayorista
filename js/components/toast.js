// Snackbar de confirmación. Compatible con la firma anterior: toast(mensaje, tipo, duración).
// El cuarto parámetro opcional agrega una acción: { label, href } o { label, onClick }.
export function toast(message, type = 'success', duration = 3200, action = null) {
  const root = document.querySelector('#toast-root') || document.body;
  if (root.id === 'toast-root') root.classList.add('toast-root');
  root.querySelectorAll('.toast').forEach(existing => { if (root.children.length >= 2) existing.remove(); });
  const element = document.createElement('div');
  element.className = `toast toast--${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  element.append(text);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 180);
  };
  if (action?.label) {
    const control = document.createElement(action.href ? 'a' : 'button');
    control.className = 'toast__action';
    control.textContent = action.label;
    if (action.href) control.href = action.href;
    else control.type = 'button';
    control.addEventListener('click', event => {
      if (action.onClick) { event.preventDefault(); action.onClick(); }
      dismiss();
    });
    element.append(control);
  }
  root.append(element);
  timer = setTimeout(dismiss, action ? Math.max(duration, 5000) : duration);
  return { dismiss, element };
}
