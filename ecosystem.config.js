/**
 * ecosystem.config.js — configuration pm2 pour le VPS.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 logs holidayhub
 *   pm2 save
 *
 * Les réglages propres au serveur restent dans .env (lu par dotenv au démarrage) :
 * ce fichier ne contient que ce qui peut être commité.
 */
module.exports = {
  apps: [{
    name: 'holidayhub',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,          // SQLite + limites en mémoire : une seule instance
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true,
    time: true,
  }],
};
