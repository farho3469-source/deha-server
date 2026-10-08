const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN = process.env.ADMIN_PASSWORD || 'admin123'; // ҳатман иваз кунед!
const FILE = 'data.json';
let data = { news: [], chat: [] };
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const save = () => fs.writeFileSync(FILE, JSON.stringify(data));

app.use(express.static('public'));

io.on('connection', (s) => {
  s.emit('init', data);

  s.on('chat', (m) => {
    if (!m || !m.name || !m.text) return;
    const msg = {
      name: String(m.name).slice(0, 30),
      text: String(m.text).slice(0, 500),
      time: Date.now(),
    };
    data.chat.push(msg);
    data.chat = data.chat.slice(-200);
    save();
    io.emit('chat', msg);
  });

  s.on('news', (m) => {
    if (!m || m.password !== ADMIN) return s.emit('err', 'Парол нодуруст');
    const n = {
      title: String(m.title || '').slice(0, 100),
      text: String(m.text || '').slice(0, 2000),
      time: Date.now(),
    };
    data.news.unshift(n);
    save();
    io.emit('news', n);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Деҳа кор мекунад'));
