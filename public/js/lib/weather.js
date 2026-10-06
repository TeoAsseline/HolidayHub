/**
 * weather.js — géocodage et prévisions via Open-Meteo (gratuit, sans clé).
 *
 * Les prévisions ne vont pas au-delà de 16 jours : pour un séjour plus lointain,
 * chaque jour garde sa météo saisie à la main. Quand les deux existent, la
 * prévision réelle l'emporte, sauf si la saisie manuelle est marquée comme alerte.
 */
import { addDays, todayISO } from './model.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_DAYS = 16;
const CACHE_MS = 60 * 60 * 1000;

const squash = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

async function geocode(name, count, signal) {
  const res = await fetch(`${GEO_URL}?name=${encodeURIComponent(name)}&count=${count}&language=fr&format=json`, { signal });
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

/**
 * Open-Meteo cherche mal les noms composés : « Port-la-Nouvelle » ne donne rien,
 * alors que « Port-la » trouve « Port-La Nouvelle ». Sans résultat, on raccourcit
 * la requête mot par mot et on ne garde que les villes qui correspondent vraiment.
 */
export async function searchPlaces(query, signal) {
  const q = query.split(',')[0].trim();
  if (q.length < 2) return [];
  let found = await geocode(q, 6, signal);
  // Préfixes « Port-la », « Port » : on coupe sur les séparateurs d'origine.
  const prefixes = [...q.matchAll(/[\s-]+/g)].map((m) => q.slice(0, m.index)).reverse();
  const target = squash(q);
  for (const prefix of prefixes) {
    if (found.length || prefix.length < 2) break;
    const wide = await geocode(prefix, 50, signal);
    found = wide.filter((r) => squash(r.name).startsWith(target)).slice(0, 6);
  }
  return found.map((r) => ({
    name: r.name,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    detail: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: Math.round(r.latitude * 1e4) / 1e4,
    lon: Math.round(r.longitude * 1e4) / 1e4,
  }));
}

/** Codes météo WMO → emoji + libellé court. */
function describe(code) {
  if (code === 0) return ['☀️', 'Ensoleillé'];
  if (code <= 2) return ['🌤️', 'Éclaircies'];
  if (code === 3) return ['☁️', 'Couvert'];
  if (code <= 48) return ['🌫️', 'Brouillard'];
  if (code <= 57) return ['🌦️', 'Bruine'];
  if (code <= 67) return ['🌧️', 'Pluie'];
  if (code <= 77) return ['🌨️', 'Neige'];
  if (code <= 82) return ['🌦️', 'Averses'];
  if (code <= 86) return ['🌨️', 'Averses de neige'];
  return ['⛈️', 'Orages'];
}

/**
 * Renvoie { 'AAAA-MM-JJ': { text, alert, summary } } pour les jours du séjour
 * couverts par les prévisions ; un objet vide sinon (ou en cas d'échec réseau).
 */
export async function forecast(destination, startDate, endDate) {
  if (!destination || destination.lat == null || destination.lon == null) return {};
  const today = todayISO();
  const lastForecastDay = addDays(today, FORECAST_DAYS - 1);
  const from = startDate > today ? startDate : today;
  const to = endDate < lastForecastDay ? endDate : lastForecastDay;
  if (from > to) return {};

  const cacheKey = `holidayhub.wx.${destination.lat},${destination.lon},${from},${to}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;
  } catch { /* stockage indisponible */ }

  const params = new URLSearchParams({
    latitude: destination.lat,
    longitude: destination.lon,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_probability_max',
    timezone: 'auto',
    start_date: from,
    end_date: to,
  });

  let body;
  try {
    const res = await fetch(`${FORECAST_URL}?${params}`);
    if (!res.ok) return {};
    body = await res.json();
  } catch {
    return {};
  }

  const d = body.daily || {};
  const data = {};
  (d.time || []).forEach((date, i) => {
    const tmax = Math.round(d.temperature_2m_max[i]);
    const tmin = Math.round(d.temperature_2m_min[i]);
    const wind = Math.round(d.wind_speed_10m_max[i]);
    const gust = Math.round(d.wind_gusts_10m_max[i]);
    const rain = d.precipitation_probability_max?.[i];
    const [emoji, label] = describe(d.weather_code[i]);
    // Même lecture que le planning d'origine : on montre les rafales quand elles
    // dépassent nettement le vent moyen, sinon le vent.
    const windText = gust >= wind + 15 ? `Rafales ${gust} km/h` : `Vent ${wind} km/h`;
    const alert = tmax >= 35 || gust >= 70 || wind >= 50 || d.weather_code[i] >= 95;
    data[date] = {
      text: `${emoji} ${tmax}°C | ${windText}${alert ? ' ⚠️' : ''}`,
      alert,
      summary: `${label}, ${tmin}° / ${tmax}°C, vent ${wind} km/h, rafales ${gust} km/h` + (rain != null ? `, pluie ${rain} %` : ''),
    };
  });

  try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), data })); } catch { /* plein */ }
  return data;
}

/**
 * Branche une autocomplétion de destination sur un champ texte.
 * onPick(place | null) est appelé quand une ville est choisie ou que le texte change.
 */
export function bindPlaceAutocomplete(input, onPick) {
  const wrap = input.closest('.autocomplete');
  const list = document.createElement('ul');
  list.className = 'autocomplete-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');

  let results = [];
  let active = -1;
  let controller = null;
  let timer = null;

  function render() {
    list.innerHTML = '';
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = r.name;
      if (r.detail) {
        const small = document.createElement('small');
        small.textContent = r.detail;
        li.appendChild(small);
      }
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
  }

  function pick(i) {
    const place = results[i];
    if (!place) return;
    input.value = place.label;
    results = [];
    render();
    onPick(place);
  }

  input.addEventListener('input', () => {
    onPick(null);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      try {
        results = await searchPlaces(input.value, controller.signal);
        active = -1;
        render();
      } catch { /* requête annulée */ }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % results.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + results.length) % results.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }
    else if (e.key === 'Escape') { results = []; render(); e.stopPropagation(); }
  });

  input.addEventListener('blur', () => setTimeout(() => { results = []; render(); }, 120));
}
