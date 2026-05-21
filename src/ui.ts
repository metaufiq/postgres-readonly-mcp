export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Postgres Read-Only MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px system-ui, -apple-system, sans-serif; max-width: 880px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin: 0 0 .25rem 0; }
  .subtitle { color: #888; margin-bottom: 1.5rem; }
  .card { border: 1px solid rgba(127,127,127,.3); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .row { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .name { font-weight: 600; font-size: 15px; }
  .meta { color: #888; font-size: 12px; margin-top: 2px; font-family: ui-monospace, monospace; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; vertical-align: middle; margin-left: .5rem; }
  .badge.active { background: #10b98133; color: #059669; }
  .badge.idle { background: rgba(127,127,127,.2); color: #888; }
  button { font: inherit; padding: 6px 12px; border: 1px solid rgba(127,127,127,.4); background: transparent; border-radius: 5px; cursor: pointer; color: inherit; }
  button.primary { background: #2563eb; color: white; border-color: #2563eb; }
  button.danger { color: #dc2626; border-color: #fca5a5; }
  button:hover { opacity: .85; }
  input { font: inherit; padding: 6px 8px; border: 1px solid rgba(127,127,127,.4); border-radius: 4px; width: 100%; background: transparent; color: inherit; box-sizing: border-box; }
  .field { margin-bottom: .5rem; }
  .field label { display: block; font-size: 12px; color: #888; margin-bottom: 3px; }
  .checkbox-field { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; }
  .checkbox-field input { width: auto; }
  .checkbox-field label { margin: 0; color: inherit; font-size: 13px; }
  .hint { color: #888; font-size: 12px; margin-top: -.25rem; margin-bottom: .5rem; }
  .actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  .empty { color: #888; text-align: center; padding: 1.25rem; }
  .error { color: #dc2626; margin-top: .5rem; font-size: 13px; }
  details { margin-top: .75rem; }
  summary { cursor: pointer; color: #2563eb; font-size: 13px; user-select: none; }
  h3 { margin: 0 0 .75rem 0; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
  .modal { background: Canvas; color: CanvasText; border: 1px solid rgba(127,127,127,.4); border-radius: 8px; padding: 1.25rem; width: 100%; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
  .modal h3 { margin-top: 0; }
  .modal .actions { justify-content: flex-end; margin-top: 1rem; }
</style>
</head>
<body>
  <h1>Postgres Read-Only MCP</h1>
  <div class="subtitle">Manage saved database connections. By default passwords are stripped from the URL before being written to disk and must be re-entered on each Connect. Tick <em>Save password</em> to persist the password in <code>connections.json</code> instead.</div>

  <div id="list"></div>

  <div class="card">
    <h3>Add new connection</h3>
    <div class="field">
      <label>Connection name</label>
      <input id="new-name" placeholder="my-prod-db" autocomplete="off">
    </div>
    <div class="field">
      <label>Postgres URL</label>
      <input id="new-url" placeholder="postgresql://user:password@host:5432/dbname" autocomplete="off">
    </div>
    <div class="checkbox-field">
      <input type="checkbox" id="new-save-pw">
      <label for="new-save-pw">Save password in connections.json (skips the prompt on Connect)</label>
    </div>
    <div class="actions">
      <button class="primary" onclick="addConn()">Save & Connect</button>
      <button onclick="addConn(false)">Save only</button>
    </div>
    <div id="new-err" class="error"></div>
  </div>

<script>
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

function esc(s){return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function jsAttr(s){return String(s).replace(/[\\\\'"]/g, c => "\\\\" + c);}

async function load() {
  let data;
  try { data = await api('/api/connections'); }
  catch (e) { document.getElementById('list').innerHTML = '<div class="card empty">Error: ' + esc(e.message) + '</div>'; return; }
  const root = document.getElementById('list');
  if (!data.connections.length) {
    root.innerHTML = '<div class="card empty">No saved connections yet. Add one below.</div>';
    return;
  }
  root.innerHTML = data.connections.map(renderCard).join('');
}

function renderCard(c) {
  const i = c.url_info || {};
  const meta = i.host
    ? (i.user ? i.user + '@' : '') + i.host + (i.port ? ':' + i.port : '') + '/' + (i.db || '')
    : '(unparseable url)';
  const badge = c.active
    ? '<span class="badge active">connected</span>'
    : '<span class="badge idle">idle</span>';
  const n = jsAttr(c.name);
  const id = 'c-' + encodeURIComponent(c.name).replace(/%/g, '_');
  const connectBtn = c.active
    ? '<button onclick="act(\\'' + n + '\\', \\'disconnect\\')">Disconnect</button>'
    : '<button class="primary" onclick="act(\\'' + n + '\\', \\'connect\\', ' + (c.has_saved_password ? 'true' : 'false') + ')">Connect</button>';
  return '<div class="card" id="' + id + '">'
    + '<div class="row">'
      + '<div style="flex:1; min-width:200px">'
        + '<div class="name">' + esc(c.name) + badge + '</div>'
        + '<div class="meta">' + esc(meta) + '</div>'
      + '</div>'
      + '<div class="actions">'
        + connectBtn
        + '<button class="danger" onclick="del(\\'' + n + '\\')">Delete</button>'
      + '</div>'
    + '</div>'
    + '<details>'
      + '<summary>Edit name / URL / password</summary>'
      + '<div style="margin-top:.75rem">'
        + '<div class="field"><label>Name</label><input id="' + id + '-name" value="' + esc(c.name) + '"></div>'
        + '<div class="field"><label>Postgres URL (leave blank to keep current)</label><input id="' + id + '-url" placeholder="postgresql://..."></div>'
        + '<div class="checkbox-field">'
          + '<input type="checkbox" id="' + id + '-save-pw"' + (c.save_password ? ' checked' : '') + '>'
          + '<label for="' + id + '-save-pw">Save password in connections.json</label>'
        + '</div>'
        + '<div class="hint">' + (c.has_saved_password
            ? 'A password is currently stored for this connection.'
            : 'To store a password, provide a URL above that includes one and tick the box.')
          + '</div>'
        + '<div class="actions"><button class="primary" onclick="save(\\'' + n + '\\', \\'' + id + '\\', ' + (c.save_password ? 'true' : 'false') + ')">Save changes</button></div>'
        + '<div id="' + id + '-err" class="error"></div>'
      + '</div>'
    + '</details>'
  + '</div>';
}

function askPassword(name) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">'
        + '<h3>Connect to "' + esc(name) + '"</h3>'
        + '<div class="field">'
          + '<label>Password (leave blank if using .pgpass or trust auth)</label>'
          + '<input id="pw-input" type="password" autocomplete="current-password">'
        + '</div>'
        + '<div class="actions">'
          + '<button id="pw-cancel">Cancel</button>'
          + '<button id="pw-ok" class="primary">Connect</button>'
        + '</div>'
      + '</div>';
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('#pw-input');
    const cleanup = (val) => { document.body.removeChild(backdrop); resolve(val); };
    backdrop.querySelector('#pw-ok').onclick = () => cleanup(input.value);
    backdrop.querySelector('#pw-cancel').onclick = () => cleanup(null);
    backdrop.addEventListener('click', e => { if (e.target === backdrop) cleanup(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') cleanup(input.value);
      else if (e.key === 'Escape') cleanup(null);
    });
    input.focus();
  });
}

async function act(name, action, hasSavedPassword) {
  let opts = { method: 'POST' };
  if (action === 'connect' && !hasSavedPassword) {
    const pw = await askPassword(name);
    if (pw === null) return;
    opts.body = JSON.stringify({ password: pw });
  }
  try { await api('/api/connections/' + encodeURIComponent(name) + '/' + action, opts); }
  catch (e) { alert(e.message); }
  load();
}

async function del(name) {
  if (!confirm('Delete connection "' + name + '"?')) return;
  try { await api('/api/connections/' + encodeURIComponent(name), { method: 'DELETE' }); load(); }
  catch (e) { alert(e.message); }
}

async function save(name, id, previousSavePassword) {
  const newName = document.getElementById(id + '-name').value.trim();
  const newUrl = document.getElementById(id + '-url').value.trim();
  const savePassword = document.getElementById(id + '-save-pw').checked;
  const body = {};
  if (newName && newName !== name) body.name = newName;
  if (newUrl) body.url = newUrl;
  if (savePassword !== previousSavePassword) body.savePassword = savePassword;
  const errEl = document.getElementById(id + '-err');
  errEl.textContent = '';
  if (!Object.keys(body).length) { errEl.textContent = 'Nothing to change'; return; }
  try {
    await api('/api/connections/' + encodeURIComponent(name), { method: 'PUT', body: JSON.stringify(body) });
    load();
  } catch (e) { errEl.textContent = e.message; }
}

async function addConn(connectAfter = true) {
  const nameEl = document.getElementById('new-name');
  const urlEl = document.getElementById('new-url');
  const savePwEl = document.getElementById('new-save-pw');
  const errEl = document.getElementById('new-err');
  const name = nameEl.value.trim();
  const url = urlEl.value.trim();
  const savePassword = savePwEl.checked;
  errEl.textContent = '';
  if (!name || !url) { errEl.textContent = 'Both fields are required'; return; }
  try {
    await api('/api/connections', { method: 'POST', body: JSON.stringify({ name, url, savePassword, connect: connectAfter }) });
    nameEl.value = ''; urlEl.value = ''; savePwEl.checked = false;
    load();
  } catch (e) { errEl.textContent = e.message; }
}

load();
</script>
</body>
</html>`;
