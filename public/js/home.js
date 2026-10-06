/**
 * home.js — page d'accueil : thème et « Mes plannings récents ».
 */
import { $, esc, icon, toast, bindThemeToggle } from './lib/util.js';
import { listRecent, forgetPlan } from './lib/recent.js';
import { rangeLabel, todayISO } from './lib/model.js';

bindThemeToggle($('[data-theme-toggle]'));

function renderRecent() {
  const plans = listRecent();
  const section = $('#recent');
  section.hidden = plans.length === 0;
  if (!plans.length) return;

  const today = todayISO();
  $('#recent-list').innerHTML = plans.map((p) => {
    const href = p.editToken ? `/e/${encodeURIComponent(p.editToken)}` : `/p/${encodeURIComponent(p.viewId)}`;
    const status = p.endDate && p.endDate < today ? 'Terminé' : p.startDate && p.startDate <= today ? 'En cours' : '';
    const details = [p.destination, p.startDate && p.endDate ? rangeLabel(p.startDate, p.endDate) : '', status].filter(Boolean).join(' · ');
    return `
      <li class="recent-item">
        <span class="recent-icon">${icon(p.editToken ? 'edit' : 'eye')}</span>
        <a href="${href}">
          <strong>${esc(p.title)}</strong>
          <small>${esc(details)}${p.editToken ? '' : ' · lecture seule'}</small>
        </a>
        <button class="btn btn-ghost btn-icon btn-sm" data-forget="${esc(p.viewId)}" aria-label="Retirer « ${esc(p.title)} » de la liste" title="Retirer de la liste (le planning n'est pas supprimé)">${icon('x', 'icon-sm')}</button>
      </li>`;
  }).join('');
}

$('#recent-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-forget]');
  if (!b) return;
  forgetPlan(b.dataset.forget);
  renderRecent();
  toast('Retiré de la liste. Le planning existe toujours via son lien.');
});

renderRecent();

if (new URLSearchParams(location.search).has('supprime')) {
  history.replaceState(null, '', '/');
  toast('Planning supprimé.');
}
