// Chargé dans <head>, avant l'affichage : évite un flash clair quand le thème sombre est choisi.
try {
  var t = localStorage.getItem('holidayhub.theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) { /* navigation privée */ }
