// Leaderboard overlay: rated players, recent matches, and a round-by-round
// view of any match ("who played whom and how it went"). Reads the public
// API only, and renders every value with textContent.
(function () {
  'use strict';

  var MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
  var END_LABEL = { completed: 'Played to 10', vote: 'Ended early by vote', forfeit: 'Forfeit' };
  var OUTCOME_LABEL = {
    'call-made': 'Call made',
    'call-broken': 'Call broken',
    draw: 'Drawn 4-4',
    'kapothi-made': 'Kapothi!',
    'kapothi-broken': 'Kapothi broken',
  };
  var SUIT_NAME = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };

  var tab = 'players';
  var openRow = null; // key of the player row expanded in the list

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fmtDelta(d) {
    if (d == null || d === 0) return '±0';
    var r = Math.round(d * 10) / 10;
    return (r > 0 ? '+' : '') + r;
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function body() { return $('lb-body'); }

  function loading() {
    body().innerHTML = '';
    body().appendChild(el('div', 'lb-empty', 'Loading…'));
  }

  function failed() {
    body().innerHTML = '';
    body().appendChild(el('div', 'lb-empty', 'Could not load the leaderboard. Try again in a moment.'));
  }

  function setTab(name) {
    tab = name;
    document.querySelectorAll('.lb-tab').forEach(function (b) {
      var on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('lb-sub').textContent = name === 'players'
      ? 'Ranked by rating. Every 4-player match is graded. Tap a player for their matches.'
      : 'The latest recorded 4-player matches. Tap one for the round-by-round story.';
    if (name === 'players') loadPlayers(); else loadMatches();
  }

  // ---------- Team line: "Kamal & Nimal" with bots marked ----------

  function teamLine(seats, team) {
    var wrap = el('span', 'lb-teamline');
    seats.filter(function (s) { return s.team === team; }).forEach(function (s, i) {
      if (i) wrap.appendChild(document.createTextNode(' & '));
      wrap.appendChild(el('span', s.isBot ? 'lb-bot' : '', s.isBot ? 'Bot' : s.name));
    });
    return wrap;
  }

  // ---------- Players ----------

  function loadPlayers() {
    loading();
    getJSON('/api/leaderboard').then(function (d) { renderPlayers((d && d.leaderboard) || []); }, failed);
  }

  function renderPlayers(rows) {
    var b = body();
    b.innerHTML = '';
    if (!rows.length) {
      b.appendChild(el('div', 'lb-empty',
        'No ranked players yet. Finish a 4-player match with your own name to get on the board.'));
      return;
    }
    var table = el('table', 'lb-table');
    var head = el('thead');
    var hr = el('tr');
    ['#', 'PLAYER', 'RATING', 'W-L', 'GRADE', 'LAST'].forEach(function (h, i) {
      hr.appendChild(el('th', i === 2 || i === 4 ? 'num' : '', h));
    });
    head.appendChild(hr);
    table.appendChild(head);
    var tbody = el('tbody');

    rows.forEach(function (r, i) {
      var tr = el('tr', 'lb-row lb-click' + (r.rank <= 3 ? ' top' + r.rank : ''));
      tr.style.animationDelay = Math.min(i * 45, 500) + 'ms';
      tr.tabIndex = 0;
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-expanded', openRow === r.key ? 'true' : 'false');
      tr.setAttribute('aria-label', r.name + ', rating ' + r.rating + ', show matches');

      var rank = el('td', 'lb-rank');
      if (MEDALS[r.rank]) rank.appendChild(el('span', 'lb-medal', MEDALS[r.rank]));
      rank.appendChild(document.createTextNode(String(r.rank)));
      var name = el('td', 'lb-team');
      name.appendChild(document.createTextNode(r.name));
      if (r.provisional) name.appendChild(el('span', 'lb-new', 'NEW'));
      var rating = el('td', 'lb-score num');
      rating.appendChild(document.createTextNode(String(r.rating)));
      if (r.delta) rating.appendChild(el('span', 'lb-delta ' + (r.delta > 0 ? 'up' : 'down'), (r.delta > 0 ? '▲' : '▼') + Math.abs(Math.round(r.delta))));
      var wl = el('td', 'lb-wl', r.wins + '-' + r.losses + (r.draws ? '-' + r.draws : ''));
      var grade = el('td', 'num');
      grade.appendChild(el('span', 'lb-grade g-' + (r.avgGrade || 'x'), r.avgGrade || '-'));
      var last = el('td', 'lb-date', fmtDate(r.lastPlayed));
      [rank, name, rating, wl, grade, last].forEach(function (c) { tr.appendChild(c); });

      var detail = el('tr', 'lb-detail');
      detail.style.display = 'none';
      var dcell = el('td');
      dcell.colSpan = 6;
      detail.appendChild(dcell);

      function toggle() {
        var show = detail.style.display === 'none';
        detail.style.display = show ? '' : 'none';
        tr.setAttribute('aria-expanded', show ? 'true' : 'false');
        openRow = show ? r.key : null;
        if (show && !dcell.dataset.loaded) loadPlayerMatches(r, dcell);
      }
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      tbody.appendChild(tr);
      tbody.appendChild(detail);
      if (openRow === r.key) toggle();
    });
    table.appendChild(tbody);
    b.appendChild(table);
    b.appendChild(el('div', 'lb-count', rows.length === 1 ? '1 ranked player' : rows.length + ' ranked players'));
  }

  function loadPlayerMatches(r, cell) {
    cell.innerHTML = '';
    cell.appendChild(el('div', 'lb-empty', 'Loading matches…'));
    getJSON('/api/players/' + encodeURIComponent(r.name) + '/matches?limit=10').then(function (d) {
      cell.dataset.loaded = '1';
      cell.innerHTML = '';
      var p = d.player || r;
      cell.appendChild(el('div', 'lb-profile',
        p.games + ' rated game' + (p.games === 1 ? '' : 's') + ' · ' + p.winRate + '% won · best ' +
        p.bestRating + (p.avgGrade ? ' · average grade ' + p.avgGrade : '')));
      var list = el('div', 'lb-mlist');
      (d.matches || []).forEach(function (m) {
        var me = m.seats.find(function (s) { return s.key === r.key; });
        if (!me) return;
        list.appendChild(playerMatchRow(m, me));
      });
      if (!list.children.length) list.appendChild(el('div', 'lb-empty', 'No matches yet.'));
      cell.appendChild(list);
    }, function () {
      cell.innerHTML = '';
      cell.appendChild(el('div', 'lb-empty', 'Could not load the matches.'));
    });
  }

  // "W 10-6 · with Nimal vs Sunil & Ruwan · A (82) · +14"
  function playerMatchRow(m, me) {
    var won = m.winnerTeam === me.team;
    var lost = m.winnerTeam === 1 - me.team;
    var row = el('button', 'lb-mrow');
    row.type = 'button';
    var res = el('span', 'lb-res ' + (won ? 'w' : lost ? 'l' : 'd'), won ? 'W' : lost ? 'L' : 'D');
    row.appendChild(res);
    var mine = m.score[me.team];
    var theirs = m.score[1 - me.team];
    row.appendChild(el('span', 'lb-mscore', mine + '-' + theirs));
    var who = el('span', 'lb-who');
    var partner = m.seats.find(function (s) { return s.team === me.team && s.seat !== me.seat; });
    who.appendChild(document.createTextNode('with '));
    who.appendChild(el('span', partner && partner.isBot ? 'lb-bot' : '', partner ? (partner.isBot ? 'Bot' : partner.name) : '?'));
    who.appendChild(document.createTextNode(' vs '));
    who.appendChild(teamLine(m.seats, 1 - me.team));
    row.appendChild(who);
    row.appendChild(el('span', 'lb-grade g-' + (me.grade || 'x'), me.grade || '-'));
    row.appendChild(el('span', 'lb-mdelta ' + (me.delta > 0 ? 'up' : me.delta < 0 ? 'down' : ''),
      me.rated ? fmtDelta(me.delta) : 'unrated'));
    row.title = fmtDate(m.playedAt) + ' · ' + (END_LABEL[m.endReason] || m.endReason);
    row.addEventListener('click', function () { openMatch(m.id); });
    return row;
  }

  // ---------- Recent matches ----------

  function loadMatches() {
    loading();
    getJSON('/api/matches?limit=25').then(function (d) { renderMatches((d && d.matches) || []); }, failed);
  }

  function renderMatches(list) {
    var b = body();
    b.innerHTML = '';
    if (!list.length) {
      b.appendChild(el('div', 'lb-empty', 'No matches recorded yet.'));
      return;
    }
    list.forEach(function (m, i) {
      var card = el('button', 'lb-mcard');
      card.type = 'button';
      card.style.animationDelay = Math.min(i * 40, 400) + 'ms';
      var teams = el('div', 'lb-mteams');
      [0, 1].forEach(function (t) {
        var side = el('div', 'lb-side' + (m.winnerTeam === t ? ' win' : ''));
        side.appendChild(teamLine(m.seats, t));
        side.appendChild(el('span', 'lb-big', String(m.score[t])));
        teams.appendChild(side);
        if (t === 0) teams.appendChild(el('span', 'lb-vs', 'vs'));
      });
      card.appendChild(teams);
      var meta = [fmtDate(m.playedAt), m.rounds + ' round' + (m.rounds === 1 ? '' : 's'),
        END_LABEL[m.endReason] || m.endReason, m.rated ? 'rated' : 'unrated'];
      if (m.redeals) meta.splice(2, 0, m.redeals + ' redeal' + (m.redeals === 1 ? '' : 's'));
      card.appendChild(el('div', 'lb-mmeta', meta.join(' · ')));
      card.addEventListener('click', function () { openMatch(m.id); });
      b.appendChild(card);
    });
  }

  // ---------- Match detail ----------

  function openMatch(id) {
    loading();
    getJSON('/api/matches/' + encodeURIComponent(id)).then(function (d) { renderMatch(d.match); }, failed);
  }

  function renderMatch(m) {
    var b = body();
    b.innerHTML = '';
    var back = el('button', 'lb-back', '‹ BACK');
    back.type = 'button';
    back.addEventListener('click', function () { setTab(tab); });
    b.appendChild(back);

    var head = el('div', 'lb-mteams lb-mhead');
    [0, 1].forEach(function (t) {
      var side = el('div', 'lb-side' + (m.winnerTeam === t ? ' win' : ''));
      side.appendChild(el('span', 'lb-tlabel', 'TEAM ' + 'AB'[t]));
      side.appendChild(teamLine(m.seats, t));
      side.appendChild(el('span', 'lb-big', String(m.score[t])));
      head.appendChild(side);
      if (t === 0) head.appendChild(el('span', 'lb-vs', 'vs'));
    });
    b.appendChild(head);
    var meta = fmtDate(m.playedAt) + ' · ' + (END_LABEL[m.endReason] || m.endReason) + ' · ' +
      (m.rated ? 'rated' : 'unrated') + (m.note ? ' · ' + m.note : '');
    b.appendChild(el('div', 'lb-mmeta', meta));

    // Player lines: tricks, own calls, grade, rating change
    var pt = el('table', 'lb-table lb-ptable');
    var phr = el('tr');
    ['PLAYER', 'TRICKS', 'CALLS', 'GRADE', 'RATING'].forEach(function (h, i) { phr.appendChild(el('th', i ? 'num' : '', h)); });
    var phead = el('thead');
    phead.appendChild(phr);
    pt.appendChild(phead);
    var pb = el('tbody');
    m.seats.forEach(function (s) {
      var tr = el('tr');
      var nm = el('td');
      nm.appendChild(el('span', 'badge ' + (s.team === 0 ? 'team-a' : 'team-b'), 'AB'[s.team]));
      nm.appendChild(document.createTextNode(' '));
      nm.appendChild(el('span', s.isBot ? 'lb-bot' : '', s.isBot ? 'Bot' : s.name));
      if (s.seat === m.leaverSeat) nm.appendChild(el('span', 'lb-new lb-left', 'LEFT'));
      tr.appendChild(nm);
      tr.appendChild(el('td', 'num', String(s.tricks)));
      tr.appendChild(el('td', 'num', s.calls ? s.callsMade + '/' + s.calls : '-'));
      var g = el('td', 'num');
      g.appendChild(el('span', 'lb-grade g-' + (s.grade || 'x'), s.grade ? s.grade + ' ' + s.gradeScore : '-'));
      tr.appendChild(g);
      tr.appendChild(el('td', 'num lb-mdelta ' + (s.delta > 0 ? 'up' : s.delta < 0 ? 'down' : ''),
        s.rated ? s.ratingAfter + ' (' + fmtDelta(s.delta) + ')' : (s.isBot ? '' : 'unrated')));
      pb.appendChild(tr);
    });
    pt.appendChild(pb);
    b.appendChild(pt);

    // Round-by-round story
    b.appendChild(el('div', 'lb-h', 'HOW IT PLAYED OUT'));
    var nameOf = function (seat) {
      var s = m.seats.find(function (x) { return x.seat === seat; });
      return s ? (s.isBot ? 'Bot' : s.name) : '?';
    };
    var teamOf = function (seat) {
      var s = m.seats.find(function (x) { return x.seat === seat; });
      return s ? s.team : 0;
    };
    var tt = el('table', 'lb-table lb-timeline');
    var thr = el('tr');
    ['R', 'CALLER', 'TRUMP', 'TRICKS', 'RESULT', 'SCORE'].forEach(function (h, i) {
      thr.appendChild(el('th', i === 3 || i === 5 ? 'num' : '', h));
    });
    var thead = el('thead');
    thead.appendChild(thr);
    tt.appendChild(thead);
    var tb = el('tbody');
    (m.timeline || []).forEach(function (t) {
      var tr = el('tr', t.type === 'redeal' ? 'lb-redeal' : '');
      tr.appendChild(el('td', 'lb-rank', String(t.round)));
      var caller = el('td');
      caller.appendChild(el('span', 'badge ' + (teamOf(t.caller) === 0 ? 'team-a' : 'team-b'), 'AB'[teamOf(t.caller)]));
      caller.appendChild(document.createTextNode(' ' + nameOf(t.caller)));
      tr.appendChild(caller);
      var trump = el('td', 'lb-trump ' + (t.trump === '♥' || t.trump === '♦' ? 'red' : 'blk'), t.trump || '-');
      trump.title = SUIT_NAME[t.trump] || '';
      tr.appendChild(trump);
      if (t.type === 'redeal') {
        var rd = el('td', 'lb-redeal-note',
          'Redeal: Team ' + 'AB'[t.shortTeam] + ' held only ' + t.counts[t.shortTeam] + ' trump' +
          (t.counts[t.shortTeam] === 1 ? '' : 's'));
        rd.colSpan = 3;
        tr.appendChild(rd);
      } else {
        tr.appendChild(el('td', 'num', t.tricks[0] + '-' + t.tricks[1]));
        var result = OUTCOME_LABEL[t.outcome] || t.outcome;
        if (t.scoringTeam === 0 || t.scoringTeam === 1) result += ', Team ' + 'AB'[t.scoringTeam] + ' +' + t.points;
        if (t.bonusPaid) result += ' (' + t.bonusPaid + ' carried)';
        tr.appendChild(el('td', 'lb-outcome', result));
        tr.appendChild(el('td', 'num', (t.scoreAfter || []).join('-')));
      }
      tb.appendChild(tr);
    });
    tt.appendChild(tb);
    b.appendChild(tt);
    if (!(m.timeline || []).length) b.appendChild(el('div', 'lb-empty', 'No rounds were completed.'));
  }

  // ---------- Open / close ----------

  function open() {
    $('leaderboard-overlay').style.display = 'flex';
    setTab(tab);
  }

  function close() {
    $('leaderboard-overlay').style.display = 'none';
  }

  document.querySelectorAll('.lb-tab').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.dataset.tab); });
  });
  $('lb-close').addEventListener('click', close);
  $('leaderboard-overlay').addEventListener('click', function (e) {
    if (e.target === $('leaderboard-overlay')) close();
  });

  window.OmiBoard = { open: open, close: close };
})();
