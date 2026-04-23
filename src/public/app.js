(async () => {
  const me = await fetch('/api/me').then(r => r.json());
  if (!me.role) { location.href = '/login'; return; }
  const isWriter = me.role === 'writer';

  const roleLabel = document.getElementById('role-label');
  roleLabel.textContent = isWriter ? 'Writing' : 'Reading';

  const writeTab = document.querySelector('[data-view="write"]');
  const readTab = document.querySelector('[data-view="read"]');
  const backupBtn = document.getElementById('backup-btn');
  if (!isWriter) {
    writeTab.style.display = 'none';
    backupBtn.style.display = 'none';
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
            ['blockquote', 'link', 'image'],
            ['clean'],
          ],
          handlers: {
            image: () => document.getElementById('photo-input').click(),
          },
        },
      },
    });

    quill.on('text-change', (_delta, _old, source) => {
      if (source === 'user') scheduleSave();
    });

    const photoInput = document.getElementById('photo-input');
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0];
      photoInput.value = '';
      if (!file || !currentDate) return;
      setStatus('Uploading photo…');
      const fd = new FormData();
      fd.append('photo', file);
      const r = await fetch(`/api/entries/${currentDate}/photos`, { method: 'POST', body: fd });
      if (!r.ok) { setStatus('Upload failed'); return; }
      const { url } = await r.json();
      const range = quill.getSelection(true);
      quill.insertEmbed(range.index, 'image', url, 'user');
      quill.setSelection(range.index + 1);
    });

    // Save on blur and before leaving page
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
  async function loadTimeline() {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '<p class="muted">Loading…</p>';
    const entries = await fetch('/api/entries').then(r => r.json());
    if (!entries.length) {
      timeline.innerHTML = '<p class="muted">No entries yet.</p>';
      return;
    }
    timeline.innerHTML = '';
    for (const { date } of entries) {
      const e = await fetch(`/api/entries/${date}`).then(r => r.json());
      const article = document.createElement('article');
      article.className = 'entry';
      const h = document.createElement('h2');
      h.textContent = formatDate(date);
      const body = document.createElement('div');
      body.className = 'entry-body ql-editor';
      body.innerHTML = e.html || '<p class="muted">(empty)</p>';
      article.appendChild(h);
      article.appendChild(body);
      timeline.appendChild(article);
    }
  }
})();
