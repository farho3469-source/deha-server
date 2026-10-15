const express = require('express');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { MongoClient, ObjectId } = require('mongodb');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });

const ADMIN = String(process.env.ADMIN_PASSWORD || 'admin123').trim();
const MONGO_URI = String(process.env.MONGODB_URI || '')
  .replace(/[^\x21-\x7E]/g, '')
  .replace(/["'<>]/g, '');
const client = new MongoClient(MONGO_URI);
let users, chat, news, media, ads, subs, config, places, reqs, reports, dbh;
let VAPID_PUBLIC = '';
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
const HEX24 = /^[0-9a-f]{24}$/;
const SEED = {
  'Душанбе': ['Душанбе', 'Исмоили Сомонӣ', 'Сино', 'Шоҳмансур', 'Фирдавсӣ'],
  'Суғд': ['Хуҷанд', 'Бӯстон', 'Исфара', 'Истаравшан', 'Конибодом', 'Панҷакент', 'Айнӣ', 'Ашт', 'Бобоҷон Ғафуров', 'Деваштич', 'Зафаробод', 'Кӯҳистони Мастчоҳ', 'Мастчоҳ', 'Спитамен', 'Шаҳристон', 'Ҷаббор Расулов'],
  'Хатлон': ['Бохтар', 'Кӯлоб', 'Левакант', 'Норак', 'Ёвон', 'Восеъ', 'Ховалинг', 'Данғара', 'Дӯстӣ', 'Ҷайҳун', 'Ҷалолиддини Румӣ', 'Ҷомӣ', 'Кӯшониён', 'Қубодиён', 'Муъминобод', 'Носири Хусрав', 'Панҷ', 'Фархор', 'Хуросон', 'Шаҳритус', 'Шамсиддин Шоҳин', 'Темурмалик', 'Балҷувон', 'Ҳамадонӣ'],
  'Бадахшон': ['Хоруғ', 'Дарвоз', 'Ванҷ', 'Ишкошим', 'Рӯшон', 'Роштқалъа', 'Шуғнон', 'Мурғоб'],
  'НТҶ': ['Ҳисор', 'Рӯдакӣ', 'Шаҳринав', 'Турсунзода', 'Варзоб', 'Файзобод', 'Рашт', 'Лахш', 'Нуробод', 'Рогун', 'Тоҷикобод', 'Ваҳдат', 'Сангвор', 'Ҷиргатол'],
};
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function resolveVillage(b) {
  const vid = String(b.village || '');
  if (HEX24.test(vid)) return places.findOne({ _id: new ObjectId(vid), type: 'v' });
  const did = String(b.district || '');
  const name = String(b.vname || '').trim().slice(0, 40);
  if (!name || !HEX24.test(did) || !(await places.findOne({ _id: new ObjectId(did), type: 'd' }))) return null;
  const ex = await places.findOne({ type: 'v', parent: did, name: { $regex: '^' + escRe(name) + '$', $options: 'i' } });
  if (ex) return ex;
  const r = await places.insertOne({ type: 'v', name, parent: did });
  return { _id: r.insertedId, type: 'v', name, parent: did };
}
const ADMIN_PHONES = String(process.env.ADMIN_PHONES || '').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean);
const isAdmin = (m, u) => (!!u && u.admin === true) || (!!m && String(m.password || '').trim() === ADMIN);

/* ---------- нишона ва manifest (барои насби барнома) ---------- */
const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function makeIcon(n) {
  const row = n * 3 + 1;
  const raw = Buffer.alloc(row * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let c = 0x2f6b3a;
      if (v > 0.75) c = 0x27500a;
      if ((u - 0.68) ** 2 + (v - 0.3) ** 2 < 0.0081) c = 0xfac775;
      if (u >= 0.33 && u <= 0.67 && v >= 0.5 && v <= 0.75) c = 0xf5c4b3;
      if (v >= 0.3 && v < 0.5 && Math.abs(u - 0.5) <= ((v - 0.3) / 0.2) * 0.23) c = 0x993c1d;
      if (u >= 0.46 && u <= 0.54 && v >= 0.6 && v <= 0.75) c = 0x712b13;
      const o = y * row + 1 + x * 3;
      raw[o] = c >> 16;
      raw[o + 1] = (c >> 8) & 255;
      raw[o + 2] = c & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const ICONS = {};
const MANIFEST = JSON.stringify({
  name: 'Деҳа',
  short_name: 'Деҳа',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#efece3',
  theme_color: '#2f6b3a',
  lang: 'tg',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});

/* ---------- занг (WebRTC) ---------- */
const callPairs = new Map();
const pendingCalls = new Map();
const pairKey = (a, b) => [a, b].sort().join(':');
const OPEN_RELAY = [
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
let iceCache = { t: 0, v: null };
async function iceServers() {
  if (iceCache.v && Date.now() - iceCache.t < 1800000) return iceCache.v;
  let v = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  try {
    if (process.env.ICE_JSON) {
      v = v.concat(JSON.parse(process.env.ICE_JSON));
    } else if (process.env.METERED_DOMAIN && process.env.METERED_KEY) {
      const r = await fetch(
        'https://' + process.env.METERED_DOMAIN + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(process.env.METERED_KEY)
      );
      const j = await r.json();
      if (Array.isArray(j) && j.length) v = j.concat(v);
      else v = v.concat(OPEN_RELAY);
    } else {
      v = v.concat(OPEN_RELAY);
    }
  } catch (e) {
    console.error('ice', e);
  }
  iceCache = { t: Date.now(), v };
  return v;
}

/* ---------- ҷойҳо (ноҳия ва деҳа) ва ҳуқуқи дастрасӣ ---------- */
const vOf = (r) => {
  const p = String(r).split(':');
  return p[0] === 'v' ? { vid: p[1] || '', sub: p[2] || '' } : null;
};
const dmPair = (a, b) => 'dm:' + [a, b].sort().join(':');
async function canEnter(u, r) {
  r = String(r);
  const v = vOf(r);
  if (v) {
    if (!v.vid || u.village !== v.vid) return false;
    return !v.sub || v.sub === 'football' || (v.sub === 'women' && u.gender === 'f');
  }
  const p = r.split(':');
  if (p[0] === 'dm' && HEX24.test(p[1] || '') && HEX24.test(p[2] || '')) {
    const me = String(u._id);
    if (me !== p[1] && me !== p[2]) return false;
    return !!(await reqs.findOne({
      status: 'accepted',
      $or: [{ from: p[1], to: p[2] }, { from: p[2], to: p[1] }],
    }));
  }
  return false;
}
const myRooms = (u) => {
  if (!u.village) return [];
  const b = 'v:' + u.village;
  const l = [{ id: b, title: 'Деҳа' }];
  if (u.gender === 'f') l.push({ id: b + ':women', title: 'Занҳо' });
  l.push({ id: b + ':football', title: 'Футболистон' });
  return l;
};
const profOf = (u) => ({ name: u.name || '', village: u.village || '', district: u.district || '', gender: u.gender || '', avatar: u.avatar || '', admin: !!u.admin });
const placesOut = async () => {
  const all = await places.find({}).sort({ ord: 1, name: 1 }).toArray();
  return {
    districts: all.filter((x) => x.type === 'd').map((x) => ({ id: String(x._id), name: x.name, region: x.region || '' })),
    villages: all
      .filter((x) => x.type === 'v')
      .map((x) => ({ id: String(x._id), name: x.name, district: x.parent })),
  };
};
const adOut = (a, u) => ({
  id: String(a._id),
  uid: a.uid,
  name: a.name,
  phone: u && (a.uid === String(u._id) || (a.village && a.village === u.village)) ? a.phone : '',
  title: a.title,
  price: a.price,
  desc: a.desc,
  cat: a.cat,
  photo: a.photo || '',
  time: a.time,
});
const chatOut = (d) => {
  const { _id, ...rest } = d;
  return { ...rest, id: String(_id) };
};
const previewOf = (o) =>
  o.kind === 'image' ? '📷 Расм' : o.kind === 'audio' ? '🎤 Паёми овозӣ' : String(o.text || '').slice(0, 80);

app.use(express.json());
app.use(
  express.static('public', {
    setHeaders: (res, p) => {
      if (p.endsWith('.html') || p.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
    },
  })
);

const cleanPhone = (p) => String(p || '').replace(/[^\d]/g, '');
const fail = (res, code, error) => res.status(code).json({ error });

app.get('/manifest.json', (req, res) => res.type('application/manifest+json').send(MANIFEST));
app.get('/icon-:s.png', (req, res) => {
  const n = req.params.s;
  if (n !== '192' && n !== '512') return res.status(404).end();
  if (!ICONS[n]) ICONS[n] = makeIcon(Number(n));
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/png').send(ICONS[n]);
});
app.get('/api/ice', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.query.t || '') });
    if (!u) return res.status(401).end();
    res.json({ iceServers: await iceServers() });
  } catch (e) {
    res.status(500).end();
  }
});
app.get('/api/vapid', (req, res) => res.json({ key: VAPID_PUBLIC }));
app.get('/api/places', async (req, res) => {
  try {
    res.json(await placesOut());
  } catch (e) {
    res.json({ districts: [], villages: [] });
  }
});

app.post('/api/unpush', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.body.token || '') });
    if (u && typeof req.body.endpoint === 'string') {
      await subs.deleteOne({ endpoint: req.body.endpoint, uid: String(u._id) });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});

app.post('/api/pushtest', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.body.token || '') });
    if (!u) return fail(res, 401, 'auth');
    const list = await subs.find({ uid: String(u._id) }).toArray();
    res.json({ subs: list.length });
    setTimeout(() => {
      list.forEach(async (x) => {
        try {
          await webpush.sendNotification(
            { endpoint: x.endpoint, keys: x.keys },
            JSON.stringify({ title: 'Деҳа', body: 'Санҷиши огоҳинома ✔', tag: 'test' }),
            { TTL: 60, urgency: 'high' }
          );
          console.log('test push ok');
        } catch (e) {
          console.error('test push fail', e.statusCode, e.body);
        }
      });
    }, 10000);
  } catch (e) {
    console.error(e);
    fail(res, 500, 'Хатои сервер');
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 30);
    const phone = cleanPhone(req.body.phone);
    const password = String(req.body.password || '');
    const gender = req.body.gender === 'f' ? 'f' : req.body.gender === 'm' ? 'm' : '';
    if (!name || phone.length < 9 || phone.length > 15 || password.length < 6) {
      return fail(res, 400, 'Маълумот нодуруст аст');
    }
    const vil = await resolveVillage(req.body);
    if (!vil) return fail(res, 400, 'Ноҳия ва деҳаро интихоб кунед');
    if (await users.findOne({ phone })) {
      return fail(res, 409, 'Ин рақам аллакай сабт шудааст');
    }
    const token = crypto.randomBytes(24).toString('hex');
    await users.insertOne({
      name,
      phone,
      gender,
      village: String(vil._id),
      district: vil.parent,
      hash: await bcrypt.hash(password, 10),
      token,
      created: Date.now(),
    });
    io.emit('places', await placesOut());
    res.json({ token, name });
  } catch (e) {
    console.error(e);
    fail(res, 500, 'Хатои сервер');
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const phone = cleanPhone(req.body.phone);
    const u = await users.findOne({ phone });
    const ok = u && (await bcrypt.compare(String(req.body.password || ''), u.hash));
    if (!ok) return fail(res, 401, 'Рақам ё парол нодуруст аст');
    if (u.banned) return fail(res, 403, 'Ҳисоби шумо манъ шудааст');
    res.json({ token: u.token, name: u.name });
  } catch (e) {
    console.error(e);
    fail(res, 500, 'Хатои сервер');
  }
});

app.get('/media/:id', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.query.t || '') });
    if (!u) return res.status(401).end();
    if (!HEX24.test(req.params.id)) return res.status(404).end();
    const m = await media.findOne({ _id: new ObjectId(req.params.id) });
    if (!m) return res.status(404).end();
    res.set('Content-Type', m.type);
    res.set('Cache-Control', 'private, max-age=31536000');
    res.send(Buffer.from(m.data.buffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

/* ---------- огоҳиномаи push ---------- */
async function pushTo(uids, data) {
  if (!VAPID_PUBLIC || !uids.length) return;
  const list = await subs.find({ uid: { $in: uids } }).toArray();
  const payload = JSON.stringify(data);
  await Promise.all(
    list.map(async (x) => {
      try {
        await webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, payload, {
          TTL: 3600,
          urgency: 'high',
        });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await subs.deleteOne({ endpoint: x.endpoint });
      }
    })
  );
}
async function pushMsg(msg, roomId) {
  try {
    let targets = [];
    const v = vOf(roomId);
    if (v) {
      const q = { village: v.vid };
      if (v.sub === 'women') q.gender = 'f';
      targets = (await users.find(q, { projection: { _id: 1, blocked: 1 } }).toArray())
        .filter((x) => !(x.blocked || []).includes(msg.uid))
        .map((x) => String(x._id));
    } else {
      const p = roomId.split(':');
      targets = [p[1] === msg.uid ? p[2] : p[1]];
    }
    const inRoom = await io.in('r:' + roomId).fetchSockets();
    const skip = new Set(inRoom.filter((x) => x.data && x.data.vis !== false).map((x) => x.data.uid));
    skip.add(msg.uid);
    const sub = v && v.sub ? (v.sub === 'women' ? ' · Занҳо' : ' · Футболистон') : '';
    await pushTo(
      targets.filter((t) => !skip.has(t)),
      { title: msg.name + sub, body: previewOf(msg), tag: 'room-' + roomId }
    );
  } catch (e) {
    console.error(e);
  }
}

/* ---------- дархостҳо ва сӯҳбатҳои шахсӣ ---------- */
async function sendSocial(uid) {
  try {
    const rq = await reqs.find({ $or: [{ from: uid }, { to: uid }] }).toArray();
    const ids = [...new Set(rq.map((q) => (q.from === uid ? q.to : q.from)))];
    const us = await users
      .find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { name: 1, village: 1, avatar: 1 } })
      .toArray();
    const info = {};
    us.forEach((x) => (info[String(x._id)] = { name: x.name, village: x.village || '', av: x.avatar || '' }));
    const out = { incoming: [], contacts: [] };
    rq.forEach((q) => {
      const o = q.from === uid ? q.to : q.from;
      const i = info[o];
      if (!i) return;
      if (q.status === 'accepted') out.contacts.push({ uid: o, name: i.name, village: i.village, av: i.av, room: dmPair(uid, o) });
      else if (q.status === 'pending' && q.to === uid)
        out.incoming.push({ id: String(q._id), uid: o, name: i.name, village: i.village, av: i.av });
    });
    io.to('u:' + uid).emit('social', out);
  } catch (e) {
    console.error(e);
  }
}

async function sendBlocks(s) {
  try {
    const ids = (s.user.blocked || []).filter((x) => HEX24.test(x));
    const us = ids.length
      ? await users.find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { name: 1 } }).toArray()
      : [];
    s.emit('blocks', ids.map((id) => ({ uid: id, name: (us.find((x) => String(x._id) === id) || {}).name || '—' })));
  } catch (e) {
    console.error(e);
  }
}
async function sendReports(s) {
  const list = await reports.find({ status: 'new' }).sort({ time: -1 }).limit(50).toArray();
  s.emit(
    'reports',
    list.map((r) => ({
      id: String(r._id),
      targetName: r.targetName,
      reporterName: r.reporterName,
      text: r.text,
      time: r.time,
    }))
  );
}
async function cleanup() {
  try {
    const now = Date.now();
    const D = 86400000;
    const tOld = now - (Number(process.env.KEEP_TEXT_DAYS) || 90) * D;
    const mOld = now - (Number(process.env.KEEP_MEDIA_DAYS) || 14) * D;
    const olds = await chat
      .find(
        { $or: [{ kind: 'text', time: { $lt: tOld } }, { kind: { $in: ['image', 'audio'] }, time: { $lt: mOld } }] },
        { projection: { media: 1 } }
      )
      .limit(3000)
      .toArray();
    if (olds.length) {
      const mids = olds.map((d) => d.media).filter((x) => HEX24.test(String(x))).map((x) => new ObjectId(x));
      if (mids.length) await media.deleteMany({ _id: { $in: mids } });
      await chat.deleteMany({ _id: { $in: olds.map((d) => d._id) } });
      console.log('cleanup', olds.length);
    }
    await reports.deleteMany({ status: { $ne: 'new' }, time: { $lt: now - 90 * D } });
  } catch (e) {
    console.error('cleanup', e);
  }
}

io.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth || {}).token || '');
    if (!token) return next(new Error('auth'));
    const u = await users.findOne({ token });
    if (!u) return next(new Error('auth'));
    if (u.banned) return next(new Error('banned'));
    if (ADMIN_PHONES.includes(String(u.phone))) u.admin = true;
    socket.user = u;
    socket.data.uid = String(u._id);
    socket.data.vis = true;
    next();
  } catch (e) {
    next(new Error('auth'));
  }
});

io.on('connection', (s) => {
  const uid = String(s.user._id);
  s.join('u:' + uid);
  if (s.user.village) s.join('vil:' + s.user.village);
  s.emit('me', uid);
  s.emit('profile', profOf(s.user));
  s.emit('rooms', myRooms(s.user));
  if (!s.user.gender) s.emit('needgender');
  const pc0 = pendingCalls.get(uid);
  if (pc0 && Date.now() - pc0.time < 45000) s.emit('callincoming', pc0);

  const enter = async (r) => {
    r = String(r);
    if (!(await canEnter(s.user, r))) return s.emit('err', 'Ба ин гурӯҳ дастрасӣ нест');
    [...s.rooms].filter((x) => x.startsWith('r:')).forEach((x) => s.leave(x));
    s.join('r:' + r);
    const list = await chat.find({ room: r }).sort({ time: -1 }).limit(100).toArray();
    s.emit('history', { room: r, chat: list.reverse().map(chatOut) });
  };

  (async () => {
    try {
      const allNews = await news
        .find({}, { projection: { _id: 0 } })
        .sort({ time: -1 })
        .limit(100)
        .toArray();
      const adList = await ads.find({}).sort({ time: -1 }).limit(100).toArray();
      s.emit('init', { news: allNews, ads: adList.map((a) => adOut(a, s.user)) });
      s.emit('places', await placesOut());
      if (!s.user.village) s.emit('needplace');
      sendSocial(uid);
      sendBlocks(s);
    } catch (e) {
      console.error(e);
    }
  })();

  s.on('vis', (v) => {
    s.data.vis = !!v;
  });

  s.on('pushsub', async (sub) => {
    try {
      if (
        !sub ||
        typeof sub.endpoint !== 'string' ||
        !sub.endpoint.startsWith('https://') ||
        !sub.keys ||
        typeof sub.keys.p256dh !== 'string' ||
        typeof sub.keys.auth !== 'string'
      ) {
        return;
      }
      await subs.updateOne(
        { endpoint: sub.endpoint },
        {
          $set: {
            uid,
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            time: Date.now(),
          },
        },
        { upsert: true }
      );
    } catch (e) {
      console.error(e);
    }
  });

  s.on('setgender', async (g) => {
    try {
      if (s.user.gender) return;
      if (g !== 'm' && g !== 'f') return;
      await users.updateOne({ _id: s.user._id }, { $set: { gender: g } });
      s.user.gender = g;
      s.emit('profile', profOf(s.user));
      s.emit('rooms', myRooms(s.user));
    } catch (e) {
      console.error(e);
    }
  });

  s.on('setplace', async (m) => {
    try {
      if (s.user.village) return;
      const v = await resolveVillage(m || {});
      if (!v) return;
      const vid = String(v._id);
      await users.updateOne({ _id: s.user._id }, { $set: { village: vid, district: v.parent } });
      s.user.village = vid;
      s.user.district = v.parent;
      s.join('vil:' + vid);
      io.emit('places', await placesOut());
      s.emit('profile', profOf(s.user));
      s.emit('rooms', myRooms(s.user));
    } catch (e) {
      console.error(e);
    }
  });

  s.on('settings', async (m) => {
    try {
      if (!m) return;
      const set = {};
      const name = String(m.name || '').trim().slice(0, 30);
      if (name) set.name = name;
      if (m.gender === 'm' || m.gender === 'f') set.gender = m.gender;
      if (m.avatar !== undefined) {
        const a = String(m.avatar || '');
        if (!a) set.avatar = '';
        else if (HEX24.test(a) && (await media.findOne({ _id: new ObjectId(a), avatar: true }, { projection: { _id: 1 } }))) set.avatar = a;
      }
      let v = null;
      if (m.village || m.vname) {
        v = await resolveVillage(m);
        if (!v) return s.emit('err', 'Деҳаро интихоб кунед');
        set.village = String(v._id);
        set.district = v.parent;
      }
      if (!Object.keys(set).length) return;
      await users.updateOne({ _id: s.user._id }, { $set: set });
      const oldV = s.user.village;
      Object.assign(s.user, set);
      if (v && oldV !== set.village) {
        if (oldV) s.leave('vil:' + oldV);
        s.join('vil:' + set.village);
        [...s.rooms].filter((x) => x.startsWith('r:')).forEach((x) => s.leave(x));
        await ads.updateMany({ uid }, { $set: { village: set.village } });
        io.emit('places', await placesOut());
      }
      s.emit('profile', profOf(s.user));
      s.emit('rooms', myRooms(s.user));
      s.emit('settingsok');
      sendSocial(uid);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('callinvite', async (m) => {
    try {
      const to = String((m && m.to) || '');
      if (!HEX24.test(to) || to === uid) return;
      const ok = await reqs.findOne({ status: 'accepted', $or: [{ from: uid, to }, { from: to, to: uid }] });
      if (!ok) return s.emit('err', 'Аввал запрос лозим аст');
      const now = Date.now();
      for (const [k, t] of callPairs) if (now - t > 3600000) callPairs.delete(k);
      callPairs.set(pairKey(uid, to), now);
      const info = { from: uid, name: s.user.name, video: !!m.video, time: now };
      pendingCalls.set(to, info);
      io.to('u:' + to).emit('callincoming', info);
      pushTo([to], { title: (m.video ? '🎥 ' : '📞 ') + 'Занг', body: s.user.name + ' занг мезанад', tag: 'call' });
      setTimeout(() => {
        const p = pendingCalls.get(to);
        if (p && p.time === now) pendingCalls.delete(to);
      }, 50000);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('callanswer', (m) => {
    const to = String((m && m.to) || '');
    if (!callPairs.has(pairKey(uid, to))) return;
    const p = pendingCalls.get(uid);
    if (p && p.from === to) pendingCalls.delete(uid);
    io.to('u:' + to).emit('callanswer', { from: uid, accept: !!m.accept, busy: !!m.busy });
  });

  s.on('callsig', (m) => {
    const to = String((m && m.to) || '');
    if (!callPairs.has(pairKey(uid, to)) || !m.data || typeof m.data !== 'object') return;
    io.to('u:' + to).emit('callsig', { from: uid, data: m.data });
  });

  s.on('callend', (m) => {
    const to = String((m && m.to) || '');
    if (!callPairs.has(pairKey(uid, to))) return;
    const p = pendingCalls.get(to);
    if (p && p.from === uid) pendingCalls.delete(to);
    const q = pendingCalls.get(uid);
    if (q && q.from === to) pendingCalls.delete(uid);
    io.to('u:' + to).emit('callend', { from: uid });
  });

  s.on('makeadmin', async (m) => {
    try {
      if (!(m && String(m.password || '').trim() === ADMIN)) return s.emit('err', 'Парол нодуруст');
      await users.updateOne({ _id: s.user._id }, { $set: { admin: true } });
      s.user.admin = true;
      s.emit('profile', profOf(s.user));
      s.emit('err', '✔ Ҳисоби шумо акнун админ аст. Парол дигар лозим нест.');
    } catch (e) {
      console.error(e);
    }
  });

  s.on('block', async (u) => {
    try {
      u = String(u);
      if (!HEX24.test(u) || u === uid) return;
      await users.updateOne({ _id: s.user._id }, { $addToSet: { blocked: u } });
      s.user.blocked = [...new Set([...(s.user.blocked || []), u])];
      sendBlocks(s);
    } catch (e) {
      console.error(e);
    }
  });
  s.on('unblock', async (u) => {
    try {
      u = String(u);
      await users.updateOne({ _id: s.user._id }, { $pull: { blocked: u } });
      s.user.blocked = (s.user.blocked || []).filter((x) => x !== u);
      sendBlocks(s);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('report', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const doc = await chat.findOne({ _id: new ObjectId(id) });
      if (!doc || doc.uid === uid || !(await canEnter(s.user, doc.room))) return;
      if (!(await reports.findOne({ msg: id, reporter: uid }))) {
        await reports.insertOne({
          msg: id,
          room: doc.room,
          reporter: uid,
          reporterName: s.user.name,
          target: doc.uid,
          targetName: doc.name,
          text: previewOf(doc),
          time: Date.now(),
          status: 'new',
        });
      }
      s.emit('reported');
    } catch (e) {
      console.error(e);
    }
  });
  s.on('reports', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      await sendReports(s);
    } catch (e) {
      console.error(e);
    }
  });
  s.on('repact', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const id = String(m.id || '');
      if (!HEX24.test(id)) return;
      const r = await reports.findOne({ _id: new ObjectId(id) });
      if (!r) return;
      if (m.act === 'delete') {
        const doc = await chat.findOne({ _id: new ObjectId(r.msg) });
        if (doc) {
          await chat.deleteOne({ _id: doc._id });
          if (doc.media && HEX24.test(doc.media)) await media.deleteOne({ _id: new ObjectId(doc.media) }).catch(() => {});
          io.emit('msgdel', r.msg);
        }
      }
      if (m.act === 'ban' && HEX24.test(r.target)) {
        await users.updateOne({ _id: new ObjectId(r.target) }, { $set: { banned: true } });
        io.in('u:' + r.target).disconnectSockets(true);
      }
      await reports.updateOne({ _id: r._id }, { $set: { status: m.act === 'dismiss' ? 'dismissed' : 'done' } });
      await sendReports(s);
    } catch (e) {
      console.error(e);
    }
  });
  s.on('unban', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const r = await users.updateOne({ phone: cleanPhone(m.phone) }, { $set: { banned: false } });
      s.emit('err', r.matchedCount ? 'Манъ кушода шуд' : 'Чунин рақам нест');
    } catch (e) {
      console.error(e);
    }
  });
  s.on('stats', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const st = await dbh.command({ dbStats: 1, scale: 1048576 });
      s.emit(
        'stats',
        {
          mb: Math.round(st.storageSize * 10) / 10,
          msgs: await chat.estimatedDocumentCount(),
          files: await media.estimatedDocumentCount(),
          users: await users.estimatedDocumentCount(),
        }
      );
    } catch (e) {
      console.error(e);
    }
  });

  s.on('placeadd', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const name = String(m.name || '').trim().slice(0, 40);
      if (!name) return;
      const type = m.type === 'v' ? 'v' : 'd';
      let parent = '';
      if (type === 'v') {
        parent = String(m.parent || '');
        if (!HEX24.test(parent) || !(await places.findOne({ _id: new ObjectId(parent), type: 'd' }))) {
          return s.emit('err', 'Ноҳияро интихоб кунед');
        }
      }
      await places.insertOne({ type, name, parent });
      io.emit('places', await placesOut());
    } catch (e) {
      console.error(e);
    }
  });

  s.on('wipechat', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const docs = await chat.find({ media: { $exists: true } }, { projection: { media: 1 } }).toArray();
      const ids = docs
        .map((d) => d.media)
        .filter((x) => HEX24.test(String(x)))
        .map((x) => new ObjectId(x));
      if (ids.length) await media.deleteMany({ _id: { $in: ids } });
      await chat.deleteMany({});
      io.emit('wiped');
    } catch (e) {
      console.error(e);
    }
  });

  s.on('members', async (vid) => {
    try {
      vid = String(vid);
      if (!HEX24.test(vid)) return;
      const list = await users
        .find({ village: vid, _id: { $ne: s.user._id } }, { projection: { name: 1, avatar: 1, blocked: 1 } })
        .limit(300)
        .toArray();
      const rq = await reqs.find({ $or: [{ from: uid }, { to: uid }] }).toArray();
      const st = (id) => {
        const x = rq.find((q) => q.from === id || q.to === id);
        if (!x) return 'none';
        if (x.status === 'accepted') return 'accepted';
        if (x.status === 'pending') return x.from === uid ? 'sent' : 'incoming';
        return x.from === uid ? 'declined' : 'none';
      };
      s.emit('members', {
        village: vid,
        list: list
          .filter((x) => !(x.blocked || []).includes(uid))
          .map((x) => ({ uid: String(x._id), name: x.name, av: x.avatar || '', state: st(String(x._id)) })),
      });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('reqsend', async (to) => {
    try {
      to = String(to);
      if (!HEX24.test(to) || to === uid) return;
      const other = await users.findOne({ _id: new ObjectId(to) });
      if (!other) return;
      if ((other.blocked || []).includes(uid)) return s.emit('err', 'Дархост фиристода нашуд');
      const ex = await reqs.findOne({ $or: [{ from: uid, to }, { from: to, to: uid }] });
      if (ex) {
        if (ex.status === 'pending' && ex.from === to) {
          await reqs.updateOne({ _id: ex._id }, { $set: { status: 'accepted' } });
        } else if (ex.status === 'declined' && ex.from === to) {
          await reqs.updateOne({ _id: ex._id }, { $set: { from: uid, to, status: 'pending', time: Date.now() } });
          pushTo([to], { title: 'Деҳа', body: s.user.name + ' мехоҳад бо шумо гап занад', tag: 'req' });
        } else {
          return s.emit(
            'err',
            ex.status === 'accepted'
              ? 'Шумо аллакай гап зада метавонед'
              : ex.status === 'pending'
              ? 'Дархост аллакай фиристода шудааст'
              : 'Дархост рад шудааст'
          );
        }
      } else {
        await reqs.insertOne({ from: uid, to, status: 'pending', time: Date.now() });
        pushTo([to], { title: 'Деҳа', body: s.user.name + ' мехоҳад бо шумо гап занад', tag: 'req' });
      }
      sendSocial(uid);
      sendSocial(to);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('reqans', async (m) => {
    try {
      if (!m || !HEX24.test(String(m.id))) return;
      const q = await reqs.findOne({ _id: new ObjectId(String(m.id)), to: uid, status: 'pending' });
      if (!q) return;
      await reqs.updateOne({ _id: q._id }, { $set: { status: m.accept ? 'accepted' : 'declined' } });
      sendSocial(uid);
      sendSocial(q.from);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('join', (r) => {
    enter(r).catch(console.error);
  });
  s.on('leave', () => {
    [...s.rooms].filter((x) => x.startsWith('r:')).forEach((x) => s.leave(x));
  });

  s.on('upload', async (m, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const type = String((m && m.type) || '').split(';')[0];
      const ok = type === 'image/jpeg' || AUDIO_TYPES.includes(type);
      if (!ok || !m.data || !m.data.length || m.data.length > 2000000) {
        return cb({ error: 'Файл нодуруст аст' });
      }
      const r = await media.insertOne({ type, data: Buffer.from(m.data), time: Date.now(), ...(m.avatar ? { avatar: true } : {}) });
      cb({ id: String(r.insertedId) });
    } catch (e) {
      console.error(e);
      cb({ error: 'Хатои сервер' });
    }
  });

  s.on('chat', async (m) => {
    try {
      if (!m) return;
      const room = String(m.room || '');
      if (!(await canEnter(s.user, room))) return;
      if (!vOf(room)) {
        const pp = room.split(':');
        const oth = await users.findOne({ _id: new ObjectId(pp[1] === uid ? pp[2] : pp[1]) }, { projection: { blocked: 1 } });
        if (oth && (oth.blocked || []).includes(uid)) return;
      }
      const kind = ['text', 'image', 'audio'].includes(m.kind) ? m.kind : 'text';
      const msg = { uid, name: s.user.name, av: s.user.avatar || '', room, kind, time: Date.now() };
      if (kind === 'text') {
        msg.text = String(m.text || '').trim().slice(0, 500);
        if (!msg.text) return;
      } else {
        msg.media = String(m.media || '');
        if (!HEX24.test(msg.media)) return;
        msg.dur = Math.min(Number(m.dur) || 0, 120);
      }
      const rid = String(m.reply || '');
      if (HEX24.test(rid)) {
        const o = await chat.findOne({ _id: new ObjectId(rid) });
        if (o && o.room === room) {
          msg.reply = { id: rid, uid: o.uid, name: o.name, text: previewOf(o) };
        }
      }
      const r = await chat.insertOne({ ...msg });
      msg.id = String(r.insertedId);
      io.to('r:' + room).emit('chat', msg);
      const v = vOf(room);
      if (v && !v.sub) {
        s.to('vil:' + v.vid).emit('newmsg', { room, name: msg.name });
      } else if (!v) {
        const p = room.split(':');
        io.to('u:' + (p[1] === uid ? p[2] : p[1])).emit('newmsg', { room, name: msg.name });
      }
      pushMsg(msg, room);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('msgdel', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const admin = isAdmin(m, s.user);
      const _id = new ObjectId(id);
      const doc = await chat.findOne(admin ? { _id } : { _id, uid });
      if (!doc) return s.emit('err', 'Нест кардан мумкин нест');
      await chat.deleteOne({ _id });
      if (doc.media && HEX24.test(doc.media)) {
        await media.deleteOne({ _id: new ObjectId(doc.media) }).catch(() => {});
      }
      io.emit('msgdel', id);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('ad', async (m) => {
    try {
      if (!m) return;
      const title = String(m.title || '').trim().slice(0, 100);
      if (!title) return s.emit('err', 'Сарлавҳа нависед');
      const a = {
        uid,
        name: s.user.name,
        phone: s.user.phone,
        village: s.user.village || '',
        title,
        price: String(m.price || '').trim().slice(0, 40),
        desc: String(m.desc || '').trim().slice(0, 500),
        cat: ['cow', 'sheep', 'other'].includes(m.cat) ? m.cat : 'other',
        photo: HEX24.test(String(m.photo || '')) ? String(m.photo) : '',
        time: Date.now(),
      };
      const r = await ads.insertOne({ ...a });
      const full = { ...a, _id: r.insertedId };
      for (const sk of io.sockets.sockets.values()) {
        if (sk.user) sk.emit('ad', adOut(full, sk.user));
      }
    } catch (e) {
      console.error(e);
      s.emit('err', 'Эълон нашр нашуд');
    }
  });

  s.on('addel', async (id) => {
    try {
      id = String(id);
      if (!HEX24.test(id)) return;
      const r = await ads.deleteOne({ _id: new ObjectId(id), uid });
      if (r.deletedCount) io.emit('addel', id);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('news', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const n = {
        title: String(m.title || '').slice(0, 100),
        text: String(m.text || '').slice(0, 2000),
        time: Date.now(),
      };
      await news.insertOne({ ...n });
      io.emit('news', n);
    } catch (e) {
      console.error(e);
    }
  });
});

(async () => {
  try {
    await client.connect();
    const db = client.db('deha');
    users = db.collection('users');
    chat = db.collection('chat');
    news = db.collection('news');
    media = db.collection('media');
    ads = db.collection('ads');
    subs = db.collection('subs');
    config = db.collection('config');
    places = db.collection('places');
    reqs = db.collection('reqs');
    reports = db.collection('reports');
    dbh = db;
    await users.createIndex({ phone: 1 }, { unique: true });
    await subs.createIndex({ endpoint: 1 }, { unique: true });
    await subs.createIndex({ uid: 1 });
    await chat.createIndex({ room: 1, time: -1 });
    await reqs.createIndex({ from: 1 });
    await reqs.createIndex({ to: 1 });
    await reports.createIndex({ status: 1, time: -1 });
    let ord = 0;
    for (const [region, names] of Object.entries(SEED)) {
      for (const name of names) {
        await places.updateOne({ type: 'd', name }, { $set: { region, ord: ++ord }, $setOnInsert: { parent: '' } }, { upsert: true });
      }
    }

    let v = await config.findOne({ _id: 'vapid' });
    if (!v) {
      const k = webpush.generateVAPIDKeys();
      v = { _id: 'vapid', publicKey: k.publicKey, privateKey: k.privateKey };
      await config.insertOne(v);
    }
    webpush.setVapidDetails('mailto:admin@example.com', v.publicKey, v.privateKey);
    VAPID_PUBLIC = v.publicKey;

    server.listen(process.env.PORT || 3000, () => console.log('Деҳа кор мекунад'));
    setInterval(cleanup, 6 * 3600 * 1000);
    setTimeout(cleanup, 60000);
  } catch (e) {
    console.error('Хатои база:', e);
    process.exit(1);
  }
})();
