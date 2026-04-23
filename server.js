const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Game State ──────────────────────────────────────────────────────────────
const rooms = {}; // roomCode → RoomState
const clients = {}; // ws → { roomCode, playerId, isGM }

const ROLES_DEF = {
  vampir:    { name: 'Vampir',    icon: '🧛', team: 'kötü',  action: 'kill',        chatAccess: 'vampir' },
  doktor:    { name: 'Doktor',    icon: '💉', team: 'iyi',   action: 'protect' },
  dedektif:  { name: 'Dedektif',  icon: '🔍', team: 'iyi',   action: 'investigate' },
  avci:      { name: 'Avcı',      icon: '🏹', team: 'iyi',   action: 'avci_target' },
  cadi:      { name: 'Cadı',      icon: '🧙', team: 'iyi',   action: 'witch' },
  joker:     { name: 'Joker',     icon: '🃏', team: 'nötr',  action: 'none' },
  kahin:     { name: 'Kahin',     icon: '👁️', team: 'iyi',   action: 'vision' },
  koruyucu:  { name: 'Koruyucu',  icon: '🛡️', team: 'iyi',   action: 'protect' },
  koylü:     { name: 'Köylü',     icon: '👨‍🌾', team: 'iyi',   action: 'pray' },
};

function makeRoom(gmWs) {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  rooms[code] = {
    code,
    gmWs,
    phase: 'lobby',       // lobby | night | morning | day | defense | vote2 | result | ended
    nightNum: 1,
    players: [],          // { id, name, role, alive, connected, lastWords, roleHidden }
    settings: { vampir: 2, doktor: true, dedektif: true, avci: false, cadi: false, joker: false, kahin: false, koruyucu: false },
    durations: { night: 45, day: 180, defense: 15, vote2: 10 },
    actions: {},          // { kill, protect, investigate, witch, vision, avci_target }
    nightActions: [],     // log entries
    votes: {},            // playerId → targetName
    votes2: {},           // playerId → 'guilty'|'innocent'
    suspect: null,
    vampirChat: [],
    timer: null,
    timerSecs: 0,
  };
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildRolePool(room) {
  const s = room.settings;
  const pool = [];
  for (let i = 0; i < s.vampir; i++) pool.push('vampir');
  ['doktor', 'dedektif', 'avci', 'cadi', 'joker', 'kahin', 'koruyucu'].forEach(r => {
    if (s[r]) pool.push(r);
  });
  while (pool.length < room.players.length) pool.push('koylü');
  return shuffle(pool).slice(0, room.players.length);
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastRoom(roomCode, msg, excludeWs = null) {
  Object.entries(clients).forEach(([, info]) => {
    if (info.roomCode === roomCode && info.ws !== excludeWs) send(info.ws, msg);
  });
  const room = rooms[roomCode];
  if (room?.gmWs && room.gmWs !== excludeWs) send(room.gmWs, msg);
}

function broadcastAll(roomCode, msg) {
  broadcastRoom(roomCode, msg);
}

// Send full game state snapshot to one client
function sendState(ws, room, playerId) {
  const isGM = room.gmWs === ws;
  const player = room.players.find(p => p.id === playerId);

  // Public player list (role hidden unless GM or self)
  const publicPlayers = room.players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    connected: p.connected,
    roleHidden: p.roleHidden,
    role: (isGM || p.id === playerId) ? p.role : (p.alive ? '?' : (p.roleHidden ? '?' : p.role)),
    lastWords: p.lastWords,
  }));

  const isVampir = player?.role === 'vampir';

  send(ws, {
    type: 'state',
    phase: room.phase,
    nightNum: room.nightNum,
    players: publicPlayers,
    myRole: player?.role || null,
    myId: playerId,
    isGM,
    suspect: room.suspect,
    votes: isGM ? room.votes : (room.votes[playerId] ? { [playerId]: room.votes[playerId] } : {}),
    votes2: isGM ? room.votes2 : (room.votes2[playerId] ? { [playerId]: room.votes2[playerId] } : {}),
    nightActions: isGM ? room.nightActions : [],
    vampirChat: (isGM || isVampir) ? room.vampirChat : [],
    timerSecs: room.timerSecs,
    settings: isGM ? room.settings : null,
    durations: room.durations,
    actions: isGM ? room.actions : null,
  });
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  Object.entries(clients).forEach(([, info]) => {
    if (info.roomCode === roomCode) sendState(info.ws, room, info.playerId);
  });
  if (room.gmWs) sendState(room.gmWs, room, 'GM');
}

// ── Timer ────────────────────────────────────────────────────────────────────
function startTimer(room, secs, onEnd) {
  clearInterval(room.timer);
  room.timerSecs = secs;
  broadcastAll(room.code, { type: 'timer', secs });
  room.timer = setInterval(() => {
    room.timerSecs--;
    broadcastAll(room.code, { type: 'timer', secs: room.timerSecs });
    if (room.timerSecs <= 0) {
      clearInterval(room.timer);
      onEnd();
    }
  }, 1000);
}

function stopTimer(room) {
  clearInterval(room.timer);
}

// ── Phase transitions ────────────────────────────────────────────────────────
function setPhase(room, phase) {
  room.phase = phase;
  broadcastAll(room.code, { type: 'phase', phase, nightNum: room.nightNum });

  if (phase === 'night') {
    room.actions = {};
    room.nightActions = [];
    room.votes = {};
    room.votes2 = {};
    room.suspect = null;
    startTimer(room, room.durations.night, () => setPhase(room, 'morning'));
    broadcastState(room.code);
  }

  else if (phase === 'morning') {
    const { kill, protect } = room.actions;
    let msg = '';
    let died = null;

    if (kill && kill === protect) {
      msg = `🌅 Bu gece kimse ölmedi! Doktor kurtardı.`;
    } else if (kill) {
      const p = room.players.find(p => p.name === kill);
      if (p && p.alive) {
        p.alive = false;
        died = p;
        msg = `🌅 Bu gece ${kill} öldürüldü!`;
        // Avcı: eğer ölen avcıysa, hedefi de öldür
        if (p.role === 'avci' && room.actions.avci_target) {
          const target = room.players.find(t => t.name === room.actions.avci_target && t.alive);
          if (target) { target.alive = false; msg += ` Avcı ${target.name}'ı da götürdü!`; }
        }
      }
    } else {
      msg = `🌅 Bu gece kimse ölmedi!`;
    }

    // Dedektif sonucu sadece dedektife özel gönder
    if (room.actions.investigate) {
      const target = room.players.find(p => p.name === room.actions.investigate);
      const detective = room.players.find(p => p.role === 'dedektif' && p.alive);
      if (detective) {
        const detClient = Object.values(clients).find(c => c.roomCode === room.code && c.playerId === detective.id);
        if (detClient) send(detClient.ws, {
          type: 'notification',
          msg: `🔍 Sorgu sonucu: ${room.actions.investigate} — ${target?.role === 'vampir' ? '🧛 VAMPİR!' : '✅ Masum'}`,
          duration: 8000
        });
      }
    }

    broadcastAll(room.code, { type: 'notification', msg, duration: 4000 });

    // Son sözler göster
    if (died?.lastWords) {
      broadcastAll(room.code, {
        type: 'last_words',
        player: died.name,
        role: died.roleHidden ? null : died.role,
        words: died.lastWords
      });
    }

    checkWinCondition(room);
    broadcastState(room.code);
    setTimeout(() => setPhase(room, 'day'), 4000);
  }

  else if (phase === 'day') {
    room.votes = {};
    startTimer(room, room.durations.day, () => {
      findSuspect(room);
      if (room.suspect) setPhase(room, 'defense');
      else {
        broadcastAll(room.code, { type: 'notification', msg: 'Oylamada eşitlik — tartışma devam ediyor.', duration: 3000 });
        setPhase(room, 'day');
      }
    });
    broadcastState(room.code);
  }

  else if (phase === 'defense') {
    broadcastAll(room.code, {
      type: 'notification',
      msg: `🛡️ ${room.suspect} son savunmasını yapıyor...`,
      duration: room.durations.defense * 1000
    });
    startTimer(room, room.durations.defense, () => setPhase(room, 'vote2'));
    broadcastState(room.code);
  }

  else if (phase === 'vote2') {
    room.votes2 = {};
    startTimer(room, room.durations.vote2, () => resolveVote2(room));
    broadcastState(room.code);
  }
}

function findSuspect(room) {
  const counts = {};
  Object.values(room.votes).forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  if (!Object.keys(counts).length) { room.suspect = null; return; }
  const max = Math.max(...Object.values(counts));
  const top = Object.keys(counts).filter(k => counts[k] === max);
  room.suspect = top[Math.floor(Math.random() * top.length)];
}

function resolveVote2(room) {
  const vals = Object.values(room.votes2);
  const guilty = vals.filter(v => v === 'guilty').length;
  const innocent = vals.filter(v => v === 'innocent').length;

  if (guilty > innocent) {
    const p = room.players.find(p => p.name === room.suspect);
    if (p) { p.alive = false; }
    broadcastAll(room.code, {
      type: 'notification',
      msg: `⚖️ ${room.suspect} köy meydanında asıldı! ${p && !p.roleHidden ? ('Rolü: ' + ROLES_DEF[p.role]?.name) : ''}`,
      duration: 5000
    });
    if (p?.lastWords) {
      broadcastAll(room.code, {
        type: 'last_words',
        player: p.name,
        role: p.roleHidden ? null : p.role,
        words: p.lastWords
      });
    }
    // Joker kazanma kontrolü
    if (p?.role === 'joker') {
      broadcastAll(room.code, { type: 'game_over', winner: 'joker', msg: '🃏 Joker linç edildi ve kazandı!' });
      room.phase = 'ended'; return;
    }
    checkWinCondition(room);
    broadcastState(room.code);
  } else {
    broadcastAll(room.code, {
      type: 'notification',
      msg: `Eşit oy! ${room.suspect} asılmadı. Tartışma yeniden başlıyor.`,
      duration: 3000
    });
    broadcastState(room.code);
    setTimeout(() => setPhase(room, 'day'), 3000);
  }
}

function checkWinCondition(room) {
  const alive = room.players.filter(p => p.alive);
  const vampirs = alive.filter(p => p.role === 'vampir').length;
  const good = alive.filter(p => p.role !== 'vampir' && p.role !== 'joker').length;

  if (vampirs === 0) {
    broadcastAll(room.code, { type: 'game_over', winner: 'village', msg: '☀️ Köy kazandı! Tüm vampirler yok edildi.' });
    room.phase = 'ended';
  } else if (vampirs >= good) {
    broadcastAll(room.code, { type: 'game_over', winner: 'vampir', msg: '🧛 Vampirler kazandı! Köyü ele geçirdiler.' });
    room.phase = 'ended';
  }
}

// ── WebSocket message handler ────────────────────────────────────────────────
wss.on('connection', ws => {
  clients[ws] = { ws, roomCode: null, playerId: null, isGM: false };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = clients[ws];
    const room = info.roomCode ? rooms[info.roomCode] : null;

    switch (msg.type) {

      case 'gm_create': {
        const code = makeRoom(ws);
        info.roomCode = code;
        info.isGM = true;
        info.playerId = 'GM';
        rooms[code].gmWs = ws;
        send(ws, { type: 'room_created', code });
        break;
      }

      case 'gm_settings': {
        if (!room || !info.isGM) return;
        room.settings = { ...room.settings, ...msg.settings };
        room.durations = { ...room.durations, ...msg.durations };
        break;
      }

      case 'gm_start': {
        if (!room || !info.isGM) return;
        if (room.players.length < 4) { send(ws, { type: 'error', msg: 'En az 4 oyuncu gerekli!' }); return; }
        if (msg.settings) room.settings = { ...room.settings, ...msg.settings };
        if (msg.durations) room.durations = { ...room.durations, ...msg.durations };
        const pool = buildRolePool(room);
        room.players.forEach((p, i) => { p.role = pool[i]; p.alive = true; });
        setPhase(room, 'night');
        broadcastState(room.code);
        break;
      }

      case 'gm_next_phase': {
        if (!room || !info.isGM) return;
        stopTimer(room);
        const next = {
          lobby: 'night', night: 'morning', morning: 'day',
          day: 'defense', defense: 'vote2', vote2: 'result'
        };
        const forcePhase = msg.phase || next[room.phase];
        if (forcePhase === 'defense') { findSuspect(room); }
        if (forcePhase === 'vote2_resolve') { resolveVote2(room); return; }
        if (forcePhase) setPhase(room, forcePhase);
        break;
      }

      case 'gm_kill': {
        if (!room || !info.isGM) return;
        const p = room.players.find(p => p.name === msg.name);
        if (p) { p.alive = false; broadcastState(room.code); }
        break;
      }

      case 'gm_toggle_role_hidden': {
        if (!room || !info.isGM) return;
        const p = room.players.find(p => p.name === msg.name);
        if (p) { p.roleHidden = !p.roleHidden; broadcastState(room.code); }
        break;
      }

      case 'player_join': {
        if (!msg.roomCode || !msg.name) return;
        const r = rooms[msg.roomCode.toUpperCase()];
        if (!r) { send(ws, { type: 'error', msg: 'Oda bulunamadı: ' + msg.roomCode }); return; }
        if (r.phase !== 'lobby') { send(ws, { type: 'error', msg: 'Oyun zaten başladı!' }); return; }

        const existing = r.players.find(p => p.name === msg.name);
        if (existing) {
          existing.connected = true;
          info.roomCode = r.code;
          info.playerId = existing.id;
        } else {
          const player = { id: uuidv4(), name: msg.name, role: null, alive: true, connected: true, lastWords: '', roleHidden: false };
          r.players.push(player);
          info.roomCode = r.code;
          info.playerId = player.id;
        }

        send(ws, { type: 'joined', roomCode: r.code, playerId: info.playerId });
        sendState(ws, r, info.playerId);
        broadcastAll(r.code, { type: 'notification', msg: `${msg.name} odaya katıldı.`, duration: 2000 });
        if (r.gmWs) sendState(r.gmWs, r, 'GM');
        break;
      }

      case 'player_reconnect': {
        if (!msg.roomCode || !msg.playerId) return;
        const r = rooms[msg.roomCode];
        if (!r) { send(ws, { type: 'error', msg: 'Oda bulunamadı.' }); return; }
        const p = r.players.find(p => p.id === msg.playerId);
        if (p) {
          p.connected = true;
          info.roomCode = r.code;
          info.playerId = p.id;
          sendState(ws, r, p.id);
        }
        break;
      }

      case 'action': {
        if (!room || !info.playerId) return;
        const player = room.players.find(p => p.id === info.playerId);
        if (!player || !player.alive) return;
        // kaydet
        room.actions[msg.actionType] = msg.target;
        room.nightActions = room.nightActions.filter(a => a.playerId !== info.playerId);
        room.nightActions.push({ playerId: info.playerId, name: player.name, role: player.role, actionType: msg.actionType, target: msg.target });
        send(ws, { type: 'action_ack', actionType: msg.actionType, target: msg.target });
        if (room.gmWs) sendState(room.gmWs, room, 'GM');
        break;
      }

      case 'vote': {
        if (!room || !info.playerId) return;
        const voter = room.players.find(p => p.id === info.playerId);
        if (!voter || !voter.alive) return;
        if (room.phase === 'day') {
          room.votes[info.playerId] = msg.target;
          broadcastAll(room.code, { type: 'vote_update', votes: room.votes });
          if (room.gmWs) sendState(room.gmWs, room, 'GM');
        }
        break;
      }

      case 'vote2': {
        if (!room || !info.playerId) return;
        const voter = room.players.find(p => p.id === info.playerId);
        if (!voter || !voter.alive) return;
        if (room.phase === 'vote2') {
          room.votes2[info.playerId] = msg.verdict; // 'guilty' | 'innocent'
          send(ws, { type: 'vote2_ack', verdict: msg.verdict });
          if (room.gmWs) sendState(room.gmWs, room, 'GM');
        }
        break;
      }

      case 'last_words': {
        if (!room || !info.playerId) return;
        const p = room.players.find(p => p.id === info.playerId);
        if (p) { p.lastWords = msg.text; }
        break;
      }

      case 'vampir_chat': {
        if (!room || !info.playerId) return;
        const sender = room.players.find(p => p.id === info.playerId);
        if (!sender || sender.role !== 'vampir') return;
        const entry = { sender: sender.name, text: msg.text, time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) };
        room.vampirChat.push(entry);
        // Sadece vampirlere ve GM'e gönder
        Object.entries(clients).forEach(([, c]) => {
          if (c.roomCode !== room.code) return;
          const p = room.players.find(p => p.id === c.playerId);
          if (p?.role === 'vampir') send(c.ws, { type: 'vampir_chat_msg', entry });
        });
        send(room.gmWs, { type: 'vampir_chat_msg', entry });
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = clients[ws];
    if (info?.roomCode) {
      const room = rooms[info.roomCode];
      if (room) {
        const p = room.players.find(p => p.id === info.playerId);
        if (p) p.connected = false;
        if (room.gmWs === ws) { room.gmWs = null; }
        if (room.gmWs) sendState(room.gmWs, room, 'GM');
      }
    }
    delete clients[ws];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🧛 Gece Köyü sunucusu ayakta → http://localhost:${PORT}`));
