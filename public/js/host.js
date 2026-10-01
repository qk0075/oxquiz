(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io();

  const esc = (str) =>
    String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  const show = (id) =>
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));

  const LABEL = {
    LOBBY: '입장 대기',
    INTRO: '시작 멘트',
    COUNTDOWN: '카운트다운',
    QUESTION: '문제 진행중',
    REVEAL: '정답 공개',
    FINISHED: '퀴즈 종료',
    RANKING: '등수 발표',
    PRIZE: '상품 안내',
  };

  let authed = false;
  let savedKey = new URLSearchParams(location.search).get('key') || localStorage.getItem('ox-host-key') || '';

  function auth(key) {
    socket.emit('host:join', { key }, (res) => {
      if (!res?.ok) {
        $('auth-err').textContent = res?.error || '인증에 실패했습니다.';
        return;
      }
      authed = true;
      localStorage.setItem('ox-host-key', key);
      savedKey = key;
      $('auth-err').textContent = '';
      show('v-console');
      loadQR();
    });
  }

  $('btn-auth').addEventListener('click', () => auth($('key').value.trim()));
  $('key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') auth($('key').value.trim());
  });

  socket.on('connect', () => {
    if (savedKey) auth(savedKey);
  });

  let qrHtml = '';
  let joinUrl = '';
  async function loadQR() {
    try {
      const r = await fetch('/api/join-qr').then((x) => x.json());
      joinUrl = r.url;
      qrHtml = `${r.dataUrl ? `<img class="qr" src="${r.dataUrl}" alt="참가 QR" />` : ''}
        <div class="link">${esc(r.url)}</div>
        <button class="btn ghost sm" id="btn-copy" style="margin-top:12px">🔗 참가 링크 복사</button>`;
    } catch {
      qrHtml = '<div class="link">QR을 불러오지 못했습니다. 새로고침해 주세요.</div>';
    }
    render();
  }

  async function copyJoinUrl(btn) {
    let done = false;
    try {
      await navigator.clipboard.writeText(joinUrl);
      done = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = joinUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { done = document.execCommand('copy'); } catch { done = false; }
      ta.remove();
    }
    btn.textContent = done ? '✅ 복사됐어요!' : '길게 눌러서 주소를 복사하세요';
    setTimeout(() => { btn.textContent = '🔗 참가 링크 복사'; }, 2000);
  }

  const act = (action, extra) => socket.emit('host:action', { action, ...extra });

  let lastState = null;

  function render(s) {
    if (s) lastState = s;
    if (!authed || !lastState) return;
    $('h-state').textContent = LABEL[lastState.state] || lastState.state;
    $('h-body').innerHTML = body(lastState);
    $('h-actions').innerHTML = actions(lastState);
    bind(lastState);
  }

  socket.on('state', render);

  function body(s) {
    switch (s.state) {
      case 'LOBBY':
        return `
          <div class="panel">
            <div class="panel-title">참가 링크</div>
            ${qrHtml}
          </div>
          ${playersPanel(s)}`;

      case 'INTRO':
      case 'COUNTDOWN':
        return `
          <div class="panel" style="text-align:center;padding:36px 16px">
            <div style="font-size:15px;color:var(--muted);font-weight:700">
              ${s.state === 'INTRO' ? '시작 멘트 재생 중' : '카운트다운'}
            </div>
            <div style="font-size:60px;font-weight:900;margin-top:12px">${s.remaining ?? ''}</div>
          </div>
          ${playersPanel(s)}`;

      case 'QUESTION':
      case 'REVEAL': {
        const c = s.counts || { O: 0, X: 0, none: 0 };
        const revealed = s.state === 'REVEAL';
        return `
          <div class="panel">
            <div class="panel-title">Q${s.qIndex + 1} / ${s.qTotal}${
          revealed ? ` · 정답 ${s.correctAnswer}` : ` · ${s.remaining ?? 0}초`
        }</div>
            <div style="font-size:17px;font-weight:700;line-height:1.5;word-break:keep-all">
              ${esc(s.questionText || '')}
            </div>
          </div>
          <div class="panel">
            <div class="panel-title">응답 현황</div>
            <div class="stat-row">
              <div class="stat"><div class="stat-num" style="color:var(--o)">${c.O}</div><div class="stat-lbl">O</div></div>
              <div class="stat"><div class="stat-num" style="color:var(--x)">${c.X}</div><div class="stat-lbl">X</div></div>
              <div class="stat"><div class="stat-num" style="color:var(--muted)">${c.none}</div><div class="stat-lbl">미응답</div></div>
            </div>
          </div>
          ${scorePanel(s)}`;
      }

      case 'FINISHED':
        return `
          <div class="panel" style="text-align:center;padding:32px 16px">
            <div style="font-size:52px">🏁</div>
            <div style="font-size:19px;font-weight:900;margin-top:12px">${esc(s.messages.finish)}</div>
            <div style="font-size:14px;color:var(--muted);margin-top:8px">'종료'를 누르면 등수를 발표합니다</div>
          </div>
          ${scorePanel(s)}`;

      case 'RANKING':
        return `
          <div class="panel">
            <div class="panel-title">최종 등수 (${s.ranking.length}명)</div>
            <div class="rank-list">
              ${
                s.ranking
                  .map(
                    (p) => `<div class="rank-item">
                      <span class="rank-no${p.rank ? '' : ' plain'}">${p.position}등</span>
                      <span class="rank-nick">${esc(p.nick)}</span>
                      <span class="rank-score">${p.correct}개 · ${p.score}점</span>
                    </div>`
                  )
                  .join('') || '<div class="rank-nick" style="color:var(--muted)">참가자가 없습니다</div>'
              }
            </div>
          </div>`;

      case 'PRIZE': {
        const pz = s.prize;
        if (!pz) return '';
        const ws = pz.winners || [];
        return `
          <div class="panel" style="text-align:center;padding:28px 16px">
            <div class="prize-rank">${esc(pz.label || pz.rank + '등')}</div>
            <div style="font-size:23px;font-weight:900">${esc(pz.name)}</div>
            <div style="font-size:14px;color:var(--muted);margin-top:6px">${esc(pz.desc || '')}</div>
          </div>
          <div class="panel">
            <div class="panel-title">당첨자 ${ws.length}명</div>
            <div class="chips">
              ${
                ws.map((w) => `<span class="chip">${esc(w.nick)}</span>`).join('') ||
                '<span class="chip off">해당자 없음</span>'
              }
            </div>
          </div>
          <div style="font-size:13px;color:var(--muted);text-align:center">
            ${pz.rank >= s.prizeTotal ? "'처음으로'를 누르면 새 퀴즈를 시작합니다" : `다음: ${esc(nextLabel(s))}`}
          </div>`;
      }

      default:
        return '';
    }
  }

  function playersPanel(s) {
    return `
      <div class="panel">
        <div class="panel-title">참가자 ${s.playerCount}명${
          s.players.length > s.playerCount ? ` (연결 끊김 ${s.players.length - s.playerCount}명)` : ''
        }</div>
        <div class="chips">
          ${
            s.players
              .map(
                (p) => `<span class="chip${p.connected ? '' : ' off'}">${esc(p.nick)}<button class="chip-x" data-kick="${esc(p.id)}" data-nick="${esc(p.nick)}" title="내보내기">×</button></span>`
              )
              .join('') || '<span class="chip off">아직 참가자가 없습니다</span>'
          }
        </div>
      </div>`;
  }

  function scorePanel(s) {
    const top = [...s.players].sort((a, b) => b.score - a.score).slice(0, 8);
    return `
      <div class="panel">
        <div class="panel-title">실시간 점수 TOP ${top.length}</div>
        <div class="rank-list">
          ${
            top
              .map(
                (p, i) => `<div class="rank-item">
                  <span class="rank-no">${i + 1}</span>
                  <span class="rank-nick">${esc(p.nick)}</span>
                  <span class="rank-score">${p.correct}개 · ${p.score}점</span>
                </div>`
              )
              .join('') || '<div class="rank-nick" style="color:var(--muted)">참가자가 없습니다</div>'
          }
        </div>
      </div>`;
  }

  function nextLabel(s) {
    return (s.prizeLabels || [])[s.prizeRank] || s.prizeRank + 1 + '등';
  }

  function actions(s) {
    const reset = `<button class="btn danger sm" data-act="reset">⛔ 강제 종료 (처음으로)</button>`;

    switch (s.state) {
      case 'LOBBY':
        return `<button class="btn" data-act="start" ${s.playerCount ? '' : 'disabled'}>
                  ▶ 퀴즈 시작${s.playerCount ? '' : ' (참가자 대기 중)'}
                </button>`;
      case 'FINISHED':
        return `<button class="btn" data-act="finish">🏅 종료 · 등수 발표</button>${reset}`;
      case 'RANKING':
        return `<button class="btn" data-act="prize">🎁 상품 안내</button>${reset}`;
      case 'PRIZE':
        return `<button class="btn" data-act="next">
                  ${s.prizeRank >= s.prizeTotal ? '🔄 처음으로' : `➡ 다음 (${nextLabel(s)})`}
                </button>${reset}`;
      default:
        return reset;
    }
  }

  function bind(s) {
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.act;
        if (a === 'reset' && !confirm('퀴즈를 강제 종료하고 대기실로 돌아갑니다.\n계속할까요?')) return;
        act(a);
      });
    });
    document.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nick = btn.dataset.nick || '참가자';
        if (!confirm(`${nick} 님을 내보낼까요?`)) return;
        act('kick', { playerId: btn.dataset.kick });
      });
    });
    const copy = $('btn-copy');
    if (copy) copy.addEventListener('click', () => copyJoinUrl(copy));
    void s;
  }

  if (savedKey) $('key').value = savedKey;
})();
