(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io();

  let playerId = localStorage.getItem('ox-player-id');
  if (!playerId) {
    playerId = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ox-player-id', playerId);
  }

  let joined = false;
  let editingNick = false;
  let myNick = localStorage.getItem('ox-nick') || '';
  let questionSec = 10;

  function show(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  }

  $('nick').value = myNick;

  function join() {
    const nick = $('nick').value.trim();
    if (!nick) return ($('login-err').textContent = '닉네임을 입력해주세요.');
    $('btn-join').disabled = true;
    socket.emit('player:join', { playerId, nick }, (res) => {
      $('btn-join').disabled = false;
      if (!res?.ok) return ($('login-err').textContent = res?.error || '입장에 실패했습니다.');
      joined = true;
      editingNick = false;
      myNick = nick;
      localStorage.setItem('ox-nick', nick);
      $('login-err').textContent = '';
    });
  }

  function setLoginMode(editing) {
    editingNick = editing;
    $('btn-join').textContent = editing ? '변경하기' : '입장하기';
    $('btn-cancel').hidden = !editing;
    $('login-sub').textContent = editing
      ? '새 닉네임을 입력하세요. 퀴즈가 시작되면 바꿀 수 없어요.'
      : '닉네임을 정하고 입장하세요!';
    $('login-err').textContent = '';
    if (editing) {
      show('v-login');
      $('nick').value = myNick;
      $('nick').focus();
      $('nick').select();
    }
  }

  $('btn-join').addEventListener('click', join);
  $('nick').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });

  $('btn-rename').addEventListener('click', () => setLoginMode(true));
  $('btn-cancel').addEventListener('click', () => {
    setLoginMode(false);
    show('v-lobby');
  });

  let myAnswer = null;
  document.querySelectorAll('.ox').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (myAnswer) return;
      myAnswer = btn.dataset.a;
      paintAnswer();
      if (navigator.vibrate) navigator.vibrate(35);
      socket.emit('player:answer', { ans: myAnswer });
    });
  });

  function paintAnswer() {
    document.querySelectorAll('.ox').forEach((b) => {
      b.classList.toggle('picked', myAnswer === b.dataset.a);
      b.classList.toggle('dim', !!myAnswer && myAnswer !== b.dataset.a);
    });
  }

  let lastQIndex = -1;

  socket.on('state', (s) => {
    $('login-title').textContent = s.title;

    if (!joined) {
      show('v-login');
      return;
    }

    if (editingNick && s.state !== 'LOBBY') setLoginMode(false);
    if (editingNick) return;

    const score = s.me?.score ?? 0;

    switch (s.state) {
      case 'LOBBY':
        myAnswer = null;
        lastQIndex = -1;
        $('lobby-nick').textContent = s.me?.nick || myNick;
        $('lobby-count').textContent = `참가자 ${s.playerCount}명`;
        show('v-lobby');
        break;

      case 'INTRO':
        $('intro-msg').textContent = s.messages.intro;
        show('v-intro');
        break;

      case 'COUNTDOWN':
        $('count-num').textContent = s.remaining ?? '';
        show('v-count');
        break;

      case 'QUESTION': {
        if (s.qIndex !== lastQIndex) {
          lastQIndex = s.qIndex;
          myAnswer = null;
          questionSec = Math.max(s.remaining ?? 10, 1);
        }

        if (s.myAnswer) myAnswer = s.myAnswer;
        paintAnswer();

        $('q-no').textContent = `Q${s.qIndex + 1} / ${s.qTotal}`;
        $('q-score').textContent = `${fmt(score)}점`;
        $('q-text').textContent = s.questionText || '';
        $('q-sec').textContent = `${s.remaining ?? 0}초`;

        const pct = Math.max(0, ((s.remaining ?? 0) / questionSec) * 100);
        $('q-bar').style.width = pct + '%';
        $('q-bar').classList.toggle('warn', (s.remaining ?? 0) <= 5);
        show('v-question');
        break;
      }

      case 'REVEAL': {
        const ans = s.correctAnswer;
        $('r-mark').textContent = ans;
        $('r-mark').className = 'result-mark ' + (ans === 'O' ? 'o' : 'x');
        const my = s.myAnswer;
        const ok = my === ans;
        $('r-verdict').textContent = !my ? '시간 초과 😴' : ok ? '정답입니다! 🎉' : '아쉬워요 😢';
        $('r-verdict').className = 'verdict ' + (ok ? 'good' : 'bad');
        $('r-gain').innerHTML = ok
          ? `+${fmt(s.me.lastGain)}점 <span class="bonus">⚡ 스피드 +${s.me.lastBonus}</span>`
          : '';
        $('r-score').textContent = `${fmt(score)}점`;
        show('v-reveal');
        break;
      }

      case 'FINISHED':
        $('finish-msg').textContent = s.messages.finish;
        $('f-score').textContent = `내 점수 ${fmt(score)}점`;
        show('v-finished');
        break;

      case 'RANKING':
        renderRanking(s);
        show('v-ranking');
        break;

      case 'PRIZE':
        renderPrize(s);
        show('v-prize');
        break;
    }
  });

  function renderRanking(s) {
    const list = s.ranking || [];
    const me = list.find((p) => p.id === s.me?.id);
    $('rk-me').textContent = me ? `내 등수 ${me.position}등` : '-';
    $('rk-list').innerHTML = list
      .map(
        (p) => `<div class="rank-item${p.id === s.me?.id ? ' me' : ''}">
          <span class="rank-no${p.rank ? '' : ' plain'}">${p.position}등</span>
          <span class="rank-nick">${esc(p.nick)}</span>
          <span class="rank-score">${fmt(p.score)}점</span>
        </div>`
      )
      .join('');
  }

  function renderPrize(s) {
    const pz = s.prize;
    if (!pz) return;
    const em = $('pz-emoji');
    em.textContent = pz.emoji || '';
    em.hidden = !pz.emoji;
    $('pz-rank').textContent = pz.label || `${pz.rank}등`;
    $('pz-name').textContent = pz.name;
    $('pz-desc').textContent = pz.desc || '';

    const ws = pz.winners || [];
    const many = ws.length > 3;
    $('pz-winners').innerHTML = ws.length
      ? ws
          .map(
            (w) =>
              `<div class="winner-name${many ? ' small' : ''}">${esc(w.nick)}${
                w.id === s.me?.id ? ' (나!)' : ''
              }</div>`
          )
          .join('')
      : '<div class="winner-name small">해당자 없음</div>';
  }

  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

  const esc = (str) =>
    String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  socket.on('kicked', () => {
    joined = false;
    myNick = '';
    localStorage.removeItem('ox-nick');
    setLoginMode(false);
    show('v-login');
    $('login-err').textContent = '운영자가 참가자 목록에서 내보냈습니다.';
  });

  socket.on('connect', () => {
    if (joined || myNick) {
      socket.emit('player:join', { playerId, nick: myNick }, (res) => {
        if (res?.ok) joined = true;
      });
    }
  });
})();
