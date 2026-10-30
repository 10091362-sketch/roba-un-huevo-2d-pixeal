// Servidor de "Roba un Huevo 2D". Sin dependencias: node server.js  ->  http://localhost:8787
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8787, DBFILE = path.join(__dirname, 'data.json'), HTML = path.join(__dirname, 'roba_un_huevo_2d.html');
const MAX_PLAYERS = 6, CYCLE = 300, WORLD_END = 32970, ROOMS = +process.env.ROOMS || 3;
let db = { users: {} }; try { db = JSON.parse(fs.readFileSync(DBFILE, 'utf8')); } catch {}
let dirty = false;
setInterval(() => { if (dirty) { fs.writeFileSync(DBFILE + '.tmp', JSON.stringify(db)); fs.renameSync(DBFILE + '.tmp', DBFILE); dirty = false; } }, 2000).unref();
const sessions = new Map(), fails = new Map();   // token -> {user, exp}; ip:user -> {n, until}
const rooms = [...Array(ROOMS)].map((_, i) => ({ id: 's' + (i + 1), name: 'Servidor ' + (i + 1), epoch: Date.now(), players: new Map() }));
const HEX = /^#[0-9a-fA-F]{6}$/;

// ---------- Cuentas ----------
const hashPw = (pw, salt = crypto.randomBytes(16)) => salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cleanLook = l => { const o = {}; for (const k of ['skin', 'shirt', 'pants', 'shoe']) o[k] = l && HEX.test(l[k]) ? l[k] : { skin: '#facc15', shirt: '#0284c7', pants: '#16a34a', shoe: '#14532d' }[k]; o.hair = l && HEX.test(l.hair) ? l.hair : null; o.acc = Number.isInteger(l && l.acc) && l.acc >= 0 && l.acc <= 3 ? l.acc : 0; return o; };
function newSession(user) { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, { user, exp: Date.now() + 12 * 3600e3 }); return t; }
function auth(req) { const s = sessions.get(req.headers['x-token']); if (!s) return null; if (s.exp < Date.now()) { sessions.delete(req.headers['x-token']); return null; } return s.user; }
// ---------- Guardado: solo campos conocidos, tipos y tamaños validados; cada cuenta solo toca lo suyo ----------
const NUM = ['coins', 'speed', 'treadmillLevel', 'rebirths', 'baseSlotsMax', 'nightCount', 'lastSpecialNight', 'baseIncome'];
const ARR = ['inventoryEggs', 'inventoryPets', 'placedPets', 'ownedBats', 'ownedTrails'], STR = ['equippedBat', 'activeTrail', 'playerName'];
function sanitizeProgress(p) {
  if (!p || typeof p !== 'object') throw new Error('Datos inválidos');
  const o = {};
  for (const k of NUM) if (p[k] !== undefined) { if (!Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1e15) throw new Error('Valor inválido: ' + k); o[k] = p[k]; }
  for (const k of ARR) if (p[k] !== undefined) { if (!Array.isArray(p[k]) || p[k].length > 500) throw new Error('Lista inválida: ' + k); o[k] = p[k]; }
  for (const k of STR) if (p[k] !== undefined) { if (typeof p[k] !== 'string' || p[k].length > 40) throw new Error('Texto inválido: ' + k); o[k] = p[k]; }
  if (typeof p.muted === 'boolean') o.muted = p.muted;
  return o;
}
// ---------- HTTP ----------
function body(req) { return new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 300000) { rej(new Error('Demasiado grande')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(new Error('JSON inválido')); } }); }); }
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
const roomInfo = r => ({ id: r.id, name: r.name, players: r.players.size, max: MAX_PLAYERS, full: r.players.size >= MAX_PLAYERS });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return res.end(fs.readFileSync(HTML)); }
    if (req.method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
      const b = await body(req), user = String(b.user || ''), pass = String(b.pass || ''), key = req.socket.remoteAddress + ':' + user.toLowerCase();
      const f = fails.get(key); if (f && f.until > Date.now()) return send(res, 429, { error: 'Demasiados intentos. Espera un minuto.' });
      if (url.pathname === '/api/register') {
        if (!/^[A-Za-z0-9_]{3,16}$/.test(user)) return send(res, 400, { error: 'Usuario: 3 a 16 letras, números o _' });
        if (pass.length < 8 || pass.length > 64) return send(res, 400, { error: 'La contraseña debe tener entre 8 y 64 caracteres' });
        if (db.users[user.toLowerCase()]) return send(res, 409, { error: 'Ese nombre de usuario ya existe' });
        db.users[user.toLowerCase()] = { name: user, pw: hashPw(pass), look: cleanLook(b.look), progress: {}, created: Date.now() }; dirty = true;
        return send(res, 200, { token: newSession(user.toLowerCase()), user, look: db.users[user.toLowerCase()].look, progress: {} });
      }
      const u = db.users[user.toLowerCase()];
      if (!u || !checkPw(pass, u.pw)) { const n = (f ? f.n : 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 60000 : 0 }); return send(res, 401, { error: 'Usuario o contraseña incorrectos' }); }
      fails.delete(key); return send(res, 200, { token: newSession(user.toLowerCase()), user: u.name, look: u.look, progress: u.progress });
    }
    const who = auth(req);
    if (url.pathname === '/api/servers' && req.method === 'GET') return send(res, 200, { rooms: rooms.map(roomInfo) });
    if (!who) return send(res, 401, { error: 'Sesión no válida' });
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(req.headers['x-token']); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/save' && req.method === 'POST') { const b = await body(req); const u = db.users[who]; u.progress = sanitizeProgress(b.progress); if (b.look) u.look = cleanLook(b.look); dirty = true; for (const r of rooms) for (const p of r.players.values()) if (p.user === who) { p.look = u.look; } return send(res, 200, { ok: true, look: u.look }); }
    send(res, 404, { error: 'No encontrado' });
  } catch (e) { send(res, 400, { error: e.message || 'Error' }); }
});
// ---------- WebSocket mínimo (RFC 6455, solo texto) ----------
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key']; if (!key) { socket.destroy(); return null; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const c = { socket, buf: Buffer.alloc(0), onmsg: null, onclose: null,
    send(o) { const d = Buffer.from(JSON.stringify(o)); const h = d.length < 126 ? Buffer.from([0x81, d.length]) : Buffer.from([0x81, 126, d.length >> 8, d.length & 255]); if (!socket.destroyed) socket.write(Buffer.concat([h, d])); },
    close() { socket.end(); } };
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]); if (c.buf.length > 65536) return socket.destroy();
    for (;;) {
      const b = c.buf; if (b.length < 2) return;
      const op = b[0] & 15; let len = b[1] & 127, off = 2;
      if (!(b[1] & 128) || len === 127) return socket.destroy();
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), pl = Buffer.from(b.subarray(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
      c.buf = b.subarray(off + 4 + len);
      if (op === 8) return socket.end();
      if (op === 9) socket.write(Buffer.concat([Buffer.from([0x8A, pl.length]), pl]));
      else if (op === 1 && c.onmsg) { try { c.onmsg(JSON.parse(pl.toString())); } catch {} }
    }
  });
  socket.on('close', () => c.onclose && c.onclose()); socket.on('error', () => {});
  return c;
}
const pub = p => ({ s: p.slot, n: p.name, look: p.look, x: p.x, y: p.y, vx: p.vx, f: p.f, st: p.st });
const bcast = (room, o, except) => { for (const p of room.players.values()) if (p !== except) p.c.send(o); };
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x'), s = sessions.get(url.searchParams.get('token')), room = rooms.find(r => r.id === url.searchParams.get('room'));
  const c = wsAccept(req, socket); if (!c) return;
  const refuse = (t, msg) => { c.send({ t, msg }); c.close(); };
  if (!s || s.exp < Date.now()) return refuse('error', 'Sesión no válida');
  if (!room) return refuse('error', 'Servidor no encontrado');
  for (const r of rooms) for (const q of r.players.values()) if (q.user === s.user) return refuse('error', 'Esta cuenta ya está conectada');
  if (room.players.size >= MAX_PLAYERS) return refuse('full', 'Servidor lleno (6/6). Prueba otro servidor.');
  let slot = 0; while (room.players.has(slot)) slot++;                       // base libre más baja (0 a 5): nunca una ocupada
  const u = db.users[s.user], p = { c, user: s.user, slot, name: u.progress.playerName || u.name, look: u.look, x: 150, y: 400, vx: 0, f: 1, st: 'idle', last: 0, n: 0 };
  room.players.set(slot, p);
  c.send({ t: 'welcome', slot, room: roomInfo(room), players: [...room.players.values()].map(pub), remaining: CYCLE - ((Date.now() - room.epoch) / 1000) % CYCLE });
  bcast(room, { t: 'join', p: pub(p) }, p);
  c.onmsg = m => {
    if (m.t === 'pos') {
      const now = Date.now(); if (now - p.last < 25) return; p.last = now;
      if (![m.x, m.y, m.vx].every(Number.isFinite)) return;
      p.x = Math.max(0, Math.min(WORLD_END, m.x)); p.y = Math.max(-300, Math.min(460, m.y)); p.vx = Math.max(-60, Math.min(60, m.vx)); p.f = m.f === -1 ? -1 : 1;
      p.st = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit'].includes(m.st) ? m.st : 'idle';
    } else if (m.t === 'look') { p.look = cleanLook(m.look); db.users[p.user].look = p.look; dirty = true; bcast(room, { t: 'look', s: p.slot, look: p.look }); }
  };
  c.onclose = () => { if (room.players.get(slot) === p) { room.players.delete(slot); bcast(room, { t: 'leave', s: slot }); } };   // libera la base; el progreso queda guardado en la cuenta
});
setInterval(() => { for (const r of rooms) if (r.players.size) { const rem = CYCLE - ((Date.now() - r.epoch) / 1000) % CYCLE; bcast(r, { t: 'snap', p: [...r.players.values()].map(p => ({ s: p.slot, x: p.x, y: p.y, vx: p.vx, f: p.f, st: p.st })), remaining: rem }); } }, 50).unref();
if (require.main === module) server.listen(PORT, () => console.log('Roba un Huevo 2D en http://localhost:' + PORT + '  (cuentas en data.json)'));
module.exports = { server, rooms, db };
