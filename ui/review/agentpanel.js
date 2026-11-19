// The Agent tab: talk to OpenCode from inside NodeCut, in this film's folder.
//
// This is not a terminal. It sends one message at a time to `opencode run` on the hub and shows what comes back: your
// message, the agent's reply, the files it touched, and the CLI's own errors verbatim (a blocked model and a missing
// credit are the two things a user actually hits, and both have to be readable, not a spinner).
//
// Everything goes through the hub so the run happens in the film folder with the user's real environment.
import { openPop } from './dock.js';
// mk('div', 'cls', {attrs}) or mk('div', {attrs}) — a plain class string and an attributes object are both accepted,
// because passing one where the other is expected silently produces class="[object Object]" and a zero-height row.
const mk = (tag, cls, attrs = {}) => {
  const e = document.createElement(tag);
  if (typeof cls === 'string') { if (cls) e.className = cls; }
  else if (cls && typeof cls === 'object') { attrs = cls; }
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
};

export function createAgentPanel({ projectId, api, onEvent, aside = null }) {
  const el = mk('div', 'rv2-agent');
  const log = mk('div', 'ag-log');
  const row = mk('div', 'ag-row');
  const input = mk('textarea', 'ag-input', { rows: 3, placeholder: 'Tell the agent what to do. e.g. "Make beat 3 a chart instead of a clip."' });
  const sendBtn = mk('button', 'primary ag-send'); sendBtn.textContent = 'Send';
  const stopBtn = mk('button', 'ghost ag-stop', { hidden: '' }); stopBtn.textContent = '■ Stop';
  // The model list is ~600 entries, which is not something a native <select> can be used for: you scroll blindly past
  // hundreds of names you cannot read. This is a searchable picker instead — a button showing the current model that
  // opens a specced-over search box and a filtered list. It deliberately keeps a `value` property and fires `change`,
  // so the rest of the panel (saving, reading the model on send) does not need to know the control changed shape.
  const modelBtn = mk('button', 'ag-model', { type: 'button', title: 'Which model the agent uses — click to search' });
  const modelSearch = mk('input', 'ag-modelsearch', { type: 'search', placeholder: 'Search models…', 'aria-label': 'Search models', autocomplete: 'off', spellcheck: 'false' });
  const modelListEl = mk('div', 'ag-modellist', { role: 'listbox', 'aria-label': 'Models' });
  // mk() takes (tag, cls, attrs) and appends no children — passing one as a fourth argument silently drops it, which
  // is why the search box vanished from the popover on the first attempt. Build with append instead.
  const modelPopBox = mk('div', 'ag-modellayer');
  modelPopBox.append(modelSearch, modelListEl);
  let models = [], modelPop = null, modelHi = 0, modelFiltered = [];
  const modelSel = {
    get value() { return this._v || ''; },
    set value(v) { this._v = v || ''; paintModelBtn(); },
  };
  function paintModelBtn() {
    modelBtn.textContent = modelSel._v || 'Default model';
    modelBtn.title = (modelSel._v || 'Default model') + ' — click to search';
  }
  function setModel(v) { const changed = v !== modelSel._v; modelSel._v = v; paintModelBtn(); if (changed) modelBtn.dispatchEvent(new Event('change')); }
  function paintModelList() {
    const q = modelSearch.value.trim().toLowerCase();
    // every whitespace-separated term must appear somewhere in the name, so "deep seek flash" still finds
    // deepinfra/deepseek-ai/DeepSeek-V4-Flash — matching the whole query as one substring would not
    const terms = q ? q.split(/\s+/) : [];
    modelFiltered = terms.length ? models.filter(m => { const l = m.toLowerCase(); return terms.every(t => l.includes(t)); }) : models;
    if (!modelFiltered.length) {
      const msg = mk('div', 'ag-modelempty');
      msg.textContent = models.length ? `No model matches “${modelSearch.value.trim()}”.` : 'No models found';
      modelListEl.replaceChildren(msg);
      modelHi = 0; return;
    }
    if (modelHi >= modelFiltered.length) modelHi = 0;
    modelListEl.replaceChildren(...modelFiltered.slice(0, 300).map((m, i) => {
      const row = mk('button', 'ag-modelrow' + (i === modelHi ? ' hi' : '') + (m === modelSel._v ? ' on' : ''), { type: 'button', role: 'option', title: m });
      row.dataset.model = m;
      row.setAttribute('aria-selected', m === modelSel._v ? 'true' : 'false');
      // show the family dimly and the model name clearly: 600 rows of "deepinfra/deepseek-ai/…" all look alike.
      // set the text explicitly: mk() ignores anything past its third argument, so passing text there yields an
      // empty, 10 px high row.
      const cut = m.lastIndexOf('/') + 1;
      if (cut > 0 && cut < m.length) {
        const fam = mk('span', 'ag-modelfam'); fam.textContent = m.slice(0, cut);
        const nm = mk('span', 'ag-modelname'); nm.textContent = m.slice(cut);
        row.append(fam, nm);
      } else {
        const nm = mk('span', 'ag-modelname'); nm.textContent = m;
        row.append(nm);
      }
      row.addEventListener('mouseenter', () => { modelHi = i; highlightModelRows(); });
      row.addEventListener('click', () => { setModel(m); closeModelPop(); });
      return row;
    }));
  }
  function highlightModelRows() {
    [...modelListEl.children].forEach((c, i) => c.classList.toggle('hi', i === modelHi));
    modelListEl.children[modelHi]?.scrollIntoView({ block: 'nearest' });
  }
  function openModelPop() {
    if (modelPop) { closeModelPop(); return; }
    modelSearch.value = '';
    modelHi = Math.max(0, models.indexOf(modelSel._v));
    paintModelList();
    // host must be document.body, not the panel: the popover is position:fixed but it is still trapped in the stacking
    // context of whatever it was appended to. Inside the panel it rendered *under* the timeline canvas (which is later
    // in the DOM and creates its own context), so the list was invisible while every element measured where it should.
    modelPop = openPop({ anchor: modelBtn, host: document.body, content: modelPopBox, onClose: () => { modelPop = null; } });
    modelSearch.focus();
  }
  function closeModelPop() { modelPop?.close(); modelPop = null; }
  modelBtn.addEventListener('click', openModelPop);
  modelSearch.addEventListener('input', () => { modelHi = 0; paintModelList(); });
  modelSearch.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!modelFiltered.length) return;
      modelHi = (modelHi + (e.key === 'ArrowDown' ? 1 : -1) + modelFiltered.length) % modelFiltered.length;
      highlightModelRows();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (modelFiltered[modelHi]) { setModel(modelFiltered[modelHi]); closeModelPop(); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); closeModelPop();
    }
  });
  paintModelBtn();
  const status = mk('div', 'ag-status');
  const statusTxt = mk('span', 'ag-status-txt');
  const etaTxt = mk('span', 'ag-eta');
  etaTxt.hidden = true;
  status.append(statusTxt, etaTxt);
  row.append(input);
  const spacer = mk('span', 'spacer'); const controls = mk('div', 'ag-controls');
  // `aside` is the notes "Send to OpenCode" button. It used to live in the panel's footer, a full-width bar at the
  // very bottom, which meant the Agent tab showed two send buttons in two different places. It belongs next to Send:
  // the two of them share their own row, model picker above, so they can never wrap apart at panel width.
  const sendRow = mk('div', 'ag-sendrow');
  if (aside) sendRow.append(aside);
  sendRow.append(sendBtn);
  controls.append(modelBtn, stopBtn, spacer, sendRow);

  let state = { status: 'idle', entries: [] };
  let busy = false;

  // A brand-new film whose agent never began is the one state where silence looks like the app is broken: the folder
  // exists, the page looks normal, and no work is happening. Show it plainly with a way out, instead of relying on
  // someone noticing there is nothing in the transcript. Declared before the append below, which puts it on the page.
  const stalled = mk('div', 'ag-stalled');
  stalled.hidden = true;
  function paintStalled() {
    const idleAndEmpty = state.status === 'idle' && !(state.entries || []).length;
    stalled.hidden = !(idleAndEmpty && state.hasBrief);
    if (stalled.hidden) return;
    stalled.replaceChildren();
    // mk's third argument is an attribute map, not text: text goes through textContent, as elsewhere in this file.
    stalled.append(
      Object.assign(mk('span', 'ag-stalled-txt'), {
        textContent: 'This film has a brief but the agent has not started building it.',
      }),
      Object.assign(mk('button', 'ag-stalled-btn'), {
        textContent: 'Start building it',
        onclick: async () => {
          stalled.hidden = true;
          try {
            await api(`/api/project/${projectId}/agent/start-building`, { method: 'POST' });
            await refresh(); poll();
          } catch (e) {
            state = { ...state, entries: [...state.entries, { kind: 'error', text: e.message }] };
            renderLog();
          }
        },
      }),
    );
  }

  el.append(stalled, log, row, controls, status);

  const label = (st) => ({
    idle: 'Ready', running: 'Working…', done: 'Done', failed: 'Failed', stopped: 'Stopped', timeout: 'Timed out',
  }[st] || st);

  function renderLog() {
    // the transcript is rebuilt from the server's copy each poll: no client-side drift, no lost lines
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren();
    if (!state.entries.length) {
      log.append(mk('div', 'ag-empty'), Object.assign(mk('div', 'ag-empty-in'), { textContent: 'Ask the agent to plan, build or fix this film. It works in this project folder.' }));
    }
    paintStalled();
    for (const e of state.entries) {
      if (e.kind === 'you') log.append(withText(mk('div', 'ag-you'), e.text));
      else if (e.kind === 'text') log.append(withText(mk('div', 'ag-text'), e.text));
      else if (e.kind === 'tool') log.append(withText(mk('div', 'ag-tool'), '⚙ ' + e.text));
      else if (e.kind === 'error') log.append(withText(mk('div', 'ag-err'), e.text));
      else if (e.kind === 'raw') log.append(withText(mk('div', 'ag-raw'), e.text));
      else if (e.kind === 'thinking') { /* not shown by default; the reply is what matters */ }
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
    // textContent on a container deletes its children, which silently removed the ETA span. The label is its own node so
    // the ETA can sit beside it and survive every redraw.
    statusTxt.textContent = label(state.status) + (state.model ? ' · ' + state.model : '');
    status.className = 'ag-status ' + state.status;
    // The ETA sits at the right-hand end of the status row, under Send. While running it shows what is known and how far
    // along it is; once it was running long enough for the estimate to be worth stating, it counts down.
    const eta = state.eta && state.status === 'running' ? state.eta : null;
    if (eta) {
      const bits = [];
      if (eta.steps) bits.push(`step ${eta.steps}`);
      bits.push(eta.text);
      etaTxt.textContent = bits.join(' · ');
      etaTxt.className = 'ag-eta' + (eta.confident === false ? ' late' : '');
      etaTxt.hidden = false;
    } else if (etaTxt) {
      etaTxt.hidden = true;
      etaTxt.textContent = '';
    }
    const running = state.status === 'running';
    sendBtn.disabled = running || busy;
    stopBtn.hidden = !running;
    sendBtn.textContent = running ? 'Working…' : 'Send';
  }

  function withText(node, text) { node.textContent = text; return node; }

  async function refresh() {
    try {
      const s = await api(`/api/project/${projectId}/agent`);
      state = s;
      renderLog();
    } catch { /* the hub may be down for a moment; the next poll fixes it */ }
  }

  async function loadModels() {
    try {
      const r = await api('/api/agent/models');
      models = r.models || [];
      const saved = localStorage.getItem('vh-agent-model') || r.default || '';
      // a saved model that no longer exists falls back to the configured default, then to the first
      modelSel.value = models.includes(saved) ? saved : (r.default && models.includes(r.default) ? r.default : (models[0] || ''));
      if (modelPop) paintModelList();
    } catch { /* leave the picker empty; the run still uses the CLI default */ }
  }

  async function send() {
    const message = input.value.trim();
    if (!message || busy) return;
    busy = true;
    sendBtn.disabled = true;
    const model = modelSel.value || null;
    if (model) localStorage.setItem('vh-agent-model', model);
    try {
      state = await api(`/api/project/${projectId}/agent`, { method: 'POST', body: { message, model } });
      input.value = '';
      renderLog();
      poll();
    } catch (e) {
      busy = false;
      state = { ...state, status: 'failed', entries: [...state.entries, { kind: 'you', text: message }, { kind: 'error', text: e.message }] };
      renderLog();
    } finally { busy = false; sendBtn.disabled = state.status === 'running'; }
  }

  async function stopRun() {
    try { state = await api(`/api/project/${projectId}/agent`, { method: 'POST' }); } catch { }
    try { await api(`/api/project/${projectId}/agent/stop`, { method: 'POST' }); } catch { }
    setTimeout(refresh, 300);
  }

  let timer = null;
  function poll() {
    clearInterval(timer);
    timer = setInterval(async () => {
      await refresh();
      if (state.status !== 'running') { clearInterval(timer); timer = null; }
    }, 1200);
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stopRun);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { /* newline: a message can be several lines */ }
  });
  // saving happens whenever the picker changes, which covers both a click and Enter on a search result
  modelBtn.addEventListener('change', () => localStorage.setItem('vh-agent-model', modelSel.value));

  const off = onEvent ? onEvent('agent', () => { if (state.status === 'running') refresh(); }) : null;

  return {
    el,
    init: async () => { await refresh(); await loadModels(); if (state.status === 'running') poll(); },
    destroy: () => { clearInterval(timer); if (off) off(); },
    focus: () => input.focus(),
  };
}
