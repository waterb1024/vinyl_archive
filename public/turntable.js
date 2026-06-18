(function () {
  const audio = document.getElementById('tt-audio');
  if (!audio) return;

  const lp = document.getElementById('lp');
  const labelImg = document.getElementById('lp-label-img');
  const tonearm = document.getElementById('tonearm');
  const playBtn = document.getElementById('tt-play');
  const playIcon = playBtn.querySelector('.tt-play-icon');
  const nowPlaying = document.getElementById('now-playing');
  const npTitle = document.getElementById('np-title');
  const npArtist = document.getElementById('np-artist');
  const npSource = document.getElementById('np-source');

  let current = null; // { id, title, artist, cover, previewUrl }
  const previewCache = new Map(); // id -> { previewUrl, trackName, artistName } | null

  function setState(state) {
    lp.dataset.state = state;
    tonearm.dataset.state = state === 'playing' ? 'on' : 'off';
    playIcon.textContent = state === 'playing' ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
  }

  const colorCache = new Map();

  function showCard(card) {
    labelImg.src = card.dataset.cover;
    labelImg.alt = card.dataset.title;
    npTitle.textContent = card.dataset.title;
    npArtist.textContent = card.dataset.artist;
    nowPlaying.dataset.state = 'active';
    applyLpColor(card.dataset.cover);
  }

  async function applyLpColor(coverUrl) {
    let color = colorCache.get(coverUrl);
    if (color === undefined) {
      color = await extractVinylColor(coverUrl);
      colorCache.set(coverUrl, color);
    }
    if (color) lp.style.setProperty('--lp-color', color);
  }

  function extractVinylColor(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const size = 32;
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 200) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          if (!n) return resolve(null);
          r /= n; g /= n; b /= n;
          const [h, s, l] = rgbToHsl(r, g, b);
          const sat = Math.min(1, s * 1.6 + 0.1);
          const light = Math.max(0.18, Math.min(0.42, l));
          resolve(hslToCss(h, sat, light));
        } catch {
          resolve(null);
        }
      };
      img.src = url;
    });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    return [h * 60, s, l];
  }

  function hslToCss(h, s, l) {
    return `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  }

  async function loadPreview(card) {
    const id = card.dataset.id;
    if (previewCache.has(id)) return previewCache.get(id);
    const url = `/api/itunes/preview?artist=${encodeURIComponent(card.dataset.artist)}&title=${encodeURIComponent(card.dataset.title)}`;
    npSource.textContent = 'Looking up preview…';
    try {
      const res = await fetch(url);
      const { preview } = await res.json();
      previewCache.set(id, preview || null);
      return preview;
    } catch {
      previewCache.set(id, null);
      return null;
    }
  }

  async function playCard(card) {
    showCard(card);
    setState('cueing');
    const preview = await loadPreview(card);
    if (!preview) {
      npSource.textContent = 'No iTunes preview found.';
      setState('idle');
      playBtn.disabled = true;
      return;
    }
    current = { card, ...preview };
    playBtn.disabled = false;
    audio.src = preview.preview_url;
    try {
      await audio.play();
      npSource.textContent = `Apple Music preview · ${preview.track_name} — ${preview.artist_name}`;
    } catch (err) {
      npSource.textContent = 'Click play to start (browser blocked autoplay).';
      setState('idle');
    }
  }

  document.querySelectorAll('.sheet-row .sheet-play').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.sheet-row');
      if (current?.card === row && !audio.paused) {
        audio.pause();
      } else {
        document.querySelectorAll('.sheet-row.active').forEach((r) => r.classList.remove('active'));
        row.classList.add('active');
        playCard(row);
      }
    });
  });

  // Sheet toggle (mobile)
  const sheet = document.getElementById('sheet');
  const sheetToggle = document.getElementById('sheet-toggle');
  const sheetClose = document.getElementById('sheet-close');
  const sheetBackdrop = document.getElementById('sheet-backdrop');
  function openSheet(open) {
    sheet.dataset.open = open ? 'true' : 'false';
    sheetBackdrop.dataset.open = open ? 'true' : 'false';
    sheetToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (sheetToggle) sheetToggle.addEventListener('click', () => openSheet(true));
  if (sheetClose) sheetClose.addEventListener('click', () => openSheet(false));
  if (sheetBackdrop) sheetBackdrop.addEventListener('click', () => openSheet(false));

  // View toggle (list / grid)
  const viewToggle = document.getElementById('view-toggle');
  const sheetList = document.getElementById('sheet-list');
  if (viewToggle && sheetList) {
    const stored = localStorage.getItem('vinyl-archive:view');
    const initial = stored === 'grid' ? 'grid' : 'list';
    const applyView = (mode) => {
      sheetList.classList.toggle('view-grid', mode === 'grid');
      viewToggle.dataset.current = mode;
      viewToggle.setAttribute(
        'aria-label',
        mode === 'grid' ? 'Switch to list view' : 'Switch to grid view'
      );
      viewToggle.setAttribute('aria-pressed', mode === 'grid' ? 'true' : 'false');
    };
    applyView(initial);
    viewToggle.addEventListener('click', () => {
      const next = viewToggle.dataset.current === 'grid' ? 'list' : 'grid';
      applyView(next);
      localStorage.setItem('vinyl-archive:view', next);
    });
  }

  playBtn.addEventListener('click', () => {
    if (!current) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  audio.addEventListener('play', () => setState('playing'));
  audio.addEventListener('pause', () => setState('paused'));
  audio.addEventListener('ended', () => setState('idle'));
})();
