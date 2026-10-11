const express = require('express');
const http = require('http');
const crypto = require('crypto');
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
let users, chat, news, media, ads, subs, config;
let VAPID_PUBLIC = '';
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];
const HEX24 = /^[0-9a-f]{24}$/;

const ROOMS = {
  village: { title: 'Деҳа', only: null },
  women: { title: 'Занҳо', only: 'f' },
  football: { title: 'Футболистон', only: null },
};
const canEnter = (u, r) => ROOMS[r] && (!ROOMS[r].only || u.gender === ROOMS[r].only);
const myRooms = (u) =>
  Object.keys(ROOMS)
    .filter((r) => canEnter(u, r))
    .map((r) => ({ id: r, title: ROOMS[r].title }));
const roomFilter = (r) =>
  r === 'village' ? { $or: [{ room: 'village' }, { room: { $exists: false } }] } : { room: r };
const adOut = (a) => ({
  id: String(a._id),
  uid: a.uid,
  name: a.name,
  phone: a.phone,
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

app.get('/api/vapid', (req, res) => res.json({ key: VAPID_PUBLIC }));

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
    if (await users.findOne({ phone })) {
      return fail(res, 409, 'Ин рақам аллакай сабт шудааст');
    }
    const token = crypto.randomBytes(24).toString('hex');
    await users.insertOne({
      name,
      phone,
      gender,
      hash: await bcrypt.hash(password, 10),
      token,
      created: Date.now(),
    });
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
async function pushMsg(msg, roomId) {
  try {
    if (!VAPID_PUBLIC) return;
    const inRoom = await io.in('r:' + roomId).fetchSockets();
    const skip = new Set(inRoom.filter((x) => x.data && x.data.vis !== false).map((x) => x.data.uid));
    skip.add(msg.uid);
    let list = await subs.find({ uid: { $nin: [...skip] } }).toArray();
    const only = ROOMS[roomId].only;
    if (only) {
      const okIds = new Set(
        (await users.find({ gender: only }, { projection: { _id: 1 } }).toArray()).map((x) => String(x._id))
      );
      list = list.filter((x) => okIds.has(x.uid));
    }
    if (!list.length) return;
    const title = roomId === 'village' ? msg.name : msg.name + ' · ' + ROOMS[roomId].title;
    const payload = JSON.stringify({ title, body: previewOf(msg), tag: 'room-' + roomId });
    await Promise.all(
      list.map(async (x) => {
        try {
          await webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, payload, {
            TTL: 3600,
            urgency: 'high',
          });
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            await subs.deleteOne({ endpoint: x.endpoint });
          }
        }
      })
    );
  } catch (e) {
    console.error(e);
  }
}

io.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth || {}).token || '');
    if (!token) return next(new Error('auth'));
    const u = await users.findOne({ token });
    if (!u) return next(new Error('auth'));
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
  s.emit('me', uid);
  s.emit('rooms', myRooms(s.user));
  if (!s.user.gender) s.emit('needgender');

  const enter = async (r) => {
    if (!canEnter(s.user, r)) return s.emit('err', 'Ба ин гурӯҳ дастрасӣ нест');
    Object.keys(ROOMS).forEach((x) => s.leave('r:' + x));
    s.join('r:' + r);
    const list = await chat.find(roomFilter(r)).sort({ time: -1 }).limit(100).toArray();
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
      s.emit('init', { news: allNews, ads: adList.map(adOut) });
      await enter('village');
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
      s.emit('rooms', myRooms(s.user));
    } catch (e) {
      console.error(e);
    }
  });

  s.on('join', (r) => {
    enter(String(r)).catch(console.error);
  });

  s.on('upload', async (m, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const type = String((m && m.type) || '').split(';')[0];
      const ok = type === 'image/jpeg' || AUDIO_TYPES.includes(type);
      if (!ok || !m.data || !m.data.length || m.data.length > 2000000) {
        return cb({ error: 'Файл нодуруст аст' });
      }
      const r = await media.insertOne({ type, data: Buffer.from(m.data), time: Date.now() });
      cb({ id: String(r.insertedId) });
    } catch (e) {
      console.error(e);
      cb({ error: 'Хатои сервер' });
    }
  });

  s.on('chat', async (m) => {
    try {
      if (!m) return;
      const room = String(m.room || 'village');
      if (!canEnter(s.user, room)) return;
      const kind = ['text', 'image', 'audio'].includes(m.kind) ? m.kind : 'text';
      const msg = { uid, name: s.user.name, room, kind, time: Date.now() };
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
        if (o && (o.room || 'village') === room) {
          msg.reply = { id: rid, uid: o.uid, name: o.name, text: previewOf(o) };
        }
      }
      const r = await chat.insertOne({ ...msg });
      msg.id = String(r.insertedId);
      io.to('r:' + room).emit('chat', msg);
      pushMsg(msg, room);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('msgdel', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const admin = String((m && m.password) || '').trim() === ADMIN;
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
        title,
        price: String(m.price || '').trim().slice(0, 40),
        desc: String(m.desc || '').trim().slice(0, 500),
        cat: ['cow', 'sheep', 'other'].includes(m.cat) ? m.cat : 'other',
        photo: HEX24.test(String(m.photo || '')) ? String(m.photo) : '',
        time: Date.now(),
      };
      const r = await ads.insertOne({ ...a });
      io.emit('ad', adOut({ ...a, _id: r.insertedId }));
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
      if (!m || String(m.password || '').trim() !== ADMIN) return s.emit('err', 'Парол нодуруст');
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
    await users.createIndex({ phone: 1 }, { unique: true });
    await subs.createIndex({ endpoint: 1 }, { unique: true });
    await subs.createIndex({ uid: 1 });

    let v = await config.findOne({ _id: 'vapid' });
    if (!v) {
      const k = webpush.generateVAPIDKeys();
      v = { _id: 'vapid', publicKey: k.publicKey, privateKey: k.privateKey };
      await config.insertOne(v);
    }
    webpush.setVapidDetails('mailto:admin@example.com', v.publicKey, v.privateKey);
    VAPID_PUBLIC = v.publicKey;

    server.listen(process.env.PORT || 3000, () => console.log('Деҳа кор мекунад'));
  } catch (e) {
    console.error('Хатои база:', e);
    process.exit(1);
  }
})();
