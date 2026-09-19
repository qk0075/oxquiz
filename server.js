'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || 'admin';
const CONFIG_PATH = path.join(__dirname, 'quiz-config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const QUESTIONS = config.questions;

const TIMING = {
  introSec: Number(process.env.INTRO_SEC) || config.timing.introSec,
  countdownSec: Number(process.env.COUNTDOWN_SEC) || config.timing.countdownSec,
  questionSec: Number(process.env.QUESTION_SEC) || config.timing.questionSec,
  revealSec: Number(process.env.REVEAL_SEC) || config.timing.revealSec,
};

const SCORING = config.scoring ?? { correctPoints: 1000, speedBonusMax: 50 };

if (SCORING.speedBonusMax * QUESTIONS.length >= SCORING.correctPoints) {
  const safeMax = Math.floor((SCORING.correctPoints - 1) / QUESTIONS.length);
  console.warn(
    `[경고] speedBonusMax(${SCORING.speedBonusMax})가 너무 큽니다. ` +
      `속도만으로 정답 수가 뒤집힐 수 있습니다. ${safeMax} 이하를 권장합니다.`
  );
}

const restAt = config.prizes.findIndex((p) => p.winners === 'rest');
if (restAt !== -1 && restAt !== config.prizes.length - 1) {
  console.warn(
    `[경고] ${config.prizes[restAt].rank}등이 "rest"인데 마지막이 아닙니다. ` +
      `그 뒤 등수(${config.prizes.slice(restAt + 1).map((p) => p.rank + '등').join(', ')})는 당첨자가 없습니다.`
  );
}

function speedBonus(ms) {
  const limitMs = TIMING.questionSec * 1000;
  const ratio = Math.max(0, Math.min(1, 1 - ms / limitMs));
  return Math.round(SCORING.speedBonusMax * ratio);
}

const S = {
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  COUNTDOWN: 'COUNTDOWN',
  QUESTION: 'QUESTION',
  REVEAL: 'REVEAL',
  FINISHED: 'FINISHED',
  RANKING: 'RANKING',
  PRIZE: 'PRIZE',
};

const game = {
  state: S.LOBBY,
  qIndex: -1,
  endsAt: 0,
  qStartedAt: 0,
  prizeRank: 0,
  players: new Map(),
  ranking: [],
};

function makePlayer(id, nick) {
  return {
    id,
    nick,
    score: 0,
    correct: 0,
    totalMs: 0,
    answers: [],
    connected: true,
    joinedAt: Date.now(),
  };
}

function resetScores() {
  for (const p of game.players.values()) {
    p.score = 0;
    p.correct = 0;
    p.totalMs = 0;
    p.answers = [];
  }
  game.ranking = [];
}

function assignRanks(list) {
  let i = 0;
  for (const pz of config.prizes) {
    const count = pz.winners === 'rest' ? list.length - i : pz.winners ?? 0;
    for (let k = 0; k < count && i < list.length; k++, i++) list[i].rank = pz.rank;
  }
  for (; i < list.length; i++) list[i].rank = 0;
}

function computeRanking() {
  const list = [...game.players.values()]
    .map((p) => ({
      id: p.id,
      nick: p.nick,
      score: p.score,
      correct: p.correct,
      totalMs: p.totalMs,
      joinedAt: p.joinedAt,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.correct - a.correct ||
        a.totalMs - b.totalMs ||
        a.joinedAt - b.joinedAt
    );

  assignRanks(list);
  list.forEach((p, i) => { p.position = i + 1; });

  game.ranking = list;
  return list;
}

function winnersOf(rank) {
  return game.ranking.filter((p) => p.rank === rank);
}

function remainingSec() {
  if (!game.endsAt) return null;
  return Math.max(0, Math.ceil((game.endsAt - Date.now()) / 1000));
}

function answerCounts() {
  let O = 0;
  let X = 0;
  for (const p of game.players.values()) {
    const a = p.answers[game.qIndex];
    if (a?.ans === 'O') O += 1;
    else if (a?.ans === 'X') X += 1;
  }
  return { O, X, none: game.players.size - O - X };
}

function publicState() {
  const q = QUESTIONS[game.qIndex];
  return {
    title: config.title,
    state: game.state,
    messages: config.messages,
    qIndex: game.qIndex,
    qTotal: QUESTIONS.length,
    questionText: game.state === S.QUESTION || game.state === S.REVEAL ? q?.text ?? null : null,
    correctAnswer: game.state === S.REVEAL ? q?.answer ?? null : null,
    remaining: remainingSec(),
    playerCount: game.players.size,
    prizeRank: game.prizeRank,
  };
}

function hostState() {
  const base = publicState();
  return {
    ...base,
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      nick: p.nick,
      score: p.score,
      correct: p.correct,
      connected: p.connected,
    })),
    counts: game.state === S.QUESTION || game.state === S.REVEAL ? answerCounts() : null,
    ranking: game.ranking,
    prize: game.prizeRank
      ? { ...config.prizes.find((x) => x.rank === game.prizeRank), winners: winnersOf(game.prizeRank) }
      : null,
    prizeTotal: config.prizes.length,
  };
}

function playerViewFor(p) {
  const base = publicState();
  const myAnswer = p ? p.answers[game.qIndex]?.ans ?? null : null;
  const me = p
    ? {
        id: p.id,
        nick: p.nick,
        score: p.score,
        correct: p.correct,
        lastCorrect: p.answers[game.qIndex]?.correct ?? null,
        lastGain: p.answers[game.qIndex]?.gain ?? 0,
        lastBonus: p.answers[game.qIndex]?.bonus ?? 0,
      }
    : null;
  return {
    ...base,
    me,
    myAnswer,
    ranking: game.state === S.RANKING || game.state === S.PRIZE ? game.ranking : null,
    prize: game.prizeRank
      ? { ...config.prizes.find((x) => x.rank === game.prizeRank), winners: winnersOf(game.prizeRank) }
      : null,
  };
}

function broadcast() {
  for (const [sid, sock] of io.of('/').sockets) {
    if (sock.data.role === 'host') sock.emit('state', hostState());
    else sock.emit('state', playerViewFor(game.players.get(sock.data.playerId)));
    void sid;
  }
}

function setPhase(state, durationSec) {
  game.state = state;
  game.endsAt = durationSec ? Date.now() + durationSec * 1000 : 0;
  if (state === S.QUESTION) game.qStartedAt = Date.now();
  broadcast();
}

function startQuiz() {
  resetScores();
  game.qIndex = -1;
  game.prizeRank = 0;
  setPhase(S.INTRO, TIMING.introSec);
}

function nextQuestion() {
  game.qIndex += 1;
  if (game.qIndex >= QUESTIONS.length) {
    game.qIndex = QUESTIONS.length - 1;
    computeRanking();
    setPhase(S.FINISHED, 0);
    return;
  }
  setPhase(S.QUESTION, TIMING.questionSec);
}

function resetToLobby() {
  resetScores();
  game.state = S.LOBBY;
  game.qIndex = -1;
  game.endsAt = 0;
  game.prizeRank = 0;
  broadcast();
}

setInterval(() => {
  if (game.endsAt && Date.now() >= game.endsAt) {
    switch (game.state) {
      case S.INTRO:
        setPhase(S.COUNTDOWN, TIMING.countdownSec);
        break;
      case S.COUNTDOWN:
        nextQuestion();
        break;
      case S.QUESTION:
        setPhase(S.REVEAL, TIMING.revealSec);
        break;
      case S.REVEAL:
        nextQuestion();
        break;
      default:
        game.endsAt = 0;
    }
    return;
  }

  if (game.endsAt) broadcast();
}, 500);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', true);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

app.get('/api/join-qr', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/`;
  try {
    res.json({ url, dataUrl: await QRCode.toDataURL(url, { margin: 1, width: 320 }) });
  } catch {
    res.json({ url, dataUrl: null });
  }
});

io.on('connection', (socket) => {
  socket.data.role = 'guest';

  socket.on('player:join', ({ playerId, nick } = {}, ack) => {
    const name = String(nick ?? '').trim().slice(0, 12);
    if (!name) return ack?.({ ok: false, error: '닉네임을 입력해주세요.' });

    const taken = [...game.players.values()].some((p) => p.nick === name && p.id !== playerId);
    if (taken) return ack?.({ ok: false, error: '이미 사용 중인 닉네임입니다.' });

    let player = game.players.get(playerId);

    if (game.state !== S.LOBBY && !player) {
      return ack?.({ ok: false, error: '퀴즈가 이미 진행 중입니다. 잠시 후 다시 시도해주세요.' });
    }

    if (player && player.nick !== name && game.state !== S.LOBBY) {
      return ack?.({ ok: false, error: '퀴즈 진행 중에는 닉네임을 변경할 수 없습니다.' });
    }

    if (player) {
      player.nick = name;
      player.connected = true;
    } else {
      player = makePlayer(playerId, name);
      game.players.set(playerId, player);
    }

    socket.data.role = 'player';
    socket.data.playerId = playerId;
    ack?.({ ok: true });
    broadcast();
  });

  socket.on('player:answer', ({ ans } = {}) => {
    if (game.state !== S.QUESTION) return;
    if (ans !== 'O' && ans !== 'X') return;

    const player = game.players.get(socket.data.playerId);
    if (!player || player.answers[game.qIndex]) return;

    const ms = Date.now() - game.qStartedAt;
    const correct = QUESTIONS[game.qIndex].answer === ans;
    const bonus = correct ? speedBonus(ms) : 0;
    const gain = correct ? SCORING.correctPoints + bonus : 0;
    player.answers[game.qIndex] = { ans, ms, correct, gain, bonus };

    if (correct) {
      player.score += gain;
      player.correct += 1;
      player.totalMs += ms;
    } else {
      player.totalMs += TIMING.questionSec * 1000;
    }
    broadcast();
  });

  socket.on('host:join', ({ key } = {}, ack) => {
    if (key !== HOST_KEY) return ack?.({ ok: false, error: '운영자 키가 올바르지 않습니다.' });
    socket.data.role = 'host';
    ack?.({ ok: true });
    socket.emit('state', hostState());
  });

  socket.on('host:action', ({ action, playerId } = {}) => {
    if (socket.data.role !== 'host') return;

    switch (action) {
      case 'start':
        if (game.state === S.LOBBY) startQuiz();
        break;

      case 'finish':
        computeRanking();
        game.prizeRank = 0;
        setPhase(S.RANKING, 0);
        break;

      case 'prize':
        if (!game.ranking.length) computeRanking();
        game.prizeRank = 1;
        setPhase(S.PRIZE, 0);
        break;

      case 'next':
        if (game.state !== S.PRIZE) break;
        if (game.prizeRank >= config.prizes.length) resetToLobby();
        else {
          game.prizeRank += 1;
          broadcast();
        }
        break;

      case 'reset':
        resetToLobby();
        break;

      case 'kick':
        game.players.delete(playerId);
        broadcast();
        break;

      default:
        break;
    }
  });

  socket.on('disconnect', () => {
    const player = game.players.get(socket.data.playerId);
    if (player) {
      player.connected = false;

      if (game.state === S.LOBBY) game.players.delete(player.id);
      broadcast();
    }
  });
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanAddress();
  console.log('\n  ' + config.title + ' 서버가 시작되었습니다.\n');
  console.log(`  참가자 : http://${ip}:${PORT}/`);
  console.log(`  운영자 : http://${ip}:${PORT}/host?key=${HOST_KEY}\n`);
});
