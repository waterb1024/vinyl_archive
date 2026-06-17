(function () {
  const root = document.getElementById('price-chart');
  if (!root) return;
  const albumId = root.dataset.albumId;
  const status = document.getElementById('price-chart-status');

  fetch(`/albums/${albumId}/price-history`)
    .then((r) => r.json())
    .then(({ months }) => render(months || []))
    .catch(() => { status.textContent = 'Failed to load history.'; });

  function render(months) {
    if (!months.length) {
      status.textContent = 'No data yet — open this page again later to start tracking.';
      return;
    }
    status.textContent = months.length === 1
      ? 'Tracking started — chart fills in as months pass.'
      : '';

    const pts = months.map((m) => ({ label: m.month, value: Number(m.krw) || 0 }));
    const w = root.clientWidth || 600;
    const h = 220;
    const pad = { l: 56, r: 16, t: 16, b: 32 };
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;

    const vals = pts.map((p) => p.value);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    let yMax, yMin;
    if (max === min) {
      yMax = max * 1.2 || 1;
      yMin = Math.max(0, max * 0.8);
    } else {
      const pad10 = (max - min) * 0.1;
      yMax = max + pad10;
      yMin = Math.max(0, min - pad10);
    }
    const ySpan = Math.max(yMax - yMin, 1);

    const xStep = pts.length > 1 ? innerW / (pts.length - 1) : 0;
    const singleX = pad.l + innerW / 2;
    const xy = (i, v) => [
      pts.length > 1 ? pad.l + i * xStep : singleX,
      pad.t + innerH - ((v - yMin) / ySpan) * innerH,
    ];

    let linePath = '';
    let areaPath = '';
    if (pts.length > 1) {
      linePath = pts.map((p, i) => {
        const [x, y] = xy(i, p.value);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      areaPath = linePath +
        ` L${xy(pts.length - 1, yMin)[0].toFixed(1)},${(pad.t + innerH).toFixed(1)}` +
        ` L${xy(0, yMin)[0].toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
    }

    const ticks = 4;
    const yTicks = [];
    for (let i = 0; i <= ticks; i++) {
      const v = yMin + (ySpan * i) / ticks;
      const y = pad.t + innerH - (i / ticks) * innerH;
      yTicks.push({ v, y });
    }

    const xLabels = pts.map((p, i) => {
      const skip = Math.ceil(pts.length / 6);
      if (i % skip !== 0 && i !== pts.length - 1) return '';
      const [x] = xy(i, p.value);
      return `<text x="${x}" y="${h - 10}" class="axis-x">${p.label}</text>`;
    }).join('');

    const yGrid = yTicks.map(({ v, y }) =>
      `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="grid" />
       <text x="${pad.l - 8}" y="${y + 4}" class="axis-y">${fmtKrwShort(v)}</text>`
    ).join('');

    const dots = pts.map((p, i) => {
      const [x, y] = xy(i, p.value);
      return `<circle cx="${x}" cy="${y}" r="3" class="dot">
                <title>${p.label} · ${fmtKrw(p.value)}</title>
              </circle>`;
    }).join('');

    root.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" class="chart-svg">
        ${yGrid}
        <path d="${areaPath}" class="area" />
        <path d="${linePath}" class="line" />
        ${dots}
        ${xLabels}
      </svg>`;
  }

  function fmtKrw(n) { return '₩' + Number(n).toLocaleString('ko-KR'); }
  function fmtKrwShort(n) {
    n = Number(n);
    if (n >= 1e8) return '₩' + (n / 1e8).toFixed(1) + '억';
    if (n >= 1e4) return '₩' + Math.round(n / 1e4) + '만';
    return '₩' + Math.round(n).toLocaleString('ko-KR');
  }
})();
