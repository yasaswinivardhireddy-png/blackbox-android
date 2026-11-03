const KINDS = { '': 'All', crash: 'Crashes', native_crash: 'Native crashes', anr: 'ANRs', hang: 'Hangs', non_fatal: 'Non-fatals', leak: 'Leaks', jank: 'Jank', exit: 'System kills' };
const LABEL = { crash: 'CRASH', native_crash: 'NATIVE', anr: 'ANR', hang: 'HANG', non_fatal: 'NON-FATAL', leak: 'LEAK', jank: 'JANK', exit: 'KILLED' };
let kind = new URLSearchParams(location.search).get('kind') ?? '';
let selected = new URLSearchParams(location.search).get('issue');

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x, digits = 1) => (x == null ? 'n/a' : `${(x * 100).toFixed(digits)}%`);
const get = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

function renderKinds() {
  $('#kinds').innerHTML = Object.entries(KINDS)
    .map(([k, label]) => `<button type="button" data-kind="${k}" aria-pressed="${k === kind}">${label}</button>`)
    .join('');
  $('#kinds').onclick = (e) => {
    const k = e.target.closest('button')?.dataset.kind;
    if (k === undefined) return;
    kind = k;
    renderKinds();
    loadIssues();
  };
}

async function loadOverview() {
  const o = await get('/v1/overview');
  const card = (label, value, note = '') => `<div class="card"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  $('#cards').innerHTML = [
    card('Sessions', o.sessions.toLocaleString()),
    card('Crash-free sessions', pct(o.crashFreeSessions, 2), 'JVM and native crashes'),
    card('ANR rate', pct(o.anrRate, 2), 'System-declared ANRs per session'),
    card('Hang rate', pct(o.hangRate, 2), 'Main thread blocked ≥ 2 s'),
    card('Cold start p50 / p90', o.coldStartMs.count ? `${o.coldStartMs.p50} / ${o.coldStartMs.p90} ms` : 'n/a', `${o.coldStartMs.count} cold starts`),
    card('SDK init p50 / p90', o.sdkInitUs.count ? `${o.sdkInitUs.p50} / ${o.sdkInitUs.p90} µs` : 'n/a', 'Main-thread cost of Blackbox.init'),
    card('Slow frames', pct(o.frames.slowShare), `${o.frames.total.toLocaleString()} frames, ${o.frames.frozen} frozen`),
  ].join('');
}

async function loadIssues() {
  const { items } = await get(`/v1/issues${kind ? `?kind=${kind}` : ''}`);
  const body = $('#issues tbody');
  body.innerHTML = items.length
    ? items
        .map(
          (i) => `<tr tabindex="0" data-id="${esc(i.id)}" aria-selected="${i.id === selected}">
            <td><span class="kind ${esc(i.kind)}">${LABEL[i.kind] ?? esc(i.kind)}</span></td>
            <td><div class="title">${esc(i.title)}</div><div class="loc">${esc(i.location)}</div></td>
            <td>${esc(i.category)}</td><td class="num">${i.sessions}</td><td class="num">${i.events}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">No issues yet. Run the sample app and upload reports.</td></tr>';
  body.onclick = (e) => select(e.target.closest('tr')?.dataset.id);
  body.onkeydown = (e) => e.key === 'Enter' && select(e.target.closest('tr')?.dataset.id);
  const target = items.some((i) => i.id === selected) ? selected : items[0]?.id;
  if (target) select(target);
}

function bars(title, rows) {
  if (!rows?.length) return '';
  const max = Math.max(...rows.map((r) => r.sessions));
  return `<h3>${title}</h3><div class="bars">${rows
    .map((r) => `<span>${esc(r.value)}</span><span class="bar" style="width:${Math.max(4, (r.sessions / max) * 100)}%" aria-hidden="true"></span><span class="num">${r.sessions}</span>`)
    .join('')}</div>`;
}

const stack = (frames) =>
  `<pre class="stack">${frames.map((f) => `<span class="${f.inApp ? 'app' : 'other'}">${f.inApp ? '▶ ' : '  '}${esc(f.text)}</span>`).join('\n')}</pre>`;

async function select(id) {
  if (!id) return;
  selected = id;
  history.replaceState(null, '', `?${new URLSearchParams({ ...(kind && { kind }), issue: id })}`);
  document.querySelectorAll('#issues tbody tr').forEach((tr) => tr.setAttribute('aria-selected', String(tr.dataset.id === id)));
  const d = await get(`/v1/issues/${encodeURIComponent(id)}`);
  const a = d.analysis;
  const device = d.sample.device;
  $('#detail-title').textContent = a.title;
  $('#detail').innerHTML = `
    <div class="loc">${esc(a.location)}</div>
    <div class="explain"><strong>${esc(a.category)}</strong> <span class="confidence">(${esc(a.confidence)} confidence)</span><br>${esc(a.explanation)}</div>
    <h3>Evidence</h3><ul class="evidence">${a.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    ${d.hotspots.length ? `<div class="flag">⚠ Concentrated on <strong>${esc(d.hotspots[0].value)}</strong> (${esc(d.hotspots[0].dimension)}): ${pct(d.hotspots[0].issueShare, 0)} of affected sessions vs ${pct(d.hotspots[0].fleetShare, 0)} of all sessions.</div>` : ''}
    ${a.frames.length ? `<h3>Stack ${a.retraced ? '(retraced with R8 mapping)' : ''}${a.symbolicated ? '(symbolicated)' : ''} <span class="hint">▶ marks app frames</span></h3>${stack(a.frames)}` : ''}
    ${(a.threads ?? []).filter((t) => t.frames.length).map((t) => `<h3>Thread "${esc(t.name)}" (${esc(t.state)})</h3>${stack(t.frames)}`).join('')}
    ${d.sample.breadcrumbs.length ? `<h3>Breadcrumbs</h3><ol class="crumbs">${d.sample.breadcrumbs.slice(-12).map((b) => `<li>[${esc(b.c)}] ${esc(b.m)}</li>`).join('')}</ol>` : ''}
    <h3>Latest sample</h3><div class="hint">${esc(device.manufacturer)} ${esc(device.model)}, API ${device.sdkInt} · app ${esc(d.sample.app.version)} (${d.sample.app.build}) · ${new Date(d.sample.timestamp).toISOString()}</div>
    ${bars('Sessions by manufacturer', d.byManufacturer)}${bars('Sessions by Android API level', d.byOsVersion)}${bars('Sessions by app version', d.byAppVersion)}`;
}

async function loadHotspots() {
  const { flagged } = await get('/v1/hotspots');
  $('#hotspots').innerHTML = flagged.length
    ? flagged
        .map((h) => {
          const s = h.segments[0];
          return `<div class="flag"><strong>${esc(h.issue.title)}</strong> (${esc(h.issue.category)})<br>${pct(s.issueShare, 0)} of affected sessions are on <strong>${esc(s.value)}</strong> (${esc(s.dimension)}), which is ${pct(s.fleetShare, 0)} of all sessions: ${s.lift.toFixed(1)}× over-represented.</div>`;
        })
        .join('')
    : '<div class="empty">No issue is concentrated on a device maker, model or Android version.</div>';
}

async function loadJank() {
  const { items } = await get('/v1/jank');
  $('#jank tbody').innerHTML = items.length
    ? items
        .map((j) => `<tr><td class="loc">${esc(j.screen)}</td><td class="num">${j.frames}</td><td class="num">${pct(j.slow / j.frames)}</td><td class="num">${j.frozen}</td><td class="num">${Math.round(j.worstMs)} ms</td></tr>`)
        .join('')
    : '<tr><td colspan="5" class="empty">No frame data yet.</td></tr>';
}

renderKinds();
await Promise.all([loadOverview(), loadIssues(), loadHotspots(), loadJank()]);
