(function () {
  const q = document.getElementById('discogs-q');
  if (!q) return;

  const list = document.getElementById('discogs-results');
  const status = document.getElementById('discogs-status');
  const form = document.getElementById('album-form');
  const coverUrl = document.getElementById('cover_url');
  const releaseIdInput = document.getElementById('discogs_release_id');
  const preview = document.getElementById('cover-preview');
  const previewImg = document.getElementById('cover-preview-img');
  const coverClear = document.getElementById('cover-clear');

  let timer = null;
  let abortCtl = null;

  function setStatus(msg) { status.textContent = msg || ''; }
  function hideList() { list.hidden = true; list.innerHTML = ''; }

  function fillField(name, value, { overwrite = false } = {}) {
    const el = form.elements[name];
    if (!el || value == null || value === '') return;
    if (overwrite || !el.value) el.value = value;
  }

  function showCoverFromUrl(url) {
    if (!url) {
      preview.hidden = true; previewImg.src = ''; coverUrl.value = '';
      return;
    }
    coverUrl.value = url;
    previewImg.src = url;
    preview.hidden = false;
  }

  if (coverClear) coverClear.addEventListener('click', () => showCoverFromUrl(null));

  async function loadRelease(id) {
    setStatus('Loading…');
    try {
      const res = await fetch('/api/discogs/release/' + encodeURIComponent(id));
      if (!res.ok) throw new Error('Failed to load release');
      const r = await res.json();
      fillField('title', r.title, { overwrite: true });
      fillField('artist', r.artist, { overwrite: true });
      fillField('year', r.year, { overwrite: true });
      fillField('genre', r.genre, { overwrite: true });
      fillField('label', r.label, { overwrite: true });
      fillField('notes', r.notes);
      showCoverFromUrl(r.cover_url);
      if (releaseIdInput) releaseIdInput.value = id;
      setStatus('Filled from Discogs');
      hideList();
    } catch (err) {
      setStatus('Could not load release');
    }
  }

  async function search(term) {
    if (abortCtl) abortCtl.abort();
    abortCtl = new AbortController();
    setStatus('Searching…');
    try {
      const res = await fetch('/api/discogs/search?q=' + encodeURIComponent(term), {
        signal: abortCtl.signal,
      });
      if (!res.ok) throw new Error('search failed');
      const { results } = await res.json();
      if (!results.length) {
        list.innerHTML = '<li class="discogs-empty">No matches</li>';
        list.hidden = false;
        setStatus('');
        return;
      }
      list.innerHTML = results.map((r) => `
        <li class="discogs-result" data-id="${r.id}">
          <div class="discogs-thumb">${r.thumb ? `<img src="${r.thumb}" alt="" loading="lazy" />` : ''}</div>
          <div class="discogs-meta">
            <p class="discogs-title">${escapeHtml(r.title || '')}</p>
            <p class="discogs-sub muted small">${[r.year, r.label, r.genre].filter(Boolean).map(escapeHtml).join(' · ')}</p>
          </div>
        </li>
      `).join('');
      list.hidden = false;
      setStatus('');
    } catch (err) {
      if (err.name !== 'AbortError') setStatus('Search failed');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  q.addEventListener('input', () => {
    const term = q.value.trim();
    clearTimeout(timer);
    if (term.length < 2) { hideList(); setStatus(''); return; }
    timer = setTimeout(() => search(term), 350);
  });

  list.addEventListener('click', (e) => {
    const li = e.target.closest('li.discogs-result');
    if (li) loadRelease(li.dataset.id);
  });
})();
