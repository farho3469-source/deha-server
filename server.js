const express = require('express');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
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
let users, chat, news, media;
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4'];

app.use(express.json());
app.use(express.static('public'));

const cleanPhone = (p) => String(p || '').replace(/[^\d]/g, '');
const fail = (res, code, error) => res.status(code).json({ error });

app.post('/api/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 30);
    const phone = cleanPhone(req.body.phone);
    const password = String(req.body.password || '');
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
    let oid;
    try {
      oid = new ObjectId(req.params.id);
    } catch (e) {
      return res.status(404).end();
    }
    const m = await media.findOne({ _id: oid });
    if (!m) return res.status(404).end();
    res.set('Content-Type', m.type);
    res.set('Cache-Control', 'private, max-age=31536000');
    res.send(Buffer.from(m.data.buffer));
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

io.use(async (socket, next) => {
  try {
    const token = String((socket.handshake.auth || {}).token || '');
    if (!token) return next(new Error('auth'));
    const u = await users.findOne({ token });
    if (!u) return next(new Error('auth'));
    socket.user = u;
    next();
  } catch (e) {
    next(new Error('auth'));
  }
});

io.on('connection', (s) => {
  s.emit('me', String(s.user._id));

  (async () => {
    try {
      const opts = { projection: { _id: 0 } };
      const lastChat = await chat.find({}, opts).sort({ time: -1 }).limit(100).toArray();
      const allNews = await news.find({}, opts).sort({ time: -1 }).limit(100).toArray();
      s.emit('init', { chat: lastChat.reverse(), news: allNews });
    } catch (e) {
      console.error(e);
    }
  })();

  s.on('chat', async (m) => {
    try {
      const text = String((m && m.text) || '').trim().slice(0, 500);
      if (!text) return;
      const msg = {
        uid: String(s.user._id),
        name: s.user.name,
        kind: 'text',
        text,
        time: Date.now(),
      };
      await chat.insertOne({ ...msg });
      io.emit('chat', msg);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('media', async (m) => {
    try {
      const kind = m && m.kind;
      const type = String((m && m.type) || '').split(';')[0];
      const okType =
        (kind === 'image' && type === 'image/jpeg') ||
        (kind === 'audio' && AUDIO_TYPES.includes(type));
      if (!okType || !m.data || !m.data.length || m.data.length > 2000000) {
        return s.emit('err', 'Файл нодуруст аст');
      }
      const r = await media.insertOne({ type, data: Buffer.from(m.data), time: Date.now() });
      const msg = {
        uid: String(s.user._id),
        name: s.user.name,
        kind,
        media: String(r.insertedId),
        dur: Math.min(Number(m.dur) || 0, 120),
        time: Date.now(),
      };
      await chat.insertOne({ ...msg });
      io.emit('chat', msg);
    } catch (e) {
      console.error(e);
      s.emit('err', 'Фиристода нашуд');
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
    await users.createIndex({ phone: 1 }, { unique: true });
    server.listen(process.env.PORT || 3000, () => console.log('Деҳа кор мекунад'));
  } catch (e) {
    console.error('Хатои база:', e);
    process.exit(1);
  }
})();
