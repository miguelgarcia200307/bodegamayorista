// Fechas del CRM calculadas siempre con el día local de America/Bogota.
// Regla del 29 de febrero (idéntica a public.birthday_in_year en la base de datos):
// en años no bisiestos el cumpleaños se celebra el 28 de febrero y la edad cambia ese día.

const DAY_MS = 86400000;

export function bogotaTodayIso(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const isoToUtc = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const utcToIso = time => new Date(time).toISOString().slice(0, 10);

export function birthdayInYear(birthIso, year) {
  const [, month, day] = birthIso.split('-').map(Number);
  return utcToIso(Date.UTC(year, month - 1, month === 2 && day === 29 && !isLeapYear(year) ? 28 : day));
}

export function isValidBirthDate(value, todayIso = bogotaTodayIso()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && value <= todayIso && y >= 1900;
}

export function birthdayInfo(birthIso, todayIso = bogotaTodayIso()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthIso || '')) return null;
  const year = Number(todayIso.slice(0, 4));
  const birthYear = Number(birthIso.slice(0, 4));
  const today = isoToUtc(todayIso);
  const thisYear = birthdayInYear(birthIso, year);
  const age = year - birthYear - (todayIso < thisYear ? 1 : 0);
  const next = thisYear >= todayIso ? thisYear : birthdayInYear(birthIso, year + 1);
  return {
    age,
    next,
    days: Math.round((isoToUtc(next) - today) / DAY_MS),
    turning: Number(next.slice(0, 4)) - birthYear,
    thisYear,
    daysFromThisYear: Math.round((isoToUtc(thisYear) - today) / DAY_MS),
    inCurrentMonth: thisYear.slice(5, 7) === todayIso.slice(5, 7)
  };
}
