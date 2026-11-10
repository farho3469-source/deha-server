/* Баннери боло: клиент. Дар index.html бо як сатр пайваст мешавад. */
(function () {
  const st = document.createElement('style');
  st.textContent = '#hsc.hasb::after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;background:linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.08) 50%,rgba(0,0,0,.45))}';
  document.head.append(st);

  let bn = '', hooked = null;
  function paint() {
    const h = $('hsc');
    if (bn) {
      h.innerHTML = '';
      h.style.background = 'url("' + mediaUrl(bn) + '") center/cover no-repeat';
      h.classList.add('hasb');
    } else {
      h.style.background = '';
      h.classList.remove('hasb');
      h.innerHTML = sceneSvg('h');
    }
  }

  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
  document.body.append(inp);

  function needPw() {
    if (!prof.admin && !$('pw').value.trim()) { alert('Аввал пароли админро нависед'); return true; }
    return false;
  }
  function pickBanner() { if (!needPw()) inp.click(); }
  function clearBanner() {
    if (needPw()) return;
    if (confirm('Акси боло тоза карда шавад?')) socket.emit('setbanner', { media: '', password: $('pw').value });
  }
  inp.onchange = async () => {
    const f = inp.files[0]; inp.value = '';
    if (!f || !socket) return;
    toast('Интизор шавед...');
    try {
      const id = await upload('image/jpeg', await shrink(f));
      socket.emit('setbanner', { media: id, password: $('pw').value });
      toast('✔ Акси боло иваз шуд');
    } catch (e) { alert('Расм фиристода нашуд'); }
  };

  const anchor = document.querySelector('#s4 [onclick="loadStats()"]');
  if (anchor) {
    const mk = (txt, fn) => {
      const b = document.createElement('button');
      b.className = 'btn g'; b.style.cssText = 'width:100%;margin-top:8px';
      b.textContent = txt; b.onclick = fn; return b;
    };
    anchor.after(mk('🖼 Иваз кардани акси боло', pickBanner), mk('🗑 Акси болоро тоза кардан', clearBanner));
  }

  function hook() {
    if (!socket || hooked === socket) return;
    hooked = socket;
    socket.on('banner', (d) => { bn = (d && d.media) || ''; paint(); });
  }
  hook();
  const _start = start;
  start = function (t) { _start(t); hook(); };
})();
