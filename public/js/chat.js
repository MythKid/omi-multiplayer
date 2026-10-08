// Table chat panel. Non-modal: it floats over a corner of the table and
// never blocks the cards, so play continues while it is open. New messages
// also pop up as short speech bubbles next to the speaker's seat, so the
// panel can stay closed. Every message is rendered with textContent only.
(function () {
  'use strict';

  var QUICK = ['Good game', 'Nice hand!', 'Well played', 'Sorry!', 'Hurry up 😅', '👍', '🐽'];
  var BUBBLE_MS = 4000;
  var BUBBLE_CHARS = 60;
  var MAX_ROWS = 60;

  var socket = null;
  var opts = null;
  var isOpen = false;
  var available = false;
  var unread = 0;
  var soundOn = true;
  var muted = {}; // lowercased name -> true, kept for this browser tab

  function $(id) { return document.getElementById(id); }

  function load() {
    try { muted = JSON.parse(sessionStorage.getItem('omi-chat-muted') || '{}') || {}; } catch (e) { muted = {}; }
    try { soundOn = localStorage.getItem('omi-chat-sound') !== 'off'; } catch (e) {}
  }

  function saveMuted() {
    try { sessionStorage.setItem('omi-chat-muted', JSON.stringify(muted)); } catch (e) {}
  }

  function isMuted(name) { return !!muted[String(name || '').toLowerCase()]; }

  function isMine(m) {
    var me = opts.myName();
    return !!me && String(m.name || '').toLowerCase() === me.toLowerCase();
  }

  // ---------- Panel ----------

  function setUnread(n) {
    unread = n;
    var badge = $('chat-unread');
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'flex' : 'none';
    $('btn-chat').setAttribute('aria-label', n > 0 ? 'Open chat (' + n + ' unread)' : 'Open chat');
  }

  function open() {
    if (!available) return;
    isOpen = true;
    $('chat-panel').style.display = 'flex';
    $('btn-chat').setAttribute('aria-expanded', 'true');
    $('btn-chat').classList.add('on');
    setUnread(0);
    var log = $('chat-log');
    log.scrollTop = log.scrollHeight;
    // Phones would pop the keyboard over the table; only focus on desktop.
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) $('chat-input').focus();
  }

  function close() {
    isOpen = false;
    $('chat-panel').style.display = 'none';
    $('btn-chat').setAttribute('aria-expanded', 'false');
    $('btn-chat').classList.remove('on');
  }

  // Shown only while seated at a table (lobby, game or results).
  function setAvailable(v) {
    available = !!v;
    $('btn-chat').style.display = available ? 'flex' : 'none';
    if (!available) close();
  }

  // Leaving a table: forget its conversation.
  function reset() {
    $('chat-log').innerHTML = '';
    setUnread(0);
    close();
    document.querySelectorAll('.chat-bubble').forEach(function (b) { b.remove(); });
  }

  // ---------- Messages ----------

  function renderRow(m) {
    var row = document.createElement('div');
    row.className = 'chat-msg';
    row.dataset.name = String(m.name || '').toLowerCase();
    if (m.kind === 'system') {
      row.classList.add('sys');
      row.textContent = m.text;
      return row;
    }
    if (isMine(m)) row.classList.add('mine');
    if (isMuted(m.name)) row.classList.add('muted');

    var who = document.createElement('button');
    who.type = 'button';
    who.className = 'chat-who' + (m.team === 0 ? ' team-a' : m.team === 1 ? ' team-b' : '');
    who.textContent = m.name;
    who.title = isMine(m) ? 'You' : 'Tap to mute or unmute ' + m.name;
    if (!isMine(m)) who.addEventListener('click', function () { toggleMute(m.name); });
    row.appendChild(who);

    var text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = m.text;
    row.appendChild(text);

    var hidden = document.createElement('span');
    hidden.className = 'chat-hidden';
    hidden.textContent = 'muted';
    row.appendChild(hidden);
    return row;
  }

  function append(m) {
    var log = $('chat-log');
    var nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(renderRow(m));
    while (log.children.length > MAX_ROWS) log.removeChild(log.firstChild);
    if (nearBottom || isMine(m)) log.scrollTop = log.scrollHeight;
  }

  function toggleMute(name) {
    var key = String(name || '').toLowerCase();
    if (muted[key]) delete muted[key]; else muted[key] = true;
    saveMuted();
    document.querySelectorAll('.chat-msg').forEach(function (row) {
      if (row.dataset.name === key) row.classList.toggle('muted', !!muted[key]);
    });
    if (opts.toast) opts.toast(muted[key] ? name + ' is muted for you' : name + ' is unmuted');
  }

  // A short bubble next to the speaker's name tag (game screen only). It is
  // positioned on the table itself, so table re-renders never wipe it.
  function bubble(m) {
    if (m.kind !== 'user' || !m.inGame || isMine(m)) return;
    var zone = opts.zoneForSeat(m.seat);
    var table = $('table');
    if (!zone || !table) return;
    var tag = zone.querySelector('.ptag') || zone;
    var tr = table.getBoundingClientRect();
    var r = tag.getBoundingClientRect();
    if (!r.width) return;

    var old = table.querySelector('.chat-bubble[data-seat="' + m.seat + '"]');
    if (old) old.remove();

    var chars = Array.from(m.text);
    var b = document.createElement('div');
    b.className = 'chat-bubble';
    b.dataset.seat = String(m.seat);
    b.textContent = chars.length > BUBBLE_CHARS ? chars.slice(0, BUBBLE_CHARS).join('') + '…' : m.text;
    table.appendChild(b);

    // Above the tag when the seat is low on the screen, otherwise below it.
    var below = r.top - tr.top < tr.height / 2;
    var w = b.offsetWidth;
    var h = b.offsetHeight;
    var left = r.left - tr.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(tr.width - w - 8, left));
    var top = below ? r.bottom - tr.top + 8 : r.top - tr.top - h - 8;
    b.style.left = left + 'px';
    b.style.top = Math.max(8, top) + 'px';
    b.classList.add(below ? 'from-top' : 'from-bottom');
    setTimeout(function () { b.classList.add('out'); }, BUBBLE_MS - 300);
    setTimeout(function () { b.remove(); }, BUBBLE_MS);
  }

  function receive(m) {
    append(m);
    if (m.kind !== 'user' || isMine(m) || isMuted(m.name)) return;
    bubble(m);
    if (!isOpen) setUnread(unread + 1);
    if (soundOn && opts.sound) opts.sound();
  }

  function send(text) {
    var t = String(text || '').trim();
    if (!t) return;
    socket.emit('chat-send', { text: t });
  }

  function renderQuick() {
    var row = $('chat-quick');
    row.innerHTML = '';
    QUICK.forEach(function (q) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-chip';
      chip.textContent = q;
      chip.addEventListener('click', function () { send(q); });
      row.appendChild(chip);
    });
  }

  function renderSound() {
    var b = $('chat-sound');
    b.textContent = soundOn ? '🔔' : '🔕';
    b.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    b.title = soundOn ? 'Mute chat sounds' : 'Unmute chat sounds';
  }

  // opts: { socket, myName(), zoneForSeat(seat), sound(), toast(msg) }
  function init(o) {
    opts = o;
    socket = o.socket;
    load();
    renderQuick();
    renderSound();

    $('btn-chat').addEventListener('click', function () { if (isOpen) close(); else open(); });
    $('chat-close').addEventListener('click', close);
    $('chat-sound').addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem('omi-chat-sound', soundOn ? 'on' : 'off'); } catch (e) {}
      renderSound();
    });
    $('chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('chat-input');
      send(input.value);
      input.value = '';
    });
    $('chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });

    socket.on('chat-history', function (list) {
      $('chat-log').innerHTML = '';
      (list || []).forEach(append);
      setUnread(0);
    });
    socket.on('chat-message', function (m) { if (m) receive(m); });
    socket.on('chat-error', function (d) { if (d && d.message && opts.toast) opts.toast(d.message); });
  }

  window.OmiChat = { init: init, open: open, close: close, setAvailable: setAvailable, reset: reset };
})();
