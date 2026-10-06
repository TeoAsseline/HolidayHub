/**
 * templates.js — modèles de départ proposés à la création.
 *
 * Un modèle ne connaît pas les dates : il décrit des jours « types » (arrivée,
 * jour du milieu, départ) que l'on applique à chaque jour du séjour.
 */
import { uid } from './util.js';
import { emptyPlan, dateRange, newEvent, getDay } from './model.js';

const ev = (title, extra = {}) => ({ title, ...extra });
const items = (...labels) => labels.map((text) => ({ id: uid(), text, done: false }));

const BAGAGES = items('Papiers d\'identité', 'Chargeurs & batterie externe', 'Maillot de bain', 'Serviette de plage',
  'Crème solaire', 'Lunettes de soleil', 'Trousse de toilette', 'Médicaments', 'Enceinte');

export const TEMPLATES = [
  {
    id: 'vierge',
    emoji: '📄',
    name: 'Vierge',
    desc: 'Les périodes de la journée et des listes vides. Tu pars de zéro.',
    apply(plan) {
      plan.lists = [
        { id: uid(), title: 'Courses', items: [] },
        { id: uid(), title: 'Bagages', items: [] },
      ];
    },
  },
  {
    id: 'plage',
    emoji: '🏖️',
    name: 'Semaine à la plage',
    desc: 'Réveil, plage l\'aprèm, repas maison et restos, menus et budget prêts.',
    apply(plan, dates) {
      plan.budget.items = [
        { id: uid(), label: 'Courses', amount: 0, mode: 'total' },
        { id: uid(), label: 'Essence', amount: 0, mode: 'total' },
        { id: uid(), label: 'Logement', amount: 0, mode: 'total' },
      ];
      plan.menus = ['Pâtes carbo', 'Burgers maison', 'Barbecue', 'Chili con carne', 'Croque-monsieur / Wraps', 'Sandwichs pique-nique']
        .map((label) => ({ id: uid(), label, done: false }));
      plan.lists = [
        { id: uid(), title: 'Courses', items: items('Eau', 'Pâtes', 'Viande barbecue', 'Pain', 'Chips', 'Glaces') },
        { id: uid(), title: 'Bagages', items: structuredClone(BAGAGES) },
      ];
      dates.forEach((date, i) => {
        const first = i === 0, last = i === dates.length - 1;
        if (first) {
          put(plan, date, 'matin', ev('Préparation des bagages'));
          put(plan, date, 'midi', ev('Repas en route', { tags: ['tbd'] }));
          put(plan, date, 'aprem', ev('Départ route', { time: '14:00', tags: ['trajet'] }));
          put(plan, date, 'aprem', ev('Arrivée & installation', { time: '18:00', location: 'Logement' }));
          put(plan, date, 'soiree', ev('Dîner d\'arrivée', { tags: ['resto'] }));
          getDay(plan, date).label = 'Arrivée';
        } else if (last) {
          put(plan, date, 'matin', ev('Rangement / Check-out'));
          put(plan, date, 'midi', ev('Repas fin de séjour', { tags: ['tbd'] }));
          put(plan, date, 'aprem', ev('Départ & retour', { tags: ['trajet'] }));
          getDay(plan, date).label = 'Départ';
        } else {
          put(plan, date, 'reveil', ev('Réveil', { time: '10:00' }));
          put(plan, date, 'matin', ev('Matinée libre / Chill'));
          put(plan, date, 'midi', ev('Repas maison', { tags: ['tbd'] }));
          put(plan, date, 'aprem', ev('Session plage', { time: '14:00' }));
          put(plan, date, 'soiree', ev('Soirée à la maison', { tags: ['chill'] }));
        }
      });
    },
  },
  {
    id: 'weekend',
    emoji: '🎉',
    name: 'Week-end entre amis',
    desc: 'Arrivée, une grosse journée d\'activités, départ. Idéal sur 2 à 4 jours.',
    apply(plan, dates) {
      plan.budget.items = [
        { id: uid(), label: 'Logement', amount: 0, mode: 'total' },
        { id: uid(), label: 'Courses', amount: 0, mode: 'total' },
      ];
      plan.lists = [
        { id: uid(), title: 'Courses', items: items('Apéro', 'Petit-déj', 'Boissons') },
        { id: uid(), title: 'Bagages', items: structuredClone(BAGAGES).slice(0, 4) },
      ];
      dates.forEach((date, i) => {
        const first = i === 0, last = i === dates.length - 1;
        if (first) {
          put(plan, date, 'aprem', ev('Route & arrivée', { tags: ['trajet'] }));
          put(plan, date, 'soiree', ev('Apéro d\'arrivée', { tags: ['chill'] }));
          getDay(plan, date).label = 'Arrivée';
        } else if (last) {
          put(plan, date, 'matin', ev('Brunch & rangement'));
          put(plan, date, 'aprem', ev('Retour', { tags: ['trajet'] }));
          getDay(plan, date).label = 'Départ';
        } else {
          put(plan, date, 'matin', ev('Activité du jour', { tags: ['activite', 'tbd'] }));
          put(plan, date, 'midi', ev('Déjeuner', { tags: ['tbd'] }));
          put(plan, date, 'soiree', ev('Soirée', { tags: ['resto'] }));
        }
      });
    },
  },
  {
    id: 'roadtrip',
    emoji: '🚐',
    name: 'Road-trip',
    desc: 'Une étape par jour : trajet le matin, visite l\'aprèm, nuit sur place.',
    apply(plan, dates) {
      plan.periods = plan.periods.filter((p) => p.id !== 'reveil');
      plan.tags.push({ id: uid(), label: 'Hébergement', tone: 'teal' });
      plan.budget.items = [
        { id: uid(), label: 'Essence', amount: 0, mode: 'total' },
        { id: uid(), label: 'Péages', amount: 0, mode: 'total' },
        { id: uid(), label: 'Hébergements', amount: 0, mode: 'total' },
      ];
      plan.lists = [
        { id: uid(), title: 'Voiture', items: items('Niveaux & pneus', 'Badge télépéage', 'Gilets & triangle', 'Câble de charge', 'Playlist') },
        { id: uid(), title: 'Bagages', items: structuredClone(BAGAGES) },
      ];
      dates.forEach((date, i) => {
        const last = i === dates.length - 1;
        put(plan, date, 'matin', ev(i === 0 ? 'Départ' : 'Route vers l\'étape suivante', { time: '09:00', tags: ['trajet'] }));
        put(plan, date, 'midi', ev('Pique-nique', { tags: ['tbd'] }));
        if (last) {
          put(plan, date, 'aprem', ev('Retour à la maison', { tags: ['trajet'] }));
          getDay(plan, date).label = 'Retour';
        } else {
          put(plan, date, 'aprem', ev('Visite', { tags: ['activite'] }));
          put(plan, date, 'soiree', ev('Nuit à l\'étape', { location: 'À définir' }));
          getDay(plan, date).label = `Étape ${i + 1}`;
        }
      });
    },
  },
];

function put(plan, date, periodId, fields) {
  if (!plan.periods.some((p) => p.id === periodId)) return;
  const day = getDay(plan, date);
  (day.cells[periodId] = day.cells[periodId] || []).push(newEvent(fields));
}

export function buildPlan(templateId, base) {
  const plan = emptyPlan(base);
  const template = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
  template.apply(plan, dateRange(plan.startDate, plan.endDate));
  return plan;
}
