/**
 * build-images.js — régénère les images dérivées du logo et de la vignette.
 *
 *   npm run images
 *
 * À lancer après avoir modifié public/img/logo.svg ou public/img/og.svg ;
 * les PNG produits sont commités (sharp n'est qu'une dépendance de dev).
 */
'use strict';

const path = require('path');
const sharp = require('sharp');

const IMG = path.join(__dirname, '..', 'public', 'img');
const logo = path.join(IMG, 'logo.svg');

const icons = [
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
];

(async () => {
  for (const [file, size] of icons) {
    await sharp(logo, { density: 72 * (size / 64) * 2 }).resize(size, size).png().toFile(path.join(IMG, file));
    console.log('✓', file);
  }
  await sharp(path.join(IMG, 'og.svg'), { density: 144 }).resize(1200, 630).png({ compressionLevel: 9 }).toFile(path.join(IMG, 'og.png'));
  console.log('✓ og.png');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
