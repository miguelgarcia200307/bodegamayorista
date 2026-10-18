import { formatMoney } from './helpers.js';

// Los documentos usan instantáneas guardadas. La configuración actual completa
// únicamente documentos antiguos que todavía no tenían snapshot.
export const SALE_LEGAL_NOTICE = 'Comprobante comercial interno. No es factura electrónica ni documento equivalente validado por la DIAN.';
const GOLD = [164, 123, 40];
const GOLD_DARK = [118, 86, 26];
const INK = [23, 32, 25];
const MUTED = [92, 103, 95];
const LINE = [222, 227, 223];
const PAPER = [249, 247, 242];
const PDF_FONT = 'Lato';
let pdfFontFiles;

const SALE_STATUS = { solicitud: 'Solicitud (sin confirmar)', confirmada: 'Venta confirmada', pagada: 'Pagada', entregada: 'Entregada', cancelada: 'Cancelada', devuelta: 'Devuelta' };
const QUOTE_STATUS = { borrador: 'Borrador', enviada: 'Enviada', aceptada: 'Aceptada', rechazada: 'Rechazada', vencida: 'Vencida', convertida: 'Convertida en venta' };

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'long', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}

function optionText(snapshot) {
  return Object.entries(snapshot || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join(' · ');
}

function documentData(kind, doc, settings) {
  const isSale = kind === 'sale';
  const snapshot = Object.fromEntries(Object.entries(doc.business_snapshot || {}).filter(([, value]) => value != null && value !== ''));
  const business = { ...(settings || {}), ...snapshot };
  const customer = { ...(doc.customers || {}), ...(doc.customer_snapshot || {}) };
  const items = (isSale ? doc.sale_items : doc.quote_items || []).slice().sort((a, b) => Number(a.line_no ?? 0) - Number(b.line_no ?? 0));
  return {
    kind, doc, items, business, customer, isSale,
    number: isSale ? doc.sale_number : doc.quote_number,
    title: isSale ? 'Comprobante de venta' : 'Cotización',
    status: (isSale ? SALE_STATUS : QUOTE_STATUS)[doc.status] || doc.status || 'Sin estado',
    terms: doc.terms_snapshot,
    warranty: isSale ? doc.warranty_snapshot : '',
    returns: isSale ? (doc.sale_returns || []) : []
  };
}

function validateDocument(data) {
  if (!data.number || /^(undefined|null)$/i.test(String(data.number))) throw new Error('El documento no tiene un consecutivo válido. Guárdalo antes de descargar el PDF.');
  if (!data.customer.full_name) throw new Error('El documento no tiene un cliente válido.');
  if (!data.items.length) throw new Error('El documento no contiene productos.');
  if (!data.business.business_name) throw new Error('Configura el nombre del negocio antes de emitir el documento.');
}

export function commercialDocumentFilename({ kind, doc }) {
  const number = String((kind === 'sale' ? doc?.sale_number : doc?.quote_number) || '').trim();
  const rawName = String(doc?.customer_snapshot?.full_name || doc?.customers?.full_name || '').trim();
  const safe = value => String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  const type = kind === 'sale' ? 'Comprobante' : 'Cotizacion';
  const parts = [type, safe(number)].filter(Boolean);
  const customer = safe(rawName).slice(0, 60).replace(/-+$/g, '');
  if (customer) parts.push(customer);
  const filename = `${parts.join('_').slice(0, 140).replace(/[_-]+$/g, '')}.pdf`;
  return /(?:undefined|null|documento)\.pdf$/i.test(filename) ? `${type}.pdf` : filename;
}

function imageData(url) {
  if (!url) return Promise.resolve(null);
  return fetch(new URL(url, location.href).href).then(response => { if (!response.ok) throw new Error('No se pudo cargar el logo'); return response.blob(); }).then(blob => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob);
  })).catch(() => null);
}

function fontFileBase64(url) {
  return fetch(url).then(response => {
    if (!response.ok) throw new Error(`No se pudo cargar la tipografía PDF (${response.status})`);
    return response.arrayBuffer();
  }).then(buffer => {
    const bytes = new Uint8Array(buffer); const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    return btoa(chunks.join(''));
  });
}

async function loadPdfFonts(pdf) {
  pdfFontFiles ||= Promise.all([
    fontFileBase64(new URL('../../assets/fonts/lato-regular.ttf', import.meta.url)),
    fontFileBase64(new URL('../../assets/fonts/lato-bold.ttf', import.meta.url))
  ]);
  try {
    const [regular, bold] = await pdfFontFiles;
    pdf.addFileToVFS('lato-regular.ttf', regular); pdf.addFont('lato-regular.ttf', PDF_FONT, 'normal');
    pdf.addFileToVFS('lato-bold.ttf', bold); pdf.addFont('lato-bold.ttf', PDF_FONT, 'bold');
    return PDF_FONT;
  } catch { return 'helvetica'; }
}

function addPdfHeader(pdf, data, logoData, compact = false, font = PDF_FONT) {
  const pageWidth = pdf.internal.pageSize.getWidth(); const left = 14; const right = pageWidth - 14; const business = data.business;
  pdf.setTextColor(...INK);
  if (logoData) {
    try {
      const properties = pdf.getImageProperties(logoData); const maxWidth = compact ? 18 : 26; const maxHeight = compact ? 12 : 19;
      const ratio = properties.width / properties.height; let width = maxWidth; let height = width / ratio;
      if (height > maxHeight) { height = maxHeight; width = height * ratio; }
      pdf.addImage(logoData, properties.fileType, left, compact ? 8 : 11, width, height, undefined, 'FAST');
    } catch { /* Wordmark textual de respaldo. */ }
  }
  const brandX = logoData ? left + (compact ? 22 : 31) : left;
  pdf.setFont(font, 'bold'); pdf.setFontSize(compact ? 10 : 13); pdf.text(String(business.business_name), brandX, compact ? 13 : 17);
  if (!compact) {
    pdf.setFont(font, 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...MUTED);
    const contact = [business.tax_id ? `NIT / identificación: ${business.tax_id}` : '', [business.address, business.city].filter(Boolean).join(', '), business.phone ? `Tel. ${business.phone}` : '', business.whatsapp ? `WhatsApp ${business.whatsapp}` : '', business.email || '', business.website || ''].filter(Boolean);
    contact.slice(0, 4).forEach((line, index) => pdf.text(String(line), brandX, 22 + index * 4));
  }
  pdf.setTextColor(...GOLD_DARK); pdf.setFont(font, 'bold'); pdf.setFontSize(compact ? 10 : 17); pdf.text(data.title, right, compact ? 13 : 16, { align: 'right' });
  pdf.setTextColor(...INK); pdf.setFontSize(compact ? 8 : 10); pdf.text(String(data.number), right, compact ? 18 : 22, { align: 'right' });
  if (!compact) {
    pdf.setFont(font, 'normal'); pdf.setFontSize(7.8); pdf.setTextColor(...MUTED); pdf.text(`Fecha: ${formatDate(data.doc.created_at)}`, right, 27, { align: 'right' });
    if (!data.isSale) pdf.text(data.doc.valid_until ? `Válida hasta: ${formatDate(data.doc.valid_until)}` : 'Vigencia sin definir', right, 32, { align: 'right' });
    pdf.setFont(font, 'bold'); pdf.setTextColor(...GOLD_DARK); pdf.text(data.status, right, 38, { align: 'right' });
  }
  pdf.setDrawColor(...GOLD); pdf.setLineWidth(.6); pdf.line(left, compact ? 23 : 43, right, compact ? 23 : 43);
}

function addCustomerBlock(pdf, data, font) {
  const { customer, doc, isSale } = data;
  const entries = [['Cliente', customer.full_name], ['Documento', customer.identification], ['Teléfono', customer.phone || customer.phone_original], ['Correo', customer.email], ['Dirección', [customer.address, customer.city].filter(Boolean).join(', ')], ...(isSale && doc.payment_method ? [['Método de pago', doc.payment_method]] : [])].filter(([, value]) => value);
  const top = 48; const height = Math.max(18, Math.ceil(entries.length / 2) * 10 + 7);
  pdf.setFillColor(...PAPER); pdf.setDrawColor(...LINE); pdf.roundedRect(14, top, 182, height, 2, 2, 'FD');
  entries.forEach(([label, value], index) => {
    const column = index % 2; const row = Math.floor(index / 2); const x = 18 + column * 90; const y = top + 7 + row * 10;
    pdf.setFont(font, 'bold'); pdf.setFontSize(6.8); pdf.setTextColor(...MUTED); pdf.text(label.toUpperCase(), x, y);
    pdf.setFont(font, 'normal'); pdf.setFontSize(8.5); pdf.setTextColor(...INK); pdf.text(pdf.splitTextToSize(String(value), 78)[0] || '', x, y + 4);
  });
  return top + height + 6;
}

function ensureRoom(pdf, y, required, data, logoData, font) {
  if (y + required <= pdf.internal.pageSize.getHeight() - 22) return y;
  pdf.addPage(); addPdfHeader(pdf, data, logoData, true, font); return 31;
}

function writePdfSection(pdf, data, logoData, font, title, text, y) {
  if (!text) return y;
  const lines = pdf.splitTextToSize(String(text), 178); y = ensureRoom(pdf, y, Math.min(18 + lines.length * 4, 54), data, logoData, font);
  pdf.setFont(font, 'bold'); pdf.setFontSize(8); pdf.setTextColor(...GOLD_DARK); pdf.text(title.toUpperCase(), 14, y);
  y += 5; pdf.setFont(font, 'normal'); pdf.setFontSize(8.3); pdf.setTextColor(...INK);
  for (const line of lines) { y = ensureRoom(pdf, y, 6, data, logoData, font); pdf.text(line, 14, y); y += 4.2; }
  return y + 4;
}

function addTotals(pdf, data, logoData, font, y) {
  y = ensureRoom(pdf, y, 38, data, logoData, font); const x = 127; const width = 69;
  const rows = [['Subtotal', data.doc.subtotal, false], ...(Number(data.doc.discount_total) ? [[(data.doc.coupon_snapshot?.code || data.doc.coupon_code) ? `Cupón ${data.doc.coupon_snapshot?.code || data.doc.coupon_code}` : 'Descuentos', Number(data.doc.discount_total), true]] : []), ['Entrega', Number(data.doc.delivery_cost || 0), false]];
  pdf.setFontSize(8.7); pdf.setTextColor(...INK);
  rows.forEach(([label, value, subtract]) => { pdf.setFont(font, 'normal'); pdf.text(label, x, y); pdf.setFont(font, 'bold'); pdf.text(`${subtract ? '− ' : ''}${formatMoney(value)}`, x + width, y, { align: 'right' }); y += 6; });
  pdf.setDrawColor(...GOLD); pdf.setLineWidth(.7); pdf.line(x, y, x + width, y); y += 7;
  pdf.setFont(font, 'bold'); pdf.setFontSize(12); pdf.setTextColor(...GOLD_DARK); pdf.text('TOTAL COP', x, y); pdf.text(formatMoney(data.doc.total), x + width, y, { align: 'right' });
  return y + 9;
}

function addPageFooters(pdf, data, font) {
  const pages = pdf.getNumberOfPages(); const contact = data.business.email || data.business.phone || data.business.whatsapp || '';
  for (let page = 1; page <= pages; page += 1) {
    pdf.setPage(page); const height = pdf.internal.pageSize.getHeight(); const width = pdf.internal.pageSize.getWidth();
    pdf.setDrawColor(...LINE); pdf.setLineWidth(.25); pdf.line(14, height - 15, width - 14, height - 15);
    pdf.setFont(font, 'normal'); pdf.setFontSize(7); pdf.setTextColor(...MUTED); pdf.text(`${data.number}${contact ? ` · ${contact}` : ''}`, 14, height - 10); pdf.text(`Página ${page} de ${pages}`, width - 14, height - 10, { align: 'right' });
  }
}

export async function buildCommercialPdf({ kind, doc, settings }) {
  const data = documentData(kind, doc, settings); validateDocument(data);
  await (document.fonts?.ready || Promise.resolve());
  const jsPDF = globalThis.jspdf?.jsPDF;
  if (!jsPDF) throw new Error('El generador de PDF no está disponible. Recarga el panel e inténtalo de nuevo.');
  const logo = await imageData(data.business.logo_url);
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', putOnlyUsedFonts: true, compress: true });
  if (typeof pdf.autoTable !== 'function') throw new Error('El componente de tablas PDF no está disponible. Recarga el panel.');
  const font = await loadPdfFonts(pdf);
  pdf.setProperties({ title: `${data.title} ${data.number}`, subject: `${data.title} para ${data.customer.full_name}`, author: data.business.business_name, creator: data.business.business_name });
  addPdfHeader(pdf, data, logo, false, font); const startY = addCustomerBlock(pdf, data, font);
  pdf.autoTable({
    startY, margin: { top: 29, right: 14, bottom: 22, left: 14 },
    head: [['#', 'Producto / servicio', 'Cant.', 'Precio unit.', 'Desc. (COP)', 'Importe']],
    body: data.items.map((item, index) => [String(index + 1), [item.product_name, item.sku ? `Ref. ${item.sku}` : '', optionText(item.option_snapshot)].filter(Boolean).join('\n'), String(Number(item.quantity)), formatMoney(item.unit_price), Number(item.discount || 0) ? formatMoney(item.discount) : '—', formatMoney(item.line_total)]),
    styles: { font, fontSize: 7.8, textColor: INK, cellPadding: { top: 2.8, right: 2, bottom: 2.8, left: 2 }, lineColor: LINE, lineWidth: { bottom: .15 }, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.3, halign: 'left' },
    columnStyles: { 0: { cellWidth: 8, halign: 'center' }, 1: { cellWidth: 73 }, 2: { cellWidth: 13, halign: 'center' }, 3: { cellWidth: 29, halign: 'right' }, 4: { cellWidth: 27, halign: 'right' }, 5: { cellWidth: 31, halign: 'right', fontStyle: 'bold' } },
    rowPageBreak: 'avoid', didDrawPage: hook => { if (hook.pageNumber > 1) addPdfHeader(pdf, data, logo, true, font); }
  });
  let y = addTotals(pdf, data, logo, font, pdf.lastAutoTable.finalY + 7);
  if (data.returns.length) y = writePdfSection(pdf, data, logo, font, 'Devoluciones registradas', data.returns.map(item => `${formatDate(item.created_at)} · ${Number(item.quantity)} unidad(es) · ${item.restocked ? 'reintegradas al inventario' : 'sin reintegro'}${item.note ? ` · ${item.note}` : ''}`).join('\n'), y);
  y = writePdfSection(pdf, data, logo, font, 'Observaciones', data.doc.notes, y); y = writePdfSection(pdf, data, logo, font, data.isSale ? 'Condiciones' : 'Condiciones comerciales', data.terms, y);
  if (data.isSale) y = writePdfSection(pdf, data, logo, font, 'Garantía', data.warranty, y);
  const notice = data.isSale ? SALE_LEGAL_NOTICE : 'Esta cotización no reserva inventario. Precios y disponibilidad se confirman al momento de la venta.';
  y = ensureRoom(pdf, y, 18, data, logo, font); pdf.setFillColor(248, 243, 232); pdf.setDrawColor(205, 182, 138); pdf.roundedRect(14, y, 182, 13, 2, 2, 'FD');
  pdf.setFont(font, 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...INK); pdf.text(pdf.splitTextToSize(notice, 174), 18, y + 5);
  addPageFooters(pdf, data, font); return pdf;
}

export async function downloadCommercialDocument({ kind, doc, settings }) {
  const pdf = await buildCommercialPdf({ kind, doc, settings }); const filename = commercialDocumentFilename({ kind, doc }); pdf.save(filename); return filename;
}

export async function printCommercialDocument({ kind, doc, settings }) {
  const previous = document.querySelector('#document-print-frame');
  if (previous?.dataset.objectUrl) URL.revokeObjectURL(previous.dataset.objectUrl);
  previous?.remove();

  // Imprimir y descargar comparten este mismo PDF. autoPrint solo añade la orden
  // de abrir el diálogo de impresión; no cambia la plantilla ni sus datos.
  const pdf = await buildCommercialPdf({ kind, doc, settings });
  if (typeof pdf.autoPrint !== 'function') throw new Error('La impresión PDF no está disponible. Recarga el panel e inténtalo de nuevo.');
  pdf.autoPrint();
  const objectUrl = URL.createObjectURL(pdf.output('blob'));
  const frame = document.createElement('iframe'); frame.id = 'document-print-frame'; frame.title = 'PDF listo para imprimir'; frame.setAttribute('aria-hidden', 'true');
  frame.dataset.objectUrl = objectUrl; frame.dataset.filename = commercialDocumentFilename({ kind, doc }); frame.dataset.pages = String(pdf.getNumberOfPages());
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0', pointerEvents: 'none' });
  frame.src = objectUrl; document.body.append(frame);
  return frame.dataset.filename;
}
