/**
 * db.js — stockage des plannings.
 *
 * Un planning = une ligne. Le contenu (jours, événements, budget, listes…) est
 * un document JSON opaque pour le serveur : c'est le front qui en connaît la
 * forme. Le serveur ne garde que ce qu'il lui faut pour router, protéger et
 * faire le ménage.
 *
 *   view_id     → lien de lecture   /p/<view_id>   (court, à partager au groupe)
 *   edit_token  → lien d'édition    /e/<edit_token> (long, à garder pour soi)
 *   version     → incrémentée à chaque sauvegarde : deux personnes qui éditent
 *                 en même temps ne s'écrasent pas sans le savoir
 */
'use strict';

const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(__dirname, process.env.DB_PATH || 'data/holidayhub.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    view_id      TEXT PRIMARY KEY,
    edit_token   TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL DEFAULT '',
    data         TEXT NOT NULL,
    version      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_plans_last_seen ON plans(last_seen_at);
`);

// Alphabet sans caractères ambigus : les liens se recopient parfois à la main.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomId(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

const stmt = {
  insert:   db.prepare(`INSERT INTO plans (view_id, edit_token, title, data, version, created_at, updated_at, last_seen_at)
                        VALUES (@view_id, @edit_token, @title, @data, 1, @now, @now, @now)`),
  byView:   db.prepare('SELECT * FROM plans WHERE view_id = ?'),
  byEdit:   db.prepare('SELECT * FROM plans WHERE edit_token = ?'),
  update:   db.prepare(`UPDATE plans SET data = @data, title = @title, version = version + 1, updated_at = @now, last_seen_at = @now
                        WHERE edit_token = @edit_token AND version = @version`),
  seen:     db.prepare('UPDATE plans SET last_seen_at = ? WHERE view_id = ?'),
  remove:   db.prepare('DELETE FROM plans WHERE edit_token = ?'),
  purge:    db.prepare('DELETE FROM plans WHERE last_seen_at < ?'),
  count:    db.prepare('SELECT COUNT(*) AS n FROM plans'),
};

function toPublic(row, withEdit) {
  const out = {
    viewId: row.view_id,
    version: row.version,
    updatedAt: row.updated_at,
    data: JSON.parse(row.data),
  };
  if (withEdit) out.editToken = row.edit_token;
  return out;
}

// Une visite repousse l'échéance de purge ; inutile d'écrire à chaque requête.
function touch(row) {
  const now = Date.now();
  if (now - row.last_seen_at > DAY) stmt.seen.run(now, row.view_id);
}

function create(data, title) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = { view_id: randomId(10), edit_token: randomId(24), title, data, now: Date.now() };
    try {
      stmt.insert.run(row);
      return { viewId: row.view_id, editToken: row.edit_token, version: 1 };
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Impossible de générer un identifiant unique');
}

function getByView(viewId) {
  const row = stmt.byView.get(viewId);
  if (!row) return null;
  touch(row);
  return toPublic(row, false);
}

function getByEdit(token) {
  const row = stmt.byEdit.get(token);
  if (!row) return null;
  touch(row);
  return toPublic(row, true);
}

/** Renvoie { ok: true, version } ou { ok: false, current } si quelqu'un a sauvegardé entre-temps. */
function save(token, baseVersion, data, title) {
  const res = stmt.update.run({ edit_token: token, version: baseVersion, data, title, now: Date.now() });
  const row = stmt.byEdit.get(token);
  if (!row) return null;
  if (res.changes === 1) return { ok: true, version: row.version, updatedAt: row.updated_at };
  return { ok: false, current: toPublic(row, true) };
}

function remove(token) {
  return stmt.remove.run(token).changes === 1;
}

function purgeInactive(retentionDays) {
  return stmt.purge.run(Date.now() - retentionDays * DAY).changes;
}

function count() {
  return stmt.count.get().n;
}

module.exports = { db, create, getByView, getByEdit, save, remove, purgeInactive, count };
