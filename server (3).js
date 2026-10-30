// Servidor de "Roba un Huevo 2D". Sin dependencias: node server.js  ->  http://localhost:8787
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8787, DATA_DIR = process.env.DATA_DIR || __dirname, DBFILE = path.join(DATA_DIR, 'data.json'), HTML = path.join(__dirname, 'roba_un_huevo_2d.html');
const MAX_PLAYERS = 6, CYCLE = 300, WORLD_END = 32970, ROOMS = +process.env.ROOMS || 10;
const ADMIN_CODE = process.env.ADMIN_CODE || '', SIZES = ['mini', 'normal', 'grande', 'gigante'];   // el código de admin SOLO vive en esta variable de entorno
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
let db = { users: {} }; try { db = JSON.parse(fs.readFileSync(DBFILE, 'utf8')); } catch {}
let dirty = false;
function flush() { if (dirty) { fs.writeFileSync(DBFILE + '.tmp', JSON.stringify(db)); fs.renameSync(DBFILE + '.tmp', DBFILE); dirty = false; } }
setInterval(flush, 2000).unref();
for (const sg of ['SIGTERM', 'SIGINT']) process.on(sg, () => { flush(); process.exit(0); });   // al apagar/redesplegar no se pierde nada
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
// ---------- Chat: filtro de insultos (lista básica, ampliable) ----------
const BAD = ['puta', 'puto', 'mierda', 'pendejo', 'pendeja', 'cabron', 'coño', 'joder', 'gilipollas', 'imbecil', 'idiota', 'estupido', 'estupida', 'marica', 'maricon', 'verga', 'culero', 'culera', 'chingar', 'chingada', 'chinga', 'hijueputa', 'hijoeputa', 'malparido', 'zorra', 'perra', 'mamon', 'carajo', 'cagar', 'culo', 'tarado', 'retrasado', 'nazi', 'hdp', 'ptm', 'fuck', 'shit', 'bitch', 'asshole', 'dick', 'cunt', 'nigger', 'faggot', 'bastard', 'slut', 'whore'];
const CL = { a: '[a4@áà]', e: '[e3éè]', i: '[i1!íì|]', o: '[o0óò]', u: '[uúü]', s: '[s5$]', c: '[cç]', n: '[nñ]', 'ñ': '[ñn]' };
const BADRE = BAD.map(w => { const short = w.length <= 5; return new RegExp((short ? '(?<![\\p{L}\\p{N}])' : '') + [...w].map(ch => (CL[ch] || ch) + '+').join('[\\W_]*') + (short ? '(?:e?s)?(?![\\p{L}\\p{N}])' : ''), 'giu'); });
function cleanChat(tx) { tx = tx.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); for (const re of BADRE) tx = tx.replace(re, '##############'); return tx; }
const dedupe = a => { const seen = new Set(); return a.filter(x => { const id = x && typeof x === 'object' ? x.id : undefined; if (id === undefined) return true; if (seen.has(id)) return false; seen.add(id); return true; }); };   // ids repetidos = objetos duplicados: se descartan
function sanitizeProgress(p) {
  if (!p || typeof p !== 'object') throw new Error('Datos inválidos');
  const o = {};
  for (const k of NUM) if (p[k] !== undefined) { if (!Number.isFinite(p[k]) || p[k] < 0 || p[k] > 1e15) throw new Error('Valor inválido: ' + k); o[k] = p[k]; }
  for (const k of ARR) if (p[k] !== undefined) { if (!Array.isArray(p[k]) || p[k].length > 500) throw new Error('Lista inválida: ' + k); o[k] = dedupe(p[k]); }
  for (const k of STR) if (p[k] !== undefined) { if (typeof p[k] !== 'string' || p[k].length > 40) throw new Error('Texto inválido: ' + k); o[k] = p[k]; }
  if (typeof p.muted === 'boolean') o.muted = p.muted;
  return o;
}
// ---------- HTTP ----------
function body(req) { return new Promise((res, rej) => { let d = ''; req.on('data', c => { d += c; if (d.length > 300000) { rej(new Error('Demasiado grande')); req.destroy(); } }); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch { rej(new Error('JSON inválido')); } }); }); }
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
// ---------- Eventos globales con duración (una sola fuente de verdad para TODAS las salas) ----------
const DEFAULT_EVENTS = { lluvia: { on: false }, velocidad: { on: false, mult: 2 }, invasion: { on: false }, oro: { on: false }, terremoto: { on: false }, niebla: { on: false }, meteoros: { on: false }, eclipse: { on: false } };
const MAX_EVENT_MS = 8 * 3600e3;   // tope de seguridad: 8 horas
if (!db.events || typeof db.events !== 'object') db.events = {};
const events = {};
for (const k of Object.keys(DEFAULT_EVENTS)) { const saved = (db.events[k] && typeof db.events[k] === 'object') ? db.events[k] : {}; events[k] = { ...DEFAULT_EVENTS[k], ...saved, on: !!saved.on }; }
db.events = events;   // misma referencia: al guardar db a disco, el estado de los eventos queda incluido automáticamente
const eventTimers = {};
const bcastAll = o => rooms.forEach(r => bcast(r, o));
function turnOffEvent(name) {   // apaga un evento (manual o automático) y restaura todo: los efectos se calculan en vivo a partir de "on", así que apagar YA revierte velocidad/gravedad/mapa/etc.
  const ev = events[name]; if (!ev) return;
  ev.on = false; ev.endsAt = null;
  if (eventTimers[name]) { clearTimeout(eventTimers[name]); delete eventTimers[name]; }
  dirty = true;
}
function turnOnEvent(name, durationMs, mult) {
  const ev = events[name]; if (!ev) return;
  if (eventTimers[name]) { clearTimeout(eventTimers[name]); delete eventTimers[name]; }
  ev.on = true;
  ev.endsAt = (Number.isFinite(durationMs) && durationMs > 0) ? Date.now() + durationMs : null;
  if (name === 'velocidad' && Number.isFinite(mult)) ev.mult = Math.max(1, Math.min(5, mult));
  if (ev.endsAt) {
    eventTimers[name] = setTimeout(() => {
      turnOffEvent(name);
      bcastAll({ t: 'events', events });
      console.log('[eventos] "' + name + '" terminó automáticamente (duración cumplida)');
    }, durationMs);
  }
  dirty = true;
}
// Al arrancar: recupera eventos que seguían activos y aún no vencían; si ya vencieron mientras el server estaba apagado, los apaga.
for (const k of Object.keys(events)) {
  const ev = events[k];
  if (!ev.on) continue;
  const remain = ev.endsAt ? ev.endsAt - Date.now() : -1;
  if (remain > 0) { eventTimers[k] = setTimeout(() => { turnOffEvent(k); bcastAll({ t: 'events', events }); }, remain); console.log('[eventos] recuperado "' + k + '" con', Math.round(remain / 1000), 's restantes'); }
  else { ev.on = false; ev.endsAt = null; dirty = true; }
}
// ---------- Anuncio global con duración y nombre de administrador (uno activo a la vez; evita duplicados) ----------
let announcement = null, announceTimer = null;
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
const roomInfo = r => ({ id: r.id, name: r.name, players: r.players.size, max: MAX_PLAYERS, full: r.players.size >= MAX_PLAYERS });
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');   // permite que el HTML esté en otro hosting (usa token, no cookies)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
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
        return send(res, 200, { token: newSession(user.toLowerCase()), user, look: db.users[user.toLowerCase()].look, progress: {}, admin: false });
      }
      const u = db.users[user.toLowerCase()];
      if (!u || !checkPw(pass, u.pw)) { const n = (f ? f.n : 0) + 1; fails.set(key, { n, until: n >= 5 ? Date.now() + 60000 : 0 }); return send(res, 401, { error: 'Usuario o contraseña incorrectos' }); }
      fails.delete(key); return send(res, 200, { token: newSession(user.toLowerCase()), user: u.name, look: u.look, progress: u.progress, admin: !!u.admin });
    }
    // ---------- Asignación de UN SOLO administrador: hay que estar logueado, escribir el código, y elegir de una lista de cuentas ----------
    // El código nunca sale del servidor: se compara aquí mismo, nunca se manda al navegador ni queda en ningún mensaje de red.
    if (req.method === 'POST' && (url.pathname === '/api/admin/verify-code' || url.pathname === '/api/admin/assign')) {
      const tokUser = auth(req); if (!tokUser) return send(res, 401, { error: 'Inicia sesión primero' });
      if (!ADMIN_CODE) return send(res, 503, { error: 'Panel de administrador deshabilitado: falta la variable ADMIN_CODE en el servidor.' });
      const b = await body(req), key = 'adm:' + req.socket.remoteAddress + ':' + tokUser, ipk = 'adm:' + req.socket.remoteAddress;
      for (const k of [key, ipk]) { const f = fails.get(k); if (f && f.until > Date.now()) return send(res, 429, { error: 'Demasiados intentos. Espera 10 minutos.' }); }
      const okCode = sameSecret(String(b.code || ''), ADMIN_CODE);
      if (url.pathname === '/api/admin/verify-code') {
        if (!okCode) {
          for (const [k, lim] of [[key, 5], [ipk, 15]]) { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= lim) { f.until = Date.now() + 600000; f.n = 0; } fails.set(k, f); }
          return send(res, 403, { error: 'Código incorrecto' });
        }
        fails.delete(key);
        const accounts = Object.keys(db.users).map(k => ({ user: k, name: db.users[k].name, admin: !!db.users[k].admin })).sort((a, b2) => a.name.localeCompare(b2.name));
        console.log('[admin] código verificado por', tokUser); return send(res, 200, { ok: true, accounts });
      }
      // act === 'assign': vuelve a exigir el código (nunca confiar en que "ya se verificó" del lado del navegador) + cuenta destino válida
      const target = String(b.target || '').toLowerCase();
      if (!(okCode && db.users[target])) {
        for (const [k, lim] of [[key, 5], [ipk, 15]]) { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; if (f.n >= lim) { f.until = Date.now() + 600000; f.n = 0; } fails.set(k, f); }
        return send(res, 403, { error: 'Código incorrecto o cuenta no encontrada' });
      }
      for (const u of Object.keys(db.users)) db.users[u].admin = (u === target);   // un solo admin a la vez: a cualquier otro se le retira el puesto automáticamente
      dirty = true;
      console.log('[admin]', tokUser, 'asignó el puesto de administrador a', target);
      for (const r of rooms) for (const p of r.players.values()) p.c.send({ t: 'admin_status', admin: !!db.users[p.user].admin });   // si alguien conectado ganó o perdió el puesto, su sesión se entera al instante, sin recargar
      return send(res, 200, { ok: true, target });
    }
    const who = auth(req);
    if (url.pathname === '/api/servers' && req.method === 'GET') return send(res, 200, { rooms: rooms.map(roomInfo), features: ['rooms', 'admin', 'chat'], version: 3 });
    if (!who) return send(res, 401, { error: 'Sesión no válida' });
    if (url.pathname === '/api/logout' && req.method === 'POST') { sessions.delete(req.headers['x-token']); return send(res, 200, { ok: true }); }
    if (url.pathname === '/api/save' && req.method === 'POST') { const b = await body(req); const u = db.users[who]; u.progress = sanitizeProgress(b.progress); if (b.look) u.look = cleanLook(b.look); dirty = true; for (const r of rooms) for (const p of r.players.values()) if (p.user === who) { p.look = u.look; } return send(res, 200, { ok: true, look: u.look }); }
    if (url.pathname.startsWith('/api/admin/')) {   // TODO el panel se valida aquí, en el servidor. No existe ninguna función de baneo.
      if (!db.users[who].admin) return send(res, 403, { error: 'Solo administradores' });
      const act = url.pathname.slice(11);
      if (act === 'overview' && req.method === 'GET') return send(res, 200, { rooms: rooms.map(r => ({ ...roomInfo(r), names: [...r.players.values()].map(p => p.name) })), players: rooms.flatMap(r => [...r.players.values()].map(p => ({ room: r.id, user: p.user, name: p.name }))), events });
      if (req.method !== 'POST') return send(res, 405, { error: 'Método no permitido' });
      const b = await body(req);
      if (act === 'announce') {
        const tx = String(b.text || '').trim().slice(0, 200);
        if (!tx) return send(res, 400, { error: 'Mensaje vacío' });
        let durationMs = 8000;
        if (b.durationMs !== undefined && b.durationMs !== null) {
          const d = Number(b.durationMs);
          if (!Number.isFinite(d) || d <= 0 || d > 3600e3) return send(res, 400, { error: 'Duración de anuncio inválida (máx 1 hora)' });
          durationMs = Math.round(d);
        }
        if (announceTimer) clearTimeout(announceTimer);
        const id = crypto.randomBytes(6).toString('hex'), adminName = db.users[who].name;   // el nombre SIEMPRE sale de la cuenta verificada por el servidor, nunca de lo que mande el navegador
        announcement = { id, text: tx, admin: adminName, endsAt: Date.now() + durationMs };
        announceTimer = setTimeout(() => { announcement = null; bcastAll({ t: 'announce_clear', id }); }, durationMs);
        console.log('[admin]', who, 'anuncio global (' + Math.round(durationMs / 1000) + 's):', tx);
        bcastAll({ t: 'announce', id, text: tx, admin: adminName, endsAt: announcement.endsAt });
        return send(res, 200, { ok: true, id });
      }
      if (act === 'event') {
        if (!events[b.name] || typeof b.on !== 'boolean') return send(res, 400, { error: 'Evento inválido' });
        if (b.on) {
          let durationMs = null;
          if (b.durationMs !== undefined && b.durationMs !== null) {
            const d = Number(b.durationMs);
            if (!Number.isFinite(d) || d <= 0 || d > MAX_EVENT_MS) return send(res, 400, { error: 'Duración inválida (máx 8 horas)' });
            durationMs = Math.round(d);
          }
          turnOnEvent(b.name, durationMs, Number(b.mult));
        } else {
          turnOffEvent(b.name);
        }
        console.log('[admin]', who, b.on ? 'inició' : 'detuvo', b.name, (b.on && events[b.name].endsAt) ? ('hasta ' + new Date(events[b.name].endsAt).toISOString()) : '');
        bcastAll({ t: 'events', events });
        return send(res, 200, { events });
      }
      if (act === 'gift') {
        let g; const a = Number(b.amount);
        if (b.kind === 'coins' || b.kind === 'speed') { if (!Number.isFinite(a) || a < 1 || a > 1e9) return send(res, 400, { error: 'Cantidad inválida' }); g = { t: 'gift', kind: b.kind, amount: Math.floor(a) }; }
        else if (b.kind === 'eggs') { const c = Math.floor(Number(b.count)); if (!/^[a-z]{3,12}$/.test(String(b.rarity)) || !SIZES.includes(b.size) || !(c >= 1 && c <= 50)) return send(res, 400, { error: 'Huevo inválido (rareza, tamaño o cantidad)' }); g = { t: 'gift', kind: 'eggs', rarity: b.rarity, size: b.size, count: c }; }
        else return send(res, 400, { error: 'Tipo de objeto no soportado' });
        const target = String(b.target || 'all').toLowerCase(); let n = 0;
        for (const r of rooms) for (const p of r.players.values()) if (target === 'all' || p.user === target) { p.c.send(g); n++; }
        if (!n) return send(res, 404, { error: 'Ese jugador no está conectado a ningún servidor' });
        console.log('[admin]', who, 'entregó', JSON.stringify(g), 'a', target, '(' + n + ')'); return send(res, 200, { delivered: n });
      }
    }
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
  c.send({ t: 'welcome', slot, room: roomInfo(room), players: [...room.players.values()].map(pub), remaining: CYCLE - ((Date.now() - room.epoch) / 1000) % CYCLE, events, announce: (announcement && announcement.endsAt > Date.now()) ? announcement : null });
  bcast(room, { t: 'join', p: pub(p) }, p);
  c.onmsg = m => {
    if (m.t === 'pos') {
      const now = Date.now(); if (now - p.last < 25) return; p.last = now;
      if (![m.x, m.y, m.vx].every(Number.isFinite)) return;
      p.x = Math.max(0, Math.min(WORLD_END, m.x)); p.y = Math.max(-300, Math.min(460, m.y)); p.vx = Math.max(-60, Math.min(60, m.vx)); p.f = m.f === -1 ? -1 : 1;
      p.st = ['idle', 'walk', 'run', 'jump', 'fall', 'land', 'hit'].includes(m.st) ? m.st : 'idle';
    } else if (m.t === 'look') { p.look = cleanLook(m.look); db.users[p.user].look = p.look; dirty = true; bcast(room, { t: 'look', s: p.slot, look: p.look }); }
    else if (m.t === 'chat') {   // el chat solo llega a quienes están en ESTA sala; todo se valida aquí
      if (typeof m.text !== 'string') return;
      const now = Date.now(); p.chatTimes = (p.chatTimes || []).filter(x => now - x < 20000);
      if (now - (p.lastChat || 0) < 1200 || p.chatTimes.length >= 8) return p.c.send({ t: 'chat_err', msg: 'Vas muy rápido. Espera un momento.' });
      const text = cleanChat(m.text); if (!text) return;
      p.lastChat = now; p.chatTimes.push(now); bcast(room, { t: 'chat', s: p.slot, n: p.name, text });
    }
  };
  c.onclose = () => { if (room.players.get(slot) === p) { room.players.delete(slot); bcast(room, { t: 'leave', s: slot }); } };   // libera la base; el progreso queda guardado en la cuenta
});
setInterval(() => { for (const r of rooms) if (r.players.size) { const rem = CYCLE - ((Date.now() - r.epoch) / 1000) % CYCLE; bcast(r, { t: 'snap', p: [...r.players.values()].map(p => ({ s: p.slot, x: p.x, y: p.y, vx: p.vx, f: p.f, st: p.st })), remaining: rem }); } }, 50).unref();
if (require.main === module) server.listen(PORT, () => console.log('Roba un Huevo 2D en http://localhost:' + PORT + '  (cuentas en data.json)'));
module.exports = { server, rooms, db };
