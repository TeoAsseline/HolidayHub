/**
 * rateLimit.js — limite de requêtes par IP, en mémoire.
 *
 * Une seule instance pm2 : un compteur en mémoire suffit, pas besoin de Redis.
 * Chaque appel à rateLimit() crée son propre compteur, ce qui permet une limite
 * globale large et des limites plus strictes sur les routes sensibles.
 */
'use strict';

function rateLimit({ windowMs, max, message = 'Trop de requêtes. Patiente un instant.' }) {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.reset <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || 'inconnu';
    let entry = hits.get(ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

module.exports = { rateLimit };
