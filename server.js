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
let users, chat, news, media, ads, subs, config, places, reqs, reports, unread, fcm, groups, dbh;
let VAPID_PUBLIC = '';

/* ---------- Firebase (FCM) барои барномаи Android ---------- */
let FB = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) FB = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT нодуруст аст', e.message);
}
let fbTok = { t: 0, v: '' };
const b64u = (x) => Buffer.from(x).toString('base64url');
async function fbAccess() {
  if (fbTok.v && Date.now() < fbTok.t) return fbTok.v;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(
    JSON.stringify({
      iss: FB.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(FB.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + body + '.' + sig,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('fcm auth ' + JSON.stringify(j).slice(0, 200));
  fbTok = { v: j.access_token, t: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  return fbTok.v;
}
async function fcmSend(tokens, data, ttl) {
  const out = [];
  if (!FB || !tokens.length) return out;
  const acc = await fbAccess();
  const d = {};
  for (const k of Object.keys(data || {})) d[k] = String(data[k]);
  if (!d.type) d.type = 'msg';
  await Promise.all(
    tokens.map(async (t) => {
      const tag = String(t).slice(-6);
      try {
        const r = await fetch('https://fcm.googleapis.com/v1/projects/' + FB.project_id + '/messages:send', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + acc, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: t, data: d, android: { priority: 'HIGH', ttl: (ttl || 60) + 's' } } }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          const st = j.error && j.error.status;
          if (r.status === 404 || st === 'NOT_FOUND' || st === 'UNREGISTERED') await fcm.deleteOne({ token: t });
          else console.error('fcm', r.status, JSON.stringify(j).slice(0, 300));
          out.push({ token: tag, status: r.status, error: st || '', message: String((j.error && j.error.message) || '').slice(0, 160) });
        } else {
          out.push({ token: tag, status: 200 });
        }
      } catch (e) {
        console.error('fcm send', e);
        out.push({ token: tag, error: String(e.message || e).slice(0, 160) });
      }
    })
  );
  return out;
}
// Огоҳиномаи системавӣ (notification), ки бе рамзи барнома аз тарафи Android нишон дода мешавад — барои санҷиш
async function fcmNotif(tokens, title, body) {
  const out = [];
  if (!FB || !tokens.length) return out;
  const acc = await fbAccess();
  await Promise.all(
    tokens.map(async (t) => {
      const tag = String(t).slice(-6);
      try {
        const r = await fetch('https://fcm.googleapis.com/v1/projects/' + FB.project_id + '/messages:send', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + acc, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token: t, notification: { title, body }, android: { priority: 'HIGH', ttl: '30s' } } }),
        });
        if (r.ok) out.push({ token: tag, status: 200 });
        else {
          const j = await r.json().catch(() => ({}));
          out.push({ token: tag, status: r.status, error: (j.error && j.error.status) || '', message: String((j.error && j.error.message) || '').slice(0, 120) });
        }
      } catch (e) {
        out.push({ token: tag, error: String(e.message || e).slice(0, 120) });
      }
    })
  );
  return out;
}
const lastTest = new Map();
async function fcmOnly(uids, data, ttl) {
  if (!FB || !uids.length) return;
  const ft = await fcm.find({ uid: { $in: uids } }).toArray();
  await fcmSend(ft.map((x) => x.token), data, ttl);
}

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
const CONTACT = String(process.env.CONTACT_EMAIL || '').trim();
const MIN_AGE = Number(process.env.MIN_AGE) || 13;
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
  id: '/',
  description: 'Чат, бозор ва хабарҳои деҳа',
  categories: ['social'],
  orientation: 'portrait',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#2f6b3a',
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
  if (p[0] === 'g' && HEX24.test(p[1] || '')) {
    return !!(await groups.findOne({ _id: new ObjectId(p[1]), members: String(u._id) }, { projection: { _id: 1 } }));
  }
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
const profOf = (u) => ({ name: u.name || '', village: u.village || '', district: u.district || '', gender: u.gender || '', avatar: u.avatar || '', admin: !!u.admin, first: u.first || u.name || '', surname: u.surname || '', age: u.age || '' });
const placesOut = async () => {
  const all = await places.find({}).sort({ ord: 1, name: 1 }).toArray();
  // шумораи одамон дар ҳар деҳа ва ноҳия
  const agg = await users
    .aggregate([
      { $match: { village: { $exists: true, $ne: '' } } },
      { $group: { _id: { v: '$village', d: '$district' }, n: { $sum: 1 } } },
    ])
    .toArray();
  const vc = {}, dc = {};
  let total = 0;
  agg.forEach((x) => {
    vc[x._id.v] = (vc[x._id.v] || 0) + x.n;
    dc[x._id.d] = (dc[x._id.d] || 0) + x.n;
    total += x.n;
  });
  return {
    total,
    districts: all.filter((x) => x.type === 'd').map((x) => ({ id: String(x._id), name: x.name, region: x.region || '', count: dc[String(x._id)] || 0 })),
    villages: all
      .filter((x) => x.type === 'v')
      .map((x) => ({ id: String(x._id), name: x.name, district: x.parent, count: vc[String(x._id)] || 0 })),
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
const newsOut = (d) => ({ id: String(d._id), uid: d.uid || '', name: d.name || '', title: d.title || '', text: d.text || '', photo: d.photo || '', time: d.time });
const chatOut = (d) => {
  const { _id, hid, ...rest } = d;
  return { ...rest, id: String(_id) };
};
const previewOf = (o, l) =>
  o.kind === 'image'
    ? l === 'ru' ? '📷 Фото' : '📷 Расм'
    : o.kind === 'audio'
    ? l === 'ru' ? '🎤 Голосовое сообщение' : '🎤 Паёми овозӣ'
    : String(o.text || '').slice(0, 80);

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

/* ---------- сиёсати махфият, нест кардани ҳисоб, assetlinks (барои Play Market) ---------- */
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shell = (title, inner) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
  esc(title) +
  '</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:18px;line-height:1.55;color:#222;background:#fff}h1{color:#2f6b3a;font-size:26px}h2{font-size:19px;margin-top:26px;color:#2f6b3a}li{margin:4px 0}input,button{font-size:16px;padding:12px;margin:6px 0;width:100%;box-sizing:border-box;border:1px solid #bbb;border-radius:10px}button{background:#b00020;color:#fff;border:0}.ok{color:#2f6b3a;font-weight:600}.err{color:#b00020}hr{margin:30px 0;border:0;border-top:1px solid #ddd}.nav a{margin-right:14px;color:#2f6b3a}</style></head><body>' +
  inner +
  '</body></html>';
const POLICY = {
  en: ['Privacy Policy', 'Last updated: October 2026', [
    ['About', ['Деҳа (Deha) is a community app for villages in Tajikistan: village chat, private chats, a marketplace and news.', 'This policy explains what data the app collects, how it is used and how it can be deleted.']],
    ['Data we collect', ['Account data: first name, surname, age, phone number, password (stored only as a hash), the district and village you choose, and your language.', 'Optional: gender and profile photo.', 'Content you create: chat messages, photos, voice messages, marketplace ads, and your reports and blocks.', 'Technical: a push-notification token, so that notifications can be delivered to your device.']],
    ['How we use it', ['To create your account and show you your village chat, marketplace and news.', 'To deliver notifications about new messages and chat requests.', 'To keep the community safe: reports, blocking and moderation.']],
    ['Who can see your data', ['Your name, photo and messages are visible to the people in the chats where you write.', 'Your phone number is visible only to people from your own village (for the call button in the marketplace). It is not shown to anyone else.', 'A private chat with a person from another village starts only after that person accepts your request.']],
    ['Sharing', ['We do not sell your data and we do not show ads.', 'Service providers process data on our behalf: hosting (Render), database (MongoDB Atlas) and push delivery (your browser vendor, for example Google). Data may therefore be processed outside Tajikistan.']],
    ['Retention', ['Text messages: 90 days. Photos and voice messages: 14 days. Marketplace ads: 90 days.', 'Account data is kept until you delete your account.']],
    ['Security', ['Data is sent over an encrypted HTTPS connection. Passwords are stored only as hashes.']],
    ['Children', ['The app is not intended for children under 13. We do not knowingly collect data from them. Age is entered at registration.']],
    ['Your rights and account deletion', ['You can edit your name, surname, age, village and photo in Settings.', 'You can delete your account in the app (Settings → Delete account) or on the page /delete-account. Deletion removes your account, messages, photos, voice messages, ads and notification tokens.']],
  ], 'Contact'],
  ru: ['Политика конфиденциальности', 'Обновлено: октябрь 2026', [
    ['О приложении', ['Деҳа (Деха) — приложение для сельских общин Таджикистана: чат деревни, личные чаты, рынок объявлений и новости.', 'Здесь описано, какие данные собирает приложение, как они используются и как их удалить.']],
    ['Какие данные мы собираем', ['Данные аккаунта: имя, фамилия, возраст, номер телефона, пароль (хранится только в виде хэша), выбранные район и деревня, язык.', 'По желанию: пол и фото профиля.', 'Ваш контент: сообщения в чатах, фото, голосовые сообщения, объявления на рынке, ваши жалобы и блокировки.', 'Технические данные: токен push-уведомлений для доставки уведомлений на ваше устройство.']],
    ['Как мы их используем', ['Чтобы создать аккаунт и показывать чат вашей деревни, рынок и новости.', 'Чтобы доставлять уведомления о новых сообщениях и запросах на чат.', 'Чтобы поддерживать безопасность: жалобы, блокировка и модерация.']],
    ['Кто видит ваши данные', ['Ваше имя, фото и сообщения видят участники чатов, в которых вы пишете.', 'Ваш номер телефона видят только жители вашей деревни (кнопка звонка на рынке). Другим он не показывается.', 'Личный чат с жителем другой деревни начинается только после того, как он примет ваш запрос.']],
    ['Передача данных', ['Мы не продаём данные и не показываем рекламу.', 'Данные обрабатывают наши поставщики услуг: хостинг (Render), база данных (MongoDB Atlas) и доставка push (производитель браузера, например Google). Поэтому данные могут обрабатываться за пределами Таджикистана.']],
    ['Сроки хранения', ['Текстовые сообщения — 90 дней. Фото и голосовые сообщения — 14 дней. Объявления — 90 дней.', 'Данные аккаунта хранятся, пока вы не удалите аккаунт.']],
    ['Безопасность', ['Данные передаются по защищённому соединению HTTPS. Пароли хранятся только в виде хэшей.']],
    ['Дети', ['Приложение не предназначено для детей младше 13 лет. Мы сознательно не собираем их данные. Возраст указывается при регистрации.']],
    ['Ваши права и удаление аккаунта', ['Имя, фамилию, возраст, деревню и фото можно изменить в «Настройках».', 'Аккаунт можно удалить в приложении («Настройки» → «Удалить аккаунт») или на странице /delete-account. При удалении стираются аккаунт, сообщения, фото, голосовые, объявления и токены уведомлений.']],
  ], 'Контакты'],
  tg: ['Сиёсати махфият', 'Навсозӣ: октябри 2026', [
    ['Дар бораи барнома', ['Деҳа — барнома барои деҳаҳои Тоҷикистон: чати деҳа, чатҳои шахсӣ, бозори эълонҳо ва хабарҳо.', 'Дар ин ҷо навишта шудааст, ки барнома кадом маълумотро ҷамъ мекунад, чӣ тавр истифода мебарад ва чӣ тавр нест кардан мумкин аст.']],
    ['Кадом маълумотро ҷамъ мекунем', ['Маълумоти ҳисоб: ном, насаб, синну сол, рақами телефон, парол (танҳо ҳамчун хэш нигоҳ дошта мешавад), ноҳия ва деҳаи интихобшуда, забон.', 'Ихтиёрӣ: ҷинс ва сурати профил.', 'Мундариҷаи шумо: паёмҳо дар чат, суратҳо, паёмҳои овозӣ, эълонҳо дар бозор, шикоят ва манъҳои шумо.', 'Техникӣ: токени огоҳиномаҳо барои расонидани огоҳинома ба дастгоҳи шумо.']],
    ['Чӣ тавр истифода мебарем', ['Барои сохтани ҳисоб ва нишон додани чати деҳа, бозор ва хабарҳо.', 'Барои расонидани огоҳинома дар бораи паёмҳои нав ва дархостҳои чат.', 'Барои амнияти ҷамъият: шикоят, манъ ва назорат.']],
    ['Кӣ маълумотро мебинад', ['Номи шумо, сурат ва паёмҳоятонро иштирокчиёни чатҳое мебинанд, ки дар онҳо менависед.', 'Рақами телефони шумо танҳо барои одамони деҳаи худатон намоён аст (тугмаи занг дар бозор). Ба дигарон нишон дода намешавад.', 'Чати шахсӣ бо одами деҳаи дигар танҳо баъд аз он оғоз мешавад, ки ӯ дархости шуморо қабул кунад.']],
    ['Додани маълумот', ['Мо маълумотро намефурӯшем ва реклама нишон намедиҳем.', 'Маълумотро хидматрасонҳо коркард мекунанд: ҳостинг (Render), база (MongoDB Atlas) ва расонидани push (истеҳсолкунандаи браузер, масалан Google). Бинобар ин маълумот метавонад берун аз Тоҷикистон коркард шавад.']],
    ['Мӯҳлати нигоҳдорӣ', ['Паёмҳои матнӣ: 90 рӯз. Суратҳо ва паёмҳои овозӣ: 14 рӯз. Эълонҳо: 90 рӯз.', 'Маълумоти ҳисоб то нест кардани ҳисоб нигоҳ дошта мешавад.']],
    ['Бехатарӣ', ['Маълумот тавассути пайвасти рамзгузоришудаи HTTPS ирсол мешавад. Паролҳо танҳо ҳамчун хэш нигоҳ дошта мешаванд.']],
    ['Кӯдакон', ['Барнома барои кӯдакони аз 13 хурд нест. Мо маълумоти онҳоро ҷамъ намекунем. Синну сол ҳангоми сабти ном навишта мешавад.']],
    ['Ҳуқуқи шумо ва нест кардани ҳисоб', ['Ном, насаб, синну сол, деҳа ва суратро дар «Танзимот» тағйир додан мумкин аст.', 'Ҳисобро дар барнома («Танзимот» → «Ҳисобро нест кардан») ё дар саҳифаи /delete-account нест кардан мумкин аст. Ҳангоми нест кардан ҳисоб, паёмҳо, суратҳо, паёмҳои овозӣ, эълонҳо ва токени огоҳиномаҳо нест мешаванд.']],
  ], 'Тамос'],
};
app.get('/privacy', (req, res) => {
  const lang = POLICY[req.query.lang] ? req.query.lang : 'en';
  const [title, upd, sections, contact] = POLICY[lang];
  let h = '<p class="nav"><a href="?lang=en">English</a><a href="?lang=ru">Русский</a><a href="?lang=tg">Тоҷикӣ</a><a href="/delete-account">Delete account</a></p><h1>' + esc(title) + ' · Деҳа</h1><p>' + esc(upd) + '</p>';
  sections.forEach(([hd, items]) => {
    h += '<h2>' + esc(hd) + '</h2><ul>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  });
  h += '<h2>' + esc(contact) + '</h2><p>' + (CONTACT ? esc(CONTACT) : '—') + '</p>';
  res.send(shell(title + ' · Деҳа', h));
});
app.get('/delete-account', (req, res) => {
  const h = `<p class="nav"><a href="/privacy">Privacy Policy</a></p>
<h1>Деҳа — Delete account / Удалить аккаунт / Нест кардани ҳисоб</h1>
<p>EN: Enter your phone number and password to permanently delete your account and all your data (messages, photos, voice messages, ads).</p>
<p>RU: Введите номер телефона и пароль, чтобы навсегда удалить аккаунт и все ваши данные (сообщения, фото, голосовые, объявления).</p>
<p>TG: Рақами телефон ва паролро нависед, то ҳисоб ва ҳамаи маълумоти шумо (паёмҳо, суратҳо, овозҳо, эълонҳо) якбора нест шавад.</p>
<input id="p" type="tel" placeholder="+992...">
<input id="w" type="password" placeholder="Password / Пароль / Парол">
<button id="b">Delete / Удалить / Нест кардан</button>
<p id="m"></p>
<script>
document.getElementById('b').onclick = async function(){
  var m = document.getElementById('m'); m.className = ''; m.textContent = '...';
  try {
    var r = await fetch('/api/delete-account', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: document.getElementById('p').value, password: document.getElementById('w').value }) });
    var d = await r.json();
    if (r.ok){ m.className = 'ok'; m.textContent = 'OK: account deleted / Аккаунт удалён / Ҳисоб нест шуд'; }
    else { m.className = 'err'; m.textContent = d.error || 'Error'; }
  } catch (e) { m.className = 'err'; m.textContent = 'Error / Ошибка / Хато'; }
};
</script>`;
  res.send(shell('Delete account · Деҳа', h));
});
app.post('/api/delete-account', async (req, res) => {
  try {
    const u = await users.findOne({ phone: cleanPhone(req.body.phone) });
    const ok = u && (await bcrypt.compare(String(req.body.password || ''), u.hash));
    if (!ok) return fail(res, 401, 'Wrong phone or password / Неверный номер или пароль / Рақам ё парол нодуруст аст');
    await deleteUser(u);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    fail(res, 500, 'Server error / Ошибка сервера / Хатои сервер');
  }
});
app.get('/.well-known/assetlinks.json', (req, res) => {
  const pkg = String(process.env.ANDROID_PACKAGE || '').trim();
  const fp = String(process.env.ANDROID_SHA256 || '').split(',').map((x) => x.trim()).filter(Boolean);
  res.type('application/json').send(
    JSON.stringify(
      pkg && fp.length
        ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fp } }]
        : []
    )
  );
});
app.get('/health', (req, res) => res.type('text/plain').send('ok'));
// Санҷиши push: /fcm-test?key=ПАРОЛИ_АДМИН&phone=РАҚАМ[&type=msg]
app.get('/fcm-test', async (req, res) => {
  try {
    if (String(req.query.key || '') !== ADMIN) return res.status(403).json({ error: 'key' });
    if (!FB) return res.json({ error: 'firebase нест' });
    const u = await users.findOne({ phone: cleanPhone(req.query.phone) });
    if (!u) return res.json({ error: 'чунин рақам нест' });
    const ft = await fcm.find({ uid: String(u._id) }).toArray();
    const data =
      req.query.type === 'msg'
        ? { type: 'msg', title: 'Деҳа', body: 'Санҷиши паём', tag: 'test' }
        : { type: 'call', from: String(u._id), name: 'Санҷиш', video: '0' };
    const acc = await fbAccess();
    const out = [];
    for (const t of ft) {
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + FB.project_id + '/messages:send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + acc, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: t.token, data, android: { priority: 'HIGH', ttl: '30s' } } }),
      });
      const j = await r.json().catch(() => ({}));
      out.push({ http: r.status, natija: j.name ? 'ok' : j.error ? j.error.status + ': ' + j.error.message : '?', token: t.token.slice(0, 10) + '...' });
    }
    res.json({ tokens: ft.length, sent: out });
  } catch (e) {
    res.json({ error: String(e.message || e) });
  }
});
// Санҷиши занг: /fcm-test?key=ПАРОЛИ_АДМИН&phone=РАҚАМ — ба дастгоҳҳои ин корбар push-и «занг» мефиристад
app.get('/fcm-test', async (req, res) => {
  try {
    if (String(req.query.key || '') !== ADMIN) return res.status(403).json({ error: 'key' });
    if (!FB) return res.json({ error: 'firebase off' });
    const u = await users.findOne({ phone: cleanPhone(req.query.phone) });
    if (!u) return res.json({ error: 'корбар ёфт нашуд' });
    const ft = await fcm.find({ uid: String(u._id) }).toArray();
    const results = await fcmSend(
      ft.map((x) => x.token),
      { type: 'call', from: String(u._id), name: 'Санҷиш', video: '0', title: 'Санҷиш', body: 'Занги санҷишӣ' },
      30
    );
    res.json({ user: u.name, tokens: ft.length, results });
  } catch (e) {
    res.json({ error: String(e.message || e).slice(0, 300) });
  }
});
app.get('/fcm-status', async (req, res) => {
  try {
    res.json({ firebase: !!FB, project: FB ? FB.project_id : '', tokens: fcm ? await fcm.estimatedDocumentCount() : 0 });
  } catch (e) {
    res.json({ firebase: !!FB, error: String(e.message || e) });
  }
});
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

/* ---------- барномаи Android: токени FCM ва рад кардани занг аз огоҳинома ---------- */
app.post('/api/fcm', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.body.token || '') });
    const t = String(req.body.fcm || '');
    if (!u || t.length < 20 || t.length > 400) return res.status(400).json({ ok: false });
    await fcm.updateOne({ token: t }, { $set: { uid: String(u._id), token: t, time: Date.now() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

app.post('/api/calldecline', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.body.token || '') });
    if (!u) return res.status(401).json({ ok: false });
    const uid = String(u._id);
    const to = String(req.body.to || '');
    if (!callPairs.has(pairKey(uid, to))) return res.json({ ok: false });
    const p = pendingCalls.get(uid);
    if (p && p.from === to) pendingCalls.delete(uid);
    io.to('u:' + to).emit('callanswer', { from: uid, accept: false, busy: false });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// Барномаи Android: занг ба дастгоҳ расид (занг мезанад) — ба занггиранда хабар медиҳад
app.post('/api/callrecv', async (req, res) => {
  try {
    const u = await users.findOne({ token: String(req.body.token || '') });
    if (!u) return res.status(401).json({ ok: false });
    const uid = String(u._id);
    const to = String(req.body.to || '');
    if (!callPairs.has(pairKey(uid, to))) return res.json({ ok: false });
    io.to('u:' + to).emit('callstatus', { peer: uid, state: 'ringing' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
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
    const surname = String(req.body.surname || '').trim().slice(0, 30);
    const age = parseInt(req.body.age, 10);
    const phone = cleanPhone(req.body.phone);
    const password = String(req.body.password || '');
    const gender = req.body.gender === 'f' ? 'f' : req.body.gender === 'm' ? 'm' : '';
    if (!name || !surname) return fail(res, 400, 'Ном ва насабро нависед');
    if (!(age >= 5 && age <= 100)) return fail(res, 400, 'Синну солро дуруст нависед');
    if (age < MIN_AGE) return fail(res, 400, 'Ин барнома барои синни аз ' + MIN_AGE + ' боло аст');
    if (phone.length < 9 || phone.length > 15 || password.length < 6) {
      return fail(res, 400, 'Рақам ё парол нодуруст аст (парол камаш 6 аломат)');
    }
    const vil = await resolveVillage(req.body);
    if (!vil) return fail(res, 400, 'Ноҳия ва деҳаро интихоб кунед');
    if (await users.findOne({ phone })) {
      return fail(res, 409, 'Ин рақам аллакай сабт шудааст');
    }
    const token = crypto.randomBytes(24).toString('hex');
    await users.insertOne({
      name: name + ' ' + surname,
      first: name,
      surname,
      age,
      phone,
      gender,
      village: String(vil._id),
      district: vil.parent,
      hash: await bcrypt.hash(password, 10),
      token,
      lang: req.body.lang === 'ru' ? 'ru' : 'tg',
      created: Date.now(),
    });
    io.emit('places', await placesOut());
    res.json({ token, name: name + ' ' + surname });
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
// opts.ttl — мӯҳлати push бо сонияҳо (барои занг кӯтоҳ мешавад)
async function pushTo(uids, mk, opts) {
  if (!uids.length) return;
  const ttl = (opts && opts.ttl) || 3600;
  const ids = uids.filter((x) => HEX24.test(x)).map((x) => new ObjectId(x));
  const us = await users.find({ _id: { $in: ids } }, { projection: { lang: 1 } }).toArray();
  const lang = {};
  us.forEach((u) => (lang[String(u._id)] = u.lang === 'ru' ? 'ru' : 'tg'));
  // барномаи Android: push тавассути FCM; ин корбарон push-и браузерро намегиранд
  const have = new Set();
  if (FB) {
    try {
      const ft = await fcm.find({ uid: { $in: uids } }).toArray();
      const byLang = {};
      ft.forEach((x) => {
        have.add(x.uid);
        const l = lang[x.uid] || 'tg';
        (byLang[l] = byLang[l] || []).push(x.token);
      });
      for (const l of Object.keys(byLang)) await fcmSend(byLang[l], typeof mk === 'function' ? mk(l) : mk, ttl);
    } catch (e) {
      console.error('fcm', e);
    }
  }
  if (!VAPID_PUBLIC) return;
  const list = await subs.find({ uid: { $in: uids.filter((x) => !have.has(x)) } }).toArray();
  const cache = {};
  await Promise.all(
    list.map(async (x) => {
      const l = lang[x.uid] || 'tg';
      if (!cache[l]) cache[l] = JSON.stringify(typeof mk === 'function' ? mk(l) : mk);
      try {
        await webpush.sendNotification({ endpoint: x.endpoint, keys: x.keys }, cache[l], {
          TTL: ttl,
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
    let gname = '';
    const v = vOf(roomId);
    if (v) {
      const q = { village: v.vid };
      if (v.sub === 'women') q.gender = 'f';
      targets = (await users.find(q, { projection: { _id: 1, blocked: 1 } }).toArray())
        .filter((x) => !(x.blocked || []).includes(msg.uid))
        .map((x) => String(x._id));
    } else if (roomId.startsWith('g:')) {
      const gt = await groupTargets(roomId, msg.uid);
      gname = gt.name;
      targets = gt.list;
    } else {
      const p = roomId.split(':');
      targets = [p[1] === msg.uid ? p[2] : p[1]];
    }
    const inRoom = await io.in('r:' + roomId).fetchSockets();
    const skip = new Set(inRoom.filter((x) => x.data && x.data.vis !== false).map((x) => x.data.uid));
    skip.add(msg.uid);
    await pushTo(
      targets.filter((t) => !skip.has(t)),
      (l) => {
        const ru = l === 'ru';
        const sub = v && v.sub ? (v.sub === 'women' ? (ru ? ' · Женщины' : ' · Занҳо') : ru ? ' · Футболисты' : ' · Футболистон') : gname ? ' · ' + gname : '';
        return { title: msg.name + sub, body: previewOf(msg, l), tag: 'room-' + roomId, type: 'msg', room: roomId };
      }
    );
  } catch (e) {
    console.error(e);
  }
}

/* ---------- шумораи паёмҳои нахондашуда ---------- */
async function bump(msg, roomId) {
  try {
    let targets = [];
    let gname = '';
    const v = vOf(roomId);
    if (v) {
      const q = { village: v.vid };
      if (v.sub === 'women') q.gender = 'f';
      targets = (await users.find(q, { projection: { _id: 1, blocked: 1 } }).toArray())
        .filter((x) => !(x.blocked || []).includes(msg.uid))
        .map((x) => String(x._id));
    } else if (roomId.startsWith('g:')) {
      const gt = await groupTargets(roomId, msg.uid);
      gname = gt.name;
      targets = gt.list;
    } else {
      const p = roomId.split(':');
      targets = [p[1] === msg.uid ? p[2] : p[1]];
    }
    const inRoom = await io.in('r:' + roomId).fetchSockets();
    const here = new Set(inRoom.filter((x) => x.data && x.data.vis !== false).map((x) => x.data.uid));
    targets = targets.filter((t) => t !== msg.uid && !here.has(t));
    if (!targets.length) return;
    await unread.bulkWrite(
      targets.map((u) => ({
        updateOne: { filter: { uid: u, room: roomId }, update: { $inc: { n: 1 } }, upsert: true },
      }))
    );
    targets.forEach((u) => io.to('u:' + u).emit('unread', { room: roomId, inc: 1 }));
  } catch (e) {
    console.error('bump', e);
  }
}

/* ---------- гурӯҳҳои оилавӣ ва авлодӣ ---------- */
async function groupsFor(uid) {
  const gs = await groups.find({ members: uid }).sort({ created: -1 }).toArray();
  const ids = [...new Set(gs.flatMap((g) => g.members))].filter((x) => HEX24.test(x));
  const us = ids.length
    ? await users.find({ _id: { $in: ids.map((i) => new ObjectId(i)) } }, { projection: { name: 1, avatar: 1 } }).toArray()
    : [];
  const info = {};
  us.forEach((x) => (info[String(x._id)] = { name: x.name || '—', av: x.avatar || '' }));
  return gs.map((g) => ({
    id: String(g._id),
    name: g.name,
    owner: g.owner,
    members: g.members.map((m) => ({ uid: m, name: (info[m] || {}).name || '—', av: (info[m] || {}).av || '' })),
  }));
}
async function sendGroups(uid) {
  try {
    io.to('u:' + uid).emit('groups', await groupsFor(uid));
  } catch (e) {
    console.error(e);
  }
}
async function getGroup(id) {
  id = String(id || '');
  return HEX24.test(id) ? groups.findOne({ _id: new ObjectId(id) }) : null;
}
async function validMembers(ids, by) {
  if (!ids.length) return [];
  const us = await users
    .find({ _id: { $in: ids.map((i) => new ObjectId(i)) }, banned: { $ne: true }, blocked: { $ne: by } }, { projection: { _id: 1 } })
    .toArray();
  return us.map((x) => String(x._id));
}
async function groupTargets(roomId, senderUid) {
  const id = String(roomId).split(':')[1] || '';
  const g = await getGroup(id);
  if (!g) return { name: '', list: [] };
  const others = g.members.filter((x) => x !== senderUid && HEX24.test(x));
  const bl = others.length
    ? await users.find({ _id: { $in: others.map((i) => new ObjectId(i)) }, blocked: senderUid }, { projection: { _id: 1 } }).toArray()
    : [];
  const nb = new Set(bl.map((x) => String(x._id)));
  return { name: g.name, list: others.filter((x) => !nb.has(x)) };
}
async function purgeGroup(g) {
  const room = 'g:' + String(g._id);
  const docs = await chat.find({ room, media: { $exists: true } }, { projection: { media: 1 } }).toArray();
  const mids = docs.map((d) => d.media).filter((x) => HEX24.test(String(x))).map((x) => new ObjectId(x));
  if (mids.length) await media.deleteMany({ _id: { $in: mids } });
  await chat.deleteMany({ room });
  await unread.deleteMany({ room });
  await groups.deleteOne({ _id: g._id });
  io.in('r:' + room).socketsLeave('r:' + room);
  await Promise.all(g.members.map(sendGroups));
}
async function dropMember(g, u) {
  const room = 'g:' + String(g._id);
  await unread.deleteOne({ uid: u, room }).catch(() => {});
  const rest = g.members.filter((x) => x !== u);
  if (!rest.length) return purgeGroup(g);
  const set = { members: rest };
  if (g.owner === u) set.owner = rest[0];
  await groups.updateOne({ _id: g._id }, { $set: set });
  io.in('u:' + u).socketsLeave('r:' + room);
  await Promise.all([u, ...rest].map(sendGroups));
}

/* ---------- дархостҳо ва сӯҳбатҳои шахсӣ ---------- */
async function deleteUser(u) {
  const uid = String(u._id);
  const msgs = await chat.find({ uid }, { projection: { media: 1 } }).toArray();
  const myAds = await ads.find({ uid }).toArray();
  const mids = msgs.map((d) => d.media).concat(myAds.map((a) => a.photo), [u.avatar]).filter((x) => HEX24.test(String(x || ''))).map((x) => new ObjectId(x));
  if (mids.length) await media.deleteMany({ _id: { $in: mids } });
  await chat.deleteMany({ uid });
  await ads.deleteMany({ uid });
  await subs.deleteMany({ uid });
  await unread.deleteMany({ uid });
  await fcm.deleteMany({ uid });
  await reqs.deleteMany({ $or: [{ from: uid }, { to: uid }] });
  await reports.deleteMany({ $or: [{ by: uid }, { msgUid: uid }] });
  await users.updateMany({ blocked: uid }, { $pull: { blocked: uid } });
  const gs = await groups.find({ members: uid }).toArray();
  for (const g of gs) await dropMember(g, uid);
  await users.deleteOne({ _id: u._id });
  myAds.forEach((a) => io.emit('addel', String(a._id)));
  io.in('u:' + uid).emit('deleted');
  io.in('u:' + uid).disconnectSockets(true);
}
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
    const lang = (socket.handshake.auth || {}).lang === 'ru' ? 'ru' : 'tg';
    if (u.lang !== lang) {
      users.updateOne({ _id: u._id }, { $set: { lang } }).catch(() => {});
      u.lang = lang;
    }
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
  sendGroups(uid);

  unread
    .find({ uid })
    .toArray()
    .then((l) => {
      const o = {};
      l.forEach((x) => (o[x.room] = x.n));
      s.emit('unreadall', o);
    })
    .catch(console.error);

  const enter = async (r) => {
    r = String(r);
    if (!(await canEnter(s.user, r))) return s.emit('err', 'Ба ин гурӯҳ дастрасӣ нест');
    [...s.rooms].filter((x) => x.startsWith('r:')).forEach((x) => s.leave(x));
    s.join('r:' + r);
    unread.deleteOne({ uid, room: r }).catch(() => {});
    s.emit('unread', { room: r, set: 0 });
    const list = await chat.find({ room: r, hid: { $ne: uid } }).sort({ time: -1 }).limit(100).toArray();
    s.emit('history', { room: r, chat: list.reverse().map(chatOut) });
  };

  (async () => {
    try {
      const allNews = (await news.find({}).sort({ time: -1 }).limit(100).toArray()).map(newsOut);
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

  s.on('seen', async (m) => {
    try {
      const room = String((m && m.room) || '');
      if (!room || !(await canEnter(s.user, room))) return;
      await unread.deleteOne({ uid, room });
      s.emit('unread', { room, set: 0 });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gfind', async (m) => {
    try {
      const q = String((m && m.q) || '').trim().slice(0, 40);
      const bl = (s.user.blocked || []).filter((b) => HEX24.test(b)).map((b) => new ObjectId(b));
      const base = { _id: { $ne: s.user._id, $nin: bl }, blocked: { $ne: uid }, banned: { $ne: true } };
      const proj = { projection: { name: 1, avatar: 1, village: 1 } };
      let list = [];
      if (q.length >= 2) {
        list = await users.find({ ...base, name: { $regex: escRe(q), $options: 'i' } }, proj).limit(30).toArray();
      } else if (s.user.village) {
        list = await users.find({ ...base, village: s.user.village }, proj).limit(200).toArray();
      }
      s.emit('gpeople', {
        q,
        list: list.map((x) => ({ uid: String(x._id), name: x.name, av: x.avatar || '', village: x.village || '' })),
      });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gcreate', async (m) => {
    try {
      const name = String((m && m.name) || '').trim().slice(0, 40);
      if (!name) return s.emit('err', 'Номи гурӯҳро нависед');
      if ((await groups.countDocuments({ owner: uid })) >= 20) return s.emit('err', 'Гурӯҳҳо аз ҳад зиёданд');
      const want = [...new Set((Array.isArray(m.members) ? m.members : []).map(String).filter((x) => HEX24.test(x) && x !== uid))].slice(0, 199);
      const ok = await validMembers(want, uid);
      const doc = { name, owner: uid, members: [uid, ...ok], created: Date.now() };
      const r = await groups.insertOne(doc);
      await Promise.all(doc.members.map((x) => sendGroups(x)));
      s.emit('gcreated', { id: String(r.insertedId), name });
      if (ok.length) {
        pushTo(ok, (l) => ({
          title: 'Деҳа',
          body: l === 'ru' ? s.user.name + ' добавил вас в группу «' + name + '»' : s.user.name + ' шуморо ба гурӯҳи «' + name + '» илова кард',
          tag: 'grp-' + r.insertedId,
          type: 'msg',
        })).catch(console.error);
      }
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gadd', async (m) => {
    try {
      const g = await getGroup(m && m.id);
      if (!g || g.owner !== uid) return;
      const want = [...new Set((Array.isArray(m.members) ? m.members : []).map(String).filter((x) => HEX24.test(x) && !g.members.includes(x)))].slice(0, Math.max(0, 200 - g.members.length));
      const add = await validMembers(want, uid);
      if (!add.length) return;
      await groups.updateOne({ _id: g._id }, { $addToSet: { members: { $each: add } } });
      await Promise.all([...g.members, ...add].map((x) => sendGroups(x)));
      pushTo(add, (l) => ({
        title: 'Деҳа',
        body: l === 'ru' ? s.user.name + ' добавил вас в группу «' + g.name + '»' : s.user.name + ' шуморо ба гурӯҳи «' + g.name + '» илова кард',
        tag: 'grp-' + g._id,
        type: 'msg',
      })).catch(console.error);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gremove', async (m) => {
    try {
      const g = await getGroup(m && m.id);
      if (!g || g.owner !== uid) return;
      const t = String((m && m.uid) || '');
      if (t === uid || !g.members.includes(t)) return;
      await dropMember(g, t);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gleave', async (m) => {
    try {
      const g = await getGroup(m && m.id);
      if (!g || !g.members.includes(uid)) return;
      await dropMember(g, uid);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('gdel', async (m) => {
    try {
      const g = await getGroup(m && m.id);
      if (!g || g.owner !== uid) return;
      await purgeGroup(g);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('fcmtoken', async (t) => {
    try {
      t = String(t || '');
      if (t.length < 20 || t.length > 400) return;
      await fcm.updateOne({ token: t }, { $set: { uid, token: t, time: Date.now() } }, { upsert: true });
    } catch (e) {
      console.error(e);
    }
  });
  // Санҷиши занг аз худи барнома: баъди 10 сония ба дастгоҳҳои худи корбар занги санҷишӣ меояд
  s.on('fcmselftest', async () => {
    try {
      const ft = FB ? await fcm.find({ uid }).toArray() : [];
      s.emit('fcmres', { fb: !!FB, tokens: ft.length });
      if (!ft.length) return;
      setTimeout(async () => {
        try {
          const toks = ft.map((x) => x.token);
          const data = await fcmSend(toks, { type: 'call', from: uid, name: 'Санҷиш', video: '0', title: 'Санҷиш', body: 'Занги санҷишӣ' }, 30);
          const notif = await fcmNotif(toks, 'Санҷиш: огоҳиномаи системавӣ', 'Агар ин омад, Firebase ба ин телефон мерасад');
          lastTest.set(uid, { time: Date.now(), data, notif });
        } catch (e) {
          console.error('fcmselftest', e);
          lastTest.set(uid, { time: Date.now(), data: [{ error: String(e.message || e).slice(0, 160) }], notif: [] });
        }
      }, 10000);
    } catch (e) {
      console.error(e);
    }
  });
  s.on('fcmlast', () => {
    s.emit('fcmlast', lastTest.get(uid) || {});
  });
  s.on('fcmoff', async (t) => {
    try {
      await fcm.deleteOne({ token: String(t || ''), uid });
    } catch (e) {
      console.error(e);
    }
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
      const first = String(m.name || '').trim().slice(0, 30);
      if (first) set.first = first;
      if (m.surname !== undefined) set.surname = String(m.surname || '').trim().slice(0, 30);
      const ag = parseInt(m.age, 10);
      if (ag >= MIN_AGE && ag <= 100) set.age = ag;
      if (set.first !== undefined || set.surname !== undefined) {
        const f = set.first !== undefined ? set.first : s.user.first || s.user.name || '';
        const sn = set.surname !== undefined ? set.surname : s.user.surname || '';
        set.name = (f + ' ' + sn).trim();
      }
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
      // ҳолати қабулкунанда барои занггиранда: дар шабака / push / дастрас нест
      const online = (await io.in('u:' + to).fetchSockets()).length > 0;
      let cstate = 'ringing';
      if (!online) {
        const nf = FB ? await fcm.countDocuments({ uid: to }) : 0;
        const ns = await subs.countDocuments({ uid: to });
        cstate = nf + ns > 0 ? 'push' : 'offline';
      }
      s.emit('callstatus', { peer: to, state: cstate });
      const info = { from: uid, name: s.user.name, video: !!m.video, time: now };
      pendingCalls.set(to, info);
      io.to('u:' + to).emit('callincoming', info);
      pushTo(
        [to],
        {
          title: (m.video ? '🎥 ' : '📞 ') + 'Занг',
          body: s.user.name + ' занг мезанад',
          tag: 'call',
          type: 'call',
          from: uid,
          name: s.user.name,
          video: m.video ? '1' : '0',
          requireInteraction: true,
          renotify: true,
          vibrate: [400, 200, 400, 200, 400, 200, 400],
        },
        { ttl: 30 }
      );
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
    fcmOnly([to], { type: 'callend' }, 10).catch(() => {});
  });

  s.on('delaccount', async (m) => {
    try {
      const ok = m && (await bcrypt.compare(String(m.password || ''), s.user.hash));
      if (!ok) return s.emit('err', 'Парол нодуруст');
      await deleteUser(s.user);
    } catch (e) {
      console.error(e);
    }
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
      if (m.act === 'delete' && r.kind === 'news') {
        const nd = await news.findOne({ _id: new ObjectId(r.msg) });
        if (nd) {
          await news.deleteOne({ _id: nd._id });
          if (nd.photo && HEX24.test(nd.photo)) await media.deleteOne({ _id: new ObjectId(nd.photo) }).catch(() => {});
          io.emit('newsdel', r.msg);
        }
      } else if (m.act === 'delete') {
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
      await unread.deleteMany({});
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

  s.on('search', async (m) => {
    try {
      const room = String((m && m.room) || '');
      const q = String((m && m.q) || '').trim().slice(0, 50);
      if (q.length < 2 || !(await canEnter(s.user, room))) return;
      const list = await chat
        .find({ room, kind: 'text', hid: { $ne: uid }, text: { $regex: escRe(q), $options: 'i' } })
        .sort({ time: -1 })
        .limit(50)
        .toArray();
      s.emit('searchres', { room, q, list: list.map(chatOut) });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('findpeople', async (m) => {
    try {
      const q = String((m && m.q) || '').trim().slice(0, 40);
      if (q.length < 2) return;
      const bl = (s.user.blocked || []).filter((b) => HEX24.test(b)).map((b) => new ObjectId(b));
      const list = await users
        .find(
          { name: { $regex: escRe(q), $options: 'i' }, _id: { $ne: s.user._id, $nin: bl }, blocked: { $ne: uid }, banned: { $ne: true } },
          { projection: { name: 1, avatar: 1, village: 1 } }
        )
        .limit(30)
        .toArray();
      const rq = await reqs.find({ $or: [{ from: uid }, { to: uid }] }).toArray();
      const st = (id) => {
        const x = rq.find((r) => r.from === id || r.to === id);
        if (!x) return 'none';
        if (x.status === 'accepted') return 'accepted';
        if (x.status === 'pending') return x.from === uid ? 'sent' : 'incoming';
        return x.from === uid ? 'declined' : 'none';
      };
      s.emit('people', {
        q,
        list: list.map((x) => ({ uid: String(x._id), name: x.name, av: x.avatar || '', village: x.village || '', state: st(String(x._id)) })),
      });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('vinfo', async () => {
    try {
      const vid = s.user.village;
      if (!vid) return;
      const bl = (s.user.blocked || []).filter((b) => HEX24.test(b)).map((b) => new ObjectId(b));
      const list = await users
        .find({ village: vid, banned: { $ne: true }, blocked: { $ne: uid }, _id: { $nin: bl } }, { projection: { name: 1, avatar: 1 } })
        .limit(500)
        .toArray();
      const socks = await io.in('vil:' + vid).fetchSockets();
      const on = new Set(socks.map((x) => x.data && x.data.uid));
      s.emit('vinfo', {
        village: vid,
        total: list.length,
        online: list.filter((x) => on.has(String(x._id))).length,
        list: list.map((x) => ({ uid: String(x._id), name: x.name, av: x.avatar || '', on: on.has(String(x._id)), me: String(x._id) === uid })),
      });
    } catch (e) {
      console.error(e);
    }
  });

  s.on('markread', async (m) => {
    try {
      const room = String((m && m.room) || '');
      if (!room.startsWith('dm:') || !(await canEnter(s.user, room))) return;
      const r = await chat.updateMany({ room, uid: { $ne: uid }, rd: { $ne: true } }, { $set: { rd: true } });
      if (r.modifiedCount) {
        const p = room.split(':');
        io.to('u:' + (p[1] === uid ? p[2] : p[1])).emit('read', { room });
      }
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
      const same = !!(other.village && other.village === s.user.village);
      const ex = await reqs.findOne({ $or: [{ from: uid, to }, { from: to, to: uid }] });
      if (ex) {
        if (same && ex.status !== 'accepted') {
          await reqs.updateOne({ _id: ex._id }, { $set: { status: 'accepted' } });
        } else if (ex.status === 'pending' && ex.from === to) {
          await reqs.updateOne({ _id: ex._id }, { $set: { status: 'accepted' } });
        } else if (ex.status === 'declined' && ex.from === to) {
          await reqs.updateOne({ _id: ex._id }, { $set: { from: uid, to, status: 'pending', time: Date.now() } });
          pushTo([to], (l) => ({ title: 'Деҳа', body: l === 'ru' ? s.user.name + ' хочет написать вам' : s.user.name + ' мехоҳад бо шумо гап занад', tag: 'req' }));
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
        await reqs.insertOne({ from: uid, to, status: same ? 'accepted' : 'pending', time: Date.now() });
        if (!same) pushTo([to], (l) => ({ title: 'Деҳа', body: l === 'ru' ? s.user.name + ' хочет написать вам' : s.user.name + ' мехоҳад бо шумо гап занад', tag: 'req' }));
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
      if (room.startsWith('dm:')) {
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
      } else if (room.startsWith('dm:')) {
        const p = room.split(':');
        io.to('u:' + (p[1] === uid ? p[2] : p[1])).emit('newmsg', { room, name: msg.name });
      } else if (room.startsWith('g:')) {
        const gt = await groupTargets(room, uid);
        gt.list.forEach((x) => io.to('u:' + x).emit('newmsg', { room, name: msg.name }));
      }
      bump(msg, room);
      pushMsg(msg, room);
    } catch (e) {
      console.error(e);
    }
  });

  // «Аз худам нест кардан»: паём танҳо барои ҳамин корбар пинҳон мешавад
  s.on('msghide', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const doc = await chat.findOne({ _id: new ObjectId(id) }, { projection: { room: 1 } });
      if (!doc || !(await canEnter(s.user, doc.room))) return;
      await chat.updateOne({ _id: doc._id }, { $addToSet: { hid: uid } });
      s.emit('msghid', id);
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

  // Ҳар корбар хабар навишта метавонад (пароли админ лозим нест)
  s.on('news', async (m) => {
    try {
      if (!m) return;
      const title = String(m.title || '').trim().slice(0, 100);
      const text = String(m.text || '').trim().slice(0, 3000);
      let photo = String(m.photo || '');
      if (!HEX24.test(photo) || !(await media.findOne({ _id: new ObjectId(photo) }, { projection: { _id: 1 } }))) photo = '';
      if (!title && !text && !photo) return s.emit('err', 'Сарлавҳа ё матн нависед');
      if (!isAdmin(m, s.user) && (await news.countDocuments({ uid, time: { $gt: Date.now() - 86400000 } })) >= 10) {
        return s.emit('err', 'Имрӯз хабар аз ҳад зиёд нашр кардед. Фардо кӯшиш кунед');
      }
      const n = { uid, name: s.user.name, title, text, photo, time: Date.now() };
      const r = await news.insertOne({ ...n });
      io.emit('news', newsOut({ ...n, _id: r.insertedId }));
    } catch (e) {
      console.error(e);
    }
  });

  s.on('newsdel', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const d = await news.findOne({ _id: new ObjectId(id) });
      if (!d) return;
      if (!(isAdmin(m, s.user) || d.uid === uid)) return s.emit('err', 'Нест кардан мумкин нест');
      await news.deleteOne({ _id: d._id });
      if (d.photo && HEX24.test(d.photo)) await media.deleteOne({ _id: new ObjectId(d.photo) }).catch(() => {});
      io.emit('newsdel', id);
    } catch (e) {
      console.error(e);
    }
  });

  s.on('newsreport', async (m) => {
    try {
      const id = String((m && m.id) || '');
      if (!HEX24.test(id)) return;
      const d = await news.findOne({ _id: new ObjectId(id) });
      if (!d || d.uid === uid) return;
      if (!(await reports.findOne({ msg: id, reporter: uid }))) {
        await reports.insertOne({
          kind: 'news',
          msg: id,
          room: 'news',
          reporter: uid,
          reporterName: s.user.name,
          target: d.uid || '',
          targetName: d.name || '—',
          text: ('📰 ' + (d.title || d.text || '')).slice(0, 80),
          time: Date.now(),
          status: 'new',
        });
      }
      s.emit('reported');
    } catch (e) {
      console.error(e);
    }
  });

  s.on('newsclean', async (m) => {
    try {
      if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
      const empty = (f) => ({ $or: [{ [f]: { $exists: false } }, { [f]: { $in: ['', null] } }] });
      await news.deleteMany({ $and: [empty('title'), empty('text'), empty('photo')] });
      const list = (await news.find({}).sort({ time: -1 }).limit(100).toArray()).map(newsOut);
      io.emit('newslist', list);
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
    unread = db.collection('unread');
    fcm = db.collection('fcm');
    groups = db.collection('groups');
    dbh = db;
    await users.createIndex({ phone: 1 }, { unique: true });
    await users.createIndex({ village: 1 });
    await subs.createIndex({ endpoint: 1 }, { unique: true });
    await subs.createIndex({ uid: 1 });
    await chat.createIndex({ room: 1, time: -1 });
    await reqs.createIndex({ from: 1 });
    await reqs.createIndex({ to: 1 });
    await reports.createIndex({ status: 1, time: -1 });
    await unread.createIndex({ uid: 1, room: 1 }, { unique: true });
    await fcm.createIndex({ token: 1 }, { unique: true });
    await fcm.createIndex({ uid: 1 });
    await groups.createIndex({ members: 1 });
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
