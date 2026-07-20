async function loadProps() {
  const statusEl = document.getElementById('status-message');
  const gridEl = document.getElementById('props-grid');

  try {
    const response = await fetch('data.json');
    if (!response.ok) {
      throw new Error('Failed to load data.json (' + response.status + ')');
    }
    const players = await response.json();
    renderProps(players);
    statusEl.style.display = 'none';
  } catch (err) {
    statusEl.textContent = 'Could not load props: ' + err.message;
  }
}

function renderProps(players) {
  const gridEl = document.getElementById('props-grid');
  gridEl.innerHTML = '';

  players.forEach(function (player) {
    const card = document.createElement('div');
    card.className = 'prop-card';

    const name = document.createElement('div');
    name.className = 'player-name';
    name.textContent = player.player;
    card.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'team-meta';
    meta.textContent = player.team + ' vs ' + player.opponent;
    card.appendChild(meta);

    (player.props || []).forEach(function (prop) {
      const line = document.createElement('div');
      line.className = 'stat-line';

      const statLabel = document.createElement('span');
      statLabel.textContent = prop.stat;

      const statValue = document.createElement('span');
      statValue.className = 'stat-value';
      statValue.textContent = prop.line;

      line.appendChild(statLabel);
      line.appendChild(statValue);
      card.appendChild(line);
    });

    gridEl.appendChild(card);
  });
}

loadProps();
