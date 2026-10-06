# HolidayHub

Le planning de vacances entre amis, sans compte : une grille jours × périodes (réveil, matin, midi, aprèm,
soirée), le budget par personne calculé tout seul, les menus et les restos numérotés, la météo, les listes
cochables. Un lien de lecture pour le groupe, un lien d'édition pour les organisateurs.

En ligne : **https://holidayhub.teoasseline.fr** — pm2 `holidayhub`, port **7700**.

## Lancer en local

```bash
npm install
cp .env.example .env     # puis HOST=0.0.0.0 et BASE_URL=http://localhost:7700
npm run dev              # http://localhost:7700, redémarre à chaque modification
```

Aucune étape de build : le front est du HTML/CSS/JS servi tel quel depuis `public/`.

## Fonctionnement

- **Pas de compte.** Créer un planning renvoie deux identifiants aléatoires :
  `/p/<10 caractères>` (lecture) et `/e/<24 caractères>` (édition). Les plannings ouverts sont mémorisés
  dans le navigateur (`localStorage`) et listés sur l'accueil, avec leur lien d'édition s'il est connu.
- **Un planning = un document JSON** dans SQLite (`data/holidayhub.db`). Sa forme est décrite en tête de
  `public/js/lib/model.js` ; le serveur ne vérifie que l'essentiel (titre, dates, taille ≤ 512 Ko).
- **Sauvegarde automatique** (900 ms après la dernière modification). Chaque sauvegarde porte la version
  qu'elle modifie : si quelqu'un a enregistré entre-temps, le serveur répond 409 et l'interface propose
  de charger l'autre version ou de garder la sienne.
- **Météo** : Open-Meteo, appelé directement par le navigateur (géocodage + prévisions à 16 jours).
  Au-delà, chaque jour garde sa météo saisie à la main.
- **Ménage** : un planning sans aucune visite depuis `RETENTION_DAYS` jours (365) est supprimé.
- **Anti-abus** : 600 requêtes/min/IP au total, `CREATE_PER_HOUR` créations/heure/IP (20),
  120 sauvegardes/min/IP.

## Mettre en ligne (première fois)

Procédure complète dans `TeoAsselineFR/INFRASTRUCTURE.md`, section « Mettre un nouveau site en ligne ».
Spécifique à HolidayHub :

1. **DNS OVH** : enregistrement `A` `holidayhub` → `51.210.13.237`.
2. **Serveur** :
   ```bash
   cd /var/www && git clone <dépôt> HolidayHub && cd HolidayHub
   npm ci --omit=dev
   cp .env.example .env          # HOST=127.0.0.1, BASE_URL=https://holidayhub.teoasseline.fr
   chmod +x deploy.sh
   pm2 start ecosystem.config.js && pm2 save
   ```
3. **Apache** — `/etc/apache2/sites-available/holidayhub.conf` :
   ```apache
   <VirtualHost *:80>
       ServerName holidayhub.teoasseline.fr
       ProxyPreserveHost On
       RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}
       ProxyPass / http://127.0.0.1:7700/
       ProxyPassReverse / http://127.0.0.1:7700/
       ErrorLog ${APACHE_LOG_DIR}/holidayhub-error.log
       CustomLog ${APACHE_LOG_DIR}/holidayhub-access.log combined
   </VirtualHost>
   ```
   Pas de websocket ici : pas besoin de la règle socket.io.
   ```bash
   a2ensite holidayhub && apache2ctl configtest && systemctl reload apache2
   certbot --apache -d holidayhub.teoasseline.fr
   ```
4. **Déploiement automatique** : générer une clé dédiée, la restreindre dans `/root/.ssh/authorized_keys`
   avec `command="/var/www/HolidayHub/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty`,
   puis renseigner les secrets GitHub `VPS_HOST`, `VPS_USER`, `VPS_KNOWN_HOSTS` (identiques aux autres apps)
   et `VPS_SSH_KEY` (la clé privée de HolidayHub).

Ensuite, **chaque push sur `main` déploie** : `deploy.sh` met à jour, réinstalle les dépendances si besoin,
redémarre pm2 et revient au commit précédent si `/api/health` ne répond pas dans les 15 s.

## Images

`public/img/logo.svg` et `public/img/og.svg` sont les sources. Après modification :

```bash
npm run images    # régénère favicon, icônes PWA et og.png (sharp, dépendance de dev)
```

## Sauvegarde

Tout l'état de production tient dans `data/holidayhub.db` (ignoré par git) et `.env`.
