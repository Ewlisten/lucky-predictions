// ---------- Config ----------

const STATS = ['PTS', 'REB', 'AST', 'FG3M', 'STL', 'BLK', 'TOV'];
const STREAK_DISPLAY_MIN = 2;

// ---------- CSV parsing (same implementation as dashboard.js) ----------

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

// ---------- Defensive column access ----------

function normalizeHeaderKey(h) {
  return h.trim().toLowerCase().replace(/[\s_]+/g, '');
}

function pickField(row, ...candidates) {
  const normalizedMap = {};
  Object.keys(row).forEach((k) => {
    normalizedMap[normalizeHeaderKey(k)] = row[k];
  });
  for (const c of candidates) {
    if (normalizedMap[c] !== undefined && normalizedMap[c] !== '') return normalizedMap[c];
  }
  return '';
}

// ---------- Row normalization ----------

function parseTrackerDate(raw) {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return new Date(+us[3], +us[1] - 1, +us[2]);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeStat(raw) {
  const up = (raw || '').trim().toUpperCase();
  return STATS.includes(up) ? up : '';
}

function normalizePick(raw) {
  const up = (raw || '').toUpperCase();
  if (up.includes('OVER')) return 'OVER';
  if (up.includes('UNDER')) return 'UNDER';
  return '';
}

function normalizeTier(raw) {
  const up = (raw || '').toUpperCase();
  if (up.includes('LOCK')) return 'lock';
  if (up.includes('STRONG')) return 'strong';
  if (up.includes('LEAN')) return 'lean';
  return '';
}

function normalizeResult(raw) {
  const up = (raw || '').trim().toUpperCase();
  if (up === 'HIT' || up === 'WIN' || up === 'W') return 'hit';
  if (up === 'MISS' || up === 'LOSS' || up === 'L') return 'miss';
  return 'pending';
}

function buildTrackerRow(row, rowIndex) {
  const dateRaw = pickField(row, 'date');
  const statRaw = pickField(row, 'stat', 'type');
  return {
    id: String(rowIndex),
    dateRaw,
    date: parseTrackerDate(dateRaw),
    player: pickField(row, 'player'),
    team: pickField(row, 'team'),
    opponent: pickField(row, 'opponent', 'opp'),
    statKey: normalizeStat(statRaw),
    statRaw,
    line: pickField(row, 'line', 'bookline'),
    pick: normalizePick(pickField(row, 'pick', 'direction', 'rec', 'over/under')),
    tierKey: normalizeTier(pickField(row, 'tier')),
    result: normalizeResult(pickField(row, 'result', 'hit/miss')),
  };
}

// ---------- Hit-rate & streak calculations (pure) ----------

function computeHitRate(rows) {
  const decided = rows.filter((r) => r.result === 'hit' || r.result === 'miss');
  if (decided.length === 0) return { hits: 0, total: 0, pct: null };
  const hits = decided.filter((r) => r.result === 'hit').length;
  return { hits, total: decided.length, pct: hits / decided.length };
}

function withinTrailingDays(rows, days, today = new Date()) {
  const cutoff = new Date(today);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return rows.filter((r) => r.date && r.date >= cutoff);
}

function computeTierHitRates(rows) {
  return {
    lock: computeHitRate(rows.filter((r) => r.tierKey === 'lock')),
    strong: computeHitRate(rows.filter((r) => r.tierKey === 'strong')),
    lean: computeHitRate(rows.filter((r) => r.tierKey === 'lean')),
  };
}

function computeCurrentStreak(rows) {
  const decided = rows
    .filter((r) => r.result === 'hit' || r.result === 'miss')
    .slice()
    .sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  let streak = 0;
  for (const r of decided) {
    if (r.result === 'hit') streak++;
    else break;
  }
  return streak;
}

function formatPct(pct) {
  return pct === null ? '—' : `${Math.round(pct * 100)}%`;
}

// ---------- Data loading ----------

const TRACKER_CSV_PATH = 'data/WNBA Prop Tracker 27 - DATA 26-27.csv';

async function loadTrackerRows() {
  try {
    const res = await fetch(encodeURI(TRACKER_CSV_PATH), { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    const rows = parseCSV(text).filter((row) => pickField(row, 'date') || pickField(row, 'player'));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

// ---------- State ----------

const state = {
  allRows: [],
  tierFilter: 'all',
  statFilter: 'all',
  dateFilter: 'all',
  customFrom: null,
  customTo: null,
  sortKey: 'date',
  sortDir: 'desc',
};

const els = {
  status: document.getElementById('status-message'),
  updated: document.getElementById('last-updated'),
  summary: document.getElementById('tracker-summary'),
  pillsRow: document.getElementById('tracker-pills-row'),
  customRange: document.getElementById('custom-date-range'),
  dateFrom: document.getElementById('date-from'),
  dateTo: document.getElementById('date-to'),
  tbody: document.getElementById('tracker-tbody'),
  theadRow: document.querySelector('#tracker-table thead tr'),
};

// ---------- Filtering & sorting ----------

function passesDateFilter(r) {
  if (state.dateFilter === 'all') return true;
  if (!r.date) return false;
  if (state.dateFilter === '7d') return withinTrailingDays([r], 7).length > 0;
  if (state.dateFilter === '30d') return withinTrailingDays([r], 30).length > 0;
  if (state.dateFilter === 'custom') {
    if (state.customFrom && r.date < state.customFrom) return false;
    if (state.customTo && r.date > state.customTo) return false;
    return true;
  }
  return true;
}

function applyFilters(rows) {
  return rows.filter((r) => {
    if (state.tierFilter !== 'all' && r.tierKey !== state.tierFilter) return false;
    if (state.statFilter !== 'all' && r.statKey !== state.statFilter) return false;
    if (!passesDateFilter(r)) return false;
    return true;
  });
}

const RESULT_ORDER = { hit: 0, miss: 1, pending: 2 };
const TIER_ORDER = { lock: 0, strong: 1, lean: 2, '': 3 };

const COMPARATORS = {
  date: (a, b) => (a.date ? a.date.getTime() : -Infinity) - (b.date ? b.date.getTime() : -Infinity),
  player: (a, b) => a.player.localeCompare(b.player),
  matchup: (a, b) => (a.opponent || '').localeCompare(b.opponent || ''),
  prop: (a, b) => (a.statKey || a.statRaw).localeCompare(b.statKey || b.statRaw),
  pick: (a, b) => a.pick.localeCompare(b.pick),
  tier: (a, b) => (TIER_ORDER[a.tierKey] ?? 3) - (TIER_ORDER[b.tierKey] ?? 3),
  result: (a, b) => RESULT_ORDER[a.result] - RESULT_ORDER[b.result],
};

function sortRows(rows) {
  const cmp = COMPARATORS[state.sortKey] || COMPARATORS.date;
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => cmp(a, b) * dir);
}

// ---------- Rendering: summary ----------

function renderSummary() {
  const overall = computeHitRate(state.allRows);
  const last7 = computeHitRate(withinTrailingDays(state.allRows, 7));
  const last30 = computeHitRate(withinTrailingDays(state.allRows, 30));
  const tiers = computeTierHitRates(state.allRows);
  const streak = computeCurrentStreak(state.allRows);

  els.summary.innerHTML = '';

  const tiles = [
    { label: 'All-Time Hit Rate', value: formatPct(overall.pct), sub: `${overall.hits}/${overall.total}` },
    { label: 'Last 7 Days', value: formatPct(last7.pct), sub: `${last7.hits}/${last7.total}` },
    { label: 'Last 30 Days', value: formatPct(last30.pct), sub: `${last30.hits}/${last30.total}` },
    { label: 'Lock Hit Rate', value: formatPct(tiers.lock.pct), sub: `${tiers.lock.hits}/${tiers.lock.total}` },
    { label: 'Strong Hit Rate', value: formatPct(tiers.strong.pct), sub: `${tiers.strong.hits}/${tiers.strong.total}` },
    { label: 'Lean Hit Rate', value: formatPct(tiers.lean.pct), sub: `${tiers.lean.hits}/${tiers.lean.total}` },
  ];

  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = 'summary-tile';

    const label = document.createElement('span');
    label.className = 'summary-label';
    label.textContent = t.label;
    tile.appendChild(label);

    const value = document.createElement('span');
    value.className = 'summary-value';
    value.textContent = t.value;
    tile.appendChild(value);

    const sub = document.createElement('span');
    sub.className = 'summary-sub';
    sub.textContent = t.sub;
    tile.appendChild(sub);

    els.summary.appendChild(tile);
  });

  if (streak >= STREAK_DISPLAY_MIN) {
    const badge = document.createElement('div');
    badge.className = 'streak-badge';
    badge.textContent = `🔥 ${streak} hit streak`;
    els.summary.appendChild(badge);
  }
}

// ---------- Rendering: table ----------

function buildResultCell(result) {
  const span = document.createElement('span');
  if (result === 'hit') {
    span.className = 'result-pill result-hit';
    span.textContent = '✓ Hit';
  } else if (result === 'miss') {
    span.className = 'result-pill result-miss';
    span.textContent = '✕ Miss';
  } else {
    span.className = 'result-pill result-pending';
    span.textContent = 'Pending';
  }
  return span;
}

function buildTierBadge(tierKey) {
  const labels = { lock: 'Lock', strong: 'Strong', lean: 'Lean' };
  const badge = document.createElement('span');
  badge.className = `tier-badge ${tierKey || 'lean'}`;
  badge.textContent = labels[tierKey] || '—';
  return badge;
}

function buildPickPill(pick) {
  const pill = document.createElement('span');
  pill.className = `direction-pill dir-${pick.toLowerCase() || 'over'}`;
  pill.textContent = pick ? (pick === 'OVER' ? '▲ OVER' : '▼ UNDER') : '—';
  return pill;
}

function buildRowNode(r) {
  const tr = document.createElement('tr');
  tr.className = 'tracker-row';

  const dateCell = document.createElement('td');
  dateCell.className = 'cell-date';
  dateCell.textContent = r.dateRaw || '—';
  tr.appendChild(dateCell);

  const playerCell = document.createElement('td');
  playerCell.className = 'cell-player';
  playerCell.textContent = r.player || '—';
  tr.appendChild(playerCell);

  const matchupCell = document.createElement('td');
  matchupCell.className = 'cell-matchup';
  matchupCell.textContent = r.opponent ? `${r.team ? r.team + ' vs ' : 'vs '}${r.opponent}` : (r.team || '—');
  tr.appendChild(matchupCell);

  const propCell = document.createElement('td');
  propCell.className = 'cell-prop';
  const statLabel = r.statKey || r.statRaw || '—';
  propCell.textContent = r.line ? `${statLabel} ${r.line}` : statLabel;
  tr.appendChild(propCell);

  const pickCell = document.createElement('td');
  pickCell.className = 'cell-pick';
  pickCell.appendChild(buildPickPill(r.pick));
  tr.appendChild(pickCell);

  const tierCell = document.createElement('td');
  tierCell.className = 'cell-tier';
  tierCell.appendChild(buildTierBadge(r.tierKey));
  tr.appendChild(tierCell);

  const resultCell = document.createElement('td');
  resultCell.className = 'cell-result';
  resultCell.appendChild(buildResultCell(r.result));
  tr.appendChild(resultCell);

  return tr;
}

function renderTable() {
  const filtered = sortRows(applyFilters(state.allRows));
  els.tbody.innerHTML = '';

  if (filtered.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty-state';
    td.textContent = 'No picks match these filters.';
    tr.appendChild(td);
    els.tbody.appendChild(tr);
    return;
  }

  filtered.forEach((r) => els.tbody.appendChild(buildRowNode(r)));
}

function updateSortIndicators() {
  els.theadRow.querySelectorAll('th').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function render() {
  renderSummary();
  renderTable();
  updateSortIndicators();
}

// ---------- Controls ----------

function wireControls() {
  els.pillsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.pill-btn');
    if (!btn) return;
    const group = btn.dataset.group;
    const value = btn.dataset.value;

    btn.parentElement.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    if (group === 'tier') state.tierFilter = value;
    if (group === 'stat') state.statFilter = value;
    if (group === 'date') {
      state.dateFilter = value;
      els.customRange.hidden = value !== 'custom';
    }
    renderTable();
  });

  els.dateFrom.addEventListener('change', () => {
    state.customFrom = els.dateFrom.value ? parseTrackerDate(els.dateFrom.value) : null;
    renderTable();
  });

  els.dateTo.addEventListener('change', () => {
    state.customTo = els.dateTo.value ? parseTrackerDate(els.dateTo.value) : null;
    renderTable();
  });

  els.theadRow.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = key === 'date' ? 'desc' : 'asc';
    }
    renderTable();
    updateSortIndicators();
  });
}

function formatLastUpdated(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean);
  if (!dates.length) return 'Last updated: —';
  const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
  return `Last updated: ${latest.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

async function init() {
  wireControls();

  const rawRows = await loadTrackerRows();
  if (!rawRows) {
    els.status.textContent = 'Track record coming soon.';
    els.summary.style.display = 'none';
    document.querySelector('.tracker-table-wrap').style.display = 'none';
    return;
  }

  state.allRows = rawRows.map((row, i) => buildTrackerRow(row, i));
  els.updated.textContent = formatLastUpdated(state.allRows);
  els.status.style.display = 'none';
  render();
}

init();
