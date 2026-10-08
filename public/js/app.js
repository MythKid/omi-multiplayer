  (function () {
    'use strict';

    // The font stylesheet loads with media="print" so it never blocks first
    // paint (matters on Wi-Fi with no internet, where the fetch can hang).
    // Flipping it to "all" applies the fonts whenever they arrive.
    var fontCss = document.getElementById('font-css');
    if (fontCss) fontCss.media = 'all';

    // Register the service worker so the game is installable and loads offline.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () { /* non-fatal */ });
      });
    }

    // Must match the server's PROTOCOL_VERSION. A mismatch means this page
    // is a stale cached copy, so it reloads to fetch the current client.
    var PROTOCOL = 2;

    // Reconnect support: a session token identifies our seat across a refresh
    // or a brief network drop. Present it on connect so the server can resume.
    var sessionToken = null;
    try { sessionToken = sessionStorage.getItem('omi-token'); } catch (e) {}
    var socket = io({ auth: sessionToken ? { token: sessionToken, v: PROTOCOL } : { v: PROTOCOL } });
    var SNAMES = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };
    var SUITS = ['♠', '♥', '♦', '♣'];

    var myState = null;
    var mySeat = -1;
    var isHost = false;
    var msgTimer = null;
    var currentScreen = 'join';
    var atTable = false;       // seated at a table (lobby, game or results)
    var lastTables = [];
    var resultsChosen = false; // already answered the results screen
    var myName = '';
    try { myName = localStorage.getItem('omi-name') || ''; } catch (e) {}
    var myIdentity = null;     // how the leaderboard treats our name at this table

    // Ranked names are claimed by a secret this browser keeps (one per name),
    // so nobody else can play under that name on the leaderboard. The key
    // mirrors the server's: unsafe characters out, NFKC, lowercase.
    function nameKey(name) {
      var out = '';
      Array.from(String(name || '').normalize('NFKC')).forEach(function (ch) {
        var c = ch.codePointAt(0);
        var unsafe = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) ||
          (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
        if (!unsafe) out += ch;
      });
      return out.replace(/\s+/g, ' ').trim().slice(0, 64).toLowerCase();
    }
    function loadClaims() {
      try { return JSON.parse(localStorage.getItem('omi-claims') || '{}') || {}; } catch (e) { return {}; }
    }
    function saveClaim(key, secret) {
      var claims = loadClaims();
      claims[key] = secret;
      try { localStorage.setItem('omi-claims', JSON.stringify(claims)); } catch (e) {}
    }

    // An invite link (?table=N) joins that table as soon as a name is set.
    var wantedTable = Number(new URLSearchParams(window.location.search).get('table')) || 0;

    function $(id) { return document.getElementById(id); }

    function showScreen(name) {
      currentScreen = name;
      $('screen-join').style.display = name === 'join' ? 'flex' : 'none';
      $('screen-tables').style.display = name === 'tables' ? 'flex' : 'none';
      $('screen-lobby').style.display = name === 'lobby' ? 'flex' : 'none';
      $('screen-game').style.display = name === 'game' ? 'block' : 'none';
      // Chat belongs to a table: available in its lobby, game and results.
      if (window.OmiChat) window.OmiChat.setAvailable(name === 'lobby' || name === 'game');
    }

    function showToast(msg, ms) {
      var t = $('toast');
      t.textContent = msg;
      t.style.display = 'block';
      t.classList.remove('show');
      void t.offsetWidth; // restart the slide-in animation
      t.classList.add('show');
      clearTimeout(msgTimer);
      msgTimer = setTimeout(function () { t.style.display = 'none'; }, ms || 2200);
    }

    function relativeOffset(theirSeat, seat, numPlayers) {
      return (theirSeat - seat + numPlayers) % numPlayers;
    }

    // Zone element ids by relative offset, per mode. Play runs
    // counter-clockwise like the real game, so seat+1 renders to the RIGHT.
    var ZONES = {
      2: ['pS', 'pN'],
      3: ['pS', 'pNE', 'pNW'],
      4: ['pS', 'pE', 'pN', 'pW'],
    };
    // Trick slot classes by relative offset, per mode
    var TSLOTS = {
      2: ['ts', 'tn'],
      3: ['ts', 'tne', 'tnw'],
      4: ['ts', 'te', 'tn', 'tw'],
    };

    // ---------- Card rendering ----------

    function makeCardEl(card, faceUp) {
      var el = document.createElement('div');
      el.className = 'card';
      if (!faceUp) {
        el.classList.add('face-down');
        return el;
      }
      var red = (card.s === '♥' || card.s === '♦');
      el.classList.add(red ? 'red-c' : 'blk-c');
      el.innerHTML =
        '<div class="card-tl"><div class="cr">' + card.r + '</div><div class="cs">' + card.s + '</div></div>' +
        '<div class="cc">' + card.s + '</div>' +
        '<div class="card-br"><div class="cr">' + card.r + '</div><div class="cs">' + card.s + '</div></div>';
      return el;
    }

    function isLegal(card, myHand, leadSuit) {
      if (!leadSuit) return true;
      var suitCards = myHand.filter(function (c) { return c.s === leadSuit; });
      if (suitCards.length > 0) return card.s === leadSuit;
      return true;
    }

    // ---------- Render functions ----------

    function renderAll(state) {
      renderPlayers(state);
      renderTrick(state);
      renderInfobar(state);
      renderScores(state);
      renderDraw(state);
      renderActionPanel(state);
      renderStage(state);
      renderVote(state);
    }

    // End-match vote: propose button + live consent banner
    function renderVote(state) {
      var btn = $('btn-vote-end');
      var banner = $('vote-banner');
      var seated = state.mySeat >= 0 && state.mySeat < state.mode;
      var voteActive = !!state.endVote && !state.gameOver && !state.roundJustEnded;

      btn.style.display =
        seated && !state.endVote && !state.gameOver && !state.roundJustEnded ? 'block' : 'none';

      if (!voteActive) {
        banner.style.display = 'none';
        return;
      }
      banner.style.display = 'block';
      banner.innerHTML = '';

      var title = document.createElement('div');
      title.className = 'ap-title';
      title.textContent = 'END THE MATCH?';
      banner.appendChild(title);

      var agreed = state.endVote.agreedSeats || [];
      var msg = document.createElement('div');
      msg.className = 'vote-msg';
      var names = agreed
        .map(function (s) { return state.players[s] ? state.players[s].name : '?'; })
        .join(', ');
      msg.textContent = names + ' agreed to stop. The highest score takes the match.';
      banner.appendChild(msg);

      if (seated && agreed.indexOf(state.mySeat) === -1) {
        var yes = document.createElement('button');
        yes.className = 'vote-btn yes';
        yes.textContent = 'AGREE';
        yes.addEventListener('click', function () {
          socket.emit('vote-end', { action: 'agree' });
        });
        banner.appendChild(yes);
        var no = document.createElement('button');
        no.className = 'vote-btn no';
        no.textContent = 'DECLINE';
        no.addEventListener('click', function () {
          socket.emit('vote-end', { action: 'decline' });
        });
        banner.appendChild(no);
      } else {
        var wait = document.createElement('div');
        wait.className = 'ap-hint';
        wait.textContent = 'Waiting for the other players…';
        banner.appendChild(wait);
      }
    }

    function makeBadges(p, state) {
      var frag = document.createDocumentFragment();
      if (state.mode === 4) {
        var tb = document.createElement('span');
        tb.className = 'badge ' + (p.team === 0 ? 'team-a' : 'team-b');
        tb.textContent = p.team === 0 ? 'A' : 'B';
        frag.appendChild(tb);
      }
      if (p.isYou) {
        var yb = document.createElement('span');
        yb.className = 'badge you';
        yb.textContent = 'YOU';
        frag.appendChild(yb);
      }
      if (p.seat === state.dealer && state.mode === 4) {
        var db = document.createElement('span');
        db.className = 'badge dealer';
        db.textContent = 'DEALER';
        frag.appendChild(db);
      }
      return frag;
    }

    var prevMyHandLen = -1;

    // Compress the hand's overlap so it always fits the viewport width
    function fitMyHand(hand) {
      var n = hand.children.length;
      if (n < 2 || !hand.firstChild.offsetWidth) return;
      var cw = hand.firstChild.offsetWidth;
      // Leave room on both sides so the fanned hand never slides under the
      // corner controls (the info button sits at the bottom-right).
      var maxW = Math.min(window.innerWidth - 104, 660);
      var need = (n * cw - maxW) / (n - 1);
      var ov = Math.max(cw * 0.4, Math.min(cw * 0.82, need));
      for (var k = 1; k < n; k++) hand.children[k].style.marginLeft = (-ov) + 'px';
    }

    function renderPlayers(state) {
      ['pS', 'pN', 'pW', 'pE', 'pNW', 'pNE'].forEach(function (id) {
        $(id).innerHTML = '';
      });

      // trick.length check: after the 4th card the turn marker stays on the
      // last player while the server pauses, so no extra card is playable then
      var myTurn = state.phase === 'play' && state.currentSeat === state.mySeat
        && state.trick.length < state.mode;

      // Fresh cards flip into the hand after each deal stage, including the
      // moment a waiting partner's cards unlock once trump is called.
      var dealIn = state.myHand.length > Math.max(0, prevMyHandLen)
        && (state.phase === 'trump' || state.phase === 'dealing2' || state.phase === 'play');

      state.players.forEach(function (p, i) {
        var off = relativeOffset(p.seat, state.mySeat, state.mode);
        var zone = $(ZONES[state.mode][off]);
        if (!zone) return;

        var tag = document.createElement('div');
        tag.className = 'ptag' + (p.seat === state.currentSeat ? ' active' : '');
        var nameEl = document.createElement('span');
        nameEl.className = 'pname';
        nameEl.textContent = p.name;
        tag.appendChild(nameEl);
        tag.appendChild(makeBadges(p, state));

        var tricksEl = document.createElement('div');
        tricksEl.className = 'ptricks';
        tricksEl.textContent = 'Tricks: ' + p.tricks;

        var hand = document.createElement('div');
        hand.className = 'hand';

        var handWrap = null;
        if (i === state.mySeat && state.myHandLocked > 0) {
          // Partner of the trump caller: the cards stay face-down behind a
          // red cross until trump is called (the server withholds them).
          hand.classList.add('mine', 'locked');
          for (var lc = 0; lc < state.myHandLocked; lc++) hand.appendChild(makeCardEl(null, false));
          handWrap = document.createElement('div');
          handWrap.className = 'locked-wrap';
          handWrap.appendChild(hand);
          var lock = document.createElement('div');
          lock.className = 'hand-lock';
          lock.setAttribute('role', 'img');
          lock.setAttribute('aria-label', 'Your cards stay hidden until your partner calls trumps');
          var cross = document.createElement('span');
          cross.className = 'lock-x';
          cross.textContent = '✕';
          var waitLbl = document.createElement('span');
          waitLbl.className = 'lock-w';
          waitLbl.textContent = 'WAIT';
          lock.appendChild(cross);
          lock.appendChild(waitLbl);
          handWrap.appendChild(lock);
        } else if (i === state.mySeat) {
          hand.classList.add('mine');
          state.myHand.forEach(function (card, idx) {
            var el = makeCardEl(card, true);
            el.setAttribute('aria-label', card.r + ' of ' + SNAMES[card.s]);
            if (card.s === state.trump) el.classList.add('trump-glow');
            if (dealIn) {
              el.classList.add('deal-in');
              el.style.animationDelay = (idx * 60) + 'ms';
            }
            if (myTurn) {
              if (isLegal(card, state.myHand, state.leadSuit)) {
                el.classList.add('playable');
                el.setAttribute('role', 'button');
                el.setAttribute('tabindex', '0');
                var play = function () { socket.emit('play-card', { cardIndex: idx }); };
                el.addEventListener('click', play);
                el.addEventListener('keydown', function (e) {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
                });
              } else {
                el.classList.add('unplayable');
              }
            }
            hand.appendChild(el);
          });
        } else {
          var vertical = (ZONES[state.mode][off] === 'pW' || ZONES[state.mode][off] === 'pE');
          hand.classList.add(vertical ? 'vert' : 'horiz');
          hand.classList.add('small-backs');
          for (var c = 0; c < p.cardCount; c++) {
            hand.appendChild(makeCardEl(null, false));
          }
        }

        zone.appendChild(tag);
        zone.appendChild(tricksEl);
        zone.appendChild(handWrap || hand);
        if (i === state.mySeat) fitMyHand(hand);
      });

      prevMyHandLen = state.myHand.length;
    }

    var prevTrick = [];       // [{key, seat, rect, rot}] from the last render
    var prevTricksPlayed = 0;
    var prevRoundNum = 0;

    // A finished trick is gathered face-down and slid to the winner's pile
    function gatherTrick(state) {
      var table = $('table');
      var tRect = table.getBoundingClientRect();
      var off = relativeOffset(state.currentSeat, state.mySeat, state.mode);
      var zone = $(ZONES[state.mode][off]);
      if (!zone) return;
      var cw2 = prevTrick[0].rect.width / 2;
      var ch2 = prevTrick[0].rect.height / 2;
      var zr = zone.getBoundingClientRect();
      var tx = zr.left - tRect.left + zr.width / 2 - cw2;
      var ty = zr.top - tRect.top + zr.height / 2 - ch2;
      Sound.swish();

      // flash the winner's name tag while they gather the trick
      var tag = zone.querySelector('.ptag');
      if (tag) {
        tag.classList.add('won-flash');
        setTimeout(function () { tag.classList.remove('won-flash'); }, 1100);
      }

      prevTrick.forEach(function (p, i) {
        var el = makeCardEl(null, false);
        el.classList.add('gather-card');
        var x = p.rect.left - tRect.left;
        var y = p.rect.top - tRect.top;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        table.appendChild(el);
        void el.offsetWidth;
        el.style.transform =
          'translate(' + (tx - x + i * 1.5) + 'px,' + (ty - y - i * 1.5) + 'px) rotate(' + (i * 4 - 6) + 'deg)';
        el.style.opacity = '0.25';
        setTimeout(function () { el.remove(); }, 750);
      });
    }

    function renderTrick(state) {
      var area = $('trickarea');

      // Trick just cleared mid-round → play the gather animation first
      if (state.trick.length === 0 && prevTrick.length > 0 &&
          state.roundNum === prevRoundNum && state.tricksPlayed > prevTricksPlayed) {
        gatherTrick(state);
      }

      var oldKeys = {};
      prevTrick.forEach(function (p) { oldKeys[p.key] = p; });

      area.innerHTML = '';
      var newPrev = [];
      state.trick.forEach(function (entry) {
        var key = entry.seat + ':' + entry.card.r + entry.card.s;
        var off = relativeOffset(entry.seat, state.mySeat, state.mode);
        var slot = document.createElement('div');
        slot.className = 'tslot ' + TSLOTS[state.mode][off];
        var el = makeCardEl(entry.card, true);
        var known = oldKeys[key];
        var rot = known ? known.rot : ((Math.random() * 10) - 5);
        slot.appendChild(el);
        area.appendChild(slot);

        var rect = el.getBoundingClientRect();
        if (!known) {
          // New card: slide in from its owner's hand zone
          var zone = $(ZONES[state.mode][off]);
          if (zone) {
            var zr = zone.getBoundingClientRect();
            var dx = (zr.left + zr.width / 2) - (rect.left + rect.width / 2);
            var dy = (zr.top + zr.height / 2) - (rect.top + rect.height / 2);
            el.style.transition = 'none';
            el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + (rot + 14) + 'deg)';
            void el.offsetWidth;
            el.style.transition = '';
            Sound.swish();
          }
          el.style.transform = 'rotate(' + rot.toFixed(1) + 'deg)';
        } else {
          // Already on the table: place it without re-animating
          el.style.transition = 'none';
          el.style.transform = 'rotate(' + rot.toFixed(1) + 'deg)';
          void el.offsetWidth;
          el.style.transition = '';
        }
        newPrev.push({ key: key, seat: entry.seat, rect: rect, rot: rot });
      });

      prevTrick = newPrev;
      prevTricksPlayed = state.tricksPlayed;
      prevRoundNum = state.roundNum;
    }

    function renderInfobar(state) {
      var disp = $('trump-disp');
      disp.textContent = state.trump || '-';
      disp.className = 'trump-disp ' + (state.trump === '♥' || state.trump === '♦' ? 'red' : 'blk');
      $('trump-name').textContent = state.trump ? SNAMES[state.trump] : '-';
      $('round-num').textContent = state.roundNum;
      $('tricks-info').textContent = state.tricksPlayed + '/' + state.tricksTot;
      var kb = $('kapothi-banner');
      kb.style.display = state.kapothiTeam >= 0 ? 'block' : 'none';
      if (state.kapothiTeam >= 0) {
        kb.textContent = 'KAPOTHI · TEAM ' + 'AB'[state.kapothiTeam];
      }
    }

    function renderScores(state) {
      var list = $('score-list');
      list.innerHTML = '';
      state.players.forEach(function (p) {
        var row = document.createElement('div');
        row.className = 'sc-row';
        if (state.mode === 4) {
          var tb = document.createElement('span');
          tb.className = 'badge ' + (p.team === 0 ? 'team-a' : 'team-b');
          tb.textContent = p.team === 0 ? 'A' : 'B';
          row.appendChild(tb);
        }
        var name = document.createElement('span');
        name.className = 'sc-name' + (p.seat === state.currentSeat ? ' active' : '');
        name.textContent = p.name + (p.isYou ? ' (you)' : '');
        row.appendChild(name);
        var tricks = document.createElement('span');
        tricks.className = 'sc-tricks';
        tricks.textContent = p.tricks + ' tk';
        row.appendChild(tricks);
        var score = document.createElement('span');
        score.className = 'sc-score';
        score.textContent = p.score;
        row.appendChild(score);
        list.appendChild(row);
      });

      // 4p: scores are physical token cards captured from the opponents,
      // Team A collects the red 2 to 6s, Team B the black ones.
      if (state.mode === 4) renderTokens(state, list);
    }

    var prevTokCounts = [-1, -1];

    function renderTokens(state, list) {
      {
        var TOKENS = {
          0: ['2♥','3♥','4♥','5♥','6♥','2♦','3♦','4♦','5♦','6♦'],
          1: ['2♠','3♠','4♠','5♠','6♠','2♣','3♣','4♣','5♣','6♣'],
        };
        [0, 1].forEach(function (team) {
          var score = 0;
          state.players.forEach(function (p) { if (p.team === team) score = p.score; });
          var lbl = document.createElement('div');
          lbl.className = 'tok-lbl';
          lbl.textContent = 'TEAM ' + 'AB'[team] + ' TOKENS · ' + Math.min(score, 10) + '/10';
          list.appendChild(lbl);
          var rowEl = document.createElement('div');
          rowEl.className = 'tok-row';
          var shown = Math.min(score, 10);
          for (var i = 0; i < shown; i++) {
            var tok = document.createElement('span');
            tok.className = 'tok ' + (team === 0 ? 'red' : 'blk');
            tok.textContent = TOKENS[team][i];
            // only freshly won tokens pop, not every re-render
            if (prevTokCounts[team] >= 0 && i >= prevTokCounts[team]) {
              tok.classList.add('pop');
              tok.style.animationDelay = ((i - prevTokCounts[team]) * 120) + 'ms';
            }
            rowEl.appendChild(tok);
          }
          prevTokCounts[team] = shown;
          list.appendChild(rowEl);
        });
        if (state.drawBonus > 0) {
          var bl = document.createElement('div');
          bl.className = 'tok-lbl';
          bl.textContent = 'ON THE TABLE · ' + state.drawBonus + ' BONUS';
          list.appendChild(bl);
          var brow = document.createElement('div');
          brow.className = 'tok-row';
          for (var b = 0; b < state.drawBonus; b++) {
            var bt = document.createElement('span');
            bt.className = 'tok back';
            brow.appendChild(bt);
          }
          list.appendChild(brow);
        }
      }
    }

    function renderDraw(state) {
      var dp = $('drawpile');
      var isDeck = state.mode === 4 && state.deckCount > 0 &&
        (state.phase === 'trump' || state.phase === 'dealing1' || state.phase === 'dealing2');
      var count = isDeck ? state.deckCount : state.drawPileCount;
      if ((state.mode !== 2 || !state.drawPileCount) && !isDeck) {
        dp.style.display = 'none';
        return;
      }
      dp.style.display = 'block';
      dp.querySelector('.dp-lbl').textContent = isDeck ? 'DECK' : 'DRAW PILE';
      var stack = $('dp-stack');
      stack.innerHTML = '';
      var n = Math.min(3, count);
      for (var i = 0; i < n; i++) {
        var el = makeCardEl(null, false);
        el.style.left = (i * 3) + 'px';
        el.style.top = (i * 2) + 'px';
        stack.appendChild(el);
      }
      $('dp-count').textContent = count + ' CARDS LEFT';
    }

    function renderActionPanel(state) {
      var ap = $('action-panel');
      ap.innerHTML = '';
      ap.style.display = 'none';
      if (state.roundJustEnded) return;

      var current = state.players[state.currentSeat];
      var currentName = current ? current.name : '';
      var myTurn = state.currentSeat === state.mySeat;

      function show() { ap.style.display = 'block'; }
      function addTitle(text) {
        var t = document.createElement('div');
        t.className = 'ap-title';
        t.textContent = text;
        ap.appendChild(t);
      }
      function addWait(text) {
        var w = document.createElement('div');
        w.className = 'ap-wait';
        w.textContent = text;
        ap.appendChild(w);
        show();
      }

      if (state.phase === 'redeal' && state.redeal) {
        var rd = state.redeal;
        var shortN = rd.counts[rd.shortTeam];
        var nameOf = function (seat) { return state.players[seat] ? state.players[seat].name : '?'; };
        addTitle('REDEAL');
        var rmsg = document.createElement('div');
        rmsg.className = 'ap-wait';
        rmsg.textContent = 'Team ' + 'AB'[rd.shortTeam] + ' holds only ' + shortN + ' trump' +
          (shortN === 1 ? '' : 's') + ' between them, so the hand is thrown in.';
        ap.appendChild(rmsg);
        var rhint = document.createElement('div');
        rhint.className = 'ap-hint';
        rhint.textContent = nameOf(state.dealer) + ' reshuffles, ' + nameOf(state.breakerSeat) +
          ' cuts and ' + nameOf(state.trumpCallerSeat) + ' calls trumps again.';
        ap.appendChild(rhint);
        show();
        return;
      }

      if (state.phase === 'trump' && state.myHandLocked > 0) {
        addTitle('WAIT FOR TRUMPS');
        var lmsg = document.createElement('div');
        lmsg.className = 'ap-wait';
        lmsg.textContent = 'Your partner ' + currentName + ' is choosing trumps. ' +
          'Your cards unlock once trumps are called.';
        ap.appendChild(lmsg);
        show();
        return;
      }

      if (state.phase === 'trump' && myTurn) {
        addTitle('CHOOSE TRUMP SUIT');
        var row = document.createElement('div');
        row.className = 'ap-row';
        SUITS.forEach(function (s) {
          var b = document.createElement('button');
          b.className = 'suit-btn ' + (s === '♥' || s === '♦' ? 'red' : 'blk');
          b.textContent = s;
          b.addEventListener('click', function () {
            socket.emit('choose-trump', { suit: s });
          });
          row.appendChild(b);
        });
        ap.appendChild(row);
        if (state.mode === 4) {
          var partner = state.players[(state.mySeat + 2) % 4];
          if (partner && !partner.ai) {
            var phint = document.createElement('div');
            phint.className = 'ap-hint';
            phint.textContent = partner.name + ' cannot see their cards until you call trumps.';
            ap.appendChild(phint);
          }
        }
        show();
      } else if (state.phase === 'play' && myTurn) {
        var turn = document.createElement('div');
        turn.className = 'ap-turn';
        turn.textContent = '▶ Your turn, tap a card to play';
        ap.appendChild(turn);
        show();
      } else if (state.phase === 'kapothi' && myTurn) {
        addTitle('ALL SIX TRICKS. CALL IT?');
        var krow = document.createElement('div');
        krow.className = 'ap-row';
        var ann = document.createElement('button');
        ann.className = 'kapothi-btn announce';
        ann.textContent = 'ANNOUNCE KAPOTHI!';
        ann.addEventListener('click', function () {
          socket.emit('kapothi-call', { announce: true });
        });
        krow.appendChild(ann);
        var quiet = document.createElement('button');
        quiet.className = 'kapothi-btn';
        quiet.textContent = 'PLAY ON';
        quiet.addEventListener('click', function () {
          socket.emit('kapothi-call', { announce: false });
        });
        krow.appendChild(quiet);
        ap.appendChild(krow);
        var khint = document.createElement('div');
        khint.className = 'ap-hint';
        khint.textContent = 'Sweep all 8 → +3 tokens. Lose a trick after announcing → they take 4!';
        ap.appendChild(khint);
        show();
      } else if (state.phase === 'kapothi') {
        addWait(currentName + ' is considering Kapothi…');
      } else if (state.phase === 'shuffle') {
        if (state.dealer !== state.mySeat) {
          addWait(state.players[state.dealer].name + ' is washing the deck…');
        }
      } else if (state.phase === 'cut') {
        if (state.breakerSeat !== state.mySeat) {
          addWait(state.players[state.breakerSeat].name + ' is cutting the deck…');
        }
      } else if (state.phase === 'dealing1' || state.phase === 'dealing2') {
        addWait(state.players[state.dealer].name + ' is dealing…');
      } else if (state.phase === 'trump') {
        addWait('Waiting for ' + currentName + ' to choose trump…');
      } else if (state.phase === 'play') {
        addWait('Waiting for ' + currentName + ' to play…');
      }
    }

    // ---------- Sound (all synthesized, no audio files) ----------

    var Sound = (function () {
      var ctx = null, washGain = null, washFilter = null, washSrc = null;

      function ensure() {
        if (!ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      }

      function noiseBuffer(seconds) {
        var buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
        var d = buf.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return buf;
      }

      // Looping felt-slide noise; volume & brightness follow cursor speed
      function startWash() {
        if (!ensure() || washSrc) return;
        washSrc = ctx.createBufferSource();
        washSrc.buffer = noiseBuffer(1.2);
        washSrc.loop = true;
        washFilter = ctx.createBiquadFilter();
        washFilter.type = 'bandpass';
        washFilter.frequency.value = 1200;
        washFilter.Q.value = 0.8;
        washGain = ctx.createGain();
        washGain.gain.value = 0;
        washSrc.connect(washFilter);
        washFilter.connect(washGain);
        washGain.connect(ctx.destination);
        washSrc.start();
      }

      function setWash(speed) {
        if (!washGain) return;
        var now = ctx.currentTime;
        washGain.gain.cancelScheduledValues(now);
        washGain.gain.setTargetAtTime(Math.min(0.35, speed * 0.16), now, 0.05);
        washGain.gain.setTargetAtTime(0, now + 0.22, 0.12); // auto-decay if moves stop
        washFilter.frequency.setTargetAtTime(700 + Math.min(2600, speed * 1400), now, 0.08);
      }

      function stopWash() {
        if (!washSrc) return;
        washGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        var src = washSrc;
        washSrc = null;
        setTimeout(function () { try { src.stop(); } catch (e) {} }, 400);
      }

      // Sharp flick as a card leaves the deck
      function snap() {
        if (!ensure()) return;
        var src = ctx.createBufferSource();
        src.buffer = noiseBuffer(0.05);
        src.playbackRate.value = 0.9 + Math.random() * 0.4;
        var f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 2200;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.4, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
        src.connect(f); f.connect(g); g.connect(ctx.destination);
        src.start();
      }

      // Heavy stack-merge thud
      function thump() {
        if (!ensure()) return;
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(85, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(45, ctx.currentTime + 0.12);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.7, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
        o.connect(g); g.connect(ctx.destination);
        o.start();
        o.stop(ctx.currentTime + 0.2);
        var n = ctx.createBufferSource();
        n.buffer = noiseBuffer(0.04);
        var nf = ctx.createBiquadFilter();
        nf.type = 'lowpass';
        nf.frequency.value = 400;
        var ng = ctx.createGain();
        ng.gain.setValueAtTime(0.4, ctx.currentTime);
        ng.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        n.connect(nf); nf.connect(ng); ng.connect(ctx.destination);
        n.start();
      }

      // Rapid burst of accelerating ticks, cards interleaving in a riffle
      function riffle() {
        if (!ensure()) return;
        var t = ctx.currentTime;
        for (var i = 0; i < 24; i++) {
          var src = ctx.createBufferSource();
          src.buffer = noiseBuffer(0.012);
          src.playbackRate.value = 0.8 + Math.random() * 0.6;
          var f = ctx.createBiquadFilter();
          f.type = 'highpass';
          f.frequency.value = 1800;
          var g = ctx.createGain();
          var at = t + 0.05 + Math.pow(i / 24, 1.4) * 0.42; // accelerando
          g.gain.setValueAtTime(0.28, at);
          g.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
          src.connect(f); f.connect(g); g.connect(ctx.destination);
          src.start(at);
        }
      }

      // Soft felt swish, a card sliding onto the table
      function swish() {
        if (!ensure()) return;
        var src = ctx.createBufferSource();
        src.buffer = noiseBuffer(0.14);
        var f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(2400, ctx.currentTime);
        f.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.13);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
        src.connect(f); f.connect(g); g.connect(ctx.destination);
        src.start();
      }

      // Soft two-note blip for an incoming chat message
      function pop() {
        if (!ensure()) return;
        [880, 1320].forEach(function (f, i) {
          var o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f;
          var g = ctx.createGain();
          var at = ctx.currentTime + i * 0.07;
          g.gain.setValueAtTime(0.001, at);
          g.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
          g.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
          o.connect(g); g.connect(ctx.destination);
          o.start(at);
          o.stop(at + 0.14);
        });
      }

      // Bright little arpeggio for the big moments
      function fanfare() {
        if (!ensure()) return;
        [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i, arr) {
          var o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = f;
          var g = ctx.createGain();
          var at = ctx.currentTime + i * 0.12;
          g.gain.setValueAtTime(0.001, at);
          g.gain.exponentialRampToValueAtTime(0.28, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, at + (i === arr.length - 1 ? 0.55 : 0.16));
          o.connect(g); g.connect(ctx.destination);
          o.start(at);
          o.stop(at + 0.7);
        });
      }

      // Browsers require a user gesture before audio can start
      document.addEventListener('pointerdown', ensure, { once: true });

      return {
        startWash: startWash, setWash: setWash, stopWash: stopWash,
        snap: snap, thump: thump, riffle: riffle, swish: swish, fanfare: fanfare, pop: pop,
      };
    })();

    // ---------- Physical deck stage (4p: shuffle / cut / deal) ----------

    var STAGE_PHASES = ['shuffle', 'cut', 'dealing1', 'dealing2'];
    var stageKey = '';
    var stageTimeouts = [];
    var stageIntervals = [];
    var stageRaf = null;
    var washRelay = null;   // receives relayed shuffle-move events
    var riffleRelay = null; // receives relayed shuffle-riffle events
    var chopRelay = null;   // receives relayed shuffle-chop events

    function teardownStage() {
      stageTimeouts.forEach(clearTimeout);
      stageIntervals.forEach(clearInterval);
      stageTimeouts = [];
      stageIntervals = [];
      if (stageRaf) { cancelAnimationFrame(stageRaf); stageRaf = null; }
      washRelay = null;
      riffleRelay = null;
      chopRelay = null;
      Sound.stopWash();
      $('stage-area').innerHTML = '';
      $('stage-hint').textContent = '';
      document.querySelectorAll('.flycard, .gather-card').forEach(function (el) { el.remove(); });
    }

    function renderStage(state) {
      var active = state.mode === 4 && STAGE_PHASES.indexOf(state.phase) !== -1;
      // The redeal count is part of the key, so a thrown-in hand rebuilds the
      // shuffle stage even though the round number stays the same.
      var key = active ? (state.phase + ':' + state.roundNum + ':' + (state.redealCount || 0)) : 'off';
      if (key === stageKey) return; // don't rebuild mid-interaction
      stageKey = key;
      teardownStage();
      $('stage').style.display = active ? 'block' : 'none';
      if (!active) return;
      if (state.phase === 'shuffle') buildWash(state);
      else if (state.phase === 'cut') buildCut(state);
      else buildDeal(state);
    }

    // One riffle animation on an existing .riffle-wrap: halves tilt in,
    // strips interleave down. ~900ms.
    function playRiffleAnim(wrap) {
      Sound.riffle();
      wrap.classList.add('go');
      var strips = [];
      stageTimeouts.push(setTimeout(function () {
        for (var i = 0; i < 16; i++) {
          var s = document.createElement('div');
          s.className = 'riffle-strip drop';
          s.style.top = (98 - i * 3) + 'px';
          s.style.animationDelay = (i * 35) + 'ms';
          wrap.appendChild(s);
          strips.push(s);
        }
      }, 260));
      stageTimeouts.push(setTimeout(function () {
        wrap.classList.remove('go');
        strips.forEach(function (s) { s.remove(); });
      }, 1050));
    }

    // Shuffle bench (after the wash squares up): chop overhand packets off
    // the hand stack, riffle, or both, then offer the deck for the cut.
    function buildBench(state, opts) {
      var area = $('stage-area');
      area.innerHTML = '';

      var row = document.createElement('div');
      row.className = 'bench-row';
      var tablePile = document.createElement('div');
      tablePile.className = 'bench-stack';
      var tLbl = document.createElement('div');
      tLbl.className = 'bench-lbl';
      tLbl.textContent = 'TABLE';
      tablePile.appendChild(tLbl);
      var handStack = document.createElement('div');
      handStack.className = 'bench-stack';
      var hLbl = document.createElement('div');
      hLbl.className = 'bench-lbl';
      hLbl.textContent = 'IN HAND';
      handStack.appendChild(hLbl);
      row.appendChild(tablePile);
      row.appendChild(handStack);
      area.appendChild(row);

      var N = state.deckCount || 32;
      var hand = N;
      var pile = 0;

      function paint() {
        handStack.style.height = Math.max(8, hand * 2.4) + 'px';
        tablePile.style.height = Math.max(8, pile * 2.4) + 'px';
        handStack.style.opacity = hand ? 1 : 0.3;
        tablePile.style.opacity = pile ? 1 : 0.3;
      }
      paint();

      function chopAnim() {
        var hr = handStack.getBoundingClientRect();
        var tr = tablePile.getBoundingClientRect();
        var ar = area.getBoundingClientRect();
        var block = document.createElement('div');
        block.className = 'chop-block';
        block.style.left = (hr.left - ar.left) + 'px';
        block.style.top = (hr.top - ar.top - 20) + 'px';
        area.appendChild(block);
        void block.offsetWidth;
        block.style.transform = 'translate(' + (tr.left - hr.left) + 'px, 0)';
        stageTimeouts.push(setTimeout(function () { block.remove(); }, 340));
        Sound.snap();
      }

      // Peel a packet off the hand stack. Returns { size, passDone }.
      function doChop(sizeHint) {
        if (hand <= 0) return { size: 0, passDone: false };
        var size = Math.min(hand, Math.max(1, sizeHint));
        hand -= size;
        pile += size;
        chopAnim();
        paint();
        var passDone = hand === 0;
        if (passDone) {
          // whole deck transferred, it comes back into the hand squared
          stageTimeouts.push(setTimeout(function () {
            hand = N;
            pile = 0;
            paint();
            Sound.thump();
          }, 420));
        }
        return { size: size, passDone: passDone };
      }

      function riffleFx() {
        var wrap = document.createElement('div');
        wrap.className = 'riffle-wrap';
        area.appendChild(wrap);
        row.style.opacity = 0;
        playRiffleAnim(wrap);
        stageTimeouts.push(setTimeout(function () {
          wrap.remove();
          row.style.opacity = 1;
        }, 1100));
      }

      if (!opts.interactive) {
        $('stage-hint').textContent =
          state.players[state.dealer].name.toUpperCase() + ' IS SHUFFLING THE DECK…';
        chopRelay = function () {
          doChop(2 + Math.floor(Math.random() * 5));
        };
        riffleRelay = riffleFx;
        return { chop: chopRelay, riffle: riffleFx };
      }

      $('stage-hint').textContent = 'CLICK THE DECK TO CHOP • OR RIFFLE • THEN OFFER IT';
      var ops = [];
      var pass = [];
      var lastChop = 0;
      var offered = false;

      var riffleBtn = document.createElement('button');
      riffleBtn.className = 'stage-btn sb-left';
      riffleBtn.textContent = 'RIFFLE';
      var offerBtn = document.createElement('button');
      offerBtn.className = 'stage-btn sb-right';
      offerBtn.textContent = 'OFFER FOR CUT';
      offerBtn.disabled = true;
      area.appendChild(riffleBtn);
      area.appendChild(offerBtn);

      function refreshOffer() {
        offerBtn.disabled = offered || (ops.length === 0 && pass.length === 0);
      }

      // The server accepts at most 24 shuffle ops; stop well short of that
      // so an enthusiastic shuffler is never rejected.
      function atOpCap() { return ops.length >= 20; }

      handStack.classList.add('clickable');
      handStack.addEventListener('click', function () {
        if (offered) return;
        if (atOpCap() && pass.length === 0) return; // let a pass in progress finish
        var now = performance.now();
        var itv = lastChop ? now - lastChop : 600;
        lastChop = now;
        // quick chops peel small packets, slow deliberate ones bigger
        var sizeHint = itv < 350
          ? 2 + Math.floor(Math.random() * 3)
          : 4 + Math.floor(Math.random() * 5);
        var r = doChop(sizeHint);
        if (!r.size) return;
        pass.push(r.size);
        if (opts.entropy.length < 2000) opts.entropy.push(Math.round(itv * 10), r.size);
        socket.emit('shuffle-chop', {});
        if (r.passDone) {
          ops.push({ t: 'o', packets: pass.slice() });
          pass = [];
          lastChop = 0;
        }
        refreshOffer();
      });

      // Whatever is still in hand drops as the final packet of the pass
      function flushPass() {
        if (pass.length && hand > 0) {
          var r = doChop(hand);
          pass.push(r.size);
        }
        if (pass.length) {
          ops.push({ t: 'o', packets: pass.slice() });
          pass = [];
          lastChop = 0;
        }
      }

      riffleBtn.addEventListener('click', function () {
        if (offered || atOpCap()) return;
        flushPass();
        ops.push({ t: 'r' });
        opts.entropy.push(Math.round(performance.now() % 1e6));
        riffleFx();
        socket.emit('shuffle-riffle', {});
        riffleBtn.disabled = true;
        stageTimeouts.push(setTimeout(function () { riffleBtn.disabled = offered; }, 1100));
        refreshOffer();
      });

      offerBtn.addEventListener('click', function () {
        if (offered) return;
        flushPass();
        if (ops.length === 0) return;
        offered = true;
        riffleBtn.disabled = true;
        offerBtn.disabled = true;
        $('stage-hint').textContent = 'OFFERING THE DECK FOR THE CUT…';
        Sound.thump();
        socket.emit('shuffle-done', { entropy: opts.entropy, washMs: opts.washMs, ops: ops });
      });
      return null;
    }

    function buildWash(state) {
      var area = $('stage-area');
      var zone = document.createElement('div');
      zone.className = 'wash-zone';
      area.appendChild(zone);

      var W = area.clientWidth, H = area.clientHeight;
      // wash cards scale with the viewport, so measure the real size
      var probe = document.createElement('div');
      probe.className = 'wcard';
      probe.style.visibility = 'hidden';
      zone.appendChild(probe);
      var CW = probe.offsetWidth || 44;
      var CH = probe.offsetHeight || 64;
      probe.remove();
      var R = Math.max(96, CW * 2.9); // cursor push radius

      var cards = [];
      for (var i = 0; i < 32; i++) {
        var el = document.createElement('div');
        el.className = 'wcard';
        var x = W / 2 - CW / 2 + (Math.random() * 26 - 13);
        var y = H / 2 - CH / 2 + (Math.random() * 18 - 9);
        var rot = Math.random() * 14 - 7;
        el.style.transform = 'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg)';
        zone.appendChild(el);
        cards.push({ el: el, x: x, y: y, r: rot, vx: 0, vy: 0, vr: 0 });
      }

      var shuffler = state.players[state.dealer];
      var iAmShuffler = state.dealer === state.mySeat;
      var last = null;
      var squared = false;

      // Inertia: velocities decay with friction so cards glide and drift
      function physicsTick() {
        if (!squared) {
          for (var i = 0; i < cards.length; i++) {
            var c = cards[i];
            if (Math.abs(c.vx) < 0.05 && Math.abs(c.vy) < 0.05 && Math.abs(c.vr) < 0.05) continue;
            c.x += c.vx;
            c.y += c.vy;
            c.r += c.vr;
            if (c.x < -10 || c.x > W - CW + 10) { c.vx *= -0.5; c.x = Math.max(-10, Math.min(W - CW + 10, c.x)); }
            if (c.y < -10 || c.y > H - CH + 10) { c.vy *= -0.5; c.y = Math.max(-10, Math.min(H - CH + 10, c.y)); }
            c.vx *= 0.9;
            c.vy *= 0.9;
            c.vr *= 0.9;
            c.el.style.transform = 'translate(' + c.x + 'px,' + c.y + 'px) rotate(' + c.r + 'deg)';
          }
        }
        stageRaf = requestAnimationFrame(physicsTick);
      }
      stageRaf = requestAnimationFrame(physicsTick);

      // Smoosh the pile along the (real or virtual) pointer path
      function washStep(px, py) {
        var now = performance.now();
        if (!last) {
          last = { x: px, y: py, t: now };
          return null;
        }
        var dx = px - last.x, dy = py - last.y;
        var dt = Math.max(1, now - last.t);
        var dist = Math.sqrt(dx * dx + dy * dy);
        Sound.startWash();
        Sound.setWash(dist / dt);
        for (var i = 0; i < cards.length; i++) {
          var c = cards[i];
          var ddx = c.x + CW / 2 - px, ddy = c.y + CH / 2 - py;
          var d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < R) {
            var push = (R - d) / R;
            c.vx += dx * push * 0.45 + (Math.random() * 4 - 2) * push;
            c.vy += dy * push * 0.45 + (Math.random() * 4 - 2) * push;
            c.vr += (Math.random() * 10 - 5) * push;
          }
        }
        var out = { dist: dist, dt: dt };
        last = { x: px, y: py, t: now };
        return out;
      }

      function squareUp(afterMs, andThen) {
        squared = true;
        Sound.stopWash();
        cards.forEach(function (c, j) {
          c.el.classList.add('squaring');
          c.el.style.transform =
            'translate(' + (W / 2 - CW / 2 + j * 0.25) + 'px,' + (H / 2 - CH / 2 - j * 0.5) + 'px) rotate(0deg)';
        });
        stageTimeouts.push(setTimeout(function () {
          Sound.thump();
          if (andThen) andThen();
        }, afterMs));
      }

      if (iAmShuffler) {
        $('stage-hint').textContent = 'HOLD & DRAG TO WASH THE CARDS';
        var prog = document.createElement('div');
        prog.id = 'wash-progress';
        var fill = document.createElement('div');
        fill.id = 'wash-fill';
        prog.appendChild(fill);
        area.appendChild(prog);

        var squareBtn = document.createElement('button');
        squareBtn.className = 'stage-btn';
        squareBtn.textContent = 'SQUARE UP';
        squareBtn.style.display = 'none';
        area.appendChild(squareBtn);

        var entropy = [];
        var activeMs = 0;
        var washing = false;
        var done = false;
        var lastEmit = 0;

        squareBtn.addEventListener('click', function () {
          if (done || activeMs < 2500) return;
          done = true;
          washing = false;
          zone.classList.remove('washing');
          squareBtn.remove();
          prog.remove();
          $('stage-hint').textContent = 'SQUARING UP…';
          squareUp(520, function () {
            buildBench(state, { interactive: true, entropy: entropy, washMs: Math.round(activeMs) });
          });
        });

        zone.addEventListener('pointerdown', function (e) {
          if (done) return;
          washing = true;
          zone.classList.add('washing');
          try { zone.setPointerCapture(e.pointerId); } catch (err) {}
          last = null;
          e.preventDefault();
        });
        zone.addEventListener('pointermove', function (e) {
          if (!washing || done) return;
          var rect = zone.getBoundingClientRect();
          var px = e.clientX - rect.left, py = e.clientY - rect.top;
          var r = washStep(px, py);
          if (!r) return;
          // Keep the payload bounded no matter how long the wash runs.
          // 2000 samples is far more entropy than the seed hash needs.
          if (entropy.length < 2000) {
            entropy.push(Math.round(px), Math.round(py), Math.round(r.dt * 10), Math.round(r.dist * 10));
          }
          if (r.dist > 1.5) {
            activeMs += Math.min(r.dt, 100);
            fill.style.width = Math.min(100, (activeMs / 2500) * 100) + '%';
            if (activeMs >= 2500 && squareBtn.style.display === 'none') {
              squareBtn.style.display = 'block';
              $('stage-hint').textContent = 'KEEP WASHING, OR SQUARE UP WHEN READY';
            }
          }
          var now = performance.now();
          if (now - lastEmit > 50) {
            lastEmit = now;
            socket.emit('shuffle-move', { x: px / rect.width, y: py / rect.height });
          }
        });
        function pauseWash() {
          washing = false;
          zone.classList.remove('washing');
          Sound.setWash(0);
        }
        zone.addEventListener('pointerup', pauseWash);
        zone.addEventListener('pointercancel', pauseWash);
      } else if (shuffler.ai) {
        // Canned sequence timed against the server's 6.2s shuffle delay:
        // wash ~3.2s, square up, then two riffles.
        $('stage-hint').textContent = shuffler.name.toUpperCase() + ' IS WASHING THE DECK…';
        var t = Math.random() * 10;
        var washIv = setInterval(function () {
          t += 0.13;
          washStep(
            W / 2 + Math.sin(t * 1.7) * W * 0.3 + Math.sin(t * 3.1) * 30,
            H / 2 + Math.cos(t * 2.3) * H * 0.3 + Math.cos(t * 4.7) * 20
          );
        }, 40);
        stageIntervals.push(washIv);
        stageTimeouts.push(setTimeout(function () {
          clearInterval(washIv);
          squareUp(520, function () {
            var bench = buildBench(state, { interactive: false });
            // canned overhand pass then two riffles
            for (var c = 0; c < 6; c++) {
              stageTimeouts.push(setTimeout(bench.chop, 300 + c * 340));
            }
            stageTimeouts.push(setTimeout(bench.riffle, 2900));
            stageTimeouts.push(setTimeout(bench.riffle, 4200));
          });
        }, 3200));
      } else {
        $('stage-hint').textContent = shuffler.name.toUpperCase() + ' IS WASHING THE DECK…';
        washRelay = function (rx, ry) { washStep(rx * W, ry * H); };
        // The first relayed chop/riffle means the shuffler squared up,
        // switch this spectator to the bench view, then replay their ops.
        function toBench() {
          washRelay = null;
          return buildBench(state, { interactive: false });
        }
        var benchRef = null;
        chopRelay = function () {
          if (!benchRef) benchRef = toBench();
          benchRef.chop();
        };
        riffleRelay = function () {
          if (!benchRef) benchRef = toBench();
          benchRef.riffle();
        };
      }
    }

    function buildCut(state) {
      var area = $('stage-area');
      var iAmBreaker = state.breakerSeat === state.mySeat;
      var breaker = state.players[state.breakerSeat];
      var N = state.deckCount || 32;

      var col = document.createElement('div');
      col.className = 'cut-col';
      area.appendChild(col);

      // piles: top-first; each holds top-first [start,end) slices of the deck
      var piles = [{ segs: [[0, N]] }];
      var cutsMade = 0;
      var finished = false;

      function totalSegs() {
        return piles.reduce(function (s, p) { return s + p.segs.length; }, 0);
      }

      function updateHint() {
        if (!iAmBreaker) {
          $('stage-hint').textContent = breaker.name.toUpperCase() + ' IS CUTTING THE DECK…';
        } else if (piles.length === 1) {
          $('stage-hint').textContent = 'CLICK THE STACK TO CUT IT';
        } else {
          $('stage-hint').textContent = 'DRAG A PILE ONTO ANOTHER TO RESTACK' +
            (totalSegs() < 3 ? ', OR CUT AGAIN' : '');
        }
      }

      function renderPiles() {
        col.innerHTML = '';
        piles.forEach(function (pile) {
          var count = pile.segs.reduce(function (s, seg) { return s + (seg[1] - seg[0]); }, 0);
          var el = document.createElement('div');
          el.className = 'pile-block';
          el.style.height = Math.max(14, count * 3) + 'px';
          var cnt = document.createElement('span');
          cnt.className = 'pile-count';
          cnt.textContent = count;
          el.appendChild(cnt);
          pile.el = el;
          if (iAmBreaker && !finished) {
            el.classList.add(piles.length > 1 ? 'grabbable' : 'cuttable');
            attachPileHandlers(pile);
          }
          col.appendChild(el);
        });
        updateHint();
      }

      function slicePile(pile, clientY) {
        if (totalSegs() >= 3 || pile.segs.length !== 1) return;
        var rect = pile.el.getBoundingClientRect();
        var seg = pile.segs[0];
        var len = seg[1] - seg[0];
        var k = Math.max(1, Math.min(len - 1, Math.round(((clientY - rect.top) / rect.height) * len)));
        piles.splice(piles.indexOf(pile), 1,
          { segs: [[seg[0], seg[0] + k]] },
          { segs: [[seg[0] + k, seg[1]]] });
        cutsMade++;
        Sound.snap();
        renderPiles();
      }

      function mergePile(pile) {
        var rect = pile.el.getBoundingClientRect();
        var target = null;
        piles.forEach(function (other) {
          if (other === pile || target) return;
          var r2 = other.el.getBoundingClientRect();
          if (rect.left < r2.right && rect.right > r2.left && rect.top < r2.bottom && rect.bottom > r2.top) {
            target = other;
          }
        });
        if (!target) return false;
        target.segs = pile.segs.concat(target.segs); // dropped pile lands on top
        piles.splice(piles.indexOf(pile), 1);
        Sound.thump();
        if (piles.length === 1 && cutsMade > 0) {
          finished = true;
          renderPiles();
          $('stage-hint').textContent = 'DECK CUT. DEALING…';
          socket.emit('cut-done', { segments: piles[0].segs });
        } else {
          renderPiles();
        }
        return true;
      }

      function attachPileHandlers(pile) {
        var el = pile.el;
        var isDown = false, moved = false, startX = 0, startY = 0;

        el.addEventListener('pointerdown', function (e) {
          if (finished) return;
          isDown = true;
          moved = false;
          startX = e.clientX;
          startY = e.clientY;
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
          e.preventDefault();
        });
        el.addEventListener('pointermove', function (e) {
          if (!isDown || finished) return;
          var dx = e.clientX - startX, dy = e.clientY - startY;
          if (!moved && piles.length > 1 && Math.sqrt(dx * dx + dy * dy) > 8) {
            moved = true;
            el.classList.add('dragging');
          }
          if (moved) el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
        });
        el.addEventListener('pointerup', function (e) {
          if (!isDown) return;
          isDown = false;
          if (moved) {
            el.classList.remove('dragging');
            if (!mergePile(pile)) {
              el.style.transform = ''; // snap back
              renderPiles();
            }
          } else {
            slicePile(pile, e.clientY);
          }
        });
        el.addEventListener('pointercancel', function () {
          isDown = false;
          moved = false;
          el.classList.remove('dragging');
          el.style.transform = '';
        });
      }

      renderPiles();
    }

    // Dealing: one 4-card packet per player flies off the squared deck,
    // counter-clockwise starting with the trump caller, the way a real
    // dealer hands out cards in batches.
    function buildDeal(state) {
      if (state.phase === 'dealing1') Sound.thump(); // deck lands back centre-table
      var table = $('table');
      var tRect = table.getBoundingClientRect();
      var probe = document.createElement('div');
      probe.className = 'flycard';
      probe.style.visibility = 'hidden';
      table.appendChild(probe);
      var FW = probe.offsetWidth || 44;
      var FH = probe.offsetHeight || 64;
      probe.remove();
      var originX = tRect.width / 2 - FW / 2;
      var originY = tRect.height / 2 - FH / 2;

      for (var k = 0; k < 4; k++) {
        (function (k) {
          var seat = (state.trumpCallerSeat + k) % 4;
          var off = relativeOffset(seat, state.mySeat, 4);
          var zone = $(ZONES[4][off]);
          if (!zone) return;

          stageTimeouts.push(setTimeout(function () {
            var zr = zone.getBoundingClientRect();
            var tx = zr.left - tRect.left + zr.width / 2 - FW / 2;
            var ty = zr.top - tRect.top + zr.height / 2 - FH / 2;
            Sound.snap();

            for (var c = 0; c < 4; c++) {
              (function (c) {
                var el = document.createElement('div');
                el.className = 'flycard';
                el.style.left = (originX + c * 3) + 'px';
                el.style.top = (originY - c * 2) + 'px';
                table.appendChild(el);
                void el.offsetWidth; // flush so the transform below transitions
                el.style.transform =
                  'translate(' + (tx - originX + c * 6 - 9) + 'px,' + (ty - originY) + 'px)' +
                  ' rotate(' + (Math.random() * 24 - 12) + 'deg)';
                stageTimeouts.push(setTimeout(function () { el.remove(); }, 700));
              })(c);
            }
          }, 500 + k * 750));
        })(k);
      }
    }

    // ---------- Big moments: splash, confetti ----------

    var prevTrumpVal = null;
    var prevKapTeam = -1;
    var prevOver = false;
    var prevRedeal = false;

    function splashShow(text, cls) {
      var sp = $('splash');
      sp.innerHTML = '';
      var item = document.createElement('div');
      item.className = 'splash-item ' + cls;
      item.textContent = text;
      sp.appendChild(item);
      setTimeout(function () { if (item.parentNode) item.remove(); }, 1600);
    }

    function confettiBurst() {
      var chars = ['♠', '♥', '♦', '♣'];
      for (var i = 0; i < 28; i++) {
        var c = document.createElement('div');
        c.className = 'conf';
        c.textContent = chars[i % 4];
        c.style.left = (Math.random() * 100) + 'vw';
        c.style.color = (i % 4 === 1 || i % 4 === 2) ? '#ff6b6b' : (i % 2 ? '#e8c547' : '#f0e8cc');
        c.style.fontSize = (14 + Math.random() * 24) + 'px';
        c.style.animationDuration = (2.4 + Math.random() * 2.4) + 's';
        c.style.animationDelay = (Math.random() * 0.9) + 's';
        document.body.appendChild(c);
        (function (el) { setTimeout(function () { el.remove(); }, 6500); })(c);
      }
    }

    // One-shot reactions to state transitions
    function checkMoments(state) {
      if (state.trump && state.trump !== prevTrumpVal) {
        var red = state.trump === '♥' || state.trump === '♦';
        splashShow(state.trump + ' ' + SNAMES[state.trump].toUpperCase(),
          red ? 'suit-red' : 'suit-blk');
      }
      prevTrumpVal = state.trump;

      if (state.kapothiTeam >= 0 && prevKapTeam < 0) {
        splashShow('KAPOTHI!', 'gold');
        Sound.thump();
      }
      prevKapTeam = state.kapothiTeam != null ? state.kapothiTeam : -1;

      if (state.redeal && !prevRedeal) {
        splashShow('REDEAL', 'gold');
        Sound.thump();
      }
      prevRedeal = !!state.redeal;

      if (state.gameOver && !prevOver) {
        Sound.fanfare();
        confettiBurst();
      }
      prevOver = state.gameOver;
    }

    // ---------- Overlays ----------

    function showRoundOverlay(state) {
      var ovEl = $('overlay');
      if (ovEl.style.display === 'none') {
        var box = ovEl.querySelector('.ov-box');
        box.classList.remove('enter');
        void box.offsetWidth;
        box.classList.add('enter');
      }
      ovEl.style.display = 'flex';
      $('ov-title').textContent = state.gameOver
        ? (state.gameWinner ? '🏆 ' + state.gameWinner + ' Wins!' : '🤝 Match Drawn')
        : 'Round ' + state.roundNum + ' Over';

      var tbody = $('ov-tbody');
      tbody.innerHTML = '';
      (state.roundDeltas || []).forEach(function (d) {
        var tr = document.createElement('tr');

        var tdName = document.createElement('td');
        if (state.mode === 4) {
          var tb = document.createElement('span');
          tb.className = 'badge ' + (d.team === 0 ? 'team-a' : 'team-b');
          tb.textContent = d.team === 0 ? 'A' : 'B';
          tdName.appendChild(tb);
          tdName.appendChild(document.createTextNode(' '));
        }
        tdName.appendChild(document.createTextNode(d.name + (d.seat === state.mySeat ? ' (you)' : '')));
        tr.appendChild(tdName);

        var tdTricks = document.createElement('td');
        tdTricks.textContent = d.tricks;
        tr.appendChild(tdTricks);

        var tdDelta = document.createElement('td');
        tdDelta.textContent = (d.delta >= 0 ? '+' : '') + d.delta;
        tdDelta.className = d.delta >= 0 ? 'pos' : 'neg';
        tr.appendChild(tdDelta);

        var tdTotal = document.createElement('td');
        tdTotal.textContent = d.total;
        tr.appendChild(tdTotal);

        tbody.appendChild(tr);
      });

      $('ov-note').textContent = state.roundNote;

      // Clone the button to drop any previously attached listeners
      var oldBtn = $('btn-ready');
      var btn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(btn, oldBtn);
      btn.disabled = false;

      if (state.gameOver) {
        // Stay for a rematch at this table, or leave it. The table returns
        // to its lobby once everyone has chosen (or after a short wait).
        btn.style.display = 'none';
        $('ov-actions').style.display = 'flex';
        $('btn-stay').disabled = resultsChosen;
        $('ov-leaderboard').style.display = state.mode === 4 ? '' : 'none';
        var r = state.results || { stayed: 0, total: 0 };
        renderMyRecord(r.record);
        $('ov-waiting').textContent = resultsChosen
          ? 'Waiting for the others… ' + r.stayed + '/' + r.total + ' staying'
          : (r.stayed ? r.stayed + ' of ' + r.total + ' want a rematch' : '');
      } else {
        renderMyRecord(null);
        btn.style.display = '';
        $('ov-actions').style.display = 'none';
        btn.textContent = 'READY FOR NEXT ROUND';
        $('ov-waiting').textContent = state.readyCount > 0
          ? 'Waiting for ' + state.readyCount + '/' + state.totalPlayers + ' players…'
          : '';
        btn.addEventListener('click', function () {
          socket.emit('ready-next-round');
          btn.disabled = true;
          $('ov-waiting').textContent = 'Waiting for other players…';
        });
      }
    }

    // The results screen line: "Grade A (82) · Rating 1214 (+14)".
    function renderMyRecord(rec) {
      var box = $('ov-record');
      box.innerHTML = '';
      if (!rec) { box.style.display = 'none'; return; }
      box.style.display = 'flex';
      var grade = document.createElement('span');
      grade.className = 'lb-grade g-' + (rec.grade || 'x');
      grade.textContent = rec.grade ? rec.grade + ' ' + rec.gradeScore : '-';
      var gl = document.createElement('span');
      gl.className = 'rec-lbl';
      gl.textContent = 'YOUR GRADE';
      var g = document.createElement('div');
      g.className = 'rec-item';
      g.appendChild(gl);
      g.appendChild(grade);
      box.appendChild(g);
      var rl = document.createElement('span');
      rl.className = 'rec-lbl';
      rl.textContent = 'RATING';
      var rv = document.createElement('span');
      var rItem = document.createElement('div');
      rItem.className = 'rec-item';
      if (rec.rated) {
        var d = Math.round(rec.delta * 10) / 10;
        rv.className = 'rec-val ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
        rv.textContent = rec.rating + ' (' + (d > 0 ? '+' : '') + d + ')';
      } else {
        rv.className = 'rec-val muted';
        rv.textContent = 'not ranked';
        rItem.title = rec.note || IDENTITY_REASONS[rec.reason] || '';
      }
      rItem.appendChild(rl);
      rItem.appendChild(rv);
      box.appendChild(rItem);
      if (!rec.rated && (rec.note || IDENTITY_REASONS[rec.reason])) {
        var why = document.createElement('div');
        why.className = 'rec-why';
        why.textContent = rec.reason === 'unrated-match' || !IDENTITY_REASONS[rec.reason] ? rec.note : IDENTITY_REASONS[rec.reason];
        box.appendChild(why);
      }
    }

    // ---------- Lobby rendering ----------

    var lobbyPairing = 0;
    var LOBBY_PAIRINGS = [
      [[0, 2], [1, 3]],
      [[0, 1], [2, 3]],
      [[0, 3], [1, 2]],
    ];

    // 4p team preview: shows who partners with whom under the current
    // pairing. The host cycles through the three possible arrangements.
    function renderLobbyTeams(data) {
      var box = $('lobby-teams');
      if (data.mode !== 4) {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'flex';
      lobbyPairing = data.teamPairing || 0;

      function slotName(slot) {
        var p = data.players.find(function (pl) { return pl.seat === slot; });
        return p ? { name: p.name, ai: false } : { name: 'AI', ai: true };
      }

      var rows = $('team-rows');
      rows.innerHTML = '';
      var pairs = LOBBY_PAIRINGS[lobbyPairing];
      ['A', 'B'].forEach(function (letter, t) {
        var row = document.createElement('div');
        row.className = 'team-row';
        var badge = document.createElement('span');
        badge.className = 'badge ' + (t === 0 ? 'team-a' : 'team-b');
        badge.textContent = letter;
        row.appendChild(badge);
        var names = document.createElement('span');
        names.className = 'team-names';
        var m1 = slotName(pairs[t][0]);
        var m2 = slotName(pairs[t][1]);
        var s1 = document.createElement('span');
        s1.textContent = m1.name;
        if (m1.ai) s1.className = 'ai-name';
        var s2 = document.createElement('span');
        s2.textContent = m2.name;
        if (m2.ai) s2.className = 'ai-name';
        names.appendChild(s1);
        names.appendChild(document.createTextNode(' & '));
        names.appendChild(s2);
        row.appendChild(names);
        rows.appendChild(row);
      });

      $('btn-swap-teams').style.display = isHost ? 'inline-block' : 'none';
    }

    function renderLobby(data) {
      $('lobby-title').textContent = (data.label || 'TABLE').toUpperCase() + ' · WAITING ROOM';
      var rk = $('lobby-ranked');
      if (myIdentity) {
        rk.textContent = identityNote(myIdentity);
        rk.className = 'lobby-ranked ' + (myIdentity.ranked ? 'yes' : 'no');
        rk.style.display = 'block';
      } else {
        rk.style.display = 'none';
      }
      var wrap = $('lobby-players');
      wrap.innerHTML = '';

      for (var seat = 0; seat < data.mode; seat++) {
        (function (seat) {
          var p = data.players.find(function (pl) { return pl.seat === seat; });
          var row = document.createElement('div');
          row.className = 'lp-row' + (p ? '' : ' empty');
          var seatEl = document.createElement('span');
          seatEl.className = 'lp-seat';
          seatEl.textContent = 'SEAT ' + (seat + 1);
          row.appendChild(seatEl);
          var nameEl = document.createElement('span');
          nameEl.textContent = p ? p.name : 'Waiting… (AI will fill)';
          row.appendChild(nameEl);
          if (p && seat === data.hostSeat) {
            var tag = document.createElement('span');
            tag.className = 'lp-tag';
            tag.textContent = 'HOST';
            row.appendChild(tag);
          }
          wrap.appendChild(row);
        })(seat);
      }

      // Players joined beyond the selected mode won't be seated in the game
      data.players.forEach(function (p) {
        if (p.seat < data.mode) return;
        var row = document.createElement('div');
        row.className = 'lp-row empty';
        var seatEl = document.createElement('span');
        seatEl.className = 'lp-seat';
        seatEl.textContent = '·';
        row.appendChild(seatEl);
        var nameEl = document.createElement('span');
        nameEl.textContent = p.name + ' (not in this mode)';
        row.appendChild(nameEl);
        wrap.appendChild(row);
      });

      renderLobbyTeams(data);

      if (isHost) {
        $('lobby-mode-section').style.display = 'block';
        $('lobby-wait-msg').style.display = 'none';

        document.querySelectorAll('.mbtn').forEach(function (b) {
          b.classList.toggle('on', Number(b.dataset.mode) === data.mode);
        });

        var humans = data.players.filter(function (p) { return p.seat < data.mode; }).length;
        var btn = $('btn-start');
        btn.disabled = humans < 1;
        btn.textContent = 'START GAME';
        $('start-hint').textContent = humans >= data.mode
          ? 'All seats filled, ready to go!'
          : humans + '/' + data.mode + ' humans, empty seats will be AI players';
      } else {
        $('lobby-mode-section').style.display = 'none';
        $('lobby-wait-msg').style.display = 'block';
      }

      // This table's own invite: anyone seated can share it with a friend.
      var ipHint = $('lobby-ip-hint');
      if (data.joinURL) {
        ipHint.style.display = 'block';
        ipHint.innerHTML = '';

        var scanLbl = document.createElement('div');
        scanLbl.className = 'scan-lbl';
        scanLbl.textContent = 'SCAN TO JOIN';
        ipHint.appendChild(scanLbl);

        if (data.joinQR) {
          var img = document.createElement('img');
          img.id = 'lobby-qr';
          img.alt = 'QR code to join the game';
          img.src = data.joinQR;
          ipHint.appendChild(img);
        }

        var or = document.createElement('div');
        or.textContent = data.joinLan ? 'or open this on the same Wi-Fi:' : 'or share this link:';
        ipHint.appendChild(or);

        var ip = document.createElement('span');
        ip.className = 'ip';
        ip.textContent = data.joinURL;
        ipHint.appendChild(ip);

        if (data.joinAltURL) {
          var alt = document.createElement('div');
          alt.className = 'alt';
          alt.appendChild(document.createTextNode('Some phones can also use '));
          var altB = document.createElement('b');
          altB.textContent = data.joinAltURL;
          alt.appendChild(altB);
          ipHint.appendChild(alt);
        }

        // One-tap invite: copy the join link to share it any way (chat, etc.).
        var joinURL = data.joinURL;
        var invite = document.createElement('button');
        invite.id = 'btn-invite';
        invite.type = 'button';
        invite.textContent = 'COPY INVITE LINK';
        invite.addEventListener('click', function () {
          var done = function () {
            invite.textContent = 'LINK COPIED';
            invite.classList.add('copied');
            setTimeout(function () { invite.textContent = 'COPY INVITE LINK'; invite.classList.remove('copied'); }, 1800);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(joinURL).then(done, function () { done(); });
          } else {
            done();
          }
        });
        ipHint.appendChild(invite);
      } else {
        ipHint.style.display = 'none';
      }
    }

    // ---------- Socket events ----------

    // A fresh page per game used to reset every render cache. Tables keep the
    // page alive across games, so the caches reset when a game goes away.
    function resetGameView() {
      teardownStage();
      stageKey = '';
      prevTrick = [];
      prevTricksPlayed = 0;
      prevRoundNum = 0;
      prevMyHandLen = -1;
      prevTokCounts = [-1, -1];
      prevTrumpVal = null;
      prevKapTeam = -1;
      prevOver = false;
      prevRedeal = false;
      resultsChosen = false;
      myState = null;
      $('overlay').style.display = 'none';
      $('vote-banner').style.display = 'none';
      $('reconnect-banner').style.display = 'none';
    }

    function clearSession() {
      try { sessionStorage.removeItem('omi-token'); } catch (e) {}
      sessionToken = null;
      socket.auth = { v: PROTOCOL };
    }

    // Leave whatever table view is showing and go to the tables screen.
    function enterTables() {
      if (currentScreen === 'game' || currentScreen === 'lobby') resetGameView();
      atTable = false;
      myIdentity = null;
      window.OmiChat.reset();
      showScreen('tables');
      $('tables-name').textContent = myName;
      $('tables-error').textContent = '';
      renderTables(lastTables);
      socket.emit('browse');
      if (wantedTable) {
        var id = wantedTable;
        wantedTable = 0;
        joinTable(id);
      }
    }

    function joinTable(id) {
      $('tables-error').textContent = '';
      socket.emit('join-table', { tableId: id, name: myName, claim: loadClaims()[nameKey(myName)] });
    }

    var TABLE_STATUS = { empty: 'OPEN', open: 'OPEN', full: 'FULL', playing: 'IN PLAY', finished: 'FINISHING' };
    var MODE_NAMES = { 2: '2 players · Duel', 3: '3 players · Free-for-All', 4: '4 players · Teams' };

    function renderTables(list) {
      var wrap = $('tables-list');
      wrap.innerHTML = '';
      (list || []).forEach(function (t) {
        var card = document.createElement('div');
        card.className = 'tbl-card st-' + t.status;
        card.setAttribute('role', 'listitem');

        var head = document.createElement('div');
        head.className = 'tbl-head';
        var name = document.createElement('span');
        name.className = 'tbl-name';
        name.textContent = t.label;
        var badge = document.createElement('span');
        badge.className = 'tbl-badge';
        badge.textContent = TABLE_STATUS[t.status] || t.status;
        head.appendChild(name);
        head.appendChild(badge);
        card.appendChild(head);

        var meta = document.createElement('div');
        meta.className = 'tbl-meta';
        meta.textContent = t.humans + '/' + t.seats + ' seated · ' + (MODE_NAMES[t.mode] || '');
        card.appendChild(meta);

        var who = document.createElement('div');
        who.className = 'tbl-names';
        who.textContent = t.names && t.names.length ? t.names.join(', ') : 'Nobody here yet';
        card.appendChild(who);

        if (t.status === 'playing' || t.status === 'finished') {
          var sc = document.createElement('div');
          sc.className = 'tbl-score';
          var score = t.score || [];
          sc.textContent = 'Round ' + t.round + ' · ' +
            (t.mode === 4 ? 'Team A ' + score[0] + ' : ' + score[1] + ' Team B' : score.join(' · '));
          card.appendChild(sc);
        }

        var btn = document.createElement('button');
        btn.className = 'tbl-join';
        btn.textContent = t.canJoin ? 'JOIN' : (t.status === 'full' ? 'FULL' : 'LOCKED');
        btn.disabled = !t.canJoin;
        btn.setAttribute('aria-label', t.canJoin ? 'Join ' + t.label : t.label + ' is ' + badge.textContent.toLowerCase());
        btn.addEventListener('click', function () { joinTable(t.id); });
        card.appendChild(btn);

        wrap.appendChild(card);
      });
    }

    socket.on('server-error', function (data) {
      if (currentScreen === 'join') {
        $('join-error').textContent = data.message;
      } else if (currentScreen === 'tables') {
        $('tables-error').textContent = data.message;
      } else {
        showToast(data.message, 3000);
      }
    });

    socket.on('version-mismatch', function () {
      // One reload fetches the current client; never loop on it.
      var flag = null;
      try { flag = sessionStorage.getItem('omi-reloaded'); } catch (e) {}
      if (flag) return;
      try { sessionStorage.setItem('omi-reloaded', '1'); } catch (e) {}
      window.location.reload();
    });

    // Whether this name's 4-player games count, and (once) a new claim to keep.
    socket.on('identity', function (data) {
      if (!data) return;
      if (data.claim && data.key) saveClaim(data.key, data.claim);
      myIdentity = data;
      if (!data.ranked) showToast(identityNote(data), 4500);
    });

    var IDENTITY_REASONS = {
      generic: 'Generic names like "Player" are not ranked. Use your own name to get on the leaderboard.',
      claimed: 'This name is ranked on another device, so your games here will not count for it.',
      unavailable: 'The leaderboard is unavailable right now, so this game will not be ranked.',
    };
    function identityNote(id) {
      return id.ranked ? 'Your 4-player games at this table count toward your rating.'
        : (IDENTITY_REASONS[id.reason] || 'Your games here are not ranked.');
    }

    socket.on('tables', function (list) {
      lastTables = list || [];
      if (currentScreen === 'tables') renderTables(lastTables);
    });

    socket.on('join-error', function (data) {
      if (currentScreen === 'tables') $('tables-error').textContent = data.message;
      else showToast(data.message, 3000);
    });

    socket.on('table-joined', function (data) {
      atTable = true;
      if (data && data.name) myName = data.name; // the name as the server cleaned it
      try { sessionStorage.removeItem('omi-reloaded'); } catch (e) {}
    });

    // The server released our seat (we left, the lobby closed, or we were
    // removed for being idle). Back to the tables screen.
    socket.on('table-left', function (data) {
      clearSession();
      $('dc-overlay').style.display = 'none';
      enterTables();
      if (data && data.notice) showToast(data.notice, 5000);
    });

    socket.on('lobby-update', function (data) {
      isHost = !!data.isHost;
      atTable = true;
      // A lobby-update while a game is on screen means that game ended.
      if (currentScreen === 'game') resetGameView();
      showScreen('lobby');
      $('overlay').style.display = 'none';
      renderLobby(data);
    });

    socket.on('state-update', function (state) {
      atTable = true;
      myState = state;
      mySeat = state.mySeat;
      showScreen('game');
      if (!state.roundJustEnded) $('overlay').style.display = 'none';
      checkMoments(state);
      renderAll(state);
      renderReconnectBanner(state);
      if (state.roundJustEnded) showRoundOverlay(state);
      if (state.lastEvent) showToast(state.lastEvent);
    });

    // Show a banner while another player is briefly disconnected (their seat
    // is held open during the reconnect grace window).
    function renderReconnectBanner(state) {
      var banner = $('reconnect-banner');
      var dropped = (state.disconnectedSeats || []).filter(function (d) { return d.seat !== state.mySeat; });
      if (!dropped.length) { banner.style.display = 'none'; return; }
      var names = dropped.map(function (d) { return d.name; }).join(', ');
      banner.textContent = 'Waiting for ' + names + ' to reconnect…';
      banner.style.display = 'block';
    }

    socket.on('action-error', function (data) {
      showToast(data.message, 2500);
    });

    socket.on('table-notice', function (data) {
      if (data && data.message) showToast(data.message, 5000);
    });

    socket.on('shuffle-move', function (d) {
      if (washRelay && d && typeof d.x === 'number' && typeof d.y === 'number') {
        washRelay(d.x, d.y);
      }
    });

    socket.on('shuffle-riffle', function () {
      if (riffleRelay) riffleRelay();
    });

    socket.on('shuffle-chop', function () {
      if (chopRelay) chopRelay();
    });

    // Someone left mid-game for good: the match ended and this table is back
    // in its lobby (the lobby-update follows right after this).
    socket.on('game-abandoned', function (data) {
      var name = (data && data.name) || 'A player';
      var why = {
        idle: name + ' was idle for too long.',
        disconnect: name + ' lost connection and did not come back.',
        left: name + ' left the table.',
      }[data && data.reason] || name + ' left.';
      var counted = data && (data.forfeitTeam === 0 || data.forfeitTeam === 1)
        ? ' It counts as a loss for Team ' + 'AB'[data.forfeitTeam] + '.' : '';
      $('dc-msg').textContent = why + ' The game has ended.' + counted;
      $('dc-overlay').style.display = 'flex';
    });

    socket.on('disconnect', function () {
      if (currentScreen === 'game') {
        showToast('Connection lost, trying to reconnect…', 6000);
      }
    });

    // The server hands us (or re-confirms) our seat token. Keep it in
    // sessionStorage and on the socket so both a refresh and an automatic
    // reconnect present it.
    socket.on('session', function (data) {
      if (!data || !data.token) return;
      sessionToken = data.token;
      socket.auth = { token: data.token, v: PROTOCOL };
      try { sessionStorage.setItem('omi-token', data.token); } catch (e) {}
    });

    // Our token no longer matches a seat (the game ended while we were away,
    // or we refreshed in a lobby): drop it and go back to the tables.
    socket.on('session-invalid', function () {
      clearSession();
      if (atTable || currentScreen === 'lobby' || currentScreen === 'game') {
        if (myName) enterTables();
        else showScreen('join');
      }
    });

    // ---------- UI wiring ----------

    $('input-name').value = myName;

    $('btn-join').addEventListener('click', function () {
      var name = $('input-name').value.trim();
      if (!name) {
        $('join-error').textContent = 'Please enter a name';
        return;
      }
      $('join-error').textContent = '';
      myName = name.slice(0, 14);
      try { localStorage.setItem('omi-name', myName); } catch (e) {}
      enterTables();
    });

    $('input-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btn-join').click();
    });

    $('btn-change-name').addEventListener('click', function () {
      showScreen('join');
      $('input-name').focus();
    });

    document.querySelectorAll('.mbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        socket.emit('set-mode', { mode: Number(b.dataset.mode) });
      });
    });

    $('btn-start').addEventListener('click', function () {
      socket.emit('host-start');
    });

    $('btn-swap-teams').addEventListener('click', function () {
      socket.emit('set-teams', { pairing: (lobbyPairing + 1) % 3 });
    });

    $('btn-leave-table').addEventListener('click', function () {
      socket.emit('leave-table');
    });

    // The lobby is already underneath; just dismiss the notice.
    $('btn-back-lobby').addEventListener('click', function () {
      $('dc-overlay').style.display = 'none';
    });

    $('btn-stay').addEventListener('click', function () {
      resultsChosen = true;
      $('btn-stay').disabled = true;
      $('ov-waiting').textContent = 'Waiting for the others…';
      socket.emit('results-choice', { choice: 'stay' });
    });

    $('btn-leave-results').addEventListener('click', function () {
      socket.emit('results-choice', { choice: 'leave' });
    });

    $('btn-vote-end').addEventListener('click', function () {
      socket.emit('vote-end', { action: 'propose' });
    });

    function goHome() {
      // Free the seat right away instead of making the table wait out the
      // reconnect window, then navigate.
      if (atTable) socket.emit('leave-table');
      setTimeout(function () {
        try { socket.disconnect(); } catch (e) {}
        window.location.href = 'https://nodenull.org/';
      }, atTable ? 150 : 0);
    }

    $('btn-home').addEventListener('click', function () {
      // Only the join and tables screens have nothing to lose; a lobby or a
      // game warrants a confirmation before leaving everyone else behind.
      if (atTable) {
        $('home-confirm-overlay').style.display = 'flex';
      } else {
        goHome();
      }
    });
    $('btn-home-leave').addEventListener('click', goHome);
    $('btn-home-stay').addEventListener('click', function () {
      $('home-confirm-overlay').style.display = 'none';
    });

    $('btn-info').addEventListener('click', function () {
      $('info-overlay').style.display = 'flex';
    });
    $('info-close').addEventListener('click', function () {
      $('info-overlay').style.display = 'none';
    });
    $('info-overlay').addEventListener('click', function (e) {
      if (e.target === $('info-overlay')) $('info-overlay').style.display = 'none';
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $('info-overlay').style.display = 'none';
        $('leaderboard-overlay').style.display = 'none';
        window.OmiChat.close();
      }
    });

    window.OmiChat.init({
      socket: socket,
      myName: function () { return myName; },
      // The seat's zone on screen, for speech bubbles (game screen only)
      zoneForSeat: function (seat) {
        if (currentScreen !== 'game' || !myState) return null;
        var off = relativeOffset(seat, myState.mySeat, myState.mode);
        return $(ZONES[myState.mode][off]);
      },
      sound: function () { Sound.pop(); },
      toast: function (msg) { showToast(msg, 2200); },
    });

    // ---------- Leaderboard (public/js/leaderboard.js) ----------

    function openLeaderboard() { window.OmiBoard.open(); }

    $('btn-leaderboard').addEventListener('click', openLeaderboard);
    $('btn-leaderboard-2').addEventListener('click', openLeaderboard);
    $('ov-leaderboard').addEventListener('click', openLeaderboard);

    // Re-lay the table when the window resizes or the device rotates
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (myState && $('screen-game').style.display !== 'none') renderAll(myState);
      }, 160);
    });

  })();
  