/* Metz à pied — génération de parcours et suivi de visite (vanilla JS, sans build) */
'use strict';

// ---------- Constantes ----------
const STORE = { prefs: 'metz.prefs.v1', route: 'metz.route.v1', visited: 'metz.visited.v1' };
const METZ_CENTER = { lat: 49.1193, lng: 6.1757 };
const DETOUR = 1.3;                 // facteur de détour piéton vs vol d'oiseau
const DAY_START_DEFAULT = 9 * 60 + 30;

const DURATIONS = {                 // minutes disponibles par jour, nombre de jours
  '2h': { perDay: 120, days: 1 },
  half: { perDay: 240, days: 1 },
  day: { perDay: 480, days: 1 },
  '2days': { perDay: 480, days: 2 },
};
const PACE = {
  calm:   { speed: 3.8, visit: 1.2,  maxKmPerDay: 6 },
  normal: { speed: 4.5, visit: 1.0,  maxKmPerDay: 10 },
  brisk:  { speed: 5.3, visit: 0.85, maxKmPerDay: 15 },
};
const PAUSES = {
  cafe:     { label: 'Pause café', target: 10 * 60 + 30, dur: 20 },
  dejeuner: { label: 'Déjeuner',   target: 12 * 60 + 30, dur: 60 },
  gouter:   { label: 'Goûter',     target: 16 * 60,      dur: 25 },
};
const CATEGORY_LABELS = {
  histoire: 'Histoire', architecture: 'Architecture', art: 'Art', religieux: 'Religieux',
  nature: 'Nature', gastronomie: 'Gastronomie', shopping: 'Shopping', photo: 'Photo', nuit: 'Vie nocturne',
};
const DEFAULT_PREFS = {
  interests: ['histoire', 'architecture', 'photo'], duration: 'half', pace: 'normal',
  transport: 'walk', start: 'gare', parking: 'p-cathedrale', budget: 'paid', pauses: ['cafe'],
  startTime: null,
};

// ---------- État ----------
let DATA = null;          // contenu de lieux.json
let BY_ID = {};
let prefs = { ...DEFAULT_PREFS, ...load(STORE.prefs, DEFAULT_PREFS) };
let route = load(STORE.route, null);
let visited = new Set(load(STORE.visited, []));
let map = null, layers = null, meMarker = null, meCircle = null, watchId = null, lastPos = null;

const $ = (sel) => document.querySelector(sel);

// ---------- Stockage ----------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : structuredClone(fallback);
  } catch { return structuredClone(fallback); }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
}
const saveRoute = () => save(STORE.route, route);
const saveVisited = () => save(STORE.visited, [...visited]);

// ---------- Géométrie ----------
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const walkKm = (a, b) => haversineKm(a, b) * DETOUR;

/** Trajet entre deux points : marche, ou bus Le Met' si plus rapide et autorisé. */
function leg(a, b, p = prefs) {
  const km = walkKm(a, b);
  const walkMin = km / PACE[p.pace].speed * 60;
  if (p.transport === 'bus' && km > 1.4) {
    const busMin = 8 + km / 16 * 60;           // attente moyenne + vitesse commerciale
    if (busMin < walkMin) return { km, min: Math.round(busMin), bus: true };
  }
  return { km, min: Math.round(walkMin), bus: false };
}

// ---------- Ordonnancement : plus proche voisin + 2-opt (chemin ouvert) ----------
function nearestNeighbor(start, pts) {
  const left = pts.slice(), order = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = walkKm(cur, p); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    order.push(cur);
  }
  return order;
}
function twoOpt(start, order) {
  const best = order.slice(), n = best.length;
  const at = (i) => (i < 0 ? start : best[i]);
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = at(i - 1), b = best[i], c = best[k], d = k + 1 < n ? best[k + 1] : null;
        const before = walkKm(a, b) + (d ? walkKm(c, d) : 0);
        const after = walkKm(a, c) + (d ? walkKm(b, d) : 0);
        if (after < before - 1e-9) {
          for (let x = i, y = k; x < y; x++, y--) [best[x], best[y]] = [best[y], best[x]];
          improved = true;
        }
      }
    }
  }
  return best;
}
const optimize = (start, pts) => (pts.length < 3 ? nearestNeighbor(start, pts) : twoOpt(start, nearestNeighbor(start, pts)));

function pathStats(start, order, p = prefs) {
  let min = 0, km = 0, prev = start;
  for (const pl of order) {
    const l = leg(prev, pl, p);
    min += l.min + Math.round(pl.duree * PACE[p.pace].visit);
    if (!l.bus) km += l.km;
    prev = pl;
  }
  return { min, km };
}

// ---------- Sélection des lieux ----------
function scorePlace(pl, p, jitter) {
  const matches = pl.categories.filter((c) => p.interests.includes(c)).length;
  let s = pl.importance + matches * 2.2;
  if (p.interests.length && matches === 0) s *= 0.35;
  return s + (jitter ? Math.random() * 2 : 0);
}

function generateRoute(p, start, { jitter = false } = {}) {
  const { perDay, days } = DURATIONS[p.duration];
  const pace = PACE[p.pace];
  const pauseMin = p.pauses.reduce((s, t) => s + PAUSES[t].dur + 8, 0);   // + petit détour pour s'y rendre
  const budget = (perDay - pauseMin) * days;
  const maxKm = pace.maxKmPerDay * days;

  const candidates = DATA.lieux
    .filter((pl) => pl.type !== 'pause')
    .filter((pl) => p.budget === 'paid' || !pl.payant)
    .map((pl) => ({ pl, s: scorePlace(pl, p, jitter) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.pl);

  // Glouton : on ajoute par score décroissant tant que temps et distance tiennent.
  let chosen = [];
  for (const pl of candidates) {
    const trial = optimize(start, [...chosen, pl]);
    const st = pathStats(start, trial, p);
    if (st.min <= budget && st.km <= maxKm) chosen = trial;
  }
  if (!chosen.length && candidates.length) chosen = [candidates[0]];
  chosen = optimize(start, chosen);

  // Découpage en jours, chaque jour repart du point de départ.
  const dayLists = [];
  if (days === 1) dayLists.push(chosen);
  else {
    const day1 = [];
    let prev = start, t = 0;
    for (const pl of chosen) {
      const add = leg(prev, pl, p).min + Math.round(pl.duree * pace.visit);
      if (t + add > perDay - pauseMin && day1.length) break;
      day1.push(pl); t += add; prev = pl;
    }
    const rest = chosen.filter((pl) => !day1.includes(pl));
    dayLists.push(day1, optimize(start, rest));
  }

  const startClock = parseClock(p.startTime) ?? DAY_START_DEFAULT;
  const itemsByDay = dayLists.map((list, d) => {
    let items = list.map((pl) => ({ id: pl.id }));
    for (const type of ['cafe', 'dejeuner', 'gouter']) {
      if (p.pauses.includes(type)) items = insertPause(items, type, start, d === 0 ? startClock : DAY_START_DEFAULT, p);
    }
    return items;
  });

  return {
    createdAt: Date.now(),
    prefs: structuredClone(p),
    start,
    startClock,
    days: itemsByDay,
    current: 0,
  };
}

/** Insère une pause au moment le plus proche de l'heure cible, dans l'adresse qui fait le moins de détour. */
function insertPause(items, type, start, startClock, p) {
  const venues = DATA.lieux.filter((pl) => pl.pause?.includes(type) && !items.some((it) => it.id === pl.id));
  if (!venues.length) return items;
  const pts = items.map((it) => BY_ID[it.id]);
  // Heure d'arrivée à chaque position d'insertion possible.
  const clocks = [];
  let t = startClock, prev = start;
  for (let k = 0; k <= pts.length; k++) {
    clocks.push(t);
    if (k < pts.length) {
      t += leg(prev, pts[k], p).min + visitMinutes(items[k], p);
      prev = pts[k];
    }
  }
  let best = null;
  // Jamais de pause avant la première visite (sauf parcours vide).
  for (let k = pts.length ? 1 : 0; k <= pts.length; k++) {
    const a = k === 0 ? start : pts[k - 1], b = pts[k];
    for (const v of venues) {
      const detour = walkKm(a, v) + (b ? walkKm(v, b) : 0) - (b ? walkKm(a, b) : 0);
      const cost = Math.abs(clocks[k] - PAUSES[type].target) / 8 + detour * 4;
      if (!best || cost < best.cost) best = { k, v, cost };
    }
  }
  const out = items.slice();
  out.splice(best.k, 0, { id: best.v.id, pause: type });
  return out;
}

function visitMinutes(item, p = prefs) {
  if (item.pause) return PAUSES[item.pause].dur;
  return Math.round(BY_ID[item.id].duree * PACE[p.pace].visit);
}

// ---------- Planning (horaires) ----------
function schedule(r) {
  const p = r.prefs;
  let index = 0;
  const days = r.days.map((items, d) => {
    let t = d === 0 ? r.startClock : DAY_START_DEFAULT, prev = r.start, km = 0;
    const dayStart = t;
    const rows = items.map((it) => {
      const pl = BY_ID[it.id];
      const l = leg(prev, pl, p);
      t += l.min;
      const arrive = t;
      t += visitMinutes(it, p);
      if (!l.bus) km += l.km;
      prev = pl;
      return { ...it, pl, leg: l, arrive, leave: t, index: index++ };
    });
    return { rows, km, minutes: t - dayStart, end: t };
  });
  return {
    days,
    flat: days.flatMap((d) => d.rows),
    km: days.reduce((s, d) => s + d.km, 0),
    minutes: days.reduce((s, d) => s + d.minutes, 0),
  };
}

// ---------- Formatage ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtClock = (m) => `${Math.floor(m / 60) % 24}h${pad(Math.round(m % 60))}`;
function fmtDur(m) {
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60 ? pad(m % 60) : ''}`.trim();
}
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000 / 10) * 10} m` : `${km.toFixed(1).replace('.', ',')} km`);
function parseClock(s) {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function defaultStartTime() {
  const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
  if (m < 7 * 60 || m > 19 * 60) return '09:30';
  const r = Math.ceil(m / 15) * 15;
  return `${pad(Math.floor(r / 60))}:${pad(r % 60)}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- Questionnaire ----------
function initQuiz() {
  const parkingSel = $('#parking');
  parkingSel.innerHTML = DATA.departs.parkings.map((pk) => `<option value="${pk.id}">${esc(pk.nom)}</option>`).join('');

  document.querySelectorAll('.chips').forEach((group) => {
    const name = group.dataset.name, multi = group.hasAttribute('data-multi');
    const sync = () => group.querySelectorAll('.chip').forEach((c) => {
      const v = c.dataset.value;
      c.setAttribute('aria-pressed', multi ? prefs[name].includes(v) : prefs[name] === v);
    });
    group.addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const v = c.dataset.value;
      if (multi) prefs[name] = prefs[name].includes(v) ? prefs[name].filter((x) => x !== v) : [...prefs[name], v];
      else prefs[name] = v;
      sync();
      if (name === 'start') parkingSel.hidden = prefs.start !== 'parking';
    });
    sync();
  });

  parkingSel.value = prefs.parking;
  parkingSel.hidden = prefs.start !== 'parking';
  parkingSel.addEventListener('change', () => { prefs.parking = parkingSel.value; });
  $('#start-time').value = prefs.startTime || defaultStartTime();

  $('#quiz').addEventListener('submit', async (e) => {
    e.preventDefault();
    prefs.startTime = $('#start-time').value || defaultStartTime();
    if (!prefs.interests.length) toast('Aucun centre d\'intérêt choisi : je prends les incontournables.');
    save(STORE.prefs, prefs);
    const btn = e.submitter || $('#quiz [type=submit]');
    btn.disabled = true; btn.textContent = 'Calcul du parcours…';
    try {
      const start = await resolveStart(prefs);
      route = generateRoute(prefs, start);
      saveRoute();
      showRoute();
    } finally {
      btn.disabled = false; btn.textContent = 'Tracer mon parcours';
    }
  });
}

/** Point de départ : gare, parking ou GPS (avec repli sur la gare). */
async function resolveStart(p) {
  if (p.start === 'parking') {
    const pk = DATA.departs.parkings.find((x) => x.id === p.parking) || DATA.departs.parkings[0];
    return { lat: pk.lat, lng: pk.lng, nom: pk.nom };
  }
  if (p.start === 'gps') {
    try {
      const pos = await getPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude, nom: 'Ma position' };
      if (haversineKm(here, METZ_CENTER) > 15) {
        toast('Vous semblez loin de Metz : départ fixé à la gare.');
      } else return here;
    } catch (err) {
      toast(geoErrorMessage(err) + ' Départ fixé à la gare.', 5000);
    }
  }
  return { ...DATA.departs.gare };
}

// ---------- Géolocalisation ----------
function getPosition(opts) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject({ code: 0 });
    navigator.geolocation.getCurrentPosition(resolve, reject, opts);
  });
}
function geoErrorMessage(err) {
  switch (err?.code) {
    case 1: return 'Localisation refusée. Vous pouvez l\'autoriser dans les réglages du site (icône à gauche de l\'adresse).';
    case 2: return 'Position indisponible pour le moment.';
    case 3: return 'La localisation a mis trop de temps.';
    default: return 'Géolocalisation non disponible sur cet appareil.';
  }
}
function startWatch() {
  if (!('geolocation' in navigator) || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, (err) => {
    if (err.code === 1) {
      navigator.geolocation.clearWatch(watchId); watchId = null;
      showNotice('📍 Position non partagée : le parcours reste utilisable, sans le point bleu. Touchez ◎ pour réessayer.');
    }
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}
function onPosition(pos) {
  lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
  if (!map) return;
  const ll = [lastPos.lat, lastPos.lng];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(map);
    meCircle = L.circle(ll, { radius: lastPos.acc, color: '#1A73E8', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  } else {
    meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(lastPos.acc);
  }
}

// ---------- Écran parcours ----------
function showNotice(html) { const n = $('#notice'); n.innerHTML = html; n.hidden = false; }

function showRoute() {
  $('#screen-quiz').hidden = true;
  $('#screen-route').hidden = false;
  $('#btn-edit').hidden = false;
  window.scrollTo(0, 0);
  initMap();
  renderRoute(true);
  startWatch();
}
function showQuiz() {
  $('#screen-route').hidden = true;
  $('#screen-quiz').hidden = false;
  window.scrollTo(0, 0);
}

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  if (!window.L) {
    $('#map').innerHTML = '<p class="notice" style="margin:16px">Carte indisponible hors ligne au premier lancement. La liste des étapes reste utilisable.</p>';
    return;
  }
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([METZ_CENTER.lat, METZ_CENTER.lng], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,          // réponses CORS, cachables proprement par le service worker
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  layers = L.layerGroup().addTo(map);
  if (lastPos) onPosition({ coords: { latitude: lastPos.lat, longitude: lastPos.lng, accuracy: lastPos.acc } });
}

function renderRoute(fit = false) {
  const sch = schedule(route);
  const { perDay, days } = DURATIONS[route.prefs.duration];
  const total = sch.flat.length;
  if (route.current >= total) route.current = Math.max(0, total - 1);

  // Résumé
  $('#sum-stops').textContent = total;
  $('#sum-dist').textContent = fmtKm(sch.km);
  $('#sum-time').textContent = fmtDur(sch.minutes);
  const done = sch.flat.filter((r) => visited.has(r.id)).length;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('#sum-done').textContent = `${pct} %`;
  $('#progress-bar').style.width = `${pct}%`;

  const over = sch.days.map((d) => d.minutes - perDay).filter((x) => x > 10);
  const n = $('#notice');
  if (over.length) {
    n.hidden = false;
    n.textContent = `⏱ Le parcours dépasse votre temps disponible d'environ ${fmtDur(Math.max(...over))}. Retirez une étape si besoin.`;
  } else if (n.textContent.startsWith('⏱')) n.hidden = true;

  // Liste
  const ol = $('#stops');
  const html = [];
  sch.days.forEach((d, di) => {
    if (days > 1) html.push(`<li class="day-title">Jour ${di + 1} · ${fmtClock(d.rows[0]?.arrive ?? DAY_START_DEFAULT)} – ${fmtClock(d.end)}</li>`);
    if (di === 0 || days > 1) html.push(`<li class="leg">Départ : ${esc(route.start.nom)}</li>`);
    d.rows.forEach((r) => {
      const isDone = visited.has(r.id), isCur = r.index === route.current;
      html.push(`<li class="leg">${r.leg.bus ? '🚌 bus Le Met\'' : '🚶'} ${r.leg.min} min · ${fmtKm(r.leg.km)}</li>`);
      html.push(`<li class="stop${isDone ? ' visited' : ''}${isCur ? ' current' : ''}" data-index="${r.index}">
        <span class="badge${r.pause ? ' pause' : ''}${isDone ? ' done' : ''}">${isDone ? '✓' : r.index + 1}</span>
        <button class="stop-main" data-open="${r.index}">
          ${r.pl.image ? `<img class="stop-thumb" src="${esc(r.pl.image)}" alt="" loading="lazy" decoding="async">` : ''}
          <span class="stop-text">
            <span class="stop-name">${r.pause ? esc(PAUSES[r.pause].label) + ' · ' : ''}${esc(r.pl.nom)}</span>
            <span class="stop-meta">${fmtClock(r.arrive)} · ${fmtDur(r.leave - r.arrive)}${r.pl.payant && !r.pause ? ' · <span class="tag-pay">payant</span>' : ''}</span>
          </span>
        </button>
        <button class="stop-remove" data-remove="${r.index}" aria-label="Retirer ${esc(r.pl.nom)}">✕</button>
      </li>`);
    });
  });
  ol.innerHTML = html.join('');

  drawMap(sch, fit);
}

function drawMap(sch, fit) {
  if (!map) return;
  layers.clearLayers();
  const start = route.start;
  L.marker([start.lat, start.lng], { icon: pinIcon('D', 'start'), title: start.nom }).addTo(layers);
  sch.days.forEach((d, di) => {
    const pts = [[start.lat, start.lng], ...d.rows.map((r) => [r.pl.lat, r.pl.lng])];
    L.polyline(pts, { color: '#1F4E8C', weight: 5, opacity: 0.85, dashArray: di ? '10 8' : null }).addTo(layers);
    L.polyline(pts, { color: '#E9C766', weight: 2, opacity: 0.9 }).addTo(layers);
  });
  sch.flat.forEach((r) => {
    const cls = [r.pause ? 'pause' : '', visited.has(r.id) ? 'done' : '', r.index === route.current ? 'current' : ''].join(' ');
    L.marker([r.pl.lat, r.pl.lng], { icon: pinIcon(visited.has(r.id) ? '✓' : r.index + 1, cls), title: r.pl.nom })
      .on('click', () => openSheet(r.index))
      .addTo(layers);
  });
  if (fit) {
    const b = L.latLngBounds([[start.lat, start.lng], ...sch.flat.map((r) => [r.pl.lat, r.pl.lng])]);
    map.fitBounds(b, { padding: [28, 28] });
  }
}
const pinIcon = (label, cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${label}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] });

// ---------- Modifications du parcours ----------
function locate(index) {
  let k = index;
  for (let d = 0; d < route.days.length; d++) {
    if (k < route.days[d].length) return { d, k };
    k -= route.days[d].length;
  }
  return null;
}
function removeStop(index) {
  const loc = locate(index);
  if (!loc) return;
  const [it] = route.days[loc.d].splice(loc.k, 1);
  if (index < route.current) route.current--;
  saveRoute();
  renderRoute();
  toast(`« ${BY_ID[it.id].nom} » retiré.`);
}

function inRoute(id) { return route.days.some((d) => d.some((it) => it.id === id)); }

function openSuggestions() {
  const stops = route.days.flat().map((it) => BY_ID[it.id]).concat([route.start]);
  const list = DATA.lieux
    .filter((pl) => pl.type !== 'pause' && !inRoute(pl.id))
    .map((pl) => ({ pl, d: Math.min(...stops.map((s) => walkKm(s, pl))) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8);
  $('#suggest-list').innerHTML = list.length
    ? list.map(({ pl, d }) => `<li><button type="button" data-add="${pl.id}">
        <strong>${esc(pl.nom)}</strong>
        <small>à ${fmtKm(d)} du parcours · ${pl.duree} min${pl.payant ? ' · payant' : ' · gratuit'} · ${pl.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}</small>
      </button></li>`).join('')
    : '<li>Tous les lieux sont déjà dans votre parcours !</li>';
  $('#suggest').showModal();
}

/** Insertion au coût minimal (moindre détour), uniquement dans la partie du parcours qui reste à faire. */
function addStop(id) {
  const pl = BY_ID[id];
  const flat = route.days.flat();
  const curDone = flat[route.current] && visited.has(flat[route.current].id);
  const minIndex = route.current + (curDone ? 1 : 0);
  let best = null, offset = 0;
  route.days.forEach((items, d) => {
    for (let k = 0; k <= items.length; k++) {
      if (offset + k < minIndex) continue;
      const a = k === 0 ? route.start : BY_ID[items[k - 1].id], b = items[k] ? BY_ID[items[k].id] : null;
      const cost = walkKm(a, pl) + (b ? walkKm(pl, b) - walkKm(a, b) : 0);
      if (!best || cost < best.cost) best = { d, k, cost };
    }
    offset += items.length;
  });
  route.days[best.d].splice(best.k, 0, { id });
  saveRoute();
  renderRoute();
  toast(`« ${pl.nom} » ajouté au parcours.`);
}

function regenerate() {
  if (!confirm('Régénérer un nouveau parcours ? Les modifications seront perdues (les lieux visités restent cochés).')) return;
  route = generateRoute(route.prefs, route.start, { jitter: true });
  saveRoute();
  renderRoute(true);
  toast('Nouveau parcours proposé.');
}

// ---------- Visite ----------
function currentRow() { return schedule(route).flat[route.current]; }

function nextStep() {
  const flat = schedule(route).flat;
  if (!flat.length) return;
  const cur = flat[route.current];
  if (cur) visited.add(cur.id);
  const nextIdx = flat.findIndex((r, i) => i > route.current && !visited.has(r.id));
  saveVisited();
  if (nextIdx === -1) {
    renderRoute();
    toast('🎉 Parcours terminé ! Bravo, et bonne fin de séjour à Metz.', 5000);
    return;
  }
  route.current = nextIdx;
  saveRoute();
  renderRoute();
  const r = flat[nextIdx];
  if (map) map.flyTo([r.pl.lat, r.pl.lng], 17, { duration: 0.8 });
  toast(`Prochaine étape : ${r.pl.nom} (${r.leg.min} min)`);
}

function gmapsUrl(pl, bus) {
  const mode = bus ? 'transit' : 'walking';
  return `https://www.google.com/maps/dir/?api=1&destination=${pl.lat},${pl.lng}&travelmode=${mode}`;
}

function openSheet(index) {
  const r = schedule(route).flat[index];
  if (!r) return;
  const pl = r.pl, isDone = visited.has(pl.id);
  $('#sheet-body').innerHTML = `
    ${pl.image ? `<figure class="sheet-photo">
      <img src="${esc(pl.image)}" alt="${esc(pl.nom)}" decoding="async">
      <figcaption>${pl.imageIllustration ? 'Illustration · ' : ''}Photo : <a href="${esc(pl.imageUrl)}" target="_blank" rel="noopener">${esc(pl.imageCredit)}</a></figcaption>
    </figure>` : ''}
    <h2>${esc(pl.nom)}</h2>
    <div class="pills">
      <span class="pill">Étape ${index + 1} · ${fmtClock(r.arrive)}</span>
      <span class="pill">⏱ ${fmtDur(r.leave - r.arrive)} conseillées</span>
      <span class="pill ${pl.payant ? 'paid' : 'free'}">${pl.payant ? '€ Payant' : 'Gratuit'}</span>
      ${pl.categories.map((c) => `<span class="pill">${esc(CATEGORY_LABELS[c])}</span>`).join('')}
    </div>
    <p>${esc(pl.description)}</p>
    <h3>À regarder</h3><p>${esc(pl.aRegarder)}</p>
    <h3>Anecdote</h3><p class="callout">${esc(pl.anecdote)}</p>
    <h3>Conseil photo</h3><p>📷 ${esc(pl.photo)}</p>
    ${pl.note ? `<p class="fineprint" style="text-align:left">ℹ️ ${esc(pl.note)}</p>` : ''}
    <p class="fineprint" style="text-align:left">Horaires et tarifs à confirmer sur place.</p>
    <div class="sheet-actions">
      <button type="button" class="btn btn-ghost visited-toggle" data-toggle="${esc(pl.id)}" aria-pressed="${isDone}">${isDone ? '✓ Visité' : 'Marquer visité'}</button>
      <a class="btn btn-secondary" href="${gmapsUrl(pl, r.leg.bus)}" target="_blank" rel="noopener">Y aller ↗</a>
      <button type="button" class="btn btn-primary" data-current="${index}" style="grid-column:1/-1">Faire de cette étape l'étape en cours</button>
    </div>`;
  $('#sheet').showModal();
}

// ---------- Événements ----------
function bindEvents() {
  $('#btn-edit').addEventListener('click', showQuiz);
  $('#btn-suggest').addEventListener('click', openSuggestions);
  $('#btn-regen').addEventListener('click', regenerate);
  $('#btn-next').addEventListener('click', nextStep);
  $('#btn-gmaps').addEventListener('click', () => {
    const r = currentRow();
    if (r) window.open(gmapsUrl(r.pl, r.leg.bus), '_blank', 'noopener');
  });
  $('#btn-locate').addEventListener('click', async () => {
    if (lastPos && map) { map.flyTo([lastPos.lat, lastPos.lng], 17); return; }
    try {
      const pos = await getPosition({ enableHighAccuracy: true, timeout: 10000 });
      onPosition(pos);
      if (map) map.flyTo([lastPos.lat, lastPos.lng], 17);
      $('#notice').hidden = true;
      startWatch();
    } catch (err) { toast(geoErrorMessage(err), 5000); }
  });

  $('#stops').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]'), rm = e.target.closest('[data-remove]');
    if (open) openSheet(Number(open.dataset.open));
    if (rm) removeStop(Number(rm.dataset.remove));
  });
  $('#suggest-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    $('#suggest').close();
    addStop(b.dataset.add);
  });
  $('#sheet-body').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]'), c = e.target.closest('[data-current]');
    if (t) {
      const id = t.dataset.toggle;
      visited.has(id) ? visited.delete(id) : visited.add(id);
      saveVisited();
      t.setAttribute('aria-pressed', visited.has(id));
      t.textContent = visited.has(id) ? '✓ Visité' : 'Marquer visité';
      renderRoute();
    }
    if (c) {
      route.current = Number(c.dataset.current);
      saveRoute();
      $('#sheet').close();
      renderRoute();
      const r = currentRow();
      if (map && r) map.flyTo([r.pl.lat, r.pl.lng], 17);
    }
  });
  // Fermer les fiches en touchant le fond
  document.querySelectorAll('dialog').forEach((dlg) => dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }));
}

// ---------- Démarrage ----------
async function main() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js', { scope: './' }).catch((err) => console.warn('SW non enregistré', err));
  }
  try {
    const res = await fetch('data/lieux.json');
    DATA = await res.json();
  } catch {
    document.querySelector('.intro').textContent = 'Impossible de charger les lieux. Vérifiez la connexion puis rechargez la page.';
    return;
  }
  BY_ID = Object.fromEntries(DATA.lieux.map((pl) => [pl.id, pl]));
  // Un parcours sauvegardé qui référence un lieu disparu est abandonné.
  if (route && !route.days?.flat().every((it) => BY_ID[it.id])) route = null;

  initQuiz();
  bindEvents();
  if (route) showRoute();
}

main();
