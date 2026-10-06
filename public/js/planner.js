/**
 * planner.js — la page d'un planning, en lecture (/p/<id>) ou en édition (/e/<jeton>).
 *
 * Tout l'état tient dans `state` ; chaque modification passe par commit(),
 * qui redessine la page et programme une sauvegarde automatique. Le serveur
 * refuse une sauvegarde basée sur une version périmée (409) : on propose alors
 * de charger l'autre version ou d'écraser avec la sienne.
 */
import { $, $$, esc, icon, safeUrl, uid, debounce, money, parseAmount, initials, toast, copyText,
         openModal, confirmDialog, bindThemeToggle, bindMenus } from './lib/util.js';
import { api } from './lib/api.js';
import { rememberPlan, findRecent, forgetPlan } from './lib/recent.js';
import { forecast, bindPlaceAutocomplete } from './lib/weather.js';
import * as M from './lib/model.js';

const app = $('#app');
const actionsBar = $('#topbar-actions');
const modePill = $('#mode-pill');

const state = {
  mode: 'view',
  viewId: null,
  editToken: null,
  knownEditToken: null,   // lien d'édition retrouvé dans « mes plannings récents »
  version: 0,
  plan: null,
  weather: {},
  week: 'all',
  mobileDay: null,
  saving: false,
  changedDuringSave: false,
  dirty: false,
  saveState: 'saved',
  conflict: null,
};

const isEdit = () => state.mode === 'edit';
// Les cartes réutilisées dans la feuille d'impression s'y affichent toujours en lecture.
let printing = false;
const canEdit = () => isEdit() && !printing;
const toneClass = (tone) => `tone-${M.TONES.includes(tone) ? tone : 'grey'}`;

// ════════════════════════════════════════════════════════════════
// Démarrage
// ════════════════════════════════════════════════════════════════
async function boot() {
  const [, kind, id] = location.pathname.match(/^\/(p|e)\/([A-Za-z0-9]+)\/?$/) || [];
  if (!kind) return showError('Adresse invalide', 'Ce lien ne correspond à aucun planning.');

  let result;
  try {
    result = kind === 'e' ? await api.getEdit(id) : await api.getView(id);
  } catch (err) {
    if (err.status === 404) {
      if (kind === 'p') forgetPlan(id);
      return showError(
        kind === 'e' ? 'Lien d\'édition invalide' : 'Planning introuvable',
        'Ce planning n\'existe pas ou plus : il a peut-être été supprimé, ou n\'a pas été ouvert depuis plus d\'un an.'
      );
    }
    return showError('Chargement impossible', esc(err.message), true);
  }

  state.mode = kind === 'e' ? 'edit' : 'view';
  state.viewId = result.viewId;
  state.editToken = result.editToken || null;
  state.version = result.version;
  state.plan = M.normalize(result.data);

  remember();
  if (!isEdit()) state.knownEditToken = findRecent(state.viewId)?.editToken || null;

  const dates = M.dateRange(state.plan.startDate, state.plan.endDate);
  const today = M.todayISO();
  const todayIndex = dates.indexOf(today);
  state.mobileDay = todayIndex >= 0 ? today : dates[0];
  // Séjour en cours : on ouvre sur la semaine d'aujourd'hui.
  const allWeeks = M.weeks(dates);
  state.week = allWeeks.length === 1 ? 'all' : Math.max(0, allWeeks.findIndex((w) => w.includes(today)));

  renderTopbar();
  render();
  loadWeather();

  const params = new URLSearchParams(location.search);
  if (params.has('bienvenue')) {
    history.replaceState(null, '', location.pathname);
    openShareModal(true);
  }
}

function remember() {
  const p = state.plan;
  rememberPlan({
    viewId: state.viewId,
    editToken: state.editToken,
    title: p.title,
    startDate: p.startDate,
    endDate: p.endDate,
    destination: p.destination?.name || '',
  });
}

function showError(title, message, retry = false) {
  document.title = `${title} · HolidayHub`;
  actionsBar.innerHTML = themeButton();
  bindThemeToggle($('[data-theme-toggle]'));
  app.innerHTML = `
    <div class="error-state">
      <div>
        <h1>${esc(title)}</h1>
        <p style="margin:0.75rem auto 1.5rem">${message}</p>
        <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap">
          ${retry ? '<button class="btn" data-reload>Réessayer</button>' : ''}
          <a class="btn" href="/">${icon('home')} Accueil</a>
          <a class="btn btn-primary" href="/nouveau">${icon('plus')} Créer un planning</a>
        </div>
      </div>
    </div>`;
  $('[data-reload]', app)?.addEventListener('click', () => location.reload());
}

async function loadWeather() {
  const p = state.plan;
  if (!p.destination?.lat) { state.weather = {}; return; }
  state.weather = await forecast(p.destination, p.startDate, p.endDate);
  if (Object.keys(state.weather).length) render();
}

// ════════════════════════════════════════════════════════════════
// Sauvegarde automatique
// ════════════════════════════════════════════════════════════════
const scheduleSave = debounce(save, 900);

function commit({ weather = false } = {}) {
  state.dirty = true;
  if (state.saving) state.changedDuringSave = true;
  setSaveState('pending');
  render();
  scheduleSave();
  if (weather) loadWeather();
}

async function save() {
  if (!isEdit() || state.conflict) return;
  if (state.saving) { state.changedDuringSave = true; return; }
  state.saving = true;
  state.changedDuringSave = false;
  setSaveState('saving');
  try {
    const res = await api.save(state.editToken, state.version, state.plan);
    state.version = res.version;
    state.dirty = state.changedDuringSave;
    setSaveState(state.dirty ? 'pending' : 'saved');
    remember();
  } catch (err) {
    if (err.status === 409 && err.body?.current) {
      state.conflict = err.body.current;
      setSaveState('error', 'Conflit');
      render();
    } else {
      setSaveState('error', err.status === 0 ? 'Hors ligne' : 'Erreur');
      toast(err.message, 'error', 4000);
      setTimeout(() => { if (state.dirty) scheduleSave(); }, 5000);
    }
  } finally {
    state.saving = false;
    if (state.changedDuringSave && !state.conflict) scheduleSave();
  }
}

function setSaveState(s, label) {
  state.saveState = s;
  const el = $('#save-status');
  if (!el) return;
  const text = label || { saved: 'Enregistré', saving: 'Enregistrement…', pending: 'Modifié', error: 'Erreur' }[s];
  el.dataset.state = s;
  el.innerHTML = `<span class="save-text">${esc(text)}</span>`;
  el.title = text;
}

window.addEventListener('beforeunload', (e) => {
  if (isEdit() && (state.dirty || state.saving)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isEdit() && state.dirty && !state.saving) scheduleSave.flush();
});

// ════════════════════════════════════════════════════════════════
// Barre du haut
// ════════════════════════════════════════════════════════════════
function themeButton() {
  return '<button class="btn btn-ghost btn-icon" data-theme-toggle></button>';
}

function renderTopbar() {
  modePill.hidden = false;
  modePill.className = 'mode-pill hide-mobile' + (isEdit() ? ' editing' : '');
  modePill.innerHTML = isEdit() ? `${icon('edit', 'icon-sm')} Édition` : `${icon('eye', 'icon-sm')} Lecture seule`;

  if (isEdit()) {
    actionsBar.innerHTML = `
      <span class="save-status" id="save-status" data-state="saved"><span class="save-text">Enregistré</span></span>
      <button class="btn btn-primary" data-action="share">${icon('share')}<span class="btn-label">Partager</span></button>
      ${themeButton()}
      <div class="menu">
        <button class="btn btn-ghost btn-icon" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="Plus d'actions">${icon('more')}</button>
        <div class="menu-list" hidden>
          <button data-action="settings">${icon('settings')} Paramètres du planning</button>
          <button data-action="print">${icon('print')} Imprimer / PDF</button>
          <button data-action="duplicate">${icon('copy')} Dupliquer</button>
          <a href="/p/${esc(state.viewId)}" target="_blank" rel="noopener">${icon('eye')} Voir en lecture seule</a>
          <hr>
          <a href="/nouveau">${icon('plus')} Nouveau planning</a>
          <button class="danger" data-action="delete">${icon('trash')} Supprimer le planning</button>
        </div>
      </div>`;
  } else {
    actionsBar.innerHTML = `
      ${state.knownEditToken ? `<a class="btn btn-primary" href="/e/${esc(state.knownEditToken)}">${icon('edit')}<span class="btn-label">Modifier</span></a>` : ''}
      <button class="btn ${state.knownEditToken ? '' : 'btn-primary'}" data-action="print">${icon('print')}<span class="btn-label">Imprimer</span></button>
      ${themeButton()}
      <div class="menu">
        <button class="btn btn-ghost btn-icon" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="Plus d'actions">${icon('more')}</button>
        <div class="menu-list" hidden>
          <button data-action="share">${icon('share')} Partager ce planning</button>
          <button data-action="duplicate">${icon('copy')} En faire une copie modifiable</button>
          <hr>
          <a href="/nouveau">${icon('plus')} Créer mon planning</a>
        </div>
      </div>`;
  }
  bindThemeToggle($('[data-theme-toggle]', actionsBar));
}

// ════════════════════════════════════════════════════════════════
// Rendu
// ════════════════════════════════════════════════════════════════
function render() {
  const p = state.plan;
  document.title = `${p.title} · HolidayHub`;

  // Un redessin complet ne doit faire perdre ni le champ en cours, ni le défilement.
  const focusKey = document.activeElement?.dataset?.focusKey;
  const scrollX = $('.grid-view')?.scrollLeft || 0;
  const stripX = $('.day-strip')?.scrollLeft;

  const dates = M.dateRange(p.startDate, p.endDate);
  const allWeeks = M.weeks(dates);
  if (state.week !== 'all' && !allWeeks[state.week]) state.week = 'all';
  if (!dates.includes(state.mobileDay)) state.mobileDay = dates[0];
  const visible = state.week === 'all' ? dates : allWeeks[state.week];
  const counters = M.tagCounters(p);

  const cards = [legendCard(), menusCard(), budgetCard()];
  if (p.notice.enabled) cards.push(noticeCard());

  app.innerHTML = `
    ${state.conflict ? conflictBanner() : ''}
    ${headerSection(dates)}
    <section class="meta-grid ${cards.length === 3 ? 'three' : ''}">${cards.join('')}</section>
    ${weekBar(allWeeks)}
    <div class="grid-view table-container screen-only">${tableHTML(visible, counters, true)}</div>
    ${dayView(dates, counters)}
    ${organisationSection()}`;

  if (focusKey) {
    const el = $(`[data-focus-key="${CSS.escape(focusKey)}"]`, app);
    if (el) el.focus();
  }
  const grid = $('.grid-view');
  if (grid) grid.scrollLeft = scrollX;
  const strip = $('.day-strip');
  if (strip) {
    if (stripX != null) strip.scrollLeft = stripX;
    const chip = $('.day-chip[aria-selected="true"]', strip);
    if (chip && stripX == null) strip.scrollLeft = chip.offsetLeft - strip.clientWidth / 2 + chip.clientWidth / 2;
  }
}

function conflictBanner() {
  return `
    <div class="banner" role="alert">
      ${icon('alert')}
      <span>Ce planning a été modifié ailleurs pendant que tu l'éditais. Tes dernières modifications ne sont pas enregistrées.</span>
      <button class="btn btn-sm" data-action="conflict-theirs">Charger leur version</button>
      <button class="btn btn-sm btn-primary" data-action="conflict-mine" style="margin-left:0">Garder la mienne</button>
    </div>`;
}

function headerSection(dates) {
  const p = state.plan;
  const n = p.participants.length;
  return `
    <header class="plan-header">
      <div class="plan-header-top">
        <h1 class="plan-title">${esc(p.title)}</h1>
        ${isEdit() ? `<button class="btn btn-sm no-print" data-action="settings" style="margin-left:auto">${icon('settings', 'icon-sm')}<span class="btn-label">Paramètres</span></button>` : ''}
      </div>
      ${p.subtitle ? `<div class="plan-subtitle">${esc(p.subtitle)}</div>` : ''}
      <div class="plan-facts">
        <span>${icon('calendar')} ${esc(cap(M.rangeLabel(p.startDate, p.endDate)))} · ${esc(M.durationLabel(p.startDate, p.endDate))}</span>
        ${p.destination ? `<span>${icon('pin')} ${esc(p.destination.name)}</span>` : ''}
        ${n ? `<span>${icon('users')} ${n} participant${n > 1 ? 's' : ''}</span>` : ''}
      </div>
    </header>`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function cardHeader(title, action, iconName) {
  return `
    <div class="card-header">
      ${title}
      ${canEdit() && action ? `<div class="card-tools no-print"><button class="btn btn-ghost btn-icon btn-sm" data-action="${action}" aria-label="Modifier : ${esc(title)}" title="Modifier">${icon(iconName || 'edit', 'icon-sm')}</button></div>` : ''}
    </div>`;
}

function tagBadge(tag, suffix = '') {
  return `<span class="badge ${toneClass(tag.tone)} ${tag.tbd ? 'dashed' : ''}">${esc(tag.label)}${suffix ? ' ' + esc(suffix) : ''}</span>`;
}

function legendCard() {
  const p = state.plan;
  const usage = new Map();
  for (const { event } of M.allEvents(p)) for (const id of event.tags) usage.set(id, (usage.get(id) || 0) + 1);
  const rows = p.tags.map((tag) => {
    const n = usage.get(tag.id) || 0;
    const meaning = tag.counter ? `numéroté · ${n} prévu${n > 1 ? 's' : ''}` : tag.tbd ? 'non figé' : `${n} élément${n > 1 ? 's' : ''}`;
    return `<div class="kv-item">${tagBadge(tag, tag.counter ? 'X/' + n : '')}<span class="kv-label">${esc(meaning)}</span></div>`;
  });
  rows.push('<div class="kv-item"><span class="time-pill">00:00</span><span class="kv-label">Horaire cible</span></div>');
  return `
    <div class="card">
      ${cardHeader('Légende & statuts', 'settings-tags')}
      <div class="kv-list">${rows.join('')}</div>
    </div>`;
}

function menusCard() {
  const p = state.plan;
  const tbd = M.mealsToDecide(p);
  const hasMealPeriods = p.periods.some((x) => x.meal);
  let list;
  if (canEdit()) {
    list = `
      <ul class="check-list">
        ${p.menus.map((m) => `
          <li class="check-item ${m.done ? 'done' : ''}">
            <input type="checkbox" class="checkbox" data-change="menu-done" data-id="${esc(m.id)}" ${m.done ? 'checked' : ''} aria-label="Placé dans le planning : ${esc(m.label)}">
            <span class="check-text">${esc(m.label)}</span>
            <button class="btn btn-ghost btn-icon btn-sm row-delete" data-action="menu-delete" data-id="${esc(m.id)}" aria-label="Supprimer ${esc(m.label)}">${icon('x', 'icon-sm')}</button>
          </li>`).join('')}
      </ul>
      <form class="inline-add no-print" data-add="menu">
        <input class="input input-sm" name="label" placeholder="Ajouter un menu…" maxlength="80" data-focus-key="add-menu" aria-label="Nouveau menu">
        <button class="btn btn-sm btn-icon" aria-label="Ajouter">${icon('plus', 'icon-sm')}</button>
      </form>`;
  } else {
    list = p.menus.length
      ? `<ul class="bullet-list">${p.menus.map((m) => `<li${m.done ? ' style="text-decoration:line-through;opacity:.6"' : ''}>${esc(m.label)}</li>`).join('')}</ul>`
      : '<p class="empty-hint">Aucun menu prévu pour l\'instant.</p>';
  }
  return `
    <div class="card">
      ${cardHeader('Menus prévus')}
      ${list}
      ${hasMealPeriods ? `<div style="margin-top:auto"><span class="badge tone-grey dashed">Repas à déterminer : ${tbd}</span></div>` : ''}
    </div>`;
}

function budgetCard() {
  const p = state.plan;
  const b = M.budgetSummary(p);
  const rows = b.rows.map((r) => `
    <div class="kv-item">
      <span class="kv-label">${esc(r.label)} <span class="kv-sub">(${r.mode === 'pp' ? 'par pers.' : 'global'})</span></span>
      <span class="kv-value">${money(r.amount)}</span>
    </div>`);
  if (p.budget.includeEvents && b.pricedEvents.length) {
    rows.push(`
      <div class="kv-item">
        <span class="kv-label">Activités & restos <span class="kv-sub">(par pers.)</span></span>
        <span class="kv-value">${money(b.eventsPerPerson)}</span>
      </div>`);
  }
  return `
    <div class="card">
      ${cardHeader(`Budget (${b.n} pers.)`, 'budget')}
      <div class="kv-list">
        ${rows.length ? rows.join('') : '<p class="empty-hint">Aucun poste de dépense. Les prix saisis dans le planning s\'ajoutent automatiquement.</p>'}
        <div class="kv-item total">
          <span class="kv-label">Total par pers.</span>
          <span class="kv-value highlight">~${money(b.perPerson)}</span>
        </div>
        <div class="kv-item"><span class="kv-sub">Total groupe</span><span class="kv-sub">~${money(b.groupTotal)}</span></div>
      </div>
    </div>`;
}

function noticeCard() {
  const n = state.plan.notice;
  return `
    <div class="card notice-card">
      ${cardHeader('⚠️ ' + esc(n.title || 'À savoir'), 'settings-notice')}
      <div class="notice-text">${esc(n.text)}</div>
    </div>`;
}

const weekRange = (w) => (w.length === 1 ? M.dayMonth(w[0]) : `${M.dayMonth(w[0])} – ${M.dayMonth(w.at(-1))}`);

function weekBar(allWeeks) {
  const tabs = allWeeks.length > 1 ? `
    <div class="week-tabs hide-mobile" role="tablist" aria-label="Semaines">
      <button class="week-tab" role="tab" data-action="week" data-week="all" aria-selected="${state.week === 'all'}">Tout le séjour</button>
      ${allWeeks.map((w, i) => `
        <button class="week-tab" role="tab" data-action="week" data-week="${i}" aria-selected="${state.week === i}">
          Semaine ${i + 1}<small>${esc(weekRange(w))}</small>
        </button>`).join('')}
    </div>` : '';
  const hint = isEdit()
    ? 'Clique sur une case pour ajouter, glisse un événement pour le déplacer.'
    : '';
  if (!tabs && !hint) return '';
  return `<div class="week-bar screen-only">${tabs}${hint ? `<span class="week-bar-hint">${esc(hint)}</span>` : ''}</div>`;
}

// ── Grille ───────────────────────────────────────────────────────
function weatherFor(date) {
  const day = M.peekDay(state.plan, date);
  const auto = state.weather[date];
  if (day.weather && (day.weatherAlert || !auto)) return { text: day.weather, alert: !!day.weatherAlert, summary: 'Saisie manuelle' };
  return auto || null;
}

function dayBadges(date) {
  const day = M.peekDay(state.plan, date);
  const wx = weatherFor(date);
  const out = [];
  if (day.label) out.push(`<span class="badge badge-label">${esc(day.label)}</span>`);
  if (wx) out.push(`<span class="badge badge-weather ${wx.alert ? 'alert' : ''}" title="${esc(wx.summary || '')}">${esc(wx.text)}</span>`);
  return out.join('');
}

function tableHTML(dates, counters, interactive) {
  const p = state.plan;
  const edit = interactive && isEdit();
  const today = M.todayISO();
  const minWidth = interactive ? `style="min-width:${64 + dates.length * 145}px"` : '';
  const head = dates.map((date) => {
    const inner = `
      <span class="day-title">${esc(M.dayShort(date))}${date === today ? '<span class="today-dot" title="Aujourd\'hui"></span>' : ''}</span>
      <span class="day-badges">${dayBadges(date)}</span>`;
    return `<th class="${date === today && interactive ? 'today-col' : ''}" scope="col">
      ${edit ? `<button class="day-header" data-action="edit-day" data-date="${date}" title="Modifier la journée">${inner}</button>` : `<div class="day-header">${inner}</div>`}
    </th>`;
  }).join('');

  const rows = p.periods.map((period) => `
    <tr>
      <th class="axis ${toneClass(period.tone)}" scope="row"><div class="period-axis-label">${esc(period.name)}</div></th>
      ${dates.map((date) => `
        <td class="${date === today && interactive ? 'today-col' : ''}" data-date="${date}" data-period="${esc(period.id)}">
          <div class="cell">${M.cellEvents(p, date, period.id).map((e) => eventHTML(e, counters, edit)).join('')}</div>
          ${edit ? `<button class="add-event no-print" data-action="add-event" data-date="${date}" data-period="${esc(period.id)}" aria-label="Ajouter un événement le ${esc(M.dayLong(date))}, ${esc(period.name)}">${icon('plus', 'icon-sm')} Ajouter</button>` : ''}
        </td>`).join('')}
    </tr>`).join('');

  return `
    <table class="roadmap" ${minWidth}>
      <thead><tr><th class="axis" aria-label="Période"></th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function eventHTML(e, counters, edit) {
  const p = state.plan;
  const tags = e.tags.map((id) => M.tagById(p, id)).filter(Boolean);
  const numbers = counters.get(e.id) || {};
  const meta = [];
  if (e.location) {
    const maps = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(e.location + (p.destination ? ', ' + p.destination.name : ''));
    meta.push(`<a class="event-location" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">${icon('pin')}${esc(e.location)}</a>`);
  }
  if (e.price && e.price.amount > 0) {
    meta.push(`<span class="event-price">${money(e.price.amount)}${e.price.mode === 'total' ? ' (groupe)' : '/pers.'}</span>`);
  }
  if (tags.length) meta.push(`<span class="event-tags">${tags.map((t) => tagBadge(t, numbers[t.id] || '')).join('')}</span>`);
  if (e.notes) meta.push(`<span class="event-notes">${esc(e.notes)}</span>`);
  const url = safeUrl(e.url);
  if (url) {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* garde l'URL */ }
    meta.push(`<a class="event-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${icon('external')}${esc(host)}</a>`);
  }

  const attrs = edit
    ? `class="event-block clickable" data-event="${esc(e.id)}" draggable="true" role="button" tabindex="0" aria-label="Modifier : ${esc(e.title)}"`
    : 'class="event-block"';
  return `
    <div ${attrs}>
      <div class="event-header">
        ${e.time ? `<span class="time-pill">${esc(e.time)}</span>` : ''}
        <span class="event-task">${esc(e.title)}</span>
      </div>
      ${meta.length ? `<div class="event-meta">${meta.join('')}</div>` : ''}
    </div>`;
}

// ── Vue jour par jour (mobile) ───────────────────────────────────
function dayView(dates, counters) {
  const p = state.plan;
  const date = state.mobileDay;
  const i = dates.indexOf(date);
  const today = M.todayISO();
  const edit = isEdit();

  const chips = dates.map((d) => `
    <button class="day-chip ${d === today ? 'is-today' : ''}" role="tab" data-action="mobile-day" data-date="${d}" aria-selected="${d === date}">
      ${esc(M.weekdayShort(d))}<strong>${M.parseISO(d).getUTCDate()}</strong>
    </button>`).join('');

  const periods = p.periods.map((period) => {
    const events = M.cellEvents(p, date, period.id);
    return `
      <div class="day-period ${toneClass(period.tone)}" data-date="${date}" data-period="${esc(period.id)}">
        <div class="day-period-bar"></div>
        <div class="day-period-body">
          <div class="day-period-name">${esc(period.name)}</div>
          ${events.length ? events.map((e) => eventHTML(e, counters, edit)).join('') : (edit ? '' : '<span class="day-empty">Rien de prévu</span>')}
          ${edit ? `<button class="add-event always" data-action="add-event" data-date="${date}" data-period="${esc(period.id)}">${icon('plus', 'icon-sm')} Ajouter</button>` : ''}
        </div>
      </div>`;
  }).join('');

  const head = `
    <span class="day-title">${esc(M.dayLong(date))}${date === today ? '<span class="today-dot"></span>' : ''}</span>
    <span class="day-badges">${dayBadges(date)}</span>`;

  return `
    <div class="day-view screen-only">
      <div class="day-strip" role="tablist" aria-label="Jours du séjour">${chips}</div>
      <div class="day-card" id="day-card">
        <div class="day-card-head">
          <button class="btn btn-ghost btn-icon btn-sm" data-action="day-prev" ${i <= 0 ? 'disabled' : ''} aria-label="Jour précédent">${icon('left')}</button>
          ${edit ? `<button class="day-header" data-action="edit-day" data-date="${date}">${head}</button>` : `<div class="day-header">${head}</div>`}
          <button class="btn btn-ghost btn-icon btn-sm" data-action="day-next" ${i >= dates.length - 1 ? 'disabled' : ''} aria-label="Jour suivant">${icon('right')}</button>
        </div>
        ${periods}
      </div>
    </div>`;
}

// ── Organisation : participants et listes ────────────────────────
function organisationSection() {
  const p = state.plan;
  const edit = canEdit();
  if (!edit && !p.participants.length && !p.lists.length) return '';

  const tones = ['green', 'blue', 'amber', 'purple', 'teal', 'pink', 'red', 'grey'];
  const people = `
    <div class="card">
      ${cardHeader(`Participants (${p.participants.length})`)}
      ${p.participants.length ? `
        <div class="chip-list">
          ${p.participants.map((x, i) => `
            <span class="person-chip">
              <span class="avatar tone-${tones[i % tones.length]}">${esc(initials(x.name))}</span>
              ${esc(x.name)}
              ${edit ? `<button class="chip-x no-print" data-action="person-delete" data-id="${esc(x.id)}" aria-label="Retirer ${esc(x.name)}">${icon('x', 'icon-sm')}</button>` : ''}
            </span>`).join('')}
        </div>` : '<p class="empty-hint">Ajoute les participants : le budget par personne se calcule avec eux.</p>'}
      ${edit ? `
        <form class="inline-add no-print" data-add="person">
          <input class="input input-sm" name="label" placeholder="Prénom…" maxlength="40" data-focus-key="add-person" aria-label="Nouveau participant">
          <button class="btn btn-sm btn-icon" aria-label="Ajouter">${icon('plus', 'icon-sm')}</button>
        </form>` : ''}
    </div>`;

  const lists = p.lists.map((list) => {
    const done = list.items.filter((x) => x.done).length;
    const pct = list.items.length ? Math.round((done / list.items.length) * 100) : 0;
    return `
      <div class="card">
        <div class="card-header">
          ${esc(list.title)} <span style="font-weight:600;color:var(--text-tertiary)">${done}/${list.items.length}</span>
          ${edit ? `
            <div class="card-tools no-print">
              <button class="btn btn-ghost btn-icon btn-sm" data-action="list-rename" data-list="${esc(list.id)}" aria-label="Renommer la liste" title="Renommer">${icon('edit', 'icon-sm')}</button>
              <button class="btn btn-ghost btn-icon btn-sm" data-action="list-delete" data-list="${esc(list.id)}" aria-label="Supprimer la liste" title="Supprimer">${icon('trash', 'icon-sm')}</button>
            </div>` : ''}
        </div>
        ${list.items.length ? `<div class="list-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>` : ''}
        <ul class="check-list">
          ${list.items.map((item) => `
            <li class="check-item ${item.done ? 'done' : ''}">
              <input type="checkbox" class="checkbox" data-change="item-done" data-list="${esc(list.id)}" data-id="${esc(item.id)}" ${item.done ? 'checked' : ''} ${edit ? '' : 'disabled'} aria-label="${esc(item.text)}">
              <span class="check-text">${esc(item.text)}</span>
              ${edit ? `<button class="btn btn-ghost btn-icon btn-sm row-delete no-print" data-action="item-delete" data-list="${esc(list.id)}" data-id="${esc(item.id)}" aria-label="Supprimer ${esc(item.text)}">${icon('x', 'icon-sm')}</button>` : ''}
            </li>`).join('')}
        </ul>
        ${!list.items.length && !edit ? '<p class="empty-hint">Liste vide.</p>' : ''}
        ${edit ? `
          <form class="inline-add no-print" data-add="item" data-list="${esc(list.id)}">
            <input class="input input-sm" name="label" placeholder="Ajouter…" maxlength="120" data-focus-key="add-item-${esc(list.id)}" aria-label="Nouvel élément dans ${esc(list.title)}">
            <button class="btn btn-sm btn-icon" aria-label="Ajouter">${icon('plus', 'icon-sm')}</button>
          </form>` : ''}
      </div>`;
  }).join('');

  return `
    <section class="print-lists">
      <div class="section-title">
        <h2>Organisation</h2>
        ${edit ? `<button class="btn btn-sm no-print" data-action="add-list">${icon('plus', 'icon-sm')} Nouvelle liste</button>` : ''}
      </div>
      <div class="lists-grid">${people}${lists}</div>
    </section>`;
}

// ── Impression ───────────────────────────────────────────────────
// Zone imprimable d'un A4 paysage avec 8 mm de marge, en pixels CSS (96 ppp),
// moins une petite réserve pour les arrondis du moteur d'impression.
const PAGE_W = 1062;
const PAGE_H = 724;
const MAX_ZOOM = 1.15;
// En dessous, les mots se coupent au milieu dans les colonnes de la grille.
const MIN_DAY_COL = 150;

state.print = { mode: null, cards: true, details: true, lists: false };

function printMode() {
  const days = M.daysBetween(state.plan.startDate, state.plan.endDate) + 1;
  return state.print.mode || (days <= 10 ? 'single' : 'weeks');
}

function printRoot() {
  let root = $('#print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'print-root';
    root.className = 'print-root';
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);
  }
  return root;
}

/** Le HTML des pages à imprimer : le planning (une page, ou une par semaine), puis l'organisation. */
function printSheetsHTML() {
  const p = state.plan;
  const opts = state.print;
  const dates = M.dateRange(p.startDate, p.endDate);
  const allWeeks = M.weeks(dates);
  const groups = printMode() === 'weeks' && allWeeks.length > 1 ? allWeeks : [dates];
  const counters = M.tagCounters(p);
  const withLists = opts.lists && (p.participants.length || p.lists.length);
  const total = groups.length + (withLists ? 1 : 0);
  const n = p.participants.length;
  const sub = [
    p.subtitle,
    cap(M.rangeLabel(p.startDate, p.endDate)) + ' · ' + M.durationLabel(p.startDate, p.endDate),
    p.destination?.name,
    n ? `${n} participant${n > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' | ');

  const head = (badge) => `
    <header class="ps-head">
      <div><h1>${esc(p.title)}</h1><div class="ps-sub">${esc(sub)}</div></div>
      ${badge ? `<span class="ps-week">${esc(badge)}</span>` : ''}
    </header>`;
  const foot = (page) => `
    <footer class="ps-foot">
      <img src="/img/logo.svg" alt=""><strong>HolidayHub</strong>
      <span>${esc(location.host)}/p/${esc(state.viewId)}</span>
      ${total > 1 ? `<span class="ps-page">Page ${page}/${total}</span>` : ''}
    </footer>`;

  printing = true;
  try {
    const cards = [legendCard(), menusCard(), budgetCard()];
    if (p.notice.enabled) cards.push(noticeCard());
    const pages = groups.map((g, i) => `
      <div class="print-sheet ${opts.details ? '' : 'ps-no-details'}" data-days="${g.length}">
        ${head(groups.length > 1 ? `Semaine ${i + 1} · ${weekRange(g)}` : '')}
        ${i === 0 && opts.cards ? `<section class="ps-meta" style="grid-template-columns:repeat(${cards.length},minmax(0,1fr))">${cards.join('')}</section>` : ''}
        <div class="ps-table">${tableHTML(g, counters, false)}</div>
        ${foot(i + 1)}
      </div>`);
    if (withLists) {
      pages.push(`
        <div class="print-sheet">
          ${head('')}
          ${organisationSection()}
          ${foot(total)}
        </div>`);
    }
    return pages.join('');
  } finally {
    printing = false;
  }
}

/**
 * Cherche le zoom qui fait tenir la feuille sur une page. La feuille est mise en
 * page sur une largeur PAGE_W / zoom puis réduite d'autant : en rapetissant, elle
 * s'élargit, le texte se replie moins, et la page reste remplie en largeur.
 */
function fitSheet(sheet) {
  sheet.style.zoom = '';
  // Plafond de zoom : chaque jour garde au moins MIN_DAY_COL pixels de large.
  const days = Number(sheet.dataset.days) || 0;
  const ceiling = days ? Math.min(MAX_ZOOM, PAGE_W / (60 + days * MIN_DAY_COL)) : MAX_ZOOM;
  const fits = (z) => {
    sheet.style.width = PAGE_W / z + 'px';
    return sheet.scrollHeight * z <= PAGE_H;
  };
  let lo = 0.25, hi = ceiling;
  let best = lo;
  if (fits(hi)) best = hi;
  else for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (fits(mid)) { best = lo = mid; } else hi = mid; }
  sheet.style.width = PAGE_W / best + 'px';
  sheet.style.zoom = String(best);
  // Le zoom arrondit les polices : on vérifie la taille réelle et on resserre si besoin.
  for (let i = 0; i < 10 && sheet.getBoundingClientRect().height > PAGE_H; i++) {
    best *= 0.98;
    sheet.style.width = PAGE_W / best + 'px';
    sheet.style.zoom = String(best);
  }
  // Place restante (semaine peu remplie, plafond de largeur atteint) : la grille
  // s'étire jusqu'en bas de la page plutôt que de laisser une demi-page blanche.
  const table = sheet.querySelector('.roadmap');
  const spare = PAGE_H - sheet.getBoundingClientRect().height;
  if (table && spare > 8) {
    table.style.height = (table.getBoundingClientRect().height + spare - 4) / best + 'px';
    for (let i = 0; i < 5 && sheet.getBoundingClientRect().height > PAGE_H; i++) {
      table.style.height = parseFloat(table.style.height) - 6 / best + 'px';
    }
  }
  return best;
}

function preparePrint() {
  const root = printRoot();
  root.innerHTML = printSheetsHTML();
  return $$('.print-sheet', root).map(fitSheet);
}

window.addEventListener('beforeprint', () => { if (state.plan) preparePrint(); });
window.addEventListener('afterprint', () => { const root = $('#print-root'); if (root) root.innerHTML = ''; });

function openPrintModal() {
  const p = state.plan;
  const weekCount = M.weeks(M.dateRange(p.startDate, p.endDate)).length;
  const hasLists = p.participants.length || p.lists.length;
  const o = state.print;
  const radio = (value, label, hint, disabled = false) => `
    <label class="radio-line ${disabled ? 'disabled' : ''}">
      <input type="radio" name="ps-mode" value="${value}" ${printMode() === value ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span>${label}<small>${hint}</small></span>
    </label>`;
  const check = (key, label, disabled = false) => `
    <label class="check-line ${disabled ? 'disabled' : ''}"><input type="checkbox" class="checkbox" data-opt="${key}" ${o[key] && !disabled ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${label}</label>`;

  const m = openModal({
    title: 'Imprimer / exporter en PDF',
    wide: true,
    body: `
      <div class="print-dialog">
        <div class="print-options">
          <fieldset>
            <legend>Mise en page</legend>
            ${radio('single', 'Tout le séjour sur une page', 'Idéal jusqu\'à 10 jours environ.')}
            ${radio('weeks', 'Une page par semaine', weekCount > 1 ? `${weekCount} pages, plus lisibles.` : 'Le séjour tient en une semaine.', weekCount < 2)}
          </fieldset>
          <fieldset>
            <legend>Contenu</legend>
            ${check('cards', 'Cartes légende, menus, budget')}
            ${check('details', 'Notes et liens des événements')}
            ${check('lists', 'Page « Organisation » (listes, participants)', !hasLists)}
          </fieldset>
          <p class="print-tip">Dans la fenêtre qui s'ouvre, choisis <strong>Enregistrer au format PDF</strong> comme imprimante. L'orientation paysage et l'échelle sont déjà réglées.</p>
        </div>
        <div class="print-previews" id="ps-previews" aria-label="Aperçu"></div>
      </div>`,
    foot: `<span class="spacer"></span><button class="btn" data-close>Fermer</button><button class="btn btn-primary" data-go>${icon('print', 'icon-sm')} Imprimer / PDF</button>`,
  });
  m.el.closest('.modal').classList.add('modal-xl');

  const previews = $('#ps-previews', m.el);
  function refresh() {
    const zooms = preparePrint();
    const sheets = $$('#print-root .print-sheet');
    // La largeur réelle n'est connue qu'une fois la fenêtre affichée.
    const width = Math.min(previews.clientWidth - 32, 760) || 600;
    const scale = width / 1123;
    previews.innerHTML = '';
    sheets.forEach((sheet, i) => {
      const page = document.createElement('div');
      page.className = 'ps-preview';
      page.style.width = width + 'px';
      page.style.height = 794 * scale + 'px';
      const inner = document.createElement('div');
      inner.className = 'ps-preview-inner';
      inner.style.transform = `scale(${scale})`;
      inner.appendChild(sheet.cloneNode(true));
      page.appendChild(inner);
      previews.appendChild(page);
      const label = document.createElement('div');
      label.className = 'ps-preview-label';
      label.textContent = `Page ${i + 1}/${sheets.length}` + (zooms[i] < 0.6 ? ' · très dense, essaie « une page par semaine »' : '');
      previews.appendChild(label);
    });
  }

  m.el.addEventListener('change', (e) => {
    if (e.target.name === 'ps-mode') o.mode = e.target.value;
    if (e.target.dataset.opt) o[e.target.dataset.opt] = e.target.checked;
    refresh();
  });
  $('[data-go]', m.el).addEventListener('click', () => window.print());
  document.fonts.ready.then(() => requestAnimationFrame(refresh));
}

// ════════════════════════════════════════════════════════════════
// Interactions
// ════════════════════════════════════════════════════════════════
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) {
    // Un clic sur un événement (hors lien) l'ouvre en édition.
    const block = e.target.closest('.event-block[data-event]');
    if (block && isEdit() && !e.target.closest('a')) openEventModal({ eventId: block.dataset.event });
    return;
  }
  const p = state.plan;
  const { action } = el.dataset;
  switch (action) {
    case 'share': return openShareModal(false);
    case 'print': return openPrintModal();
    case 'duplicate': return openDuplicateModal();
    case 'delete': return deletePlan();
    case 'settings': return openSettingsModal('general');
    case 'settings-tags': return openSettingsModal('tags');
    case 'settings-notice': return openSettingsModal('notice');
    case 'budget': return openBudgetModal();
    case 'add-event': return openEventModal({ date: el.dataset.date, periodId: el.dataset.period });
    case 'edit-day': return openDayModal(el.dataset.date);
    case 'week':
      state.week = el.dataset.week === 'all' ? 'all' : Number(el.dataset.week);
      return render();
    case 'mobile-day':
      state.mobileDay = el.dataset.date;
      return render();
    case 'day-prev':
    case 'day-next': return stepDay(action === 'day-next' ? 1 : -1);
    case 'menu-delete':
      p.menus = p.menus.filter((m) => m.id !== el.dataset.id);
      return commit();
    case 'person-delete':
      p.participants = p.participants.filter((x) => x.id !== el.dataset.id);
      return commit();
    case 'item-delete': {
      const list = p.lists.find((l) => l.id === el.dataset.list);
      if (list) list.items = list.items.filter((x) => x.id !== el.dataset.id);
      return commit();
    }
    case 'add-list': return openListModal(null);
    case 'list-rename': return openListModal(el.dataset.list);
    case 'list-delete': {
      const list = p.lists.find((l) => l.id === el.dataset.list);
      if (!list) return;
      const ok = !list.items.length || await confirmDialog({
        title: 'Supprimer la liste ?',
        message: `La liste « ${esc(list.title)} » et ses ${list.items.length} élément(s) seront supprimés.`,
        confirmLabel: 'Supprimer', danger: true,
      });
      if (ok) { p.lists = p.lists.filter((l) => l !== list); commit(); }
      return;
    }
    case 'conflict-theirs':
      state.plan = M.normalize(state.conflict.data);
      state.version = state.conflict.version;
      state.conflict = null;
      state.dirty = false;
      setSaveState('saved');
      render();
      return loadWeather();
    case 'conflict-mine':
      state.version = state.conflict.version;
      state.conflict = null;
      render();
      return save();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.event-block[data-event]')) {
    e.preventDefault();
    openEventModal({ eventId: e.target.dataset.event });
  }
});

app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el || !isEdit()) return;
  const p = state.plan;
  if (el.dataset.change === 'menu-done') {
    const m = p.menus.find((x) => x.id === el.dataset.id);
    if (m) m.done = el.checked;
  } else if (el.dataset.change === 'item-done') {
    const item = p.lists.find((l) => l.id === el.dataset.list)?.items.find((x) => x.id === el.dataset.id);
    if (item) item.done = el.checked;
  }
  commit();
});

app.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-add]');
  if (!form) return;
  e.preventDefault();
  const value = form.elements.label.value.trim();
  if (!value) return;
  const p = state.plan;
  if (form.dataset.add === 'menu') p.menus.push({ id: uid(), label: value, done: false });
  if (form.dataset.add === 'person') {
    // « Léa, Tom, Inès » ajoute trois personnes d'un coup.
    value.split(/[,;]/).map((s) => s.trim()).filter(Boolean).forEach((name) => p.participants.push({ id: uid(), name: name.slice(0, 40) }));
  }
  if (form.dataset.add === 'item') {
    const list = p.lists.find((l) => l.id === form.dataset.list);
    if (list) list.items.push({ id: uid(), text: value, done: false });
  }
  commit();
});

function stepDay(delta) {
  const dates = M.dateRange(state.plan.startDate, state.plan.endDate);
  const i = dates.indexOf(state.mobileDay) + delta;
  if (i < 0 || i >= dates.length) return;
  state.mobileDay = dates[i];
  render();
  const strip = $('.day-strip');
  const chip = $('.day-chip[aria-selected="true"]', strip);
  if (strip && chip) strip.scrollTo({ left: chip.offsetLeft - strip.clientWidth / 2 + chip.clientWidth / 2, behavior: 'smooth' });
}

// Balayage horizontal sur la carte du jour (mobile).
let touch = null;
app.addEventListener('touchstart', (e) => {
  if (!e.target.closest('#day-card')) return;
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
app.addEventListener('touchend', (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 50) stepDay(dx < 0 ? 1 : -1);
}, { passive: true });

// ── Glisser-déposer (grille, ordinateur) ─────────────────────────
let dragId = null;
app.addEventListener('dragstart', (e) => {
  const block = e.target.closest?.('.event-block[data-event]');
  if (!block || !isEdit()) return;
  dragId = block.dataset.event;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
  requestAnimationFrame(() => block.classList.add('dragging'));
});
app.addEventListener('dragend', () => {
  dragId = null;
  $$('.dragging, .drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
});
app.addEventListener('dragover', (e) => {
  if (!dragId) return;
  const td = e.target.closest('td[data-date]');
  if (!td) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  $$('.drop-target').forEach((x) => x !== td.firstElementChild && x.classList.remove('drop-target'));
  td.firstElementChild.classList.add('drop-target');
});
app.addEventListener('drop', (e) => {
  const td = e.target.closest('td[data-date]');
  if (!dragId || !td) return;
  e.preventDefault();
  // Déposé sur un événement : on s'insère avant lui ; ailleurs dans la case : à la fin.
  const before = e.target.closest('.event-block[data-event]');
  let index = null;
  if (before && before.dataset.event !== dragId) {
    const target = M.findEvent(state.plan, before.dataset.event);
    const self = M.findEvent(state.plan, dragId);
    index = target.index;
    if (self && self.date === target.date && self.periodId === target.periodId && self.index < target.index) index--;
  }
  M.moveEvent(state.plan, dragId, td.dataset.date, td.dataset.period, index);
  dragId = null;
  commit();
});

// ════════════════════════════════════════════════════════════════
// Fenêtres d'édition
// ════════════════════════════════════════════════════════════════
function toneSwatches(name, current) {
  return `<div class="swatches" role="radiogroup">${M.TONES.map((t) => `
    <button type="button" class="swatch tone-${t}" data-swatch="${name}" data-tone="${t}" aria-pressed="${t === current}" aria-label="${M.TONE_NAMES[t]}" title="${M.TONE_NAMES[t]}"></button>`).join('')}</div>`;
}

// ── Événement ────────────────────────────────────────────────────
function openEventModal({ eventId, date, periodId }) {
  const p = state.plan;
  const found = eventId ? M.findEvent(p, eventId) : null;
  if (eventId && !found) return;
  const ev = found ? found.event : M.newEvent();
  const curDate = found ? found.date : date;
  const curPeriod = found ? found.periodId : periodId;
  const dates = M.dateRange(p.startDate, p.endDate);
  const selected = new Set(ev.tags);

  const body = `
    <form id="event-form" class="modal-form" style="display:flex;flex-direction:column;gap:1rem">
      <div class="field">
        <label for="ev-title">Quoi ?</label>
        <input class="input" id="ev-title" name="title" required maxlength="120" value="${esc(ev.title)}" placeholder="Session plage, Aqualand, Soirée barbecue…" autofocus>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="ev-time">Heure</label>
          <input class="input" id="ev-time" name="time" type="time" value="${esc(/^\d{2}:\d{2}$/.test(ev.time) ? ev.time : '')}">
        </div>
        <div class="field" style="grid-column: span 2">
          <label for="ev-location">Lieu</label>
          <input class="input" id="ev-location" name="location" maxlength="120" value="${esc(ev.location)}" placeholder="Cap d'Agde, Appartement…">
        </div>
      </div>
      <div class="field">
        <label for="ev-price">Prix</label>
        <div class="input-group">
          <input class="input" id="ev-price" name="price" inputmode="decimal" value="${ev.price?.amount ? String(ev.price.amount).replace('.', ',') : ''}" placeholder="0">
          <select class="select" name="priceMode" aria-label="Type de prix">
            <option value="pp" ${ev.price?.mode !== 'total' ? 'selected' : ''}>€ par personne</option>
            <option value="total" ${ev.price?.mode === 'total' ? 'selected' : ''}>€ pour le groupe</option>
          </select>
        </div>
        <span class="hint">Ajouté automatiquement au budget.</span>
      </div>
      <div class="field">
        <span class="label">Tags</span>
        <div class="chip-list" id="ev-tags">
          ${p.tags.map((t) => `
            <button type="button" class="toggle-chip ${toneClass(t.tone)}" data-tag="${esc(t.id)}" aria-pressed="${selected.has(t.id)}">
              <span class="dot"></span>${esc(t.label)}
            </button>`).join('') || '<span class="empty-hint">Aucun tag : crée-en dans les paramètres.</span>'}
        </div>
      </div>
      <div class="field">
        <label for="ev-notes">Notes</label>
        <textarea class="textarea" id="ev-notes" name="notes" maxlength="1000" placeholder="Réservation au nom de…, prévoir du liquide…">${esc(ev.notes)}</textarea>
      </div>
      <div class="field">
        <label for="ev-url">Lien</label>
        <input class="input" id="ev-url" name="url" type="url" inputmode="url" maxlength="500" value="${esc(ev.url)}" placeholder="https://… (billetterie, réservation)">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="ev-date">Jour</label>
          <select class="select" id="ev-date" name="date">
            ${dates.map((d) => `<option value="${d}" ${d === curDate ? 'selected' : ''}>${esc(M.dayLong(d))}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="ev-period">Période</label>
          <select class="select" id="ev-period" name="period">
            ${p.periods.map((x) => `<option value="${esc(x.id)}" ${x.id === curPeriod ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      ${dates.length > 1 ? `
        <details>
          <summary class="label" style="cursor:pointer;font-size:.8125rem;font-weight:600;color:var(--text-secondary)">Copier aussi sur d'autres jours</summary>
          <div class="chip-list" style="margin-top:.6rem" id="ev-repeat">
            ${dates.map((d) => `<button type="button" class="toggle-chip" data-repeat="${d}" aria-pressed="false">${esc(M.dayShort(d))}</button>`).join('')}
          </div>
        </details>` : ''}
    </form>`;

  const foot = `
    ${found ? `<button class="btn btn-danger" data-delete>${icon('trash', 'icon-sm')} Supprimer</button>` : ''}
    <span class="spacer"></span>
    <button class="btn" data-close>Annuler</button>
    <button class="btn btn-primary" data-save>${found ? 'Enregistrer' : 'Ajouter'}</button>`;

  const m = openModal({ title: found ? 'Modifier l\'événement' : 'Nouvel événement', body, foot });
  const form = $('#event-form', m.el);

  m.el.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag], [data-repeat]');
    if (chip) chip.setAttribute('aria-pressed', String(chip.getAttribute('aria-pressed') !== 'true'));
  });

  $('[data-delete]', m.el)?.addEventListener('click', () => {
    M.removeEvent(p, ev.id);
    m.close();
    commit();
    toast('Événement supprimé');
  });

  const submit = () => {
    const f = form.elements;
    const title = f.title.value.trim();
    if (!title) { f.title.focus(); f.title.reportValidity(); return; }
    const amount = parseAmount(f.price.value);
    const data = {
      title,
      time: f.time.value,
      location: f.location.value.trim(),
      price: amount ? { amount, mode: f.priceMode.value } : null,
      tags: $$('[data-tag][aria-pressed="true"]', m.el).map((b) => b.dataset.tag),
      notes: f.notes.value.trim(),
      url: f.url.value.trim(),
    };
    const targetDate = f.date.value;
    const targetPeriod = f.period.value;

    if (found) {
      Object.assign(ev, data);
      if (targetDate !== found.date || targetPeriod !== found.periodId) M.moveEvent(p, ev.id, targetDate, targetPeriod);
    } else {
      const day = M.getDay(p, targetDate);
      (day.cells[targetPeriod] = day.cells[targetPeriod] || []).push(M.newEvent(data));
    }
    const repeats = $$('[data-repeat][aria-pressed="true"]', m.el).map((b) => b.dataset.repeat).filter((d) => d !== targetDate);
    for (const d of repeats) {
      const day = M.getDay(p, d);
      (day.cells[targetPeriod] = day.cells[targetPeriod] || []).push(M.newEvent(structuredClone(data)));
    }
    m.close();
    commit();
    if (repeats.length) toast(`Copié sur ${repeats.length} autre(s) jour(s)`);
  };
  $('[data-save]', m.el).addEventListener('click', submit);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  // Entrée valide le formulaire depuis n'importe quel champ d'une ligne.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input') && !e.target.closest('.autocomplete')) { e.preventDefault(); submit(); }
  });
}

// ── Journée ──────────────────────────────────────────────────────
function openDayModal(date) {
  const p = state.plan;
  const day = M.peekDay(p, date);
  const auto = state.weather[date];
  const body = `
    <div class="field">
      <label for="day-label">Étiquette du jour</label>
      <input class="input" id="day-label" maxlength="40" value="${esc(day.label)}" placeholder="Arrivée, Départ, Excursion…" autofocus>
    </div>
    ${auto ? `
      <div class="share-box">
        <h3>${icon('cloud', 'icon-sm')} Prévision automatique</h3>
        <p>${esc(auto.text)} — ${esc(auto.summary)}</p>
      </div>` : ''}
    <div class="field">
      <label for="day-weather">Météo ${auto ? '(remplace la prévision si cochée en alerte)' : 'manuelle'}</label>
      <input class="input" id="day-weather" maxlength="60" value="${esc(day.weather)}" placeholder="31°C | Vent 15 km/h">
      ${!p.destination?.lat ? '<span class="hint">Choisis une ville dans les paramètres pour avoir la météo automatique (à moins de 16 jours).</span>' : ''}
    </div>
    <label class="check-line"><input type="checkbox" class="checkbox" id="day-alert" ${day.weatherAlert ? 'checked' : ''}> Marquer comme alerte météo ⚠️</label>`;
  const m = openModal({
    title: M.dayLong(date),
    body,
    foot: `<span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-save>Enregistrer</button>`,
  });
  const submit = () => {
    const d = M.getDay(p, date);
    d.label = $('#day-label', m.el).value.trim();
    d.weather = $('#day-weather', m.el).value.trim();
    d.weatherAlert = $('#day-alert', m.el).checked;
    m.close();
    commit();
  };
  $('[data-save]', m.el).addEventListener('click', submit);
  m.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[type=text], input:not([type])')) { e.preventDefault(); submit(); } });
}

// ── Liste ────────────────────────────────────────────────────────
function openListModal(listId) {
  const p = state.plan;
  const list = listId ? p.lists.find((l) => l.id === listId) : null;
  const m = openModal({
    title: list ? 'Renommer la liste' : 'Nouvelle liste',
    body: `
      <div class="field">
        <label for="list-title">Nom</label>
        <input class="input" id="list-title" maxlength="60" value="${esc(list?.title || '')}" placeholder="Courses, Bagages, À réserver…" autofocus>
      </div>`,
    foot: `<span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-save>${list ? 'Renommer' : 'Créer'}</button>`,
  });
  const submit = () => {
    const title = $('#list-title', m.el).value.trim();
    if (!title) return;
    if (list) list.title = title;
    else p.lists.push({ id: uid(), title, items: [] });
    m.close();
    commit();
  };
  $('[data-save]', m.el).addEventListener('click', submit);
  $('#list-title', m.el).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

// ── Budget ───────────────────────────────────────────────────────
function openBudgetModal() {
  const p = state.plan;
  const draft = structuredClone(p.budget.items);
  let includeEvents = p.budget.includeEvents;

  const m = openModal({
    title: 'Budget',
    body: '<div id="budget-body" style="display:flex;flex-direction:column;gap:1rem"></div>',
    foot: `<span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-save>Enregistrer</button>`,
  });
  const host = $('#budget-body', m.el);

  function paint() {
    const n = M.peopleCount(p);
    host.innerHTML = `
      <p class="modal-text" style="font-size:.875rem">Calcul pour <strong>${n} personne${n > 1 ? 's' : ''}</strong> (d'après la liste des participants). Un poste « global » est divisé entre tous.</p>
      <div class="edit-rows">
        ${draft.map((item, i) => `
          <div class="edit-row" data-i="${i}">
            <div class="edit-row-main">
              <input class="input input-sm" data-field="label" value="${esc(item.label)}" placeholder="Courses, Essence, Logement…" maxlength="60" aria-label="Poste">
              <div class="input-group">
                <input class="input input-sm" data-field="amount" inputmode="decimal" value="${item.amount ? String(item.amount).replace('.', ',') : ''}" placeholder="0" aria-label="Montant">
                <select class="select input-sm" data-field="mode" aria-label="Type">
                  <option value="total" ${item.mode !== 'pp' ? 'selected' : ''}>€ global</option>
                  <option value="pp" ${item.mode === 'pp' ? 'selected' : ''}>€ par pers.</option>
                </select>
              </div>
            </div>
            <div class="edit-row-tools"><button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove="${i}" aria-label="Supprimer le poste">${icon('trash', 'icon-sm')}</button></div>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-sm" data-add-row style="align-self:flex-start">${icon('plus', 'icon-sm')} Ajouter un poste</button>
      <label class="check-line"><input type="checkbox" class="checkbox" id="budget-events" ${includeEvents ? 'checked' : ''}> Ajouter les prix saisis dans le planning (activités, restos…)</label>`;
  }
  paint();

  host.addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const item = draft[Number(row.dataset.i)];
    const f = e.target.dataset.field;
    if (f === 'label') item.label = e.target.value;
    if (f === 'amount') item.amount = parseAmount(e.target.value) || 0;
    if (f === 'mode') item.mode = e.target.value;
  });
  host.addEventListener('change', (e) => {
    if (e.target.id === 'budget-events') includeEvents = e.target.checked;
    if (e.target.dataset.field === 'mode') draft[Number(e.target.closest('[data-i]').dataset.i)].mode = e.target.value;
  });
  host.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-row]')) {
      draft.push({ id: uid(), label: '', amount: 0, mode: 'total' });
      paint();
      $$('[data-field="label"]', host).at(-1)?.focus();
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) { draft.splice(Number(rm.dataset.remove), 1); paint(); }
  });
  $('[data-save]', m.el).addEventListener('click', () => {
    p.budget.items = draft.filter((x) => x.label.trim()).map((x) => ({ ...x, label: x.label.trim() }));
    p.budget.includeEvents = includeEvents;
    m.close();
    commit();
  });
}

// ── Paramètres ───────────────────────────────────────────────────
function openSettingsModal(initialTab) {
  const p = state.plan;
  const draft = {
    title: p.title,
    subtitle: p.subtitle,
    destination: p.destination ? { ...p.destination } : null,
    destText: p.destination?.label || p.destination?.name || '',
    startDate: p.startDate,
    endDate: p.endDate,
    periods: structuredClone(p.periods),
    tags: structuredClone(p.tags),
    notice: { ...p.notice },
  };
  let tab = initialTab;
  const TABS = [['general', 'Général'], ['periods', 'Périodes'], ['tags', 'Tags'], ['notice', 'Encadré']];

  const m = openModal({
    title: 'Paramètres du planning',
    wide: true,
    body: '<div id="settings-body" style="display:flex;flex-direction:column;gap:1rem"></div>',
    foot: `<span class="form-error" id="settings-error"></span><span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-save>Enregistrer</button>`,
  });
  // Les onglets se glissent entre l'en-tête et le contenu.
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.setAttribute('role', 'tablist');
  $('.modal-head', m.el).after(tabs);
  const host = $('#settings-body', m.el);

  function paintTabs() {
    tabs.innerHTML = TABS.map(([id, label]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${id === tab}">${label}</button>`).join('');
  }

  function paint() {
    paintTabs();
    if (tab === 'general') {
      host.innerHTML = `
        <div class="field">
          <label for="s-title">Titre</label>
          <input class="input" id="s-title" data-k="title" maxlength="120" value="${esc(draft.title)}">
        </div>
        <div class="field">
          <label for="s-subtitle">Sous-titre</label>
          <input class="input" id="s-subtitle" data-k="subtitle" maxlength="160" value="${esc(draft.subtitle)}" placeholder="Logistique, activités & budget">
        </div>
        <div class="field">
          <label for="s-dest">Destination</label>
          <div class="autocomplete"><input class="input" id="s-dest" value="${esc(draft.destText)}" placeholder="Port-la-Nouvelle, Barcelone…"></div>
          <span class="hint" id="s-dest-hint">${draft.destination?.lat ? `<span class="dest-picked">${icon('check', 'icon-sm')} Météo automatique activée</span>` : 'Choisis une ville dans la liste pour activer la météo automatique.'}</span>
        </div>
        <div class="field-row">
          <div class="field"><label for="s-start">Premier jour</label><input class="input" type="date" id="s-start" data-k="startDate" value="${draft.startDate}"></div>
          <div class="field"><label for="s-end">Dernier jour</label><input class="input" type="date" id="s-end" data-k="endDate" value="${draft.endDate}"></div>
        </div>`;
      const dest = $('#s-dest', host);
      dest.addEventListener('input', () => { draft.destText = dest.value; });
      bindPlaceAutocomplete(dest, (place) => {
        draft.destination = place;
        $('#s-dest-hint', host).innerHTML = place
          ? `<span class="dest-picked">${icon('check', 'icon-sm')} Météo automatique activée</span>`
          : 'Choisis une ville dans la liste pour activer la météo automatique.';
      });
    } else if (tab === 'periods') {
      host.innerHTML = `
        <p class="modal-text" style="font-size:.875rem">Les lignes de la grille. Une période « de repas » compte ses éléments « à déterminer » dans la carte Menus.</p>
        <div class="edit-rows">
          ${draft.periods.map((x, i) => `
            <div class="edit-row" data-i="${i}">
              <div class="edit-row-main">
                <input class="input input-sm" data-field="name" value="${esc(x.name)}" maxlength="24" aria-label="Nom de la période">
                <div class="edit-row-line">
                  ${toneSwatches('period', x.tone)}
                  <label class="check-line"><input type="checkbox" class="checkbox" data-field="meal" ${x.meal ? 'checked' : ''}> Période de repas</label>
                </div>
              </div>
              <div class="edit-row-tools">
                <button type="button" class="btn btn-ghost btn-icon btn-sm" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Monter">${icon('up', 'icon-sm')}</button>
                <button type="button" class="btn btn-ghost btn-icon btn-sm" data-move="1" ${i === draft.periods.length - 1 ? 'disabled' : ''} aria-label="Descendre">${icon('down', 'icon-sm')}</button>
                <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove ${draft.periods.length <= 1 ? 'disabled' : ''} aria-label="Supprimer">${icon('trash', 'icon-sm')}</button>
              </div>
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-sm" data-add-row style="align-self:flex-start">${icon('plus', 'icon-sm')} Ajouter une période</button>`;
    } else if (tab === 'tags') {
      host.innerHTML = `
        <p class="modal-text" style="font-size:.875rem">Les étiquettes à poser sur les événements. Un tag « numéroté » affiche sa position : <span class="badge tone-amber">Resto 2/4</span></p>
        <div class="edit-rows">
          ${draft.tags.map((x, i) => `
            <div class="edit-row" data-i="${i}">
              <div class="edit-row-main">
                <input class="input input-sm" data-field="label" value="${esc(x.label)}" maxlength="24" aria-label="Nom du tag">
                <div class="edit-row-line">${toneSwatches('tag', x.tone)}</div>
                <div class="edit-row-line">
                  <label class="check-line"><input type="checkbox" class="checkbox" data-field="counter" ${x.counter ? 'checked' : ''}> Numéroté (X/N)</label>
                  <label class="check-line"><input type="checkbox" class="checkbox" data-field="tbd" ${x.tbd ? 'checked' : ''}> Signifie « à déterminer »</label>
                </div>
              </div>
              <div class="edit-row-tools">
                <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove aria-label="Supprimer">${icon('trash', 'icon-sm')}</button>
              </div>
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-sm" data-add-row style="align-self:flex-start">${icon('plus', 'icon-sm')} Ajouter un tag</button>`;
    } else if (tab === 'notice') {
      host.innerHTML = `
        <label class="check-line"><input type="checkbox" class="checkbox" id="n-enabled" ${draft.notice.enabled ? 'checked' : ''}> Afficher l'encadré d'avertissement</label>
        <div class="field">
          <label for="n-title">Titre</label>
          <input class="input" id="n-title" maxlength="60" value="${esc(draft.notice.title)}">
        </div>
        <div class="field">
          <label for="n-text">Texte</label>
          <textarea class="textarea" id="n-text" maxlength="800" rows="5">${esc(draft.notice.text)}</textarea>
        </div>`;
    }
  }
  paint();

  const rowsKey = () => (tab === 'periods' ? 'periods' : 'tags');

  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; paint(); }
  });

  host.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.k) draft[t.dataset.k] = t.value;
    if (t.id === 'n-title') draft.notice.title = t.value;
    if (t.id === 'n-text') draft.notice.text = t.value;
    const row = t.closest('[data-i]');
    if (row && t.dataset.field && t.type !== 'checkbox') draft[rowsKey()][Number(row.dataset.i)][t.dataset.field] = t.value;
  });
  host.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'n-enabled') draft.notice.enabled = t.checked;
    const row = t.closest('[data-i]');
    if (row && t.type === 'checkbox') draft[rowsKey()][Number(row.dataset.i)][t.dataset.field] = t.checked;
  });
  host.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-i]');
    const list = draft[rowsKey()];
    const sw = e.target.closest('[data-swatch]');
    if (sw && row) { list[Number(row.dataset.i)].tone = sw.dataset.tone; paint(); return; }
    if (e.target.closest('[data-add-row]')) {
      if (tab === 'periods') list.push({ id: uid(), name: 'Nouvelle période', tone: 'grey', meal: false });
      else list.push({ id: uid(), label: 'Nouveau tag', tone: 'green' });
      paint();
      $$('.edit-row input', host).at(-1)?.select();
      return;
    }
    const mv = e.target.closest('[data-move]');
    if (mv && row) {
      const i = Number(row.dataset.i), j = i + Number(mv.dataset.move);
      [list[i], list[j]] = [list[j], list[i]];
      paint();
      return;
    }
    if (e.target.closest('[data-remove]') && row) {
      const item = list[Number(row.dataset.i)];
      if (tab === 'periods') {
        const n = Object.values(p.days).reduce((s, d) => s + (d.cells?.[item.id]?.length || 0), 0);
        if (n && !await confirmDialog({
          title: 'Supprimer la période ?',
          message: `« ${esc(item.name)} » contient ${n} événement(s), qui seront supprimés à l'enregistrement.`,
          confirmLabel: 'Supprimer', danger: true,
        })) return;
      }
      list.splice(Number(row.dataset.i), 1);
      paint();
    }
  });

  $('[data-save]', m.el).addEventListener('click', async () => {
    const err = $('#settings-error', m.el);
    const title = draft.title.trim();
    if (!title) { err.textContent = 'Le titre est obligatoire.'; tab = 'general'; paint(); return; }
    if (!draft.startDate || !draft.endDate || draft.endDate < draft.startDate) { err.textContent = 'Le dernier jour doit suivre le premier.'; tab = 'general'; paint(); return; }
    if (M.daysBetween(draft.startDate, draft.endDate) >= M.MAX_DAYS) { err.textContent = `Un séjour dure au plus ${M.MAX_DAYS} jours.`; tab = 'general'; paint(); return; }
    if (draft.periods.some((x) => !x.name.trim()) || draft.tags.some((x) => !x.label.trim())) { err.textContent = 'Chaque période et chaque tag doit avoir un nom.'; return; }

    const lost = M.eventsOutside(p, draft.startDate, draft.endDate);
    if (lost && !await confirmDialog({
      title: 'Raccourcir le séjour ?',
      message: `${lost} événement(s) prévus hors des nouvelles dates seront supprimés.`,
      confirmLabel: 'Continuer', danger: true,
    })) return;

    const weatherChanged = JSON.stringify(draft.destination) !== JSON.stringify(p.destination)
      || draft.startDate !== p.startDate || draft.endDate !== p.endDate;

    p.title = title;
    p.subtitle = draft.subtitle.trim();
    // Texte tapé sans choisir dans la liste : on garde le nom, sans coordonnées (pas de météo auto).
    const text = draft.destText.trim();
    p.destination = draft.destination || (text ? { name: text.split(',')[0].trim(), label: text, lat: null, lon: null } : null);
    p.startDate = draft.startDate;
    p.endDate = draft.endDate;
    M.pruneDays(p);
    p.periods = draft.periods.map((x) => ({ ...x, name: x.name.trim() }));
    p.tags = draft.tags.map((x) => ({ ...x, label: x.label.trim() }));
    p.notice = { ...draft.notice, title: draft.notice.title.trim(), text: draft.notice.text.trim() };

    // Ménage : cases de périodes supprimées, tags supprimés.
    const periodIds = new Set(p.periods.map((x) => x.id));
    const tagIds = new Set(p.tags.map((x) => x.id));
    for (const day of Object.values(p.days)) {
      for (const pid of Object.keys(day.cells)) if (!periodIds.has(pid)) delete day.cells[pid];
      for (const events of Object.values(day.cells)) for (const ev of events) ev.tags = ev.tags.filter((id) => tagIds.has(id));
    }

    m.close();
    commit({ weather: weatherChanged });
  });
}

// ── Partage ──────────────────────────────────────────────────────
function openShareModal(welcome) {
  const viewUrl = `${location.origin}/p/${state.viewId}`;
  const editUrl = state.editToken ? `${location.origin}/e/${state.editToken}` : null;
  const body = `
    ${welcome ? `<p class="modal-text">🎉 Ton planning est créé ! Il n'y a pas de compte : <strong>ces deux liens sont la seule façon d'y accéder</strong>. Il est aussi mémorisé dans « Mes plannings récents » sur cet appareil.</p>` : ''}
    <div class="share-box">
      <h3>${icon('eye', 'icon-sm')} Lien de lecture — à envoyer au groupe</h3>
      <p>Tout le monde peut consulter le planning, sans pouvoir le modifier.</p>
      <div class="copy-line">
        <input class="input input-sm" readonly value="${esc(viewUrl)}" aria-label="Lien de lecture">
        <button class="btn btn-sm" data-copy="${esc(viewUrl)}">${icon('copy', 'icon-sm')} Copier</button>
        ${navigator.share ? `<button class="btn btn-sm btn-icon" data-native-share aria-label="Partager">${icon('share', 'icon-sm')}</button>` : ''}
      </div>
    </div>
    ${editUrl ? `
      <div class="share-box secret">
        <h3>${icon('lock', 'icon-sm')} Lien d'édition — à garder précieusement</h3>
        <p>Quiconque a ce lien peut modifier ou supprimer le planning. Ne le donne qu'aux co-organisateurs.</p>
        <div class="copy-line">
          <input class="input input-sm" readonly value="${esc(editUrl)}" aria-label="Lien d'édition">
          <button class="btn btn-sm" data-copy="${esc(editUrl)}">${icon('copy', 'icon-sm')} Copier</button>
        </div>
      </div>` : ''}`;
  const m = openModal({
    title: welcome ? 'Planning créé' : 'Partager le planning',
    body,
    foot: `<span class="spacer"></span><button class="btn btn-primary" data-close>${welcome ? 'C\'est parti' : 'Fermer'}</button>`,
  });
  m.el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) copyText(c.dataset.copy);
    if (e.target.closest('[data-native-share]')) {
      navigator.share({ title: state.plan.title, text: `Le planning « ${state.plan.title} »`, url: viewUrl }).catch(() => {});
    }
  });
  $$('input[readonly]', m.el).forEach((i) => i.addEventListener('focus', () => i.select()));
}

// ── Dupliquer ────────────────────────────────────────────────────
function openDuplicateModal() {
  const p = state.plan;
  const m = openModal({
    title: isEdit() ? 'Dupliquer le planning' : 'Faire une copie modifiable',
    body: `
      <p class="modal-text" style="font-size:.875rem">La copie est un nouveau planning, avec ses propres liens. L'original n'est pas touché.</p>
      <div class="field">
        <label for="d-title">Titre de la copie</label>
        <input class="input" id="d-title" maxlength="120" value="${esc(isEdit() ? 'Copie de ' + p.title : p.title)}" autofocus>
      </div>
      <div class="field">
        <label for="d-start">Premier jour</label>
        <input class="input" type="date" id="d-start" value="${p.startDate}">
        <span class="hint">Change la date pour décaler tout le planning (ex. l'année prochaine). ${esc(M.durationLabel(p.startDate, p.endDate))}.</span>
      </div>
      <label class="check-line"><input type="checkbox" class="checkbox" id="d-reset" checked> Décocher les listes et les menus</label>`,
    foot: `<span class="form-error" id="d-error"></span><span class="spacer"></span><button class="btn" data-close>Annuler</button><button class="btn btn-primary" data-save>${icon('copy', 'icon-sm')} Créer la copie</button>`,
  });
  $('[data-save]', m.el).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const title = $('#d-title', m.el).value.trim();
    const start = $('#d-start', m.el).value;
    if (!title || !start) return;
    const copy = M.shiftPlan(p, start);
    copy.title = title;
    if ($('#d-reset', m.el).checked) {
      copy.menus.forEach((x) => { x.done = false; });
      copy.lists.forEach((l) => l.items.forEach((x) => { x.done = false; }));
    }
    btn.disabled = true;
    try {
      const res = await api.create(copy);
      rememberPlan({ viewId: res.viewId, editToken: res.editToken, title, startDate: copy.startDate, endDate: copy.endDate, destination: copy.destination?.name });
      location.href = `/e/${res.editToken}?bienvenue=1`;
    } catch (err) {
      $('#d-error', m.el).textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ── Supprimer ────────────────────────────────────────────────────
async function deletePlan() {
  const ok = await confirmDialog({
    title: 'Supprimer définitivement ?',
    message: `« ${esc(state.plan.title)} » sera supprimé pour tout le monde, et ses liens ne fonctionneront plus. C'est irréversible.`,
    confirmLabel: 'Supprimer le planning',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.remove(state.editToken);
    forgetPlan(state.viewId);
    state.dirty = false;
    location.href = '/?supprime=1';
  } catch (err) {
    toast(err.message, 'error');
  }
}

bindMenus();
boot();
