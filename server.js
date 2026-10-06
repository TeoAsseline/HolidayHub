/**
 * server.js — HolidayHub
 *
 *   npm start  →  http://localhost:7700
 *
 * Express + SQLite. Aucune étape de build : le front est du HTML/CSS/JS servi tel quel.
 * Pas de compte : un planning est accessible par deux liens secrets (lecture / édition).
 */
'use strict';

require('dotenv').config();

const path    = require('path');
const fs      = require('fs');
const express = require('express');

const plans = require('./db');
const { rateLimit } = require('./middleware/rateLimit');

const PORT     = parseInt(process.env.PORT || '7700', 10);
const PROD     = process.env.NODE_ENV === 'production';
// En production, l'app n'écoute que derrière le reverse proxy.
const HOST     = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');
const BASE_URL = String(process.env.BASE_URL || ('http://localhost:' + PORT)).replace(/\/+$/, '');
const PUBLIC   = path.join(__dirname, 'public');

const RETENTION_DAYS  = parseInt(process.env.RETENTION_DAYS || '365', 10);
const CREATE_PER_HOUR = parseInt(process.env.CREATE_PER_HOUR || '20', 10);
const MAX_PLAN_BYTES  = 512 * 1024;

const app = express();
app.set('trust proxy', 1);          // derrière le reverse proxy Apache du VPS
app.disable('x-powered-by');

// ── En-têtes de sécurité ───────────────────────────────────────
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // La météo est demandée directement à Open-Meteo par le navigateur.
  "connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Les liens de planning sont des secrets : ils ne doivent pas fuiter vers les sites cliqués.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});


// ── Pages ──────────────────────────────────────────────────────
// Les pages HTML sont lues une fois et l'adresse publique y est injectée
// (balises Open Graph, liens canoniques).
const pageCache = new Map();
function page(file) {
  if (!PROD || !pageCache.has(file)) {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8').replaceAll('{{BASE_URL}}', BASE_URL);
    pageCache.set(file, html);
  }
  return pageCache.get(file);
}

function sendPage(file, { index = true, status = 200 } = {}) {
  return (req, res) => {
    // Un planning est privé : jamais dans un moteur de recherche, jamais en cache partagé.
    if (!index) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', 'no-store');
    }
    res.status(status).type('html').send(page(file));
  };
}

app.get('/', sendPage('index.html'));
app.get('/nouveau', sendPage('new.html', { index: false }));
app.get('/p/:viewId', sendPage('planner.html', { index: false }));
app.get('/e/:editToken', sendPage('planner.html', { index: false }));

// Une page servie à deux adresses se concurrence elle-même.
app.get(['/index.html', '/new.html', '/planner.html', '/404.html'], (req, res) => {
  res.redirect(301, req.path === '/new.html' ? '/nouveau' : '/');
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    // /p/ et /e/ ne sont pas bloqués ici : ils répondent « noindex », et un robot
    // doit pouvoir lire cette consigne pour la respecter.
    '',
    `Sitemap: ${BASE_URL}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${BASE_URL}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>\n` +
    '</urlset>\n'
  );
});

// JS et CSS ne sont pas versionnés : après un déploiement, un module ES en cache
// importerait des exports qui n'existent plus. On les revalide donc à chaque fois
// (ETag → 304), et seules les images et polices gardent un cache long.
app.use(express.static(PUBLIC, {
  index: false,
  maxAge: 0,
  setHeaders(res, file) {
    const rel = path.relative(PUBLIC, file).split(path.sep)[0];
    if (rel === 'js' || rel === 'css') res.setHeader('Cache-Control', 'no-cache');
    else if (PROD && (rel === 'img' || rel === 'fonts')) res.setHeader('Cache-Control', 'public, max-age=2592000');
    else if (PROD) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

// Limite globale : seulement sur l'API, pas sur les fichiers statiques.
app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));

// ── API ────────────────────────────────────────────────────────
const api = express.Router();
api.use(express.json({ limit: MAX_PLAN_BYTES }));

const VIEW_ID    = /^[A-Za-z0-9]{10}$/;
const EDIT_TOKEN = /^[A-Za-z0-9]{24}$/;

/** Date de calendrier réelle (refuse 2026-02-30, que Date.parse accepte) et plausible. */
function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return false;
  const year = d.getUTCFullYear();
  return year >= 2000 && year <= 2100;
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Le contenu est libre, mais il doit ressembler à un planning et rester raisonnable. */
function readPlan(body) {
  const data = body && body.data;
  if (!isObject(data)) return { error: 'Planning manquant ou invalide.' };
  if (typeof data.title !== 'string' || !data.title.trim()) return { error: 'Le planning doit avoir un titre.' };
  if (!isISODate(data.startDate) || !isISODate(data.endDate)) return { error: 'Dates de séjour invalides.' };
  // Forme des collections principales : le détail est normalisé côté navigateur.
  for (const key of ['periods', 'tags', 'participants', 'menus', 'lists']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) return { error: 'Planning invalide (' + key + ').' };
  }
  for (const key of ['days', 'budget', 'notice']) {
    if (data[key] !== undefined && !isObject(data[key])) return { error: 'Planning invalide (' + key + ').' };
  }
  if (data.destination != null && !isObject(data.destination)) return { error: 'Planning invalide (destination).' };
  if (data.days) {
    for (const [date, day] of Object.entries(data.days)) {
      if (!isISODate(date) || !isObject(day)) return { error: 'Planning invalide (jours).' };
      if (day.cells !== undefined && !isObject(day.cells)) return { error: 'Planning invalide (jours).' };
      for (const events of Object.values(day.cells || {})) {
        if (!Array.isArray(events)) return { error: 'Planning invalide (événements).' };
      }
    }
  }
  if (data.budget && data.budget.items !== undefined && !Array.isArray(data.budget.items)) {
    return { error: 'Planning invalide (budget).' };
  }
  const days = (Date.parse(data.endDate) - Date.parse(data.startDate)) / 86_400_000;
  if (!(days >= 0 && days <= 92)) return { error: 'Un séjour dure entre 1 et 93 jours.' };
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_PLAN_BYTES) return { error: 'Planning trop volumineux.' };
  return { json, title: data.title.trim().slice(0, 120) };
}

api.get('/health', (req, res) => {
  // Public : on ne divulgue ni le nombre de plannings ni l'uptime.
  res.json({ ok: true });
});

api.post('/plans', rateLimit({ windowMs: 60 * 60_000, max: CREATE_PER_HOUR, message: 'Trop de plannings créés depuis cette connexion. Réessaie dans une heure.' }), (req, res) => {
  const plan = readPlan(req.body);
  if (plan.error) return res.status(400).json({ error: plan.error });
  res.status(201).json(plans.create(plan.json, plan.title));
});

api.get('/plans/view/:viewId', (req, res) => {
  if (!VIEW_ID.test(req.params.viewId)) return res.status(404).json({ error: 'Planning introuvable.' });
  const plan = plans.getByView(req.params.viewId);
  if (!plan) return res.status(404).json({ error: 'Planning introuvable.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(plan);
});

api.get('/plans/edit/:token', (req, res) => {
  if (!EDIT_TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Lien d\'édition invalide.' });
  const plan = plans.getByEdit(req.params.token);
  if (!plan) return res.status(404).json({ error: 'Lien d\'édition invalide.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(plan);
});

api.put('/plans/edit/:token', rateLimit({ windowMs: 60_000, max: 120 }), (req, res) => {
  if (!EDIT_TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Lien d\'édition invalide.' });
  const baseVersion = Number(req.body && req.body.version);
  if (!Number.isInteger(baseVersion)) return res.status(400).json({ error: 'Version manquante.' });
  const plan = readPlan(req.body);
  if (plan.error) return res.status(400).json({ error: plan.error });

  const result = plans.save(req.params.token, baseVersion, plan.json, plan.title);
  if (!result) return res.status(404).json({ error: 'Ce planning n\'existe plus.' });
  if (!result.ok) return res.status(409).json({ error: 'Le planning a été modifié par quelqu\'un d\'autre.', current: result.current });
  res.json({ version: result.version, updatedAt: result.updatedAt });
});

api.delete('/plans/edit/:token', (req, res) => {
  if (!EDIT_TOKEN.test(req.params.token) || !plans.remove(req.params.token)) {
    return res.status(404).json({ error: 'Planning introuvable.' });
  }
  res.status(204).end();
});

api.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// JSON mal formé ou trop gros : une réponse lisible plutôt qu'une page d'erreur HTML.
api.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Planning trop volumineux.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide.' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

app.use('/api', api);

app.use(sendPage('404.html', { index: false, status: 404 }));

// ── Ménage ─────────────────────────────────────────────────────
function purge() {
  try {
    const n = plans.purgeInactive(RETENTION_DAYS);
    if (n) console.log(`🧹 ${n} planning(s) inactif(s) depuis ${RETENTION_DAYS} jours supprimé(s)`);
  } catch (err) {
    console.error('Purge impossible :', err.message);
  }
}
purge();
setInterval(purge, 6 * 60 * 60 * 1000).unref();

// ── Démarrage ──────────────────────────────────────────────────
const server = app.listen(PORT, HOST, () => {
  console.log('\n  🌴  HolidayHub');
  console.log('      local  : http://localhost:' + PORT);
  console.log('      public : ' + BASE_URL + '\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n  ❌ Le port ' + PORT + ' est déjà utilisé — une autre instance tourne sans doute encore.');
    console.error(process.platform === 'win32'
      ? '       netstat -ano | findstr :' + PORT + '        puis   taskkill /PID <pid> /F'
      : '       lsof -i :' + PORT + '                      puis   kill <pid>');
    console.error('\n     Ou change de port : PORT=7701 dans .env\n');
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  server.close(() => {
    plans.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
