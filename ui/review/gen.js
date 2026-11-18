// The ✦ Assets tab in the review side panel: what a model made for this film, and the two buttons that make more.
//
// Two rules shape this file. Nothing is sent until the user presses a button, and the price of a clip is on screen
// before that button does anything. A generation is also allowed to be slow: a clip is submitted as a job and this panel
// reports the job's state instead of freezing the film while it renders on someone else's machine.
import { h, api, toast, confirmBox } from '../app.js';

const money = n => (n == null ? '—' : '$' + (+n).toFixed(2));
const when = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(); };

export function genPanel(projectId, projectPath) {
  const host = h('div', { class: 'rv2-gen' });
  // A still is its own file. A clip's still-ness is a single frame, so it is shown as a <video> paused on its first
  // frame: the browser draws that frame without playing anything, which sells "this is a clip" in a way a poster image
  // cannot, and costs nothing when the tab is closed.
  const mediaUrl = rel => '/media?p=' + encodeURIComponent(projectPath + '/' + rel);
  const previewOf = a => {
    if (a.state === 'running' || a.state === 'failed' || !a.file) return h('div', { class: 'gen-thumb gen-thumb-none' }, a.state === 'running' ? '…' : '—');
    const url = mediaUrl(a.file);
    if (a.kind === 'plate') return h('img', { class: 'gen-thumb', src: url, alt: a.name || a.id, loading: 'lazy' });
    return h('div', { class: 'gen-thumbwrap' },
      h('video', { class: 'gen-thumb', src: url, muted: true, playsinline: true, preload: 'metadata' }),
      h('span', { class: 'gen-play', title: 'A clip — plays in the film' }, '▶'));
  };
  let cfg = null;

  const draw = async () => {
    host.innerHTML = '';
    let data = { assets: [] }, spend = { spent: 0, cap: 0 };
    try { [cfg, data, spend] = await Promise.all([api('/api/gen/config'), api(`/api/gen/${projectId}`), api(`/api/gen/${projectId}/spend`)]); }
    catch (e) { host.append(h('p', { class: 'sub' }, 'Could not read gen/: ' + e.message)); return; }

    if (!cfg.enabled) {
      host.append(h('p', { class: 'sub' }, 'Model generation is off. Turn it on in Settings → Generation; anything already in this film\'s gen/ folder still shows below.'));
    }
    // what is there
    if (!data.assets.length) host.append(h('p', { class: 'sub' }, 'Nothing generated for this film yet.'));
    else host.append(h('table', { class: 't' }, h('tbody', {}, ...data.assets.map(a => h('tr', {},
      // The asset's own picture. A table of names and states told you nothing about what a model had made; you had to
      // open the file to find out what you were looking at. A still shows itself; a clip shows a frame of itself with a
      // play badge and its length, so the two kinds are distinguishable at a glance.
      h('td', { class: 'gen-thumbcell' }, previewOf(a)),
      h('td', {}, h('b', {}, a.kind === 'plate' ? '🖼 still' : '🎬 clip'), ' ', h('span', { class: 'mono dim', style: { fontSize: '11px' } }, a.id)),
      h('td', { class: 'dim', style: { fontSize: '12px' } }, a.name || ''),
      h('td', { class: 'num' },
        a.state === 'running' ? h('span', { class: 'dim' }, 'making…') :
        a.state === 'failed' ? h('span', { class: 'red', title: a.error || '' }, 'failed') :
        a.baked ? h('span', { class: 'green' }, 'ready') : h('span', { class: 'dim' }, 'not baked')),
      h('td', { class: 'num' }, money(a.cost)))))));

    if (!cfg.enabled) return;

    // spend, so the cap is never a surprise
    host.append(h('p', { class: 'sub', style: { marginTop: '10px' } }, `Today: ${money(spend.spent)} of a ${money(spend.cap)} cap.`));

    // a still
    const prompt = h('textarea', { rows: '3', placeholder: 'What the still shows: subject, light, lens, mood', style: { width: '100%' } });
    const makePlate = h('button', { onclick: async () => {
      if (!prompt.value.trim()) return toast('Say what the still should show', true);
      makePlate.disabled = true; makePlate.textContent = 'making the still…';
      try { const r = await api(`/api/gen/${projectId}/plate`, { method: 'POST', body: { prompt: prompt.value, size: '1536x1024' } }); toast(`Still ${r.id} added`); prompt.value = ''; draw(); }
      catch (e) { toast(e.message, true); }
      finally { makePlate.disabled = false; makePlate.textContent = '🖼 Make a still'; }
    } }, '🖼 Make a still');

    // a clip, from a still that is already there
    const plates = data.assets.filter(a => a.kind === 'plate' && a.state === 'ready');
    const pick = h('select', {}, plates.map(a => h('option', { value: a.id }, a.name || a.id)));
    const motion = h('textarea', { rows: '2', placeholder: 'The motion: what moves, how the camera behaves', style: { width: '100%' } });
    const priceLine = h('div', { class: 'sub', style: { fontSize: '12px' } }, '');
    const resSel = h('select', {}, ['480p', '768p', '1080p'].map(v => h('option', { value: v, selected: cfg.resolution === v }, v)));
    const durIn = h('input', { type: 'number', min: '1', max: '30', value: String(cfg.duration), style: { width: '70px' } });
    // the estimate here is a courtesy before pressing; the hub re-reads the live price list at submit and refuses if
    // the model has no published price for that resolution, so this number is never the one the cap is checked against
    const PRICE = { '480p': 0.02, '768p': 0.036, '1080p': 0.1, '2K': 0.1 };
    const refresh = () => { const c = PRICE[resSel.value] * (+durIn.value || 0); priceLine.textContent = `About ${money(c)} for ${durIn.value || 0}s at ${resSel.value} (confirmed at submit).`; };
    resSel.onchange = refresh; durIn.oninput = refresh; refresh();
    const makeClip = h('button', { onclick: async () => {
      if (!plates.length) return toast('Make a still first: a clip starts from one', true);
      if (!(await confirmBox('Make a clip?', `${priceLine.textContent} It runs for a few minutes and is added to this film.`, 'Make it'))) return;
      makeClip.disabled = true; makeClip.textContent = 'sending…';
      try {
        const r = await api(`/api/gen/${projectId}/clip`, { method: 'POST', body: { plateId: pick.value, prompt: motion.value, resolution: resSel.value, duration: +durIn.value, aspect: '16:9' } }, 180000);
        toast(`Clip ${r.id} is being made (${money(r.cost)})`); motion.value = ''; draw();
      } catch (e) { toast(e.message, true); }
      finally { makeClip.disabled = false; makeClip.textContent = '🎬 Make a clip'; }
    } }, '🎬 Make a clip');

    host.append(h('h3', { style: { margin: '14px 0 4px' } }, 'Make a still'), prompt, h('div', { class: 'row' }, makePlate));
    if (cfg.keys?.DEEPINFRA_API_KEY === false) host.append(h('p', { class: 'sub', style: { fontSize: '12px' } }, 'No DeepInfra key in Settings → Generation.'));
    host.append(h('h3', { style: { margin: '14px 0 4px' } }, 'Animate a still'),
      plates.length ? pick : h('p', { class: 'sub', style: { fontSize: '12px' } }, 'A clip starts from a still, so make one first.'),
      motion,
      h('div', { class: 'row' }, resSel, durIn, h('span', { class: 'dim', style: { fontSize: '12px' } }, 'seconds')),
      priceLine,
      h('div', { class: 'row' }, makeClip));
    if (cfg.keys?.OPENROUTER_API_KEY === false) host.append(h('p', { class: 'sub', style: { fontSize: '12px' } }, 'No OpenRouter key in Settings → Generation.'));
  };

  draw();
  return { el: host, refresh: draw };
}
