(async () => {
  const me = await fetch('/api/me').then(r => r.json());
  if (!me.role) { location.href = '/login'; return; }
  const isWriter = me.role === 'writer';

  document.getElementById('role-label').textContent = isWriter ? 'Writing' : 'Reading';

  const writeTab = document.querySelector('[data-view="write"]');
  const backupBtn = document.getElementById('backup-btn');
  const printBtn = document.getElementById('print-btn');
  if (!isWriter) {
    writeTab.style.display = 'none';
    backupBtn.style.display = 'none';
    printBtn.style.display = 'none';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    if (name === 'read') loadTimeline();
  }

  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => showView(t.dataset.view));
  });

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login';
  });

  backupBtn.addEventListener('click', () => { location.href = '/api/backup'; });

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function toYouTubeEmbed(url) {
    try {
      const u = new URL(url.trim());
      let id = '';
      if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
      else if (u.hostname.endsWith('youtube.com')) {
        if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
        else if (u.pathname.startsWith('/embed/')) id = u.pathname.slice(7);
        else if (u.pathname.startsWith('/shorts/')) id = u.pathname.slice(8);
      }
      id = id.split('/')[0].split('?')[0];
      if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
      return `https://www.youtube.com/embed/${id}`;
    } catch { return null; }
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function canResize(file) {
    return /^image\/(jpeg|jpg|png|webp)$/i.test(file.type);
  }

  async function renderResizedBlob(img, maxDim, quality) {
    let { naturalWidth: w, naturalHeight: h } = img;
    if (w > maxDim || h > maxDim) {
      if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
      else { w = Math.round(w * maxDim / h); h = maxDim; }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  }

  async function resizeImage(file, maxDim = 2048, quality = 0.85) {
    if (!canResize(file)) return file;
    if (file.size < 800 * 1024) return file;
    try {
      const url = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
      const blob = await renderResizedBlob(img, maxDim, quality);
      URL.revokeObjectURL(url);
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function showResizeDialog(file) {
    if (!canResize(file)) return file;
    const dialog = document.getElementById('resize-dialog');
    const dimInput = document.getElementById('resize-dim');
    const qualityInput = document.getElementById('resize-quality');
    const dimLabel = document.getElementById('resize-dim-label');
    const qualityLabel = document.getElementById('resize-quality-label');
    const originalSize = document.getElementById('resize-original-size');
    const outputSize = document.getElementById('resize-output-size');
    const previewImg = document.getElementById('resize-preview-img');
    const cancelBtn = document.getElementById('resize-cancel');
    const uploadBtn = document.getElementById('resize-upload');

    originalSize.textContent = formatBytes(file.size);
    outputSize.textContent = 'calculating…';

    const srcUrl = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = srcUrl;
    }).catch(() => null);
    if (!img) { URL.revokeObjectURL(srcUrl); return file; }

    let currentBlob = null;
    let previewUrl = null;

    async function rerender() {
      const maxDim = Number(dimInput.value);
      const q = Number(qualityInput.value) / 100;
      dimLabel.textContent = maxDim;
      qualityLabel.textContent = Math.round(q * 100);
      const blob = await renderResizedBlob(img, maxDim, q);
      if (!blob) return;
      currentBlob = blob;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      previewImg.src = previewUrl;
      outputSize.textContent = formatBytes(blob.size);
    }

    const debouncedRerender = debounce(rerender, 150);
    dimInput.oninput = debouncedRerender;
    qualityInput.oninput = debouncedRerender;

    function setDim(newDim) {
      const clamped = Math.max(Number(dimInput.min), Math.min(Number(dimInput.max), newDim));
      const step = Number(dimInput.step) || 1;
      dimInput.value = Math.round(clamped / step) * step;
      debouncedRerender();
    }

    const preview = document.getElementById('resize-preview');
    const handle = document.getElementById('resize-handle');

    const onWheel = (e) => {
      e.preventDefault();
      setDim(Number(dimInput.value) + (e.deltaY < 0 ? 128 : -128));
    };
    preview.addEventListener('wheel', onWheel, { passive: false });

    let dragStart = null;
    const onDragStart = (e) => {
      const pt = e.touches ? e.touches[0] : e;
      dragStart = { x: pt.clientX, y: pt.clientY, dim: Number(dimInput.value) };
      e.preventDefault();
    };
    const onDragMove = (e) => {
      if (!dragStart) return;
      const pt = e.touches ? e.touches[0] : e;
      const delta = ((pt.clientX - dragStart.x) + (pt.clientY - dragStart.y)) / 2;
      setDim(dragStart.dim + delta * 6);
    };
    const onDragEnd = () => { dragStart = null; };

    handle.addEventListener('mousedown', onDragStart);
    handle.addEventListener('touchstart', onDragStart, { passive: false });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);

    return new Promise((resolve) => {
      function cleanup(result) {
        URL.revokeObjectURL(srcUrl);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        dimInput.oninput = null;
        qualityInput.oninput = null;
        preview.removeEventListener('wheel', onWheel);
        handle.removeEventListener('mousedown', onDragStart);
        handle.removeEventListener('touchstart', onDragStart);
        window.removeEventListener('mousemove', onDragMove);
        window.removeEventListener('touchmove', onDragMove);
        window.removeEventListener('mouseup', onDragEnd);
        window.removeEventListener('touchend', onDragEnd);
        dialog.close();
        resolve(result);
      }
      cancelBtn.onclick = () => cleanup(null);
      uploadBtn.onclick = () => {
        if (!currentBlob) return cleanup(file);
        const renamed = new File(
          [currentBlob],
          file.name.replace(/\.[^.]+$/, '') + '.jpg',
          { type: 'image/jpeg' }
        );
        cleanup(renamed);
      };
      rerender().then(() => dialog.showModal());
    });
  }

  // --- Writer ---
  let quill = null;
  let currentDate = null;
  let saveTimer = null;
  let lastSaved = '';

  async function loadEntry(date) {
    currentDate = date;
    setStatus('');
    const e = await fetch(`/api/entries/${date}`).then(r => r.json());
    lastSaved = e.html || '';
    quill.root.innerHTML = lastSaved || '<p><br></p>';
    loadOnThisDay(date);
  }

  function setStatus(text) {
    document.getElementById('save-status').textContent = text;
  }

  function scheduleSave() {
    if (!isWriter || !currentDate) return;
    setStatus('Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  async function save() {
    const html = quill.root.innerHTML;
    if (html === lastSaved) { setStatus('Saved'); return; }
    const r = await fetch(`/api/entries/${currentDate}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    if (r.ok) { lastSaved = html; setStatus('Saved'); }
    else { setStatus('Save failed — try again'); }
  }

  async function loadOnThisDay(date) {
    const wrap = document.getElementById('on-this-day');
    const list = document.getElementById('otd-list');
    list.innerHTML = '';
    try {
      const hits = await fetch(`/api/on-this-day?ref=${date}`).then(r => r.json());
      if (!hits.length) { wrap.classList.add('hidden'); return; }
      wrap.classList.remove('hidden');
      for (const { date: d, html } of hits) {
        const yearsAgo = Number(date.slice(0, 4)) - Number(d.slice(0, 4));
        const card = document.createElement('div');
        card.className = 'otd-card';
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const text = (tmp.textContent || '').slice(0, 180).trim();
        card.innerHTML = `
          <div class="otd-date">${formatDate(d)} · ${yearsAgo} year${yearsAgo === 1 ? '' : 's'} ago</div>
          <div class="otd-snippet"></div>
          <div class="otd-full ql-editor hidden"></div>
          <button class="link-btn otd-toggle">Read full entry</button>
        `;
        card.querySelector('.otd-snippet').textContent = text + (text.length >= 180 ? '…' : '');
        card.querySelector('.otd-full').innerHTML = html;
        const toggle = card.querySelector('.otd-toggle');
        toggle.addEventListener('click', () => {
          const full = card.querySelector('.otd-full');
          const snippet = card.querySelector('.otd-snippet');
          const open = full.classList.toggle('hidden') === false;
          snippet.classList.toggle('hidden', open);
          toggle.textContent = open ? 'Collapse' : 'Read full entry';
        });
        list.appendChild(card);
      }
    } catch { wrap.classList.add('hidden'); }
  }

  if (isWriter) {
    const picker = document.getElementById('date-picker');
    picker.value = todayStr();
    picker.max = todayStr();
    picker.addEventListener('change', () => loadEntry(picker.value));

    quill = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Write about today…',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'link', 'image', 'video'],
            ['clean'],
          ],
          handlers: {
            image: () => document.getElementById('photo-input').click(),
            video: () => {
              const url = prompt('Paste a YouTube URL:');
              if (!url) return;
              const embedUrl = toYouTubeEmbed(url);
              if (!embedUrl) { alert('That doesn\'t look like a YouTube URL.'); return; }
              const range = quill.getSelection(true);
              quill.insertEmbed(range.index, 'video', embedUrl, 'user');
              quill.setSelection(range.index + 1);
            },
          },
        },
      },
    });

    quill.on('text-change', (_delta, _old, source) => {
      if (source === 'user') scheduleSave();
    });

    // --- Image resize on click ---
    const imgToolbar = document.getElementById('img-size-toolbar');
    let selectedImg = null;

    function positionToolbar(img) {
      const r = img.getBoundingClientRect();
      imgToolbar.style.top = `${window.scrollY + r.top - 38}px`;
      imgToolbar.style.left = `${window.scrollX + r.left}px`;
    }

    function getImgSize(img) {
      const w = (img.style.width || '').replace('%', '');
      return w ? Number(w) : 100;
    }

    function updateToolbarActive() {
      if (!selectedImg) return;
      const current = getImgSize(selectedImg);
      imgToolbar.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.size) === current);
      });
    }

    function selectImg(img) {
      if (selectedImg && selectedImg !== img) selectedImg.classList.remove('selected-img');
      selectedImg = img;
      img.classList.add('selected-img');
      positionToolbar(img);
      imgToolbar.classList.remove('hidden');
      updateToolbarActive();
    }

    function deselectImg() {
      if (selectedImg) selectedImg.classList.remove('selected-img');
      selectedImg = null;
      imgToolbar.classList.add('hidden');
    }

    quill.root.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG') {
        e.stopPropagation();
        selectImg(e.target);
      }
    });

    document.addEventListener('click', (e) => {
      if (!selectedImg) return;
      if (imgToolbar.contains(e.target)) return;
      if (e.target === selectedImg) return;
      deselectImg();
    }, true);

    imgToolbar.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!selectedImg) return;
        selectedImg.style.width = `${btn.dataset.size}%`;
        updateToolbarActive();
        positionToolbar(selectedImg);
        scheduleSave();
      });
    });

    window.addEventListener('scroll', () => {
      if (selectedImg) positionToolbar(selectedImg);
    });
    window.addEventListener('resize', () => {
      if (selectedImg) positionToolbar(selectedImg);
    });

    const photoInput = document.getElementById('photo-input');
    photoInput.addEventListener('change', async () => {
      const files = Array.from(photoInput.files || []);
      photoInput.value = '';
      if (!files.length || !currentDate) return;
      let toUpload;
      if (files.length === 1) {
        const picked = await showResizeDialog(files[0]);
        if (!picked) { setStatus(''); return; }
        toUpload = [picked];
      } else {
        setStatus(`Preparing ${files.length} photos…`);
        toUpload = await Promise.all(files.map(f => resizeImage(f)));
      }
      setStatus(`Uploading ${toUpload.length} photo${toUpload.length > 1 ? 's' : ''}…`);
      const fd = new FormData();
      for (const f of toUpload) fd.append('photo', f);
      const r = await fetch(`/api/entries/${currentDate}/photos`, { method: 'POST', body: fd });
      if (!r.ok) { setStatus('Upload failed'); return; }
      const { files: uploaded } = await r.json();
      const range = quill.getSelection(true) || { index: quill.getLength() };
      if (uploaded.length === 1) {
        quill.insertEmbed(range.index, 'image', uploaded[0].url, 'user');
        quill.setSelection(range.index + 1);
      } else {
        const html = `<div class="gallery">${uploaded.map(u => `<img src="${u.url}">`).join('')}</div><p></p>`;
        quill.clipboard.dangerouslyPasteHTML(range.index, html, 'user');
      }
      setStatus('Saving…');
      scheduleSave();
    });

    window.addEventListener('beforeunload', () => {
      if (quill && currentDate && quill.root.innerHTML !== lastSaved) {
        navigator.sendBeacon(
          `/api/entries/${currentDate}`,
          new Blob([JSON.stringify({ html: quill.root.innerHTML })], { type: 'application/json' })
        );
      }
    });

    await loadEntry(todayStr());
    showView('write');
  } else {
    showView('read');
  }

  // --- Reader ---
  let allEntries = [];

  async function loadTimeline() {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '<p class="muted">Loading…</p>';
    const list = await fetch('/api/entries').then(r => r.json());
    allEntries = [];
    for (const { date } of list) {
      const e = await fetch(`/api/entries/${date}`).then(r => r.json());
      allEntries.push({ date, html: e.html || '' });
    }
    await loadTags();
    renderEntries(allEntries);
  }

  function renderEntries(entries) {
    const timeline = document.getElementById('timeline');
    if (!entries.length) {
      timeline.innerHTML = '<p class="muted">No entries yet.</p>';
      return;
    }
    timeline.innerHTML = '';
    for (const { date, html } of entries) {
      const article = document.createElement('article');
      article.className = 'entry';
      article.id = `entry-${date}`;
      const h = document.createElement('h2');
      h.textContent = formatDate(date);
      const body = document.createElement('div');
      body.className = 'entry-body ql-editor';
      body.innerHTML = html || '<p class="muted">(empty)</p>';
      article.appendChild(h);
      article.appendChild(body);
      timeline.appendChild(article);
    }
  }

  async function loadTags() {
    try {
      const tags = await fetch('/api/tags').then(r => r.json());
      const sel = document.getElementById('tag-filter');
      sel.innerHTML = '<option value="">All tags</option>';
      for (const { tag, count } of tags) {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = `${tag} (${count})`;
        sel.appendChild(opt);
      }
    } catch {}
  }

  const searchInput = document.getElementById('search');
  const tagFilter = document.getElementById('tag-filter');
  const randomBtn = document.getElementById('random-btn');

  searchInput?.addEventListener('input', debounce(async () => {
    const q = searchInput.value.trim();
    if (!q) { renderEntries(allEntries); return; }
    const results = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then(r => r.json());
    const dates = new Set(results.map(r => r.date));
    renderEntries(allEntries.filter(e => dates.has(e.date)));
  }, 250));

  tagFilter?.addEventListener('change', () => {
    const tag = tagFilter.value.toLowerCase();
    if (!tag) { renderEntries(allEntries); return; }
    const filtered = allEntries.filter(e => {
      const text = (new DOMParser().parseFromString(e.html, 'text/html').body.textContent || '').toLowerCase();
      return text.includes(tag);
    });
    renderEntries(filtered);
  });

  randomBtn?.addEventListener('click', async () => {
    const pick = await fetch('/api/random').then(r => r.json());
    if (!pick) { alert('No entries yet.'); return; }
    if (!allEntries.length) await loadTimeline();
    const el = document.getElementById(`entry-${pick.date}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.style.transition = 'background 1s';
      el.style.background = '#fff6e0';
      setTimeout(() => { el.style.background = ''; }, 1500);
    }
  });
})();
