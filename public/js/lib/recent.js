/**
 * recent.js — « Mes plannings récents », gardés dans ce navigateur uniquement.
 *
 * Sans compte, c'est le seul moyen de retrouver un planning sans son lien :
 * on mémorise chaque planning ouvert, avec son lien d'édition quand on l'a.
 */

const KEY = 'holidayhub.recent';
const MAX = 30;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* stockage indisponible */ }
}

export function listRecent() {
  return read().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

/** Ajoute ou met à jour un planning ; un lien d'édition déjà connu n'est jamais oublié. */
export function rememberPlan({ viewId, editToken, title, startDate, endDate, destination }) {
  if (!viewId) return;
  const list = read();
  const existing = list.find((p) => p.viewId === viewId);
  const entry = {
    viewId,
    editToken: editToken || existing?.editToken || null,
    title: title || existing?.title || 'Planning',
    startDate, endDate,
    destination: destination || '',
    openedAt: Date.now(),
  };
  write([entry, ...list.filter((p) => p.viewId !== viewId)]);
}

export function findRecent(viewId) {
  return read().find((p) => p.viewId === viewId) || null;
}

export function forgetPlan(viewId) {
  write(read().filter((p) => p.viewId !== viewId));
}

/** Un lien d'édition invalide : on l'oublie (l'entrée disparaît, on ne connaît pas son viewId). */
export function forgetEditToken(editToken) {
  write(read().filter((p) => p.editToken !== editToken));
}
