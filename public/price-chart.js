(function () {
  const root = document.getElementById('price-chart');
  if (!root) return;
  const albumId = root.dataset.albumId;
  const status = document.getElementById('price-chart-status');

  fetch(`/albums/${albumId}/price-history`)
    .then((r) => r.json())
    .then(({ months }) => render(months || []))
    .catch(() => { status.textContent = 'Failed to load history.'; });

  function lastNMonths(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      out.push(label);
    }
    return out;
  }

  function render(months) {
    const labels = lastNMonths(6);
    const dataByLabel = new Map(months.map((m) => [m.month, Number(m.krw) || 0]));
    const pts = labels.map((label) => ({
      label,
      value: dataByLabel.has(label) ? dataByLabel.get(label) : null,
    }));
    const dataPts = pts.filter((p) => p.value != null);

    if (dataPts.length === 0) {
      status.textContent = '아직 시세 데이터가 없습니다 — 자동 수집이 곧 채워줍니다.';
      return;
    }
    status.textContent = dataPts.length === 1
      ? '시세 추적 시작 — 시간이 지나면서 그래프가 채워집니다.'
      : '';

    const w = root.clientWidth || 600;
    const h = 220;
    const pad = { l: 56, r: 16, t: 16, b: 32 };
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;

    const vals = dataPts.map((p) => p.value);
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
    const xAt = (i) => pad.l + i * xStep;
    const yAt = (v) => pad.t + innerH - ((v - yMin) / ySpan) * innerH;

    // Line: connect consecutive non-null points
    const lineSegs = [];
    let currentSeg = [];
    pts.forEach((p, i) => {
      if (p.value == null) {
        if (currentSeg.length) { lineSegs.push(currentSeg); currentSeg = []; }
      } else {
        currentSeg.push({ x: xAt(i), y: yAt(p.value) });
      }
    });
    if (currentSeg.length) lineSegs.push(currentSeg);

    const linePath = lineSegs.map((seg) =>
      seg.map((pt, j) => `${j === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ')
    ).join(' ');

    let areaPath = '';
    lineSegs.forEach((seg) => {
      if (seg.length < 2) return;
      const baseY = (pad.t + innerH).toFixed(1);
      const top = seg.map((pt, j) => `${j === 0 ? 'M' : 'L'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
      areaPath += ` ${top} L${seg[seg.length - 1].x.toFixed(1)},${baseY} L${seg[0].x.toFixed(1)},${baseY} Z`;
    });

    const ticks = 4;
    const yGrid = Array.from({ length: ticks + 1 }, (_, i) => {
      const v = yMin + (ySpan * i) / ticks;
      const y = pad.t + innerH - (i / ticks) * innerH;
      return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="grid" />
              <text x="${pad.l - 8}" y="${y + 4}" class="axis-y">${fmtKrwShort(v)}</text>`;
    }).join('');

    const xLabels = pts.map((p, i) => {
      const x = xAt(i);
      const month = p.label.slice(5);
      return `<text x="${x}" y="${h - 10}" class="axis-x">${month}월</text>`;
    }).join('');

    const dots = pts.map((p, i) => {
      if (p.value == null) return '';
      const x = xAt(i);
      const y = yAt(p.value);
      return `<circle cx="${x}" cy="${y}" r="3" class="dot">
                <title>${p.label} · ${fmtKrw(p.value)}</title>
              </circle>`;
    }).join('');

    root.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" class="chart-svg">
        ${yGrid}
        ${areaPath ? `<path d="${areaPath}" class="area" />` : ''}
        ${linePath ? `<path d="${linePath}" class="line" />` : ''}
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
