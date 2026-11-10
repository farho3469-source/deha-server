/* Баннери боло: сервер. Дар охири server.js бо як сатр пайваст мешавад. */
module.exports = function (c) {
  const { io, isAdmin, HEX24, ObjectId, db } = c;
  io.on('connection', async (s) => {
    try {
      const b = await db().config.findOne({ _id: 'banner' });
      s.emit('banner', { media: (b && b.media) || '' });
    } catch (e) { console.error(e); }

    s.on('setbanner', async (m) => {
      try {
        if (!isAdmin(m, s.user)) return s.emit('err', 'Парол нодуруст');
        const { config, media } = db();
        const id = String((m && m.media) || '');
        if (id && !(HEX24.test(id) && (await media.findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } })))) {
          return s.emit('err', 'Файл нодуруст аст');
        }
        const old = await config.findOne({ _id: 'banner' });
        await config.updateOne({ _id: 'banner' }, { $set: { media: id } }, { upsert: true });
        if (old && old.media && old.media !== id && HEX24.test(old.media)) {
          await media.deleteOne({ _id: new ObjectId(old.media) }).catch(() => {});
        }
        io.emit('banner', { media: id });
      } catch (e) { console.error(e); }
    });
  });
};
