'use strict';

const VERSION = '0.1.0';
const MAX_PRODUCTS = 9;          // + 1 shelf photo = 10 images, Gemini's per-message limit
const PHOTO_MAX_SIDE = 1600;     // downscale camera photos before storing
const STITCH_MAX_WIDTH = 2400;
const THUMB_SIDE = 220;

const CONDITIONS = [
  ['t2d', 'Type 2 diabetes'],
  ['t1d', 'Type 1 diabetes'],
  ['prediabetes', 'Pre-diabetes / insulin resistance'],
  ['bp', 'High blood pressure'],
  ['chol', 'High cholesterol / heart health'],
  ['weight', 'Losing weight'],
  ['gluten', 'Coeliac / gluten-free'],
  ['lactose', 'Lactose intolerant'],
  ['nuts', 'Nut allergy'],
  ['sulphite', 'Asthma / sulphite sensitive'],
  ['pregnant', 'Pregnant / breastfeeding'],
  ['kids', 'Buying for children'],
  ['vegetarian', 'Vegetarian'],
  ['halal', 'Halal'],
];

const ASSISTANTS = {
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  copilot: { name: 'Copilot', url: 'https://copilot.microsoft.com/' },
  claude: { name: 'Claude', url: 'https://claude.ai/new' },
  other: { name: 'your AI app', url: null },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normCat = (s) => String(s || '').trim().toLowerCase();
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ------------------------------------------------------------------ storage */

const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('labelcheck', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('kv');
        db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  get: (key) => DB.tx('kv', 'readonly', (s) => s.get(key)),
  set: (key, val) => DB.tx('kv', 'readwrite', (s) => s.put(val, key)),
  allHistory: () => DB.tx('history', 'readonly', (s) => s.getAll()),
  putHistory: (entry) => DB.tx('history', 'readwrite', (s) => s.put(entry)),
  addHistory: (entry) => DB.tx('history', 'readwrite', (s) => s.add(entry)),
  delHistory: (id) => DB.tx('history', 'readwrite', (s) => s.delete(id)),
};

const state = {
  settings: null,   // { profile: [], other, assistant, consent, store }
  draft: null,      // { category, products: [{front, back}], shelf, stage, picked }
  history: [],
  prepared: null,   // { files, prompt, urls } for the send view
  entryId: null,
  installEvent: null,
};

const emptyDraft = () => ({ category: '', products: [{ front: null, back: null }], shelf: null, stage: 'compare' });

async function saveSettings() { await DB.set('settings', state.settings); }
async function saveDraft() { await DB.set('draft', state.draft); }
async function loadHistory() {
  state.history = (await DB.allHistory()).sort((a, b) => b.date.localeCompare(a.date));
}

/* ------------------------------------------------------------------ images */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that photo'));
    img.src = src;
  });
}

function scaledCanvas(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

async function fileToDataURL(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return scaledCanvas(img, PHOTO_MAX_SIDE).toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function thumb(dataURL) {
  const img = await loadImage(dataURL);
  return scaledCanvas(img, THUMB_SIDE).toDataURL('image/jpeg', 0.7);
}

const canvasToBlob = (c) => new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));

function drawBanner(ctx, width, height, label, captions) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#39ff6a';
  ctx.font = `bold ${Math.round(height * 0.62)}px sans-serif`;
  ctx.fillText(label, 18, height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(height * 0.36)}px sans-serif`;
  for (const [text, x] of captions) ctx.fillText(text, x, height / 2);
}

// One image per product: FRONT on the left, BACK on the right, labelled P1, P2…
async function stitchProduct(label, frontURL, backURL) {
  const [f, b] = await Promise.all([loadImage(frontURL), loadImage(backURL)]);
  const gap = 16;
  const rf = f.naturalWidth / f.naturalHeight;
  const rb = b.naturalWidth / b.naturalHeight;
  // Never upscale the back (it holds the small print); the front may be stretched slightly to match.
  const h = Math.round(Math.min(1400, b.naturalHeight, (STITCH_MAX_WIDTH - gap) / (rf + rb)));
  const fw = Math.round(h * rf);
  const bw = Math.round(h * rb);
  const banner = Math.max(60, Math.round(h * 0.07));
  const c = document.createElement('canvas');
  c.width = fw + gap + bw;
  c.height = h + banner;
  const ctx = c.getContext('2d');
  drawBanner(ctx, c.width, banner, label, [[`FRONT`, Math.max(fw * 0.45, banner * 2.2)], [`BACK`, fw + gap + bw * 0.4]]);
  ctx.drawImage(f, 0, banner, fw, h);
  ctx.drawImage(b, fw + gap, banner, bw, h);
  return canvasToBlob(c);
}

async function labelShelf(shelfURL) {
  const img = await loadImage(shelfURL);
  const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const banner = Math.max(60, Math.round(h * 0.07));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h + banner;
  const ctx = c.getContext('2d');
  drawBanner(ctx, w, banner, 'SHELF', []);
  ctx.drawImage(img, 0, banner, w, h);
  return canvasToBlob(c);
}

/* ------------------------------------------------------------------ prompt */

function profileText(settings) {
  const names = CONDITIONS.filter(([id]) => settings.profile.includes(id)).map(([, n]) => n);
  if (settings.other) names.push(settings.other);
  return names.join('; ');
}

function learningLines(category) {
  const cat = normCat(category);
  if (!cat) return [];
  return state.history
    .filter((e) => normCat(e.category) === cat && e.chosen >= 0)
    .slice(0, 6)
    .map((e) => {
      let line = `- ${fmtDate(e.date)}: chose "${e.name || 'a product (name not saved)'}"${e.store ? ` at ${e.store}` : ''}`;
      if (e.rating === 'like') line += ' – I liked it';
      if (e.rating === 'dislike') line += ' – I did NOT like it, don\'t suggest it again';
      if (e.feedback) line += ` ("${e.feedback}")`;
      return line;
    });
}

function buildPrompt({ count, shelf, store, category, health, learning }) {
  const L = [];
  L.push(`I'm standing in a shop ${count > 1 ? 'comparing products' : 'looking at a product'}${category ? ` (${category})` : ''}. Please help me choose.`);
  L.push('');
  L.push(`PHOTOS: ${count} product photo${count > 1 ? `s labelled P1–P${count}` : ' labelled P1'}. Each shows ONE product: FRONT of the pack on the left, BACK (ingredients + nutrition table) on the right.${shelf ? ' One extra photo labelled SHELF shows the whole shelf.' : ''}`);
  L.push(store ? `STORE: ${store} (South Africa).` : 'COUNTRY: South Africa.');
  L.push(`MY HEALTH: ${health || 'no specific condition – general healthy eating'}.`);
  if (learning.length) {
    L.push('WHAT I CHOSE BEFORE in this category:');
    L.push(...learning);
    L.push('Health comes first, taste second: if my usual choice is worse for my health, tell me.');
  }
  L.push('');
  L.push(`For ${count > 1 ? 'EACH product (P1, P2, …)' : 'the product'}:`);
  L.push('1. FRONT CLAIMS – list every claim on the front exactly as printed (e.g. "lite", "natural", "no added sugar", "high fibre").');
  L.push('2. BACK DECODED – main ingredients in order (first = biggest). Name every hidden sugar (e.g. maltodextrin, glucose syrup, dextrose, fructose, invert sugar, fruit juice concentrate) and sweeteners such as maltitol and other polyols. Explain every E-number/INS code in plain words, but only call it a concern if it matters for my health – most E-numbers are harmless (E300 is vitamin C). Give per 100 g: sugar, carbohydrate, fibre, sodium/salt, saturated fat, protein.');
  L.push('3. VERDICT – ✅ Honest, ⚠️ Misleading or ❓ Can\'t tell, with one line on why the front does or doesn\'t match the back.');
  L.push('');
  L.push('Then:');
  if (count > 1) {
    L.push('• RANKING for my health, best first, one line each.');
    L.push('• BEST PICK: P#, and why in one sentence.');
  } else {
    L.push('• GOOD FOR ME? Yes / With care / No – and why in one sentence.');
  }
  if (shelf || store) {
    let s = '• BETTER OPTIONS I MAY HAVE MISSED: ';
    if (shelf) s += 'look at the SHELF photo and name products that may be better for me, and where they are on the shelf. ';
    if (store) s += `You may also check what ${store} sells in this category. `;
    s += 'Mark every suggestion "check its back label before buying" – these are leads, not facts.';
    L.push(s);
  }
  L.push('');
  L.push('RULES: use only what is printed on the labels. If something is unreadable or missing (for example no nutrition table), say "can\'t read" – never guess or use typical values. Keep it short: I\'m standing in the aisle. Information only, not medical advice.');
  return L.join('\n');
}

/* ------------------------------------------------------------------ ui helpers */

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  }
  legacyCopy(text);
  return Promise.resolve();
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* nothing else to try */ }
  ta.remove();
}

function renderChecks(container, selected) {
  container.innerHTML = CONDITIONS.map(([id, name]) => `
    <label class="check"><input type="checkbox" value="${id}" ${selected.includes(id) ? 'checked' : ''}><span>${esc(name)}</span></label>`).join('');
}

function renderRadios(container, name, selected) {
  container.innerHTML = Object.entries(ASSISTANTS).map(([id, a]) => `
    <label class="radio"><input type="radio" name="${name}" value="${id}" ${selected === id ? 'checked' : ''}><span>${id === 'other' ? 'Other / not sure' : esc(a.name)}</span></label>`).join('');
}

const readChecks = (container) => [...container.querySelectorAll('input:checked')].map((i) => i.value);
const readRadio = (container) => container.querySelector('input:checked')?.value || 'gemini';

/* ------------------------------------------------------------------ routing */

const VIEWS = ['setup', 'home', 'store', 'compare', 'send', 'pick', 'entry', 'settings'];

function go(view) {
  if (location.hash.slice(1) === view) route();
  else location.hash = view;
}

function route() {
  let view = location.hash.slice(1) || 'home';
  if (!VIEWS.includes(view)) view = 'home';
  if (!state.settings?.consent) view = 'setup';
  else if (view === 'setup') view = 'home';
  if ((view === 'send' || view === 'pick') && !completeProducts().length) view = 'compare';
  if (view === 'entry' && state.entryId == null) view = 'home';

  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  window.scrollTo(0, 0);
  ({
    setup: renderSetup, home: renderHome, store: renderStore, compare: renderCompare,
    send: renderSend, pick: renderPick, entry: renderEntry, settings: renderSettings,
  })[view]();
}

/* ------------------------------------------------------------------ setup */

function renderSetup() {
  renderChecks($('#setup-profile'), []);
  renderRadios($('#setup-assistant'), 'setup-ai', 'gemini');
}

$('#setup-consent').addEventListener('change', (e) => { $('#setup-done').disabled = !e.target.checked; });
$('#setup-done').addEventListener('click', async () => {
  state.settings = {
    profile: readChecks($('#setup-profile')),
    other: $('#setup-other').value.trim(),
    assistant: readRadio($('#setup-assistant')),
    consent: true,
    store: '',
  };
  await saveSettings();
  go('home');
});

/* ------------------------------------------------------------------ home */

function bestList() {
  const byCat = new Map();
  for (const e of state.history) {           // newest first
    if (e.chosen < 0 || e.rating === 'dislike') continue;
    const key = normCat(e.category) || '(no category)';
    const cur = byCat.get(key);
    if (!cur || (e.rating === 'like' && cur.rating !== 'like')) byCat.set(key, e);
  }
  return [...byCat.values()];
}

function entryCard(e, title) {
  const img = e.products[Math.max(0, e.chosen)]?.thumb || '';
  const chosen = e.chosen >= 0 ? (e.name || `P${e.chosen + 1}`) : 'none chosen';
  const badge = e.rating === 'like' ? '<span class="badge like">👍</span>' : e.rating === 'dislike' ? '<span class="badge dislike">👎</span>' : '';
  return `<button class="card" data-entry="${e.id}">
    <img src="${esc(img)}" alt="">
    <div><div class="t">${esc(title)}${badge}</div>
    <div class="s">${esc(chosen)}${e.store ? ' · ' + esc(e.store) : ''} · ${fmtDate(e.date)}</div></div>
  </button>`;
}

function renderHome() {
  $('#home-store').textContent = state.settings.store || 'No store set';
  const best = bestList();
  $('#best-list').innerHTML = best.length
    ? best.map((e) => entryCard(e, e.category || 'No category')).join('')
    : '<p class="empty">Your best choice per product type shows here after your first comparison.</p>';
  $('#history-list').innerHTML = state.history.length
    ? state.history.slice(0, 40).map((e) => entryCard(e, `${e.category || 'Comparison'} (${e.products.length})`)).join('')
    : '<p class="empty">Nothing yet.</p>';
  renderInstallBanner();
}

document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-entry]');
  if (card) { state.entryId = Number(card.dataset.entry); go('entry'); return; }
  const nav = e.target.closest('[data-go]');
  if (nav) go(nav.dataset.go);
});

$('#home-store-btn').addEventListener('click', () => go('store'));

/* ------------------------------------------------------------------ install banner */

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function renderInstallBanner() {
  const el = $('#install-banner');
  if (isStandalone() || (await DB.get('installDismissed'))) { el.hidden = true; return; }
  let html;
  if (state.installEvent) {
    html = '<b>Install LabelCheck</b> on your phone so it opens like an app and keeps your history.<br><button class="btn small primary" id="inst-go">Install</button>';
  } else if (isIOS()) {
    html = '<b>Add to Home Screen</b> or iPhone may delete your history after 7 days: tap Share <b>⬆</b> then <b>Add to Home Screen</b>.';
  } else {
    html = '<b>Install LabelCheck:</b> open the browser menu <b>⋮</b> and tap <b>Install app</b> or <b>Add to Home screen</b>.';
  }
  el.innerHTML = `${html} <button class="btn small" id="inst-no">Hide</button>`;
  el.hidden = false;
  $('#inst-no').onclick = async () => { await DB.set('installDismissed', true); el.hidden = true; };
  const goBtn = $('#inst-go');
  if (goBtn) goBtn.onclick = async () => {
    state.installEvent.prompt();
    await state.installEvent.userChoice;
    state.installEvent = null;
    el.hidden = true;
  };
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installEvent = e;
  if (!$('#view-home').hidden) renderInstallBanner();
});

/* ------------------------------------------------------------------ store */

function renderStore() {
  $('#store-input').value = state.settings.store || '';
  $('#store-status').textContent = '';
  $('#store-results').innerHTML = '';
}

function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function nearbyShops(lat, lon, radius) {
  const q = `[out:json][timeout:20];nwr(around:${radius},${lat},${lon})["shop"~"^(supermarket|convenience|wholesale|health_food|chemist|department_store|general|greengrocer|butcher|bakery|variety_store)$"];out center tags 40;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error(`Map service error ${res.status}`);
  const data = await res.json();
  return data.elements
    .map((el) => {
      const t = el.tags || {};
      const name = t.name || t.brand;
      const plat = el.lat ?? el.center?.lat, plon = el.lon ?? el.center?.lon;
      if (!name || plat == null) return null;
      const place = t['addr:city'] || t['addr:town'] || t['addr:suburb'] || '';
      return { label: place && !name.includes(place) ? `${name}, ${place}` : name, dist: distanceM(lat, lon, plat, plon) };
    })
    .filter(Boolean)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);
}

$('#store-detect').addEventListener('click', () => {
  const status = $('#store-status');
  if (!navigator.geolocation) { status.textContent = 'This browser cannot share your location. Type the store name instead.'; return; }
  status.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    try {
      status.textContent = 'Looking up nearby stores…';
      let shops = await nearbyShops(lat, lon, 400);
      if (!shops.length) shops = await nearbyShops(lat, lon, 2000);
      if (!shops.length) { status.textContent = 'No stores found on the map here. Type the name instead.'; return; }
      status.textContent = 'Tap your store:';
      $('#store-results').innerHTML = shops.map((s) => `
        <button class="card" data-store="${esc(s.label)}"><div><div class="t">${esc(s.label)}</div>
        <div class="s">${s.dist < 1000 ? Math.round(s.dist) + ' m' : (s.dist / 1000).toFixed(1) + ' km'} away</div></div></button>`).join('');
    } catch (err) {
      status.textContent = `Couldn't look up stores (${err.message}). Type the name instead.`;
    }
  }, (err) => {
    status.textContent = err.code === 1 ? 'Location permission was refused. Type the store name instead.' : 'Couldn\'t get your location. Type the store name instead.';
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
});

$('#store-results').addEventListener('click', (e) => {
  const b = e.target.closest('[data-store]');
  if (!b) return;
  $('#store-input').value = b.dataset.store;
  $('#store-save').click();
});

$('#store-save').addEventListener('click', async () => {
  state.settings.store = $('#store-input').value.trim();
  await saveSettings();
  toast(state.settings.store ? `Store set: ${state.settings.store}` : 'No store set');
  go('home');
});

$('#store-clear').addEventListener('click', async () => {
  state.settings.store = '';
  await saveSettings();
  go('home');
});

/* ------------------------------------------------------------------ compare */

const completeProducts = () => (state.draft?.products || []).filter((p) => p.front && p.back);

function shotHTML(kind, idx, url, label, sub) {
  if (url) {
    return `<button class="shot done" data-shot="${kind}" data-idx="${idx}"><img src="${url}" alt=""><span class="lbl">${label} ✓ (tap to retake)</span></button>`;
  }
  return `<button class="shot" data-shot="${kind}" data-idx="${idx}"><span class="ico">📷</span>${label}<span class="shot-sub">${sub}</span></button>`;
}

function renderCompare() {
  const d = state.draft;
  $('#cmp-category').value = d.category || '';
  const cats = [...new Set(state.history.map((e) => e.category).filter(Boolean))];
  $('#cat-suggest').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');

  $('#cmp-products').innerHTML = d.products.map((p, i) => `
    <div class="product">
      <div class="product-head"><span class="tag">P${i + 1}</span>
        ${d.products.length > 1 ? `<button data-remove="${i}">✕ Remove</button>` : ''}</div>
      <div class="shots">
        ${shotHTML('front', i, p.front, 'Front', 'the side with the name')}
        ${shotHTML('back', i, p.back, 'Back', 'ingredients + nutrition table')}
      </div>
    </div>`).join('');
  $('#cmp-shelf').innerHTML = shotHTML('shelf', 0, d.shelf, 'Shelf', '');

  const done = completeProducts().length;
  const incomplete = d.products.some((p) => (p.front || p.back) && !(p.front && p.back));
  $('#cmp-add').disabled = d.products.length >= MAX_PRODUCTS;
  $('#cmp-add').textContent = d.products.length >= MAX_PRODUCTS ? `Maximum ${MAX_PRODUCTS} products` : '＋ Add product';
  $('#cmp-go').disabled = !done || incomplete;
  $('#cmp-go').textContent = done > 1 ? `Compare ${done} products` : 'Check this product';
  $('#cmp-count').textContent = incomplete ? 'Each product needs both a front and a back photo.' : '';
}

let pendingShot = null;

$('#cmp-products').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const i = Number(rm.dataset.remove);
    const p = state.draft.products[i];
    if ((p.front || p.back) && !confirm(`Remove P${i + 1}?`)) return;
    state.draft.products.splice(i, 1);
    await saveDraft();
    renderCompare();
  }
});

document.addEventListener('click', (e) => {
  const s = e.target.closest('[data-shot]');
  if (!s) return;
  pendingShot = { kind: s.dataset.shot, idx: Number(s.dataset.idx) };
  const cam = $('#cam');
  cam.value = '';
  cam.click();
});

$('#cam').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file || !pendingShot) return;
  try {
    const url = await fileToDataURL(file);
    const { kind, idx } = pendingShot;
    if (kind === 'shelf') state.draft.shelf = url;
    else state.draft.products[idx][kind] = url;
    await saveDraft();
    renderCompare();
    // Gentle guidance: after a front, the back is next.
    if (kind === 'front' && !state.draft.products[idx].back) toast(`Now the back of P${idx + 1}`, 2000);
  } catch (err) {
    toast(err.message || 'Could not use that photo');
  } finally {
    pendingShot = null;
  }
});

$('#cmp-category').addEventListener('change', async (e) => {
  state.draft.category = e.target.value.trim();
  await saveDraft();
});

$('#cmp-add').addEventListener('click', async () => {
  if (state.draft.products.length >= MAX_PRODUCTS) return;
  state.draft.products.push({ front: null, back: null });
  await saveDraft();
  renderCompare();
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});

$('#cmp-clear').addEventListener('click', async () => {
  if (!confirm('Clear all photos and start over?')) return;
  state.draft = emptyDraft();
  await saveDraft();
  renderCompare();
});

$('#cmp-go').addEventListener('click', async () => {
  state.draft.category = $('#cmp-category').value.trim();
  // Drop empty product slots before sending.
  state.draft.products = completeProducts();
  state.draft.stage = 'send';
  await saveDraft();
  go('send');
});

/* ------------------------------------------------------------------ send */

async function prepare() {
  const products = completeProducts();
  const files = [];
  for (let i = 0; i < products.length; i++) {
    const blob = await stitchProduct(`P${i + 1}`, products[i].front, products[i].back);
    files.push(new File([blob], `P${i + 1}.jpg`, { type: 'image/jpeg' }));
  }
  if (state.draft.shelf) {
    files.push(new File([await labelShelf(state.draft.shelf)], 'SHELF.jpg', { type: 'image/jpeg' }));
  }
  const prompt = buildPrompt({
    count: products.length,
    shelf: !!state.draft.shelf,
    store: state.settings.store,
    category: state.draft.category,
    health: profileText(state.settings),
    learning: learningLines(state.draft.category),
  });
  return { files, prompt, urls: files.map((f) => URL.createObjectURL(f)) };
}

async function renderSend() {
  const ai = ASSISTANTS[state.settings.assistant] || ASSISTANTS.other;
  $('#send-ai-name').textContent = ai.name;
  $('#send-share').textContent = `Send to ${ai.name}`;
  $('#send-share').disabled = true;
  $('#send-status').textContent = 'Preparing photos…';
  $('#send-preview').innerHTML = '';
  if (state.prepared) state.prepared.urls.forEach((u) => URL.revokeObjectURL(u));
  try {
    state.prepared = await prepare();
  } catch (err) {
    $('#send-status').textContent = `Something went wrong preparing the photos: ${err.message}`;
    return;
  }
  $('#send-preview').innerHTML = state.prepared.urls.map((u) => `<img src="${u}" alt="">`).join('');
  $('#send-prompt').textContent = state.prepared.prompt;
  $('#send-share').disabled = false;
  $('#send-status').textContent = '';
}

function downloadFile(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function markSent() {
  state.draft.stage = 'pick';
  await saveDraft();
}

// Must stay synchronous up to navigator.share(): the share sheet needs the tap's user activation.
$('#send-share').addEventListener('click', () => {
  const { files, prompt } = state.prepared;
  const ai = ASSISTANTS[state.settings.assistant] || ASSISTANTS.other;
  const status = $('#send-status');
  copyText(prompt);

  if (navigator.canShare && navigator.canShare({ files })) {
    navigator.share({ files, text: prompt, title: 'LabelCheck' })
      .then(() => { markSent(); status.textContent = `Sent. When ${ai.name} has answered, come back and tap "I've got the answer".`; })
      .catch((err) => {
        if (err.name === 'AbortError') status.textContent = 'Cancelled. Tap the button again when ready.';
        else status.textContent = `Couldn't open the share menu (${err.message}). Tap the button again.`;
      });
    return;
  }

  // No file sharing (e.g. a computer): save the photos and open the AI website instead.
  files.forEach(downloadFile);
  markSent();
  status.textContent = `Your browser can't share photos directly. The photos were saved to Downloads and the question was copied. Upload the photos in ${ai.name} and paste the question.`;
  if (ai.url) window.open(ai.url, '_blank', 'noopener');
});

$('#send-copy').addEventListener('click', () => {
  copyText(state.prepared?.prompt || '');
  toast('Question copied');
});

/* ------------------------------------------------------------------ pick */

let pickChoice = null;

function renderPick() {
  pickChoice = null;
  $('#pick-save').disabled = true;
  $('#pick-name').value = '';
  $('#pick-note').value = '';
  $('#pick-answer').value = '';
  const products = completeProducts();
  $('#pick-grid').innerHTML = products.map((p, i) => `
    <button class="pick" data-pick="${i}"><img src="${p.front}" alt=""><span>P${i + 1}</span></button>`).join('')
    + '<button class="pick none" data-pick="-1">None of these</button>';
}

$('#pick-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  pickChoice = Number(b.dataset.pick);
  $('#pick-grid').querySelectorAll('.pick').forEach((el) => el.classList.toggle('selected', el === b));
  $('#pick-save').disabled = false;
});

$('#pick-save').addEventListener('click', async () => {
  const btn = $('#pick-save');
  btn.disabled = true;
  const products = completeProducts();
  const thumbs = await Promise.all(products.map((p) => thumb(p.front)));
  const entry = {
    date: new Date().toISOString(),
    store: state.settings.store || '',
    category: state.draft.category || '',
    products: thumbs.map((t, i) => ({ label: `P${i + 1}`, thumb: t })),
    shelf: !!state.draft.shelf,
    chosen: pickChoice,
    name: $('#pick-name').value.trim(),
    note: $('#pick-note').value.trim(),
    answer: $('#pick-answer').value.trim(),
    rating: null,
    feedback: '',
  };
  await DB.addHistory(entry);
  await loadHistory();
  state.draft = emptyDraft();
  await saveDraft();
  toast('Saved. LabelCheck will remember this next time.');
  go('home');
});

/* ------------------------------------------------------------------ entry */

let entryRating = null;

function renderEntry() {
  const e = state.history.find((x) => x.id === state.entryId);
  if (!e) { go('home'); return; }
  entryRating = e.rating;
  const chosen = e.chosen >= 0 ? `Chose <b>${esc(e.name || `P${e.chosen + 1}`)}</b>` : 'Chose none of these';
  $('#entry-body').innerHTML = `
    <h1>${esc(e.category || 'Comparison')}</h1>
    <p class="hint">${fmtDate(e.date)}${e.store ? ' · ' + esc(e.store) : ''}</p>
    <div class="entry-photos">${e.products.map((p, i) => `<img src="${esc(p.thumb)}" alt="${esc(p.label)}" class="${i === e.chosen ? 'chosen' : ''}">`).join('')}</div>
    <p>${chosen}</p>
    ${e.note ? `<p class="hint">Note: ${esc(e.note)}</p>` : ''}
    ${e.answer ? `<details class="prompt-box"><summary>AI's answer</summary><div class="answer">${esc(e.answer)}</div></details>` : ''}`;
  $('#entry-feedback').value = e.feedback || '';
  paintRating();
}

function paintRating() {
  $('#entry-like').classList.toggle('primary', entryRating === 'like');
  $('#entry-dislike').classList.toggle('primary', entryRating === 'dislike');
}

$('#entry-like').addEventListener('click', () => { entryRating = entryRating === 'like' ? null : 'like'; paintRating(); });
$('#entry-dislike').addEventListener('click', () => { entryRating = entryRating === 'dislike' ? null : 'dislike'; paintRating(); });

$('#entry-save').addEventListener('click', async () => {
  const e = state.history.find((x) => x.id === state.entryId);
  e.rating = entryRating;
  e.feedback = $('#entry-feedback').value.trim();
  await DB.putHistory(e);
  toast('Saved');
  go('home');
});

$('#entry-delete').addEventListener('click', async () => {
  if (!confirm('Delete this entry?')) return;
  await DB.delHistory(state.entryId);
  await loadHistory();
  state.entryId = null;
  go('home');
});

/* ------------------------------------------------------------------ settings */

async function renderSettings() {
  renderChecks($('#set-profile'), state.settings.profile);
  $('#set-other').value = state.settings.other || '';
  renderRadios($('#set-assistant'), 'set-ai', state.settings.assistant);
  $('#set-version').textContent = VERSION;
  const el = $('#set-storage');
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `${state.history.length} saved comparisons · ${(usage / 1048576).toFixed(1)} MB used · ${persisted ? 'protected from automatic clean-up' : 'not protected – back up regularly'}`;
  }
}

$('#set-save').addEventListener('click', async () => {
  state.settings.profile = readChecks($('#set-profile'));
  state.settings.other = $('#set-other').value.trim();
  state.settings.assistant = readRadio($('#set-assistant'));
  await saveSettings();
  toast('Settings saved');
});

$('#set-export').addEventListener('click', async () => {
  const data = { app: 'labelcheck', version: VERSION, exported: new Date().toISOString(), settings: state.settings, history: state.history };
  const name = `labelcheck-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'LabelCheck backup' }).catch(() => downloadFile(file));
  } else {
    downloadFile(file);
  }
});

// Backups are files from outside the app: keep only known fields with the right types.
function cleanEntry(h) {
  if (!h || typeof h.date !== 'string' || isNaN(Date.parse(h.date)) || !Array.isArray(h.products)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const products = h.products
    .filter((p) => p && typeof p.thumb === 'string' && p.thumb.startsWith('data:image/'))
    .map((p, i) => ({ label: `P${i + 1}`, thumb: p.thumb }));
  if (!products.length) return null;
  const chosen = Number.isInteger(h.chosen) && h.chosen < products.length ? h.chosen : -1;
  return {
    date: h.date, store: str(h.store, 100), category: str(h.category, 60), products, shelf: !!h.shelf, chosen,
    name: str(h.name, 80), note: str(h.note, 200), answer: str(h.answer, 20000),
    rating: h.rating === 'like' || h.rating === 'dislike' ? h.rating : null, feedback: str(h.feedback, 200),
  };
}

$('#set-import').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'labelcheck' || !Array.isArray(data.history)) throw new Error('Not a LabelCheck backup');
    const existing = new Set(state.history.map((h) => h.date));
    let added = 0;
    for (const h of data.history) {
      const entry = cleanEntry(h);
      if (!entry || existing.has(entry.date)) continue;
      await DB.addHistory(entry);
      added++;
    }
    if (data.settings && confirm('Also restore the health profile and settings from the backup?')) {
      const s = data.settings;
      state.settings = {
        profile: Array.isArray(s.profile) ? s.profile.filter((id) => CONDITIONS.some(([c]) => c === id)) : [],
        other: typeof s.other === 'string' ? s.other.slice(0, 200) : '',
        assistant: ASSISTANTS[s.assistant] ? s.assistant : 'gemini',
        store: typeof s.store === 'string' ? s.store.slice(0, 100) : '',
        consent: true,
      };
      await saveSettings();
    }
    await loadHistory();
    toast(`Restored ${added} comparison${added === 1 ? '' : 's'}`);
    renderSettings();
  } catch (err) {
    toast(`Restore failed: ${err.message}`);
  } finally {
    e.target.value = '';
  }
});

$('#set-wipe').addEventListener('click', async () => {
  if (!confirm('Delete your profile and ALL saved comparisons from this phone?')) return;
  if (!confirm('Are you sure? This cannot be undone unless you have a backup.')) return;
  DB.db.close();
  await new Promise((r) => { const req = indexedDB.deleteDatabase('labelcheck'); req.onsuccess = req.onerror = req.onblocked = r; });
  location.hash = '';
  location.reload();
});

/* ------------------------------------------------------------------ start */

async function start() {
  await DB.open();
  state.settings = await DB.get('settings');
  state.draft = (await DB.get('draft')) || emptyDraft();
  await loadHistory();

  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  window.addEventListener('hashchange', route);
  // Resume where the user left off (e.g. after switching to the AI app and back).
  if (!location.hash) {
    if (state.draft.stage === 'pick' && completeProducts().length) location.hash = 'pick';
    else if (state.draft.products.some((p) => p.front || p.back)) location.hash = 'compare';
  }
  route();
}

start().catch((err) => {
  document.getElementById('app').innerHTML = `<p style="padding:16px">LabelCheck could not start: ${esc(err.message)}. Private/incognito mode can block storage – try a normal browser tab.</p>`;
});
