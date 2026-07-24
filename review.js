// ---------- Config ----------

const STATS = [
  { key: 'PTS', label: 'Points' },
  { key: 'REB', label: 'Rebounds' },
  { key: 'AST', label: 'Assists' },
  { key: 'FG3M', label: '3PT Made' },
  { key: 'STL', label: 'Steals' },
  { key: 'BLK', label: 'Blocks' },
  { key: 'TOV', label: 'Turnovers' },
];

const TIER_ORDER = { lock: 0, strong: 1, lean: 2 };

// ---------- Confidence tier logic (pure) ----------

function getStrength(rec) {
  if (!rec) return null;
  const upper = rec.toUpperCase();
  if (upper.includes('STRONG')) return 'STRONG';
  if (upper.includes('LEAN')) return 'LEAN';
  return null;
}

function getDirection(rec) {
  if (!rec) return null;
  const upper = rec.toUpperCase();
  if (upper.includes('OVER')) return 'OVER';
  if (upper.includes('UNDER')) return 'UNDER';
  return null;
}

function normalizeOppTier(oppTier) {
  if (!oppTier) return null;
  const upper = oppTier.toUpperCase();
  if (upper.includes('BOTTOM')) return 'BOTTOM';
  if (upper.includes('MIDDLE')) return 'MIDDLE';
  if (upper.includes('TOP')) return 'TOP';
  return null;
}

const TIER_MAP = {
  STRONG: {
    BOTTOM: { stars: 3, label: '⭐⭐⭐ LOCK', key: 'lock' },
    MIDDLE: { stars: 2, label: '⭐⭐ STRONG', key: 'strong' },
    TOP: { stars: 1, label: '⭐ LEAN', key: 'lean' },
  },
  LEAN: {
    BOTTOM: { stars: 2, label: '⭐⭐ STRONG', key: 'strong' },
    MIDDLE: { stars: 1, label: '⭐ LEAN', key: 'lean' },
    TOP: null,
  },
};

// ---------- Exclusion pre-filter (runs before getTier, gates what reaches it) ----------
// EDGE is read here for filtering only and must never be rendered/exposed in the DOM.
function passesFilters(stat, rec, edge) {
  const direction = getDirection(rec);
  if (stat === 'PTS' && direction === 'UNDER') return false;

  const edgeNum = parseFloat(edge);
  if (!Number.isNaN(edgeNum) && edgeNum >= 20 && edgeNum < 30) return false;

  return true;
}

// Single source of truth for the confidence-tier mapping. rec/oppTier are raw
// strings straight from the sheet; everything else is derived from this.
function getTier(rec, oppTier) {
  const strength = getStrength(rec);
  const opp = normalizeOppTier(oppTier);
  if (!strength || !opp) return null;
  return TIER_MAP[strength][opp] || null;
}

function getReasoning(normalizedOppTier, statLabel) {
  switch (normalizedOppTier) {
    case 'BOTTOM':
      return `Weak matchup: opponent allows a lot of ${statLabel.toLowerCase()} to this position.`;
    case 'MIDDLE':
      return 'Average matchup.';
    case 'TOP':
      return `Tough matchup: opponent defends ${statLabel.toLowerCase()} well.`;
    default:
      return '';
  }
}

// ---------- CSV parsing ----------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const cleanRows = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (cleanRows.length < 2) return [];

  const [header, ...dataRows] = cleanRows;
  const trimmedHeader = header.map((h) => h.trim());

  return dataRows.map((r) => {
    const obj = {};
    trimmedHeader.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

// ---------- Row -> pick cards ----------

function buildPicks(rows) {
  const picks = [];

  rows.forEach((row, rowIndex) => {
    const player = row.PLAYER || '';
    const opponent = row.OPP_ABBR || row.OPPONENT || '';

    STATS.forEach(({ key, label }) => {
      const line = row[`${key}_LINE`];
      const rec = row[`${key}_REC`];
      const edge = row[`${key}_EDGE`];
      const oppTierRaw = row[`${key}_OPP_TIER`] || row[`ALLOW_${key}_TIER`] || '';

      if (!line || !rec) return;
      if (!passesFilters(key, rec, edge)) return;

      const tier = getTier(rec, oppTierRaw);
      if (!tier) return;

      const direction = getDirection(rec);
      if (!direction) return;

      picks.push({
        id: `${rowIndex}-${key}`,
        player,
        opponent,
        statKey: key,
        statLabel: label,
        line,
        direction,
        tier,
        reasoning: getReasoning(normalizeOppTier(oppTierRaw), label),
      });
    });
  });

  picks.sort((a, b) => {
    const byTier = TIER_ORDER[a.tier.key] - TIER_ORDER[b.tier.key];
    if (byTier !== 0) return byTier;
    return a.player.localeCompare(b.player);
  });

  return picks;
}

// ---------- Data loading ----------
// Convention: the daily file is named data/wnba_preds_YYYYMMDD.csv (or .json).
// Drop a new file with today's date in /data and the page picks it up with
// no code changes. Falls back one day back in case of a late upload.

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function toDashDateStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

async function tryFetchJSON(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

async function tryFetchCSV(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const rows = parseCSV(text);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

const LOOKBACK_DAYS = 14;

async function loadRows() {
  const today = new Date();

  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const stamp = toDateStamp(d);
    const fromJson = await tryFetchJSON(`data/wnba_preds_${stamp}.json`);
    if (fromJson) return fromJson;
    const fromCsv = await tryFetchCSV(`data/wnba_preds_${stamp}.csv`);
    if (fromCsv) return fromCsv;
  }
  return null;
}

// ---------- Rendering ----------

const state = {
  allPicks: [],
  tierFilter: 'all',
  statFilter: 'all',
  viewMode: 'grid',
  hiddenKeys: new Set(),
};

const els = {
  status: document.getElementById('status-message'),
  updated: document.getElementById('last-updated'),
  cards: document.getElementById('cards-container'),
  tierPills: document.getElementById('tier-pills'),
  statSelect: document.getElementById('stat-select'),
  viewToggle: document.getElementById('view-toggle'),
  exportBtn: document.getElementById('export-hidden'),
  hiddenCount: document.getElementById('hidden-count'),
};

function formatLastUpdated(dateStr) {
  if (!dateStr) return 'Last updated: —';

  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return `Last updated: ${dateStr}`;
  }
  const [y, m, d] = parts;
  const dataDate = new Date(y, m - 1, d);
  const now = new Date();
  const isToday =
    dataDate.getFullYear() === now.getFullYear() &&
    dataDate.getMonth() === now.getMonth() &&
    dataDate.getDate() === now.getDate();

  const label = isToday
    ? `Today, ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : dataDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return `Last updated: ${label}`;
}

function pickKey(pick) {
  return `${pick.player}:${pick.statKey}`;
}

function applyFilters() {
  return state.allPicks.filter((p) => {
    if (state.tierFilter !== 'all' && p.tier.key !== state.tierFilter) return false;
    if (state.statFilter !== 'all' && p.statKey !== state.statFilter) return false;
    if (state.hiddenKeys.has(pickKey(p))) return false;
    return true;
  });
}

function buildCardNode(pick) {
  const card = document.createElement('article');
  card.className = `pick-card tier-${pick.tier.key}`;

  const badge = document.createElement('span');
  badge.className = `tier-badge ${pick.tier.key}`;
  badge.textContent = pick.tier.label;
  card.appendChild(badge);

  const head = document.createElement('div');
  head.className = 'pick-head';

  const name = document.createElement('span');
  name.className = 'player-name';
  name.textContent = pick.player;
  head.appendChild(name);


  if (pick.opponent) {
    const opp = document.createElement('span');
    opp.className = 'opponent';
    opp.textContent = `vs ${pick.opponent}`;
    head.appendChild(opp);
  }
  card.appendChild(head);

  const row = document.createElement('div');
  row.className = 'pick-row';

  const dirPill = document.createElement('span');
  dirPill.className = `direction-pill dir-${pick.direction.toLowerCase()}`;
  dirPill.textContent = pick.direction === 'OVER' ? '▲ OVER' : '▼ UNDER';
  row.appendChild(dirPill);

  const statLine = document.createElement('span');
  statLine.className = 'stat-line';
  statLine.textContent = `${pick.statKey} ${pick.direction} ${pick.line}`;
  row.appendChild(statLine);

  card.appendChild(row);

  if (pick.reasoning) {
    const reasoning = document.createElement('p');
    reasoning.className = 'reasoning';
    reasoning.textContent = pick.reasoning;
    card.appendChild(reasoning);
  }

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'hide-btn';
  hideBtn.textContent = 'Hide';
  hideBtn.addEventListener('click', () => {
    state.hiddenKeys.add(pickKey(pick));
    updateHiddenCount();
    render();
  });
  card.appendChild(hideBtn);

  return card;
}

function render() {
  const filtered = applyFilters();
  els.cards.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No picks match these filters.';
    els.cards.appendChild(empty);
    return;
  }

  filtered.forEach((pick) => els.cards.appendChild(buildCardNode(pick)));
}

function populateStatSelect() {
  STATS.forEach(({ key, label }) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = label;
    els.statSelect.appendChild(opt);
  });
}

function updateHiddenCount() {
  if (!els.hiddenCount) return;
  const n = state.hiddenKeys.size;
  els.hiddenCount.textContent = n === 1 ? '1 hidden' : `${n} hidden`;
}

function exportHidden() {
  const keys = Array.from(state.hiddenKeys);
  const json = JSON.stringify(keys);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `suppressed_${toDashDateStamp(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function wireControls() {
  els.tierPills.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    els.tierPills.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tierFilter = btn.dataset.tier;
    render();
  });

  els.statSelect.addEventListener('change', () => {
    state.statFilter = els.statSelect.value;
    render();
  });

  els.viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-btn');
    if (!btn) return;
    els.viewToggle.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.viewMode = btn.dataset.view;
    els.cards.classList.toggle('view-list', state.viewMode === 'list');
  });

  els.exportBtn.addEventListener('click', exportHidden);
}

async function init() {
  populateStatSelect();
  wireControls();
  updateHiddenCount();

  const rows = await loadRows();
  if (!rows) {
    els.status.textContent = 'No picks available right now. Check back soon.';
    return;
  }

  state.allPicks = buildPicks(rows);
  els.updated.textContent = formatLastUpdated(rows[0] && rows[0].DATE);
  els.status.style.display = 'none';
  render();
}

init();
