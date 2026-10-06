/**
 * new.js — création d'un planning à partir d'un modèle.
 */
import { $, $$, esc, bindThemeToggle } from './lib/util.js';
import { api } from './lib/api.js';
import { rememberPlan } from './lib/recent.js';
import { bindPlaceAutocomplete } from './lib/weather.js';
import { TEMPLATES, buildPlan } from './lib/templates.js';
import { addDays, todayISO, daysBetween, durationLabel, rangeLabel, MAX_DAYS } from './lib/model.js';

bindThemeToggle($('[data-theme-toggle]'));

const form = $('#create-form');
const f = form.elements;
let destination = null;

$('#templates').innerHTML = TEMPLATES.map((t, i) => `
  <label class="template">
    <input type="radio" name="template" value="${t.id}" ${i === 1 ? 'checked' : ''}>
    <span class="template-emoji" aria-hidden="true">${t.emoji}</span>
    <strong>${esc(t.name)}</strong>
    <span>${esc(t.desc)}</span>
  </label>`).join('');

// Par défaut : samedi prochain, pour une semaine.
const today = todayISO();
const dow = new Date(today + 'T00:00:00Z').getUTCDay();
const nextSaturday = addDays(today, ((6 - dow + 7) % 7) || 7);
f.start.value = nextSaturday;
f.end.value = addDays(nextSaturday, 7);

function updateDuration() {
  const out = $('#duration');
  const s = f.start.value, e = f.end.value;
  if (!s || !e) { out.textContent = ''; return; }
  if (e < s) { out.textContent = ''; return; }
  out.textContent = `${rangeLabel(s, e)} · ${durationLabel(s, e)}`;
}

f.start.addEventListener('change', () => {
  // Le dernier jour suit le premier quand on le déplace avant lui.
  if (f.end.value && f.end.value < f.start.value) f.end.value = addDays(f.start.value, 7);
  updateDuration();
});
f.end.addEventListener('change', updateDuration);
updateDuration();

bindPlaceAutocomplete(f.destination, (place) => {
  destination = place;
  $('#dest-hint').innerHTML = place
    ? '<span class="dest-picked">✓ Météo automatique activée</span>'
    : 'Facultatif. Choisis une ville dans la liste pour la météo automatique.';
});

function fail(message, field) {
  $('#form-error').textContent = message;
  if (field) field.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#form-error').textContent = '';
  const title = f.title.value.trim();
  const start = f.start.value, end = f.end.value;
  if (!title) return fail('Donne un titre au planning.', f.title);
  if (!start || !end) return fail('Indique les dates du séjour.', f.start);
  if (end < start) return fail('Le dernier jour doit suivre le premier.', f.end);
  if (daysBetween(start, end) >= MAX_DAYS) return fail(`Un séjour dure au plus ${MAX_DAYS} jours.`, f.end);

  const typed = f.destination.value.trim();
  const dest = destination || (typed ? { name: typed.split(',')[0].trim(), label: typed, lat: null, lon: null } : null);
  const participants = f.people.value.split(/[,;\n]/).map((s) => s.trim().slice(0, 40)).filter(Boolean);
  const template = form.querySelector('input[name="template"]:checked')?.value || 'vierge';

  const plan = buildPlan(template, { title, startDate: start, endDate: end, destination: dest, participants });

  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Création…';
  try {
    const res = await api.create(plan);
    rememberPlan({ viewId: res.viewId, editToken: res.editToken, title, startDate: start, endDate: end, destination: dest?.name });
    location.href = `/e/${res.editToken}?bienvenue=1`;
  } catch (err) {
    fail(err.message);
    btn.disabled = false;
    btn.textContent = 'Créer le planning';
  }
});

// Entrée dans un champ simple ne doit pas créer le planning par surprise
// pendant qu'on choisit une ville dans l'autocomplétion.
$$('input', form).forEach((input) => input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && input === f.destination) e.preventDefault();
}));
