(async () => {
  let me = await fetch('/api/me').then(r => r.json());
  if (!me.role) { location.href = '/login'; return; }
  const isWriter = me.role === 'writer';

  const roleLabelEl = document.getElementById('role-label');
  const nicknameBtn = document.getElementById('nickname-btn');

  function renderMe() {
    roleLabelEl.textContent = isWriter ? 'Writing' : 'Reading';
    nicknameBtn.textContent = me.nickname ? `as ${me.nickname}` : 'Set your name';
  }
  renderMe();

  nicknameBtn.addEventListener('click', async () => {
    const nick = prompt('Your display name on comments:', me.nickname || '');
    if (nick === null) return;
    const r = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: nick }),
    });
    if (!r.ok) { alert('Could not save name'); return; }
    me = await r.json();
    renderMe();
  });

  const writeTab = document.querySelector('[data-view="write"]');
  const trashTab = document.getElementById('trash-tab');
  const backupBtn = document.getElementById('backup-btn');
  const printBtn = document.getElementById('print-btn');
  if (!isWriter) {
    writeTab.style.display = 'none';
    trashTab.style.display = 'none';
    backupBtn.style.display = 'none';
    printBtn.style.display = 'none';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    if (name === 'read') loadTimeline();
    if (name === 'trash') loadTrash();
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
  let currentEntryId = null;
  let currentDate = null;
  let saveTimer = null;
  let lastSaved = '';

  function formatEntryTime(id) {
    const t = id.slice(11);
    const hh = t.slice(0, 2), mm = t.slice(2, 4);
    const h = Number(hh);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${mm} ${ampm}`;
  }

  function countWords(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent.match(/\S+/g) || []).length;
  }

  async function selectDate(date) {
    currentDate = date;
    setStatus('');
    document.getElementById('entry-editor-wrap').classList.add('hidden');
    currentEntryId = null;
    await renderEntryTabs(date);
    loadOnThisDay(date);
  }

  async function renderEntryTabs(date) {
    const tabs = document.getElementById('entry-tabs');
    const list = await fetch(`/api/entries-for-date?date=${date}`).then(r => r.json()).catch(() => []);
    tabs.innerHTML = '';
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No entries yet for this day. Click "＋ New entry" to start writing.';
      tabs.appendChild(p);
      return;
    }
    for (const e of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entry-tab';
      btn.dataset.id = e.id;
      const time = formatEntryTime(e.id);
      btn.innerHTML = `<strong>${time}</strong> <span class="muted">· ${e.wordCount} word${e.wordCount===1?'':'s'}</span>${e.published ? '' : ' <span class="draft-dot" title="Draft">●</span>'}`;
      btn.onclick = () => loadEntry(e.id);
      tabs.appendChild(btn);
    }
  }

  async function loadEntry(id) {
    currentEntryId = id;
    setStatus('');
    const e = await fetch(`/api/entries/${id}`).then(r => r.json());
    lastSaved = e.html || '';
    quill.root.innerHTML = lastSaved || '<p><br></p>';
    document.getElementById('entry-editor-wrap').classList.remove('hidden');
    document.getElementById('entry-time-label').textContent = formatEntryTime(id);
    updatePublishUI(e.published, e.html);
    updateWordCountUI(e.html);
    document.querySelectorAll('#entry-tabs .entry-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.id === id));
  }

  async function createNewEntry() {
    if (!currentDate) return;
    const r = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: currentDate }),
    });
    if (!r.ok) { alert('Could not create entry'); return; }
    const { id } = await r.json();
    await renderEntryTabs(currentDate);
    await loadEntry(id);
    quill.focus();
  }

  async function deleteCurrentEntry() {
    if (!currentEntryId) return;
    if (!confirm('Move this entry to the trash? (You can restore it from the Trash tab.)')) return;
    await fetch(`/api/entries/${currentEntryId}`, { method: 'DELETE' });
    const date = currentDate;
    currentEntryId = null;
    document.getElementById('entry-editor-wrap').classList.add('hidden');
    await renderEntryTabs(date);
  }

  function updatePublishUI(published, html) {
    const btn = document.getElementById('publish-btn');
    const badge = document.getElementById('draft-badge');
    if (!btn) return;
    const hasContent = html && html.replace(/<[^>]+>/g, '').trim().length > 0;
    if (!hasContent) {
      btn.textContent = 'Publish';
      btn.classList.remove('published');
      badge.classList.add('hidden');
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    if (published) {
      btn.textContent = 'Unpublish';
      btn.classList.add('published');
      badge.classList.add('hidden');
    } else {
      btn.textContent = 'Publish';
      btn.classList.remove('published');
      badge.classList.remove('hidden');
    }
  }

  function updateWordCountUI(html) {
    const el = document.getElementById('entry-word-count');
    if (!el) return;
    const n = countWords(html);
    el.textContent = `${n} word${n === 1 ? '' : 's'}`;
  }

  function setStatus(text) {
    document.getElementById('save-status').textContent = text;
  }

  function scheduleSave() {
    if (!isWriter || !currentEntryId) return;
    setStatus('Saving…');
    updateWordCountUI(quill.root.innerHTML);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  async function save() {
    if (!currentEntryId) return;
    const html = quill.root.innerHTML;
    if (html === lastSaved) { setStatus('Saved'); return; }
    const r = await fetch(`/api/entries/${currentEntryId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    if (r.ok) {
      lastSaved = html;
      setStatus('Saved');
      const data = await r.json().catch(() => null);
      if (data) updatePublishUI(data.published, html);
      // Update the active tab's word count
      const tab = document.querySelector(`#entry-tabs .entry-tab[data-id="${currentEntryId}"]`);
      if (tab) {
        const n = countWords(html);
        const sp = tab.querySelector('span.muted');
        if (sp) sp.textContent = `· ${n} word${n === 1 ? '' : 's'}`;
      }
    }
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
    picker.addEventListener('change', () => selectDate(picker.value));
    document.getElementById('new-entry-btn').addEventListener('click', createNewEntry);
    document.getElementById('delete-entry-btn').addEventListener('click', deleteCurrentEntry);

    // Register a custom Audio blot so <audio> tags round-trip through Quill.
    const BlockEmbed = Quill.import('blots/block/embed');
    class AudioBlot extends BlockEmbed {
      static create(url) {
        const node = super.create();
        node.setAttribute('controls', '');
        node.setAttribute('preload', 'metadata');
        node.setAttribute('src', url);
        return node;
      }
      static value(node) { return node.getAttribute('src'); }
    }
    AudioBlot.blotName = 'audio';
    AudioBlot.tagName = 'audio';
    Quill.register(AudioBlot);

    quill = new Quill('#editor', {
      theme: 'snow',
      placeholder: 'Write about today…',
      modules: {
        toolbar: {
          container: [
            [{ header: [1, 2, 3, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ list: 'ordered' }, { list: 'bullet' }],
            ['blockquote', 'link', 'image', 'video', 'audio'],
            ['clean'],
          ],
          handlers: {
            image: () => document.getElementById('photo-input').click(),
            audio: () => document.getElementById('audio-input').click(),
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
      if (!files.length || !currentEntryId) return;
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
      const r = await fetch(`/api/entries/${currentEntryId}/photos`, { method: 'POST', body: fd });
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

    document.getElementById('publish-btn').addEventListener('click', async () => {
      if (!currentEntryId) return;
      await save();
      const current = await fetch(`/api/entries/${currentEntryId}`).then(r => r.json());
      const r = await fetch(`/api/entries/${currentEntryId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ published: !current.published }),
      });
      if (!r.ok) { alert('Failed to change publish state'); return; }
      const data = await r.json();
      updatePublishUI(data.published, quill.root.innerHTML);
      setStatus(data.published ? 'Published' : 'Unpublished (draft)');
      // Refresh tab display to update draft dot
      renderEntryTabs(currentDate);
    });

    const audioInput = document.getElementById('audio-input');
    audioInput.addEventListener('change', async () => {
      const file = audioInput.files[0];
      audioInput.value = '';
      if (!file || !currentEntryId) return;
      setStatus(`Uploading audio (${formatBytes(file.size)})…`);
      const fd = new FormData();
      fd.append('audio', file);
      const r = await fetch(`/api/entries/${currentEntryId}/audio`, { method: 'POST', body: fd });
      if (!r.ok) {
        const msg = r.status === 413 ? 'File too large' : 'Upload failed';
        setStatus(msg);
        return;
      }
      const { url } = await r.json();
      const range = quill.getSelection(true) || { index: quill.getLength() };
      quill.insertEmbed(range.index, 'audio', url, 'user');
      quill.setSelection(range.index + 1);
      setStatus('Saving…');
      scheduleSave();
    });

    window.addEventListener('beforeunload', () => {
      if (quill && currentEntryId && quill.root.innerHTML !== lastSaved) {
        navigator.sendBeacon(
          `/api/entries/${currentEntryId}`,
          new Blob([JSON.stringify({ html: quill.root.innerHTML })], { type: 'application/json' })
        );
      }
    });

    await selectDate(todayStr());
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
    for (const meta of list) {
      const e = await fetch(`/api/entries/${meta.id}`).then(r => r.json()).catch(() => null);
      if (e) allEntries.push({
        id: meta.id,
        date: meta.date,
        html: e.html || '',
        wordCount: meta.wordCount,
        published: meta.published,
      });
    }
    await Promise.all([loadTags(), loadStats(), loadCalendar()]);
    renderEntries(allEntries);
  }

  function renderEntries(entries) {
    const timeline = document.getElementById('timeline');
    if (!entries.length) {
      timeline.innerHTML = '<p class="muted">No entries yet.</p>';
      return;
    }
    timeline.innerHTML = '';
    // Oldest-first reads more naturally for reader; keep newest-first for writer
    const ordered = isWriter ? entries : [...entries].reverse();
    for (const { id, date, html, wordCount } of ordered) {
      const article = document.createElement('article');
      article.className = 'entry';
      article.id = `entry-${id}`;
      const h = document.createElement('h2');
      h.textContent = `${formatDate(date)} — ${formatEntryTime(id)}`;
      const wc = document.createElement('div');
      wc.className = 'entry-wc muted';
      wc.textContent = `${wordCount} word${wordCount === 1 ? '' : 's'}`;
      const body = document.createElement('div');
      body.className = 'entry-body ql-editor';
      body.innerHTML = html || '<p class="muted">(empty)</p>';
      article.appendChild(h);
      article.appendChild(wc);
      article.appendChild(body);
      const comments = document.createElement('div');
      comments.className = 'comments-section';
      comments.dataset.id = id;
      article.appendChild(comments);
      timeline.appendChild(article);
      renderComments(comments, id);
    }
  }

  async function renderComments(container, entryId) {
    container.innerHTML = '<h3>Comments</h3>';
    const list = await fetch(`/api/comments/${entryId}`).then(r => r.json()).catch(() => []);
    const tree = buildTree(list);
    const thread = document.createElement('div');
    thread.className = 'comment-thread';
    for (const node of tree) {
      thread.appendChild(renderCommentNode(node, entryId, container));
    }
    container.appendChild(thread);
    container.appendChild(commentForm(entryId, container, null, 'Leave a comment…'));
  }

  function buildTree(list) {
    const byId = new Map();
    const roots = [];
    for (const c of list) byId.set(c.id, { ...c, children: [] });
    for (const c of list) {
      const node = byId.get(c.id);
      if (c.parent_id != null && byId.has(c.parent_id)) {
        byId.get(c.parent_id).children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  function renderCommentNode(node, entryId, container) {
    const wrap = document.createElement('div');
    wrap.className = 'comment-wrap';
    wrap.appendChild(commentEl(node, entryId, container));
    if (node.children.length) {
      const children = document.createElement('div');
      children.className = 'comment-children';
      for (const child of node.children) children.appendChild(renderCommentNode(child, entryId, container));
      wrap.appendChild(children);
    }
    return wrap;
  }

  function commentEl(c, entryId, container) {
    const el = document.createElement('div');
    el.className = 'comment' + (c.author === 'writer' ? ' by-writer' : '');
    const when = new Date(c.created_at);
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const left = document.createElement('span');
    left.textContent = `${c.author} · ${when.toLocaleString()}`;
    const right = document.createElement('span');
    right.className = 'comment-actions';
    const reply = document.createElement('button');
    reply.className = 'link-btn';
    reply.textContent = 'reply';
    reply.onclick = () => {
      const existing = el.querySelector('.comment-form');
      if (existing) { existing.remove(); return; }
      el.appendChild(commentForm(entryId, container, c.id, `Reply to ${c.author}…`));
    };
    right.appendChild(reply);
    if (isWriter) {
      const del = document.createElement('button');
      del.className = 'comment-delete';
      del.textContent = 'delete';
      del.onclick = async () => {
        if (!confirm('Delete this comment (and its replies)?')) return;
        await fetch(`/api/comments/${c.id}`, { method: 'DELETE' });
        renderComments(container, entryId);
      };
      right.appendChild(del);
    }
    meta.appendChild(left);
    meta.appendChild(right);
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = c.body;
    el.appendChild(meta);
    el.appendChild(body);
    return el;
  }

  function commentForm(entryId, container, parentId, placeholder) {
    const form = document.createElement('form');
    form.className = 'comment-form';
    form.innerHTML = `<textarea placeholder="${placeholder}" required></textarea><button type="submit">Post</button>`;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const ta = form.querySelector('textarea');
      const body = ta.value.trim();
      if (!body) return;
      const r = await fetch(`/api/comments/${entryId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, parentId }),
      });
      if (!r.ok) { alert('Failed to post comment'); return; }
      ta.value = '';
      renderComments(container, entryId);
    };
    return form;
  }

  async function loadStats() {
    try {
      const s = await fetch('/api/stats').then(r => r.json());
      const bar = document.getElementById('stats-bar');
      const firstDate = s.first ? new Date(s.first + 'T00:00') : null;
      const days = firstDate ? Math.round((Date.now() - firstDate.getTime()) / 86400000) + 1 : 0;
      bar.innerHTML = `
        <div class="stat"><span class="value">${s.total}</span><span class="label">entries</span></div>
        <div class="stat"><span class="value">${s.currentStreak}</span><span class="label">day streak</span></div>
        <div class="stat"><span class="value">${s.longestStreak}</span><span class="label">longest streak</span></div>
        <div class="stat"><span class="value">${days}</span><span class="label">days journaling</span></div>
        <div class="stat"><span class="value">${s.totalComments}</span><span class="label">comments</span></div>
      `;
    } catch {}
  }

  let calYear = new Date().getFullYear();
  async function loadCalendar() {
    const yearEl = document.getElementById('cal-year');
    const cal = document.getElementById('calendar');
    yearEl.textContent = calYear;
    try {
      const data = await fetch(`/api/calendar?year=${calYear}`).then(r => r.json());
      const filled = new Map();
      for (const e of data.entries) filled.set(e.date, e);
      cal.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'cal-grid';
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      for (let m = 0; m < 12; m++) {
        const month = document.createElement('div');
        month.className = 'cal-month';
        month.innerHTML = `<div class="cal-month-name">${monthNames[m]}</div>`;
        const days = document.createElement('div');
        days.className = 'cal-days';
        const firstDay = new Date(calYear, m, 1).getDay();
        for (let i = 0; i < firstDay; i++) {
          const d = document.createElement('div'); d.className = 'cal-day empty-month';
          days.appendChild(d);
        }
        const lastDate = new Date(calYear, m + 1, 0).getDate();
        for (let d = 1; d <= lastDate; d++) {
          const p = (n) => String(n).padStart(2, '0');
          const iso = `${calYear}-${p(m + 1)}-${p(d)}`;
          const cell = document.createElement('div');
          cell.className = 'cal-day';
          cell.textContent = d;
          const hit = filled.get(iso);
          if (hit) {
            cell.classList.add('filled');
            if (hit.len > 200) cell.classList.add('filled-2');
            if (hit.len > 800) cell.classList.add('filled-3');
            const countPart = hit.count > 1 ? ` · ${hit.count} entries` : '';
            cell.title = `${iso}${countPart} · ${hit.len} chars` + (hit.photo_count ? ` · ${hit.photo_count} photo${hit.photo_count>1?'s':''}` : '');
            cell.onclick = () => {
              // Scroll to first entry of that date
              const match = allEntries.find(e => e.date === iso);
              if (match) {
                const el = document.getElementById(`entry-${match.id}`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            };
          }
          days.appendChild(cell);
        }
        month.appendChild(days);
        grid.appendChild(month);
      }
      cal.appendChild(grid);
    } catch {}
  }

  document.getElementById('cal-prev')?.addEventListener('click', () => { calYear--; loadCalendar(); });
  document.getElementById('cal-next')?.addEventListener('click', () => { calYear++; loadCalendar(); });

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
    const ids = new Set(results.map(r => r.id));
    renderEntries(allEntries.filter(e => ids.has(e.id)));
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
    const el = document.getElementById(`entry-${pick.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.style.transition = 'background 1s';
      el.style.background = '#fff6e0';
      setTimeout(() => { el.style.background = ''; }, 1500);
    }
  });

  // --- Trash ---
  async function loadTrash() {
    const list = document.getElementById('trash-list');
    list.innerHTML = '<p class="muted">Loading…</p>';
    const items = await fetch('/api/trash').then(r => r.json()).catch(() => []);
    if (!items.length) { list.innerHTML = '<p class="muted">Trash is empty.</p>'; return; }
    list.innerHTML = '';
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'trash-card';
      const trashedWhen = it.trashedAt ? new Date(it.trashedAt).toLocaleString() : '';
      card.innerHTML = `
        <div class="trash-meta">
          <strong>${formatDate(it.date)} — ${formatEntryTime(it.id)}</strong>
          <span class="muted">${it.wordCount} word${it.wordCount === 1 ? '' : 's'} · trashed ${trashedWhen}</span>
        </div>
        <div class="trash-snippet muted"></div>
        <div class="trash-actions">
          <button class="restore-btn">Restore</button>
          <button class="danger-btn perm-del-btn">Delete permanently</button>
        </div>
      `;
      card.querySelector('.trash-snippet').textContent = it.snippet || '(empty)';
      card.querySelector('.restore-btn').onclick = async () => {
        await fetch(`/api/entries/${it.id}/restore`, { method: 'POST' });
        loadTrash();
      };
      card.querySelector('.perm-del-btn').onclick = async () => {
        if (!confirm('Permanently delete this entry? This cannot be undone.')) return;
        await fetch(`/api/entries/${it.id}/permanent`, { method: 'DELETE' });
        loadTrash();
      };
      list.appendChild(card);
    }
  }

  document.getElementById('empty-trash-btn')?.addEventListener('click', async () => {
    if (!confirm('Permanently delete ALL entries in the trash? This cannot be undone.')) return;
    await fetch('/api/trash/empty', { method: 'POST' });
    loadTrash();
  });

  // Reading progress bar
  function updateProgress() {
    const readView = document.getElementById('read');
    if (!readView || readView.classList.contains('hidden')) return;
    const fill = document.getElementById('progress-fill');
    if (!fill) return;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? Math.min(100, Math.max(0, (scrollTop / docHeight) * 100)) : 0;
    fill.style.width = pct + '%';
  }
  window.addEventListener('scroll', updateProgress, { passive: true });
  window.addEventListener('resize', updateProgress);
})();
