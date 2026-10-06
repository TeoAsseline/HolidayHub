/**
 * api.js — appels au serveur. Chaque erreur remonte avec un message lisible
 * et le code HTTP, pour que l'appelant distingue « introuvable » de « conflit ».
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Connexion impossible. Vérifie ta connexion internet.', 0);
  }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `Erreur ${res.status}`, res.status, body);
  return body;
}

export const api = {
  create:   (data)                   => request('POST', '/api/plans', { data }),
  getView:  (viewId)                 => request('GET', `/api/plans/view/${encodeURIComponent(viewId)}`),
  getEdit:  (token)                  => request('GET', `/api/plans/edit/${encodeURIComponent(token)}`),
  save:     (token, version, data)   => request('PUT', `/api/plans/edit/${encodeURIComponent(token)}`, { version, data }),
  remove:   (token)                  => request('DELETE', `/api/plans/edit/${encodeURIComponent(token)}`),
};
