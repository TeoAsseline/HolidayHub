/**
 * model.js — la forme d'un planning et tous les calculs dérivés.
 *
 * Un planning est un simple objet JSON, stocké tel quel par le serveur :
 *
 *   {
 *     schema, title, subtitle, startDate, endDate,
 *     destination: { name, label, lat, lon } | null,
 *     notice:      { enabled, title, text },
 *     periods:     [{ id, name, tone, meal }],          lignes de la grille
 *     tags:        [{ id, label, tone, counter, tbd }], statuts et catégories
 *     days:        { 'AAAA-MM-JJ': { label, weather, weatherAlert, cells: { periodId: [event] } } },
 *     participants:[{ id, name }],
 *     budget:      { items: [{ id, label, amount, mode: 'total' | 'pp' }], includeEvents },
 *     menus:       [{ id, label, done }],
 *     lists:       [{ id, title, items: [{ id, text, done }] }],
 *   }
 *
 *   event = { id, time, title, location, price: { amount, mode } | null, tags: [tagId], notes, url }
 *
 * Aucun calcul (budget, compteur de restos, repas à déterminer…) n'est stocké :
 * tout est recalculé à l'affichage, donc toujours juste.
 */
import { uid } from './util.js';

export const SCHEMA = 1;
export const TONES = ['green', 'teal', 'blue', 'amber', 'red', 'purple', 'pink', 'grey'];
export const TONE_NAMES = {
  green: 'Vert', teal: 'Turquoise', blue: 'Bleu', amber: 'Ambre',
  red: 'Rouge', purple: 'Violet', pink: 'Rose', grey: 'Gris',
};
export const MAX_DAYS = 93;

export function defaultPeriods() {
  return [
    { id: 'reveil', name: 'Réveil', tone: 'purple', meal: false },
    { id: 'matin',  name: 'Matin',  tone: 'blue',   meal: false },
    { id: 'midi',   name: 'Midi',   tone: 'red',    meal: true },
    { id: 'aprem',  name: 'Aprèm',  tone: 'teal',   meal: false },
    { id: 'soiree', name: 'Soirée', tone: 'grey',   meal: true },
  ];
}

export function defaultTags() {
  return [
    { id: 'resto',    label: 'Resto',        tone: 'amber',  counter: true },
    { id: 'chill',    label: 'Chill',        tone: 'green' },
    { id: 'tbd',      label: 'À déterminer', tone: 'grey',   tbd: true },
    { id: 'activite', label: 'Activité',     tone: 'blue' },
    { id: 'trajet',   label: 'Trajet',       tone: 'purple' },
  ];
}

export const DEFAULT_NOTICE_TEXT =
  'Document de planification purement prévisionnel.\n\nRien n\'est figé : les horaires, trajets, repas et activités sont indicatifs et 100 % flexibles selon le contexte.';

export function emptyPlan({ title, startDate, endDate, destination = null, participants = [] }) {
  return {
    schema: SCHEMA,
    title,
    subtitle: '',
    startDate,
    endDate,
    destination,
    notice: { enabled: true, title: 'Statut du planning', text: DEFAULT_NOTICE_TEXT },
    periods: defaultPeriods(),
    tags: defaultTags(),
    days: {},
    participants: participants.map((name) => ({ id: uid(), name })),
    budget: { items: [], includeEvents: true },
    menus: [],
    lists: [],
  };
}

export function newEvent(fields = {}) {
  return { id: uid(), time: '', title: '', location: '', price: null, tags: [], notes: '', url: '', ...fields };
}

/** Complète un planning ancien ou incomplet pour que le reste du code n'ait jamais à douter. */
export function normalize(plan) {
  const p = { ...plan };
  p.schema = SCHEMA;
  p.subtitle = p.subtitle || '';
  p.destination = p.destination && p.destination.name ? p.destination : null;
  p.notice = { enabled: true, title: 'Statut du planning', text: DEFAULT_NOTICE_TEXT, ...(p.notice || {}) };
  p.periods = Array.isArray(p.periods) && p.periods.length ? p.periods : defaultPeriods();
  p.tags = Array.isArray(p.tags) ? p.tags : defaultTags();
  p.days = p.days && typeof p.days === 'object' ? p.days : {};
  p.participants = Array.isArray(p.participants) ? p.participants : [];
  p.budget = { items: [], includeEvents: true, ...(p.budget || {}) };
  p.menus = Array.isArray(p.menus) ? p.menus : [];
  p.lists = Array.isArray(p.lists) ? p.lists : [];
  for (const day of Object.values(p.days)) {
    day.cells = day.cells || {};
    for (const [pid, events] of Object.entries(day.cells)) {
      day.cells[pid] = (events || []).map((e) => newEvent({ ...e, id: e.id || uid(), tags: e.tags || [] }));
    }
  }
  return p;
}

// ── Dates ────────────────────────────────────────────────────────
// Tout est calculé en UTC : une date de séjour est un jour du calendrier,
// pas un instant, et ne doit pas glisser avec le fuseau ou l'heure d'été.
export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86_400_000);
}
export function todayISO() {
  const now = new Date();
  return toISO(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function dateRange(start, end) {
  const out = [];
  const n = daysBetween(start, end);
  for (let i = 0; i <= n && i < MAX_DAYS; i++) out.push(addDays(start, i));
  return out;
}

const fmtShortDay = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' });
const fmtLongDay  = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtDayMonth = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtFull     = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const fmtMonth    = new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: 'UTC' });

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** « Dim 19 » */
export function dayShort(iso) {
  const d = parseISO(iso);
  return cap(fmtShortDay.format(d).replace('.', '')) + ' ' + d.getUTCDate();
}
/** « Dim » */
export function weekdayShort(iso) {
  return cap(fmtShortDay.format(parseISO(iso)).replace('.', ''));
}
/** « Dimanche 19 juillet » */
export function dayLong(iso) {
  return cap(fmtLongDay.format(parseISO(iso)));
}
/** « 19 juil. » */
export function dayMonth(iso) {
  return fmtDayMonth.format(parseISO(iso));
}

/** « du 19 au 26 juillet 2026 », « du 28 juillet au 3 août 2026 »… */
export function rangeLabel(start, end) {
  const a = parseISO(start), b = parseISO(end);
  if (start === end) return 'le ' + fmtFull.format(a);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();
  if (sameMonth) return `du ${a.getUTCDate()} au ${b.getUTCDate()} ${fmtMonth.format(b)} ${b.getUTCFullYear()}`;
  if (sameYear) return `du ${a.getUTCDate()} ${fmtMonth.format(a)} au ${b.getUTCDate()} ${fmtMonth.format(b)} ${b.getUTCFullYear()}`;
  return `du ${fmtFull.format(a)} au ${fmtFull.format(b)}`;
}

export function durationLabel(start, end) {
  const days = daysBetween(start, end) + 1;
  const nights = days - 1;
  return `${days} jour${days > 1 ? 's' : ''}` + (nights > 0 ? ` · ${nights} nuit${nights > 1 ? 's' : ''}` : '');
}

/**
 * Découpe le séjour en semaines de 7 jours à partir du premier jour.
 * Un reliquat d'un ou deux jours (le dimanche du départ…) rejoint la semaine
 * précédente plutôt que de former un onglet presque vide.
 */
export function weeks(dates) {
  const out = [];
  for (let i = 0; i < dates.length; i += 7) out.push(dates.slice(i, i + 7));
  if (out.length > 1 && out.at(-1).length <= 2) out.at(-2).push(...out.pop());
  return out;
}

// ── Accès ────────────────────────────────────────────────────────
export function getDay(plan, date) {
  if (!plan.days[date]) plan.days[date] = { label: '', weather: '', weatherAlert: false, cells: {} };
  const day = plan.days[date];
  day.cells = day.cells || {};
  return day;
}

export function peekDay(plan, date) {
  return plan.days[date] || { label: '', weather: '', weatherAlert: false, cells: {} };
}

export function cellEvents(plan, date, periodId) {
  return plan.days[date]?.cells?.[periodId] || [];
}

export function tagById(plan, id) {
  return plan.tags.find((t) => t.id === id) || null;
}

/** Tous les événements du séjour, dans l'ordre de lecture : jour, période, position. */
export function allEvents(plan) {
  const out = [];
  for (const date of dateRange(plan.startDate, plan.endDate)) {
    const day = plan.days[date];
    if (!day) continue;
    for (const period of plan.periods) {
      for (const event of day.cells[period.id] || []) out.push({ date, period, event });
    }
  }
  return out;
}

export function findEvent(plan, eventId) {
  for (const [date, day] of Object.entries(plan.days)) {
    for (const [periodId, events] of Object.entries(day.cells || {})) {
      const index = events.findIndex((e) => e.id === eventId);
      if (index !== -1) return { date, periodId, index, event: events[index] };
    }
  }
  return null;
}

export function removeEvent(plan, eventId) {
  const found = findEvent(plan, eventId);
  if (found) plan.days[found.date].cells[found.periodId].splice(found.index, 1);
  return found;
}

export function moveEvent(plan, eventId, date, periodId, index = null) {
  const found = removeEvent(plan, eventId);
  if (!found) return;
  const day = getDay(plan, date);
  const list = (day.cells[periodId] = day.cells[periodId] || []);
  if (index === null || index > list.length) list.push(found.event);
  else list.splice(index, 0, found.event);
}

// ── Calculs ──────────────────────────────────────────────────────

/** Pour chaque tag « numéroté » (Resto…), la position de chaque événement : « 2/4 ». */
export function tagCounters(plan) {
  const counted = plan.tags.filter((t) => t.counter);
  const result = new Map(); // eventId → { tagId: 'n/N' }
  for (const tag of counted) {
    const events = allEvents(plan).filter(({ event }) => event.tags.includes(tag.id));
    events.forEach(({ event }, i) => {
      if (!result.has(event.id)) result.set(event.id, {});
      result.get(event.id)[tag.id] = `${i + 1}/${events.length}`;
    });
  }
  return result;
}

/** Repas encore à déterminer : événements tagués « à déterminer » dans une période de repas. */
export function mealsToDecide(plan) {
  const tbd = new Set(plan.tags.filter((t) => t.tbd).map((t) => t.id));
  return allEvents(plan).filter(({ period, event }) => period.meal && event.tags.some((id) => tbd.has(id))).length;
}

export function peopleCount(plan) {
  return Math.max(1, plan.participants.length);
}

/**
 * Budget par personne :
 *   postes « par personne » + postes globaux ÷ participants
 *   + prix des événements du planning (par personne, ou globaux ÷ participants).
 */
export function budgetSummary(plan) {
  const n = peopleCount(plan);
  const rows = plan.budget.items.map((item) => ({
    ...item,
    perPerson: item.mode === 'pp' ? item.amount : item.amount / n,
  }));

  let eventsPerPerson = 0;
  const pricedEvents = [];
  if (plan.budget.includeEvents) {
    for (const entry of allEvents(plan)) {
      const price = entry.event.price;
      if (!price || !(price.amount > 0)) continue;
      const pp = price.mode === 'total' ? price.amount / n : price.amount;
      eventsPerPerson += pp;
      pricedEvents.push({ ...entry, perPerson: pp });
    }
  }

  const itemsPerPerson = rows.reduce((s, r) => s + r.perPerson, 0);
  const perPerson = itemsPerPerson + eventsPerPerson;
  return { n, rows, eventsPerPerson, pricedEvents, perPerson, groupTotal: perPerson * n };
}

export function eventCount(plan) {
  return allEvents(plan).length;
}

/** Combien d'événements tomberaient hors du séjour si on changeait les dates. */
export function eventsOutside(plan, start, end) {
  let n = 0;
  for (const [date, day] of Object.entries(plan.days)) {
    if (date >= start && date <= end) continue;
    for (const events of Object.values(day.cells || {})) n += events.length;
  }
  return n;
}

/** Retire les jours hors séjour (après confirmation de l'utilisateur). */
export function pruneDays(plan) {
  for (const date of Object.keys(plan.days)) {
    if (date < plan.startDate || date > plan.endDate) delete plan.days[date];
  }
}

/** Copie profonde avec un nouveau premier jour : tout le contenu glisse avec. */
export function shiftPlan(plan, newStart) {
  const copy = structuredClone(plan);
  const offset = daysBetween(plan.startDate, newStart);
  if (offset === 0) return copy;
  copy.startDate = addDays(plan.startDate, offset);
  copy.endDate = addDays(plan.endDate, offset);
  copy.days = {};
  for (const [date, day] of Object.entries(plan.days)) copy.days[addDays(date, offset)] = day;
  return copy;
}
