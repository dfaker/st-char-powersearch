
/**
 * ui-wire.js (streaming)
 * - Infinite scroll: renders cards in chunks as you scroll
 * - Resets stream on any filter/sort change
 * - Uses IntersectionObserver with a sentinel element
 */



(function(){
  const qs  = (sel,root=document)=>root.querySelector(sel);
  const qsa = (sel,root=document)=>Array.from(root.querySelectorAll(sel));

  const ctl = {
    search:    qs('input[aria-label="search"]'),
    sortSelect: qs('select.select'),
    boolExpr:  qs('textarea[placeholder*="AND"]'),
    tagBundle: qs('input[aria-label="tag bundle"]'),
    mInput:    qs('input[aria-label="M"]'),
    kMin:      qs('input[aria-label="min tag count"]'),
    kMax:      qs('input[aria-label="max tag count"]'),
    rMin:      qs('input[aria-label="min rarity"]'),   
    weights:   qs('input[placeholder^="weight("]'),
    grid:      qs('.grid[role="list"]'),
    metrics:   qs('.results-head .metrics'),
    sentinel:  qs('.grid .sentinel')
  };


let currentTagFreq = [];   // [{ tag, count }] sorted desc
let currentTagSet  = null; // Set<string> for O(1) membership

function computeTagFreq(rows){
  // Tally tags among the rows we actually care about
  const freq = Object.create(null);
  for (const r of rows){
    const tags = r.tags || [];
    // avoid double-counting duplicates in a single row
    const seen = new Set();
    for (const t of tags){
      if (seen.has(t)) continue;
      seen.add(t);
      freq[t] = (freq[t] || 0) + 1;
    }
  }
  const list = Object.entries(freq)
    .map(([tag,count]) => ({ tag, count }))
    .sort((a,b)=> b.count - a.count || a.tag.localeCompare(b.tag));
  currentTagFreq = list;
  currentTagSet  = new Set(list.map(x => x.tag));
}

// prefix filter over the *useful* tags only, limited for UI
function suggestTags(prefix, limit=200){
  const p = String(prefix||"").toLowerCase();
  let src = currentTagFreq;
  if (p){
    src = src.filter(x => x.tag.indexOf(p) === 0);
  }
  return src.slice(0, limit).map(x => x.tag);
}


  function chip(text){
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = text;
    return span;
  }
  function clear(el){ if (el) el.innerHTML = ''; }
  function truncate(s, n){ s = String(s||""); return s.length > n ? s.slice(0, n-1) + '…' : s; }
  function fmtNum(x){ return Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(x); }


  function debounce(fn, delay = 200) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }


  function computeSimilarityScores(metric, refRow, candidates, store, idfMul){
    const idf = store.idf || {};                              // Σidf data from backend:contentReference[oaicite:0]{index=0}
    const refTags = new Set((refRow.tags||[]).map(String));
    const wRef = Object.create(null);

    // Weights for reference tags (current behavior: 1× boosted by IDF slider):contentReference[oaicite:1]{index=1}
    for (const t of refTags){
      const base = 1 + ((idf[t] || 0) * (idfMul - 1));        // idfMul==1 → 1; >1 boosts rarity:contentReference[oaicite:2]{index=2}
      wRef[t] = base;
    }

    // Precompute norms for cosine (TF=1, IDF weight per tag)
    let refSq = 0;
    if (metric === 'cosine'){
      for (const t of refTags){
        const w = idf[t] || 0;
        refSq += w*w;
      }
      refSq = Math.sqrt(refSq || 1e-12);
    }

    const scored = [];
    for (const r of candidates){
      const tags = new Set((r.tags||[]).map(String));

      if (metric === 'overlap'){               // IDF-boosted overlap (current default behavior)
        let s = 0;
        for (const t of tags) if (t in wRef) s += wRef[t];
        scored.push({ row: r, score: s });

      } else if (metric === 'jaccard'){        // IDF-weighted Jaccard (min/max with IDF weights)
        let num = 0, den = 0;
        const union = new Set([...tags, ...refTags]);
        for (const t of union){
          const wA = tags.has(t)    ? (idf[t] || 0) : 0;
          const wB = refTags.has(t) ? (idf[t] || 0) : 0;
          num += Math.min(wA, wB);
          den += Math.max(wA, wB);
        }
        const s = den > 0 ? (num / den) : 0;
        scored.push({ row: r, score: s });

      } else {                                 // 'cosine' — TF-IDF cosine on tag sets
        // Vector is IDF per present tag; cosine uses idf^2 on overlap / norms
        let dot = 0, aSq = 0;
        for (const t of tags){
          const w = idf[t] || 0;
          aSq += w*w;
          if (refTags.has(t)) dot += w*w;
        }
        const s = dot / ((Math.sqrt(aSq || 1e-12)) * refSq);
        scored.push({ row: r, score: isFinite(s) ? s : 0 });
      }
    }

    scored.sort((a,b)=> b.score - a.score || String(a.row.name||'').localeCompare(String(b.row.name||'')));
    return scored;
  }


  const sortMap = new Map([
    ['Name ↑ (A → Z)',              { by:'name', dir:'asc'  }],
    ['Name ↓ (Z → A)',              { by:'name', dir:'desc' }],
    ['Tag Count ↑ (Smallest → Largest)', { by:'tag_count', dir:'asc' }],
    ['Tag Count ↓ (Largest → Smallest)', { by:'tag_count', dir:'desc'}],
    ['Rarity Σidf ↑ (Smallest → Largest)', { by:'sigma_idf', dir:'asc'}],
    ['Rarity Σidf ↓ (Largest → Smallest)', { by:'sigma_idf', dir:'desc'}],
    ['Favorites → First',           { by:'fav', dir:'desc'}],
    ['Favorites → Last',            { by:'fav', dir:'asc'}],
    ['Creator ↑ (A → Z)',           { by:'creator', dir:'asc'}],
    ['Creator ↓ (Z → A)',           { by:'creator', dir:'desc'}],
    ['Created Date ↑ (Oldest → Newest)', { by:'date_added', dir:'asc'}],
    ['Created Date ↓ (Newest → Oldest)', { by:'date_added', dir:'desc'}],
    ['Last Chat Date ↑ (Oldest → Newest)', { by:'date_last_chat', dir:'asc'}],
    ['Last Chat Date ↓ (Newest → Oldest)', { by:'date_last_chat', dir:'desc'}],
    ['Chat Size ↑ (Smallest → Largest)', { by:'chat_size', dir:'asc'}],
    ['Chat Size ↓ (Largest → Smallest)', { by:'chat_size', dir:'desc'}],
    ['Data Size ↑ (Smallest → Largest)', { by:'data_size', dir:'asc'}],
    ['Data Size ↓ (Largest → Smallest)', { by:'data_size', dir:'desc'}],
  ]);


  function getSortChoice(){
    const sel = ctl.sortSelect;
    if (!sel) return { by:'date_added', dir:'desc' };
    const label = sel.value || sel.getAttribute('selected') || '';
    return sortMap.get(label) || { by:'date_added', dir:'desc' };
  }
  function parseTagBundle(s){
    const out = []; const re = /"([^"]+)"|'([^']+)'|([^,\s][^,]*)/g; let m;
    while ((m = re.exec(String(s||"")))){ const tag=(m[1]||m[2]||m[3]||'').trim(); if (tag) out.push(tag); }
    return out;
  }

  function runNgramProbableTags(){

    const host = document.getElementById('finalSection')
    if(host){
      host.remove();
    }

    const B = window.CardsBackend;
    if (!B?.store) return;
    const { store, setBlocking, setProgress, setLoadStatusText } = B;

    // Tunables (kept conservative)
    const N_MIN = 1;               // use unigrams too
    const N_MAX = 3;               // up to tri-grams
    const BATCH = 300;             // rows per chunk (non-blocking)
    const THRESH_P = 0.35;         // min aggregated probability
    const MIN_EVID = 2;            // require at least 2 n-gram "votes"
    const MAX_ADD_PER_ROW = 6;     // cap how many new tags we add per row

    // Helpers
    const stripHtml = (s)=> String(s||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    const tokenize = (s)=>{
      // alpha-num tokens; fold case
      return String(s||"")
        .toLowerCase()
        .replace(/&[a-z0-9#]+;/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    };
    const ngramsOf = (tokens)=>{
      const out = new Set();
      for (let n=N_MIN; n<=N_MAX; n++){
        for (let i=0; i+n<=tokens.length; i++){
          out.add(tokens.slice(i, i+n).join(" "));
        }
      }
      return out;
    };

    // Phase 0: show loader
    setBlocking?.(true);
    setLoadStatusText?.("Analyzing n-grams…");
    setProgress?.(0.02, "Preparing");

    const rows = store.rows;
    const total = rows.length;

    // Phase 1: build ngram → { df, tagCounts } (row-level DF to avoid double-count)
    const nDF = new Map();                 // ngram -> df (row count)
    const nTagCounts = new Map();          // ngram -> Map(tag -> count)
    const perRowNgrams = new Array(total); // cache to avoid recompute in phase 2
    let i = 0;

    function phase1Chunk(){
      const start = i;
      for (; i < Math.min(start + BATCH, total); i++){
        const r = rows[i];
        // text surface (already sanitized by backend)
        const text = stripHtml((r.creator_notes||"") + " " + (r.description||""));
        if (!text) { perRowNgrams[i] = null; continue; }

        const toks = tokenize(text);
        if (!toks.length) { perRowNgrams[i] = null; continue; }

        const ngs = ngramsOf(toks);
        perRowNgrams[i] = ngs;

        // update df and tag co-occurrence
        for (const g of ngs){
          nDF.set(g, (nDF.get(g) || 0) + 1);
          let tmap = nTagCounts.get(g);
          if (!tmap){ tmap = new Map(); nTagCounts.set(g, tmap); }
          // count each tag once per row
          for (const t of new Set(r.tags || [])){
            tmap.set(t, (tmap.get(t) || 0) + 1);
          }
        }
      }
      const p = 0.02 + 0.48 * (i / total);
      setProgress?.(p, `Scanning texts ${i}/${total}`);
      if (i < total) {
        setTimeout(phase1Chunk, 0); // yield
      } else {
        // proceed
        j = 0;
        setLoadStatusText?.("Scoring tags from n-grams…");
        setTimeout(phase2Chunk, 0);
      }
    }

    // Phase 2: per-row scoring: score[tag] = Σ_g  P(tag|g), where P(tag|g)=count(tag,g)/df(g)
    let j = 0;
    let addedTotal = 0;

    function phase2Chunk(){
      const start = j;
      for (; j < Math.min(start + BATCH, total); j++){
        const r = rows[j];
        const ngs = perRowNgrams[j];
        if (!ngs || !ngs.size) continue;

        const have = new Set((r.tags||[]));
        const scores = new Map();
        const evid  = new Map();

        for (const g of ngs){
          const df = nDF.get(g) || 0;
          if (df <= 0) continue;
          const tmap = nTagCounts.get(g);
          if (!tmap) continue;
          for (const [tag, c] of tmap){
            if (have.has(tag)) continue;            // skip existing tags
            const p = c / df;                       // P(tag|g)
            scores.set(tag, (scores.get(tag)||0) + p);
            evid.set(tag,  (evid.get(tag)||0)  + 1);
          }
        }

        // pick candidates above thresholds
        const candidates = [];
        for (const [tag, sc] of scores){
          if (sc >= THRESH_P && (evid.get(tag)||0) >= MIN_EVID){
            candidates.push({ tag, sc });
          }
        }
        candidates.sort((a,b)=> b.sc - a.sc || a.tag.localeCompare(b.tag));

        // cap additions; update row in-place (virtual tags)
        let added = 0;
        for (const c of candidates.slice(0, MAX_ADD_PER_ROW)){
          if (have.has(c.tag)) continue;
          r.tags.push(c.tag);
          (r._virtualTags || (r._virtualTags = new Set())).add(c.tag);
          added++;
        }
        if (added){
          // keep basic derived numbers consistent-ish using existing idf
          r.tag_count = r.tags.length;
          let sum = 0;
          for (const t of r.tags) sum += (store.idf[t] || 0);
          r.sigma_idf = sum;
          addedTotal += added;
        }
      }

      const p = 0.50 + 0.48 * (j / total);
      setProgress?.(p, `Scoring & applying ${j}/${total}`);
      if (j < total) {
        setTimeout(phase2Chunk, 0);
      } else {
        setProgress?.(0.99, `Applied ~${addedTotal} tags`);
        setLoadStatusText?.(`Applied ~${addedTotal} probable tags`);
        // Rerun filters/sort and re-render
        try { apply(); } catch {}
        // small delay so the "Ready" flash is visible
        setTimeout(()=> setBlocking?.(false), 120);
      }
    }

    // kick it off
    setTimeout(phase1Chunk, 0);
  }


function ensureDetailsModal(){
  if (document.getElementById('ps-details-modal')) return;
  const el = document.createElement('div');
  el.id = 'ps-details-modal';
  el.style.cssText = `
    position:fixed; inset:0; display:none; z-index:99999;
    background:rgba(0,0,0,.6); backdrop-filter: blur(4px);
  `;
  el.innerHTML = `
    <div style="position:absolute; inset:0; display:grid; place-items:center">
      <div style="width:min(960px,92vw); max-height:80vh; overflow:auto;
                  background:#0c1117; border:1px solid #1f2937; border-radius:12px;
                  box-shadow:0 16px 70px rgba(0,0,0,.6); color:#e5e7eb; padding:14px">

        <!-- BIG AVATAR -->
        <div style="text-align:center; margin-bottom:12px">
          <img id="psd-avatar"
               style="max-height:500px; border-radius:16px;
                      border:1px solid #1f2937; object-fit:cover; background:#111827" />
        </div>

        <!-- Title and Close -->
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px">
          <div style="flex:1 1 auto; min-width:0">
            <div id="psd-title" style="font-weight:700; white-space:nowrap;
                overflow:hidden; text-overflow:ellipsis">Details</div>
            <div id="psd-sub" class="micro" style="color:#93a3af"></div>
          </div>
          <button id="psd-close" class="btn" style="color:white;">Close</button>
        </div>

        <!-- Tabs -->
        <div style="display:flex; gap:6px; border-bottom:1px solid #1f2937; margin-bottom:10px">
          <button id="psd-tab-overview" class="btn" data-active="true"
                  style="padding:6px 10px; border-bottom:2px solid #60a5fa;color:white;">Overview</button>
          <button id="psd-tab-json" class="btn"
                  style="padding:6px 10px; border-bottom:2px solid transparent;color:white;">JSON</button>
        </div>

        <!-- Overview content -->
        <div id="psd-overview" style="display:block"></div>

        <!-- JSON content -->
        <pre id="psd-json" style="display:none; margin:0; white-space:pre-wrap; word-break:break-word;
             background:#0b0f16; border:1px solid #1f2937; border-radius:8px; padding:12px;
             font-family:ui-monospace,Menlo,Consolas,monospace;"></pre>
      </div>
    </div>`;
  document.body.appendChild(el);

  el.querySelector('#psd-close')?.addEventListener('click', ()=> el.style.display='none');

  // Tab switching
  const tabA = el.querySelector('#psd-tab-overview');
  const tabB = el.querySelector('#psd-tab-json');
  const paneA = el.querySelector('#psd-overview');
  const paneB = el.querySelector('#psd-json');

  function activate(which){
    const a = (which === 'overview');
    tabA.dataset.active = a ? 'true' : 'false';
    tabB.dataset.active = a ? 'false' : 'true';
    tabA.style.borderBottom = a ? '2px solid #60a5fa' : '2px solid transparent';
    tabB.style.borderBottom = !a ? '2px solid #60a5fa' : '2px solid transparent';
    paneA.style.display = a ? 'block' : 'none';
    paneB.style.display = a ? 'none' : 'block';
  }
  tabA.addEventListener('click', ()=> activate('overview'));
  tabB.addEventListener('click', ()=> activate('json'));
  activate('overview');

  // one global listener for producer replies
  if (window.channel && !window.__psDetailsWired){
    window.__psDetailsWired = true;
    window.channel.addEventListener('message', (ev) => {
      const d = ev?.data;
      if (!d || d.type !== 'details') return;
      fillDetailsModal({ loading:false, id:d.id, data:d.data });
    });
  }
}

function fillDetailsModal({ loading, id, name, avatar, data }){
  // Ensure the modal exists (creates the new 2-tab one if missing)
  ensureDetailsModal();

  const wrap = document.getElementById('ps-details-modal');
  if (!wrap) { console.error('[ps] modal wrapper missing'); return; }

  wrap.style.display = 'block';

  // Try new IDs first, then fall back to old IDs
  const t   = wrap.querySelector('#psd-title')          || wrap.querySelector('#ps-details-title');
  const sub = wrap.querySelector('#psd-sub')            || wrap.querySelector('#ps-details-sub');
  const av  = wrap.querySelector('#psd-avatar')         || null;
  const pre = wrap.querySelector('#psd-json')           || wrap.querySelector('#ps-details-body');
  const ov  = wrap.querySelector('#psd-overview')       || null; // old modal had no overview

  // If even title is missing, bail gracefully
  if (!t) { console.error('[ps] modal content not found (did old/new IDs mismatch?)'); return; }

  // Loading state
  if (loading){
    if (t)   t.textContent = name ? `Details — ${name}` : 'Details';
    if (sub) sub.textContent = (id != null) ? `• id ${id}` : '';

    if (av && avatar){
      av.src = `/thumbnail?type=avatar&file=${avatar}`;
    }

    if (pre) pre.textContent = '(loading…)';
    if (ov)  ov.innerHTML = `<div style="color:#9ca3af">(loading…)</div>`;
    return;
  }

  // Got data: normalize and render
  const n = normalizeCard(data || {});
  if (t)   t.textContent = n.name ? `Details — ${n.name}` : 'Details';
  if (sub) sub.textContent = (id != null) ? `• id ${id}` : '';
  if (av && n.avatar){
    av.style.backgroundImage = `url(/thumbnail?type=avatar&file=${n.avatar})`;
    av.style.backgroundSize = 'cover';
  }
  if (pre) pre.textContent = JSON.stringify(data ?? null, null, 2);
  if (ov)  ov.innerHTML = renderOverviewHTML(n); // if old modal is present, ov is null and this is skipped
}


function normalizeCard(d){
  const top = d || {};
  const inner = (top.data && typeof top.data === 'object') ? top.data : {};
  const get = (k, def=null) => (top[k] ?? inner[k] ?? def);

  // existing fields
  const name = get('name', top.name || inner?.data?.name || '');
  const avatar = get('avatar', top.avatar || '');
  const desc = get('description', '');
  const first_mes = get('first_mes', '');
  const scenario = get('scenario', '');
  const tags = get('tags', []);
  const creator_notes = get('creator_notes', '');
  const spec = top.spec || inner.spec || 'unknown';
  const spec_version = top.spec_version || inner.spec_version || '';
  const character_version = get('character_version', '');
  const creator = get('creator', '');

  // NEW: fields you asked to surface
  const personality = get('personality', '');
  const mes_example = get('mes_example', '');
  const system_prompt = get('system_prompt', '');
  const post_history_instructions = get('post_history_instructions', '');
  const alternate_greetings = Array.isArray(get('alternate_greetings', []))
    ? get('alternate_greetings', [])
    : [];

  // small redactor so Overview stays snappy
  const clamp = (s, n=1400) => (typeof s === 'string' && s.length > n ? s.slice(0,n) + '…' : s);

  return {
    name, avatar, spec, spec_version, character_version, creator,
    tags: Array.isArray(tags) ? tags : [],
    description: clamp(desc, 2000),
    scenario: clamp(scenario, 1200),
    first_mes: clamp(first_mes, 1000),
    creator_notes: clamp(creator_notes, 800),

    // NEW
    personality: clamp(personality, 1000),
    mes_example: clamp(mes_example, 1000),
    system_prompt: clamp(system_prompt, 1000),
    post_history_instructions: clamp(post_history_instructions, 800),
    alternate_greetings: alternate_greetings.map(s => clamp(String(s ?? ''), 1000)),
  };
}


function renderOverviewHTML(n){
  const pill = (t)=> `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid #1f2937;border-radius:999px;background:#0b1220">${escapeHTML(t)}</span>`;
  const row = (k,v)=> `
    <div style="display:grid; grid-template-columns:140px 1fr; gap:10px; padding:8px 0; border-bottom:1px solid #111827">
      <div style="color:#93a3af">${k}</div>
      <div>${v}</div>
    </div>`;

  // helper to render pre-wrapped text blocks
  const pre = (s)=> `<div style="white-space:pre-wrap">${escapeHTML(s || '')}</div>`;

  // render alternate greetings as individual rows (AG #1, AG #2, …)
  const agRows = (Array.isArray(n.alternate_greetings) && n.alternate_greetings.length)
    ? n.alternate_greetings.map((g, i) => row(`AG #${i+1}`, pre(g))).join('')
    : '';

  return `
    <div style="display:grid; gap:4px">
      ${row('Name',       `<strong>${escapeHTML(n.name || '(unknown)')}</strong>`)}
      ${row('Spec',       `${escapeHTML(n.spec)} ${n.spec_version ? `· v${escapeHTML(n.spec_version)}`:''}`)}
      ${row('Creator',    `${escapeHTML(n.creator || '')} ${n.character_version ? `· ${escapeHTML(n.character_version)}`:''}`)}
      ${row('Tags',       (n.tags?.length ? n.tags.map(pill).join('') : `<span style="color:#6b7280">(none)</span>`))}

      ${row('Scenario',   pre(n.scenario))}
      ${row('First Message', pre(n.first_mes))}
      ${row('Description', pre(n.description))}
      ${row('Creator Notes', pre(n.creator_notes))}

      <!-- NEW fields -->
      ${row('Personality', pre(n.personality))}
      ${row('Message Example', pre(n.mes_example))}
      ${row('System Prompt', pre(n.system_prompt))}
      ${row('Post-History Instr.', pre(n.post_history_instructions))}

      ${agRows}
    </div>
  `;
}


function escapeHTML(s){
  return String(s ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#39;");
}




function makeCard(r, weights){
  const score = (() => {
    // In similarity mode, use the similarity score if available
    if (r._similarityScore !== undefined) return r._similarityScore;
    // Otherwise use weights-based scoring
    if (!weights || !weights.size) return 0;
    let s = 0; for (const t of r.tags){ const w = weights.get(t); if (w) s += w; }
    return s;
  })();

  const node = document.createElement('article');
  node.className = 'card';
  node.setAttribute('role','listitem');


  node.innerHTML = `
    <div class="avatar" data-avatar>84×84</div>
    <div>
      <h4 style="margin:2px 0 4px">
        <span data-name>${r.name || '(unnamed)'}</span>
        <span class="micro">• id <span data-id>${r.id}</span></span>
      </h4>
      <div class="meta">
        <span>k=<span data-k>${r.tag_count ?? 0}</span></span>
        <span>Σidf=<span data-sigma>${fmtNum(r.sigma_idf ?? 0)}</span></span>
        <span>score=<span data-score>${fmtNum(score)}</span></span>
        <span class="micro" data-lastchat>Last chat: ${
          r.date_last_chat ? new Date(r.date_last_chat).toLocaleDateString() : '—'
        }</span>
      </div>
      <div class="tags">
        <span class="micro">Tags: </span>
        <span class="list" data-tags>${(r.tags && r.tags.length) ? r.tags.join(', ') : '—'}</span>
      </div>
      <p class="snippet" data-snippet">${
        (r.description || r.creator_notes || '—').replace(/\s+/g,' ').slice(0,219)
      }${
        ((r.description||'').length > 219 || (r.creator_notes||'').length > 512) ? '…' : ''
      }</p>
      <div class="card-actions">
        <a href="#" class="btn" role="button" data-action="view-similar">Similar</a>
        <a href="#" class="btn" role="button" data-action="view-details">Details</a>
        <a href="#" class="btn" role="button" data-action="start-chat">Chat</a>
      </div>
    </div>
  `;

  // Avatar
  const av = node.querySelector('[data-avatar]');
  if (r.avatar){
    av.style.backgroundImage = `url(/thumbnail?type=avatar&file=${r.avatar})`;
    av.textContent = '';
  }

  // Wire Start Chat → broadcast selection to producer
  const startBtn = node.querySelector('[data-action="start-chat"]');
  startBtn?.addEventListener('click', (e) => {
    const channel = window.channel || null;
    e.preventDefault();
    channel?.postMessage({ type: 'select', id: r.id });
  });

  // NEW: View Similar → enter similarity mode
  const viewBtn = node.querySelector('[data-action="view-similar"]');
  viewBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    enterSimilarityMode(r); // defined below
  });

  const detailsBtn = node.querySelector('[data-action="view-details"]');
  detailsBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    ensureDetailsModal();
    fillDetailsModal({ loading: true, id: r.id, name: r.name, avatar: r.avatar });
    const channel = window.channel || null;
    channel?.postMessage({ type: 'request-details', id: r.id });
  });


  return node;
}

function createSimilarityAside(refRow){
  const normalAside = document.querySelector('aside.sidebar');
  if (normalAside) normalAside.style.display = 'none';
  const old = document.querySelector('aside.sidebar.similarity');
  if (old) old.remove();

  const aside = document.createElement('aside');
  aside.className = 'sidebar similarity';
  aside.setAttribute('aria-label','Similarity Controls');


  // Get persisted values or defaults
  const persistedValues = window.similaritySettings || {};
  const tagMetric = persistedValues.tagMetric || 'jaccard';
  const descMetric = persistedValues.descMetric || 'none';
  const minShared = persistedValues.minShared || 2;
  const idfMul = persistedValues.idfMul || 100;
  const limit = persistedValues.limit || 500;
  const ngramMin = persistedValues.ngramMin || 1;
  const ngramMax = persistedValues.ngramMax || 3;
  const alpha = persistedValues.alpha || 60;

  aside.innerHTML = `
    <section class="section">
      <header>
        <h3>Similarity mode</h3>
        <span class="micro">Reference: <strong>${(refRow.name||'—')}</strong></span>
      </header>
      <div class="body">



        <label class="hint">Tag similarity</label>
        <select data-sim="tag-metric" style="margin-bottom:10px">
          <option value="none" ${tagMetric === 'none' ? 'selected' : ''}>None</option>
          <option value="overlap" ${tagMetric === 'overlap' ? 'selected' : ''}>Tag overlap (IDF-boostable)</option>
          <option value="jaccard" ${tagMetric === 'jaccard' ? 'selected' : ''}>Weighted Jaccard (IDF)</option>
          <option value="cosine" ${tagMetric === 'cosine' ? 'selected' : ''}>Cosine (TF-IDF on tags)</option>
          <option value="dice" ${tagMetric === 'dice' ? 'selected' : ''}>Dice coefficient</option>
          <option value="hamming" ${tagMetric === 'hamming' ? 'selected' : ''}>Hamming distance</option>
          <option value="manhattan" ${tagMetric === 'manhattan' ? 'selected' : ''}>Manhattan distance</option>
          <option value="euclidean" ${tagMetric === 'euclidean' ? 'selected' : ''}>Euclidean distance</option>
          <option value="tanimoto" ${tagMetric === 'tanimoto' ? 'selected' : ''}>Tanimoto coefficient</option>
          <option value="ochiai" ${tagMetric === 'ochiai' ? 'selected' : ''}>Ochiai coefficient</option>
          <option value="simpson" ${tagMetric === 'simpson' ? 'selected' : ''}>Simpson coefficient</option>
          <option value="braun-blanquet" ${tagMetric === 'braun-blanquet' ? 'selected' : ''}>Braun-Blanquet</option>
        </select>

        <label class="hint">Description similarity</label>
        <select data-sim="desc-metric" style="margin-bottom:10px">
          <option value="none" ${descMetric === 'none' ? 'selected' : ''}>None</option>
          <option value="cosine" ${descMetric === 'cosine' ? 'selected' : ''}>Cosine (TF-IDF)</option>
          <option value="cosine-1gram" ${descMetric === 'cosine-1gram' ? 'selected' : ''}>Cosine (1-gram only)</option>
          <option value="cosine-2gram" ${descMetric === 'cosine-2gram' ? 'selected' : ''}>Cosine (1-2 gram)</option>
          <option value="cosine-3gram" ${descMetric === 'cosine-3gram' ? 'selected' : ''}>Cosine (1-3 gram)</option>
          <option value="cosine-4gram" ${descMetric === 'cosine-4gram' ? 'selected' : ''}>Cosine (1-4 gram)</option>
          <option value="bm25" ${descMetric === 'bm25' ? 'selected' : ''}>BM25 similarity</option>
          <option value="bm25-2gram" ${descMetric === 'bm25-2gram' ? 'selected' : ''}>BM25 (1-2 gram)</option>
          <option value="bm25-3gram" ${descMetric === 'bm25-3gram' ? 'selected' : ''}>BM25 (1-3 gram)</option>
          <option value="bm25-4gram" ${descMetric === 'bm25-4gram' ? 'selected' : ''}>BM25 (1-4 gram)</option>
          <option value="jaccard-text" ${descMetric === 'jaccard-text' ? 'selected' : ''}>Jaccard (word sets)</option>
          <option value="jaccard-2gram" ${descMetric === 'jaccard-2gram' ? 'selected' : ''}>Jaccard (2-gram sets)</option>
          <option value="jaccard-3gram" ${descMetric === 'jaccard-3gram' ? 'selected' : ''}>Jaccard (3-gram sets)</option>
          <option value="jaccard-4gram" ${descMetric === 'jaccard-4gram' ? 'selected' : ''}>Jaccard (4-gram sets)</option>
          <option value="dice-text" ${descMetric === 'dice-text' ? 'selected' : ''}>Dice coefficient (words)</option>
          <option value="overlap-text" ${descMetric === 'overlap-text' ? 'selected' : ''}>Word overlap count</option>
          <option value="levenshtein" ${descMetric === 'levenshtein' ? 'selected' : ''}>Levenshtein distance</option>
          <option value="jaro-winkler" ${descMetric === 'jaro-winkler' ? 'selected' : ''}>Jaro-Winkler</option>
          <option value="lcs" ${descMetric === 'lcs' ? 'selected' : ''}>Longest common subsequence</option>
          <option value="semantic-hash" ${descMetric === 'semantic-hash' ? 'selected' : ''}>Semantic hash similarity</option>
        </select>

        <label class="hint">Tag/Description weighting</label>
        <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
          <span style="font-size:12px;color:var(--muted);min-width:40px">Tags</span>
          <input type="range" min="0" max="100" value="${persistedValues.alpha || 60}" step="5" data-sim="alpha" style="flex:1"/>
          <span style="min-width:30px;text-align:center;font-size:12px" data-sim="alpha-val">${persistedValues.alpha || 60}%</span>
          <span style="font-size:12px;color:var(--muted);min-width:60px">Description</span>
        </div>

        <label class="hint">N-gram range (for applicable metrics)</label>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="range" min="1" max="4" value="${persistedValues.ngramMin || 1}" step="1" data-sim="ngram-min" style="flex:1"/>
          <span style="min-width:20px;text-align:center" data-sim="ngram-min-val">${persistedValues.ngramMin || 1}</span>
          <span style="color:var(--muted)">to</span>
          <input type="range" min="1" max="4" value="${persistedValues.ngramMax || 3}" step="1" data-sim="ngram-max" style="flex:1"/>
          <span style="min-width:20px;text-align:center" data-sim="ngram-max-val">${persistedValues.ngramMax || 3}</span>
        </div>

        <label class="hint">Min shared tags</label>
        <input type="range" min="0" max="64" value="${minShared}" step="1" data-sim="min-shared"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="min-shared-val">${minShared}</span></div>

        <label class="hint" id="invdf">Rarity boost (× IDF)</label>
        <input type="range" min="0" max="200" value="${idfMul}" step="5" data-sim="idf-mul"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="idf-mul-val">${(idfMul/100).toFixed(1)}×</span></div>

        <label class="hint">Limit results</label>
        <input type="range" min="50" max="2000" value="${limit}" step="50" data-sim="limit"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="limit-val">${limit}</span></div>

        <div class="hint" style="margin:8px 0 6px">Top tags in current similar set:</div>
        <div class="chips" data-sim="tag-cloud"></div>
      </div>
    </section>

    <section class="section">
      <div class="body">
        <a href="#" class="btn" data-sim="back">← Back to filters</a>
      </div>
    </section>
  `;

  const content = document.querySelector('.content');
  if (content) content.insertBefore(aside, content.firstElementChild);

  const minSharedEl = aside.querySelector('[data-sim="min-shared"]');
  const minSharedVal = aside.querySelector('[data-sim="min-shared-val"]');
  minSharedEl?.addEventListener('input', ()=> minSharedVal.textContent = String(minSharedEl.value));

  const idfMulEl = aside.querySelector('[data-sim="idf-mul"]');
  const idfMulhint = aside.querySelector('#invdf')
  const idfMulVal = aside.querySelector('[data-sim="idf-mul-val"]');
  idfMulEl?.addEventListener('input', ()=> idfMulVal.textContent = (Number(idfMulEl.value)/100).toFixed(1) + '×');

  const limitEl = aside.querySelector('[data-sim="limit"]');
  const limitVal = aside.querySelector('[data-sim="limit-val"]');
  limitEl?.addEventListener('input', ()=> limitVal.textContent = String(limitEl.value));

  const ngramMinEl = aside.querySelector('[data-sim="ngram-min"]');
  const ngramMinVal = aside.querySelector('[data-sim="ngram-min-val"]');
  ngramMinEl?.addEventListener('input', ()=> {
    ngramMinVal.textContent = String(ngramMinEl.value);
    // Ensure min <= max
    const maxEl = aside.querySelector('[data-sim="ngram-max"]');
    if (maxEl && Number(ngramMinEl.value) > Number(maxEl.value)) {
      maxEl.value = ngramMinEl.value;
      aside.querySelector('[data-sim="ngram-max-val"]').textContent = ngramMinEl.value;
    }
  });

  const ngramMaxEl = aside.querySelector('[data-sim="ngram-max"]');
  const ngramMaxVal = aside.querySelector('[data-sim="ngram-max-val"]');
  ngramMaxEl?.addEventListener('input', ()=> {
    ngramMaxVal.textContent = String(ngramMaxEl.value);
    // Ensure max >= min
    const minEl = aside.querySelector('[data-sim="ngram-min"]');
    if (minEl && Number(ngramMaxEl.value) < Number(minEl.value)) {
      minEl.value = ngramMaxEl.value;
      aside.querySelector('[data-sim="ngram-min-val"]').textContent = ngramMaxEl.value;
    }
  });

  const alphaEl = aside.querySelector('[data-sim="alpha"]');
  const alphaVal = aside.querySelector('[data-sim="alpha-val"]');
  alphaEl?.addEventListener('input', ()=> {
    alphaVal.textContent = String(alphaEl.value) + '%';
  });

  aside.querySelector('[data-sim="back"]')?.addEventListener('click', (e)=>{
    e.preventDefault();
    exitSimilarityMode();
  });

  const tagMetricSel = aside.querySelector('[data-sim="tag-metric"]');
  const descMetricSel = aside.querySelector('[data-sim="desc-metric"]');

  const idfBlockInputs = [
    idfMulEl,
    idfMulVal,
    idfMulhint
  ];

  const toggleIdfVisibility = ()=>{
    const show = tagMetricSel?.value === 'overlap';
    idfBlockInputs.forEach(el => { if (el && el instanceof HTMLElement) el.style.display = show ? '' : 'none'; });
  };
  tagMetricSel?.addEventListener('change', toggleIdfVisibility);
  toggleIdfVisibility();

  descMetricSel?.addEventListener('change', e=>{
    if (e.target.value !== 'none') CardsBackend.ensureTextIndex();
  });


  return aside;
}


function enterSimilarityMode(refRow){
  const B = window.CardsBackend;
  if (!B?.store || !B?.query) return;

  const aside = createSimilarityAside(refRow); // builds the Similarity sidebar UI

  const run = () => {
    const tagMetric = aside.querySelector('[data-sim="tag-metric"]')?.value || 'none';
    const descMetric = aside.querySelector('[data-sim="desc-metric"]')?.value || 'none';
    const minSharedInput = Number(aside.querySelector('[data-sim="min-shared"]')?.value || 0);
    const idfMul = Number(aside.querySelector('[data-sim="idf-mul"]')?.value || 100) / 100;
    const limit = Number(aside.querySelector('[data-sim="limit"]')?.value || 500);

    const includeText = descMetric !== 'none';
    const includeTags = tagMetric !== 'none';

    if (includeText) CardsBackend.ensureTextIndex(); // one-time TF-IDF build for descriptions

    // If tags are disabled, do NOT pre-filter by "min shared tags"
    const minShared = includeTags ? minSharedInput : 0;

    // Tag mode passed 1:1 to backend
    const tagMode = (tagMetric === 'overlap' || tagMetric === 'jaccard' || tagMetric === 'cosine') ? tagMetric : 'cosine';

    // Get alpha from slider (convert percentage to decimal)
    const alphaPercent = Number(aside.querySelector('[data-sim="alpha"]')?.value || 60);
    const alpha = (includeTags && includeText) ? (alphaPercent / 100) : (includeTags ? 1.0 : 0.0);

    // Fast pre-filter by min shared tags (only if tags are in play)
    const refSet = new Set((refRow.tags || []).map(String));
    let candidates = B.store.rows.filter(x => x.id !== refRow.id).filter(x => {
      if (!minShared) return true;
      let c = 0;
      for (const t of x.tags) { if (refSet.has(t)) { c++; if (c >= minShared) break; } }
      return c >= minShared;
    });

    // Get n-gram settings
    const ngramMin = Number(aside.querySelector('[data-sim="ngram-min"]')?.value || 1);
    const ngramMax = Number(aside.querySelector('[data-sim="ngram-max"]')?.value || 3);

    // Score with combinedSimilarity
    const opts = { 
      tagMode, 
      descMode: descMetric, 
      weightTags: true, 
      includeText, 
      includeTags, 
      alpha, 
      idfMul,
      ngramMin,
      ngramMax
    };
    const scored = [];
    for (const r of candidates){
      const s = CardsBackend.query.combinedSimilarity(refRow.id, r.id, opts);
      scored.push({ row: r, score: s });
    }
    scored.sort((a,b)=> b.score - a.score || String(a.row.name||'').localeCompare(String(b.row.name||'')));
    let rows = scored.map(s => {
      // Attach similarity score to the row for display
      s.row._similarityScore = s.score;
      return s.row;
    });

    if (isFinite(limit) && rows.length > limit) rows = rows.slice(0, limit);

    // Stream render via existing infra
    resetStream(rows, null);
    ensureObserver(true);
    while (stream.idx < stream.rows.length && sentinelVisible()) renderNextChunk();
    ensureObserver();

    // Tag cloud from current set
    computeTagFreq(rows);
    const cloud = aside.querySelector('[data-sim="tag-cloud"]');
    if (cloud){
      cloud.innerHTML = '';
      for (const {tag, count} of currentTagFreq.slice(0, 24)){
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = `${tag} (${count})`;
        cloud.appendChild(span);
      }
    }

    // Header metrics
    updateMetrics(B.store.rows.length, rows.length, rows.length);
  };

  // Persist settings and re-run when any sim control changes
  const persistSettings = () => {
    window.similaritySettings = {
      tagMetric: aside.querySelector('[data-sim="tag-metric"]')?.value || 'jaccard',
      descMetric: aside.querySelector('[data-sim="desc-metric"]')?.value || 'none',
      minShared: Number(aside.querySelector('[data-sim="min-shared"]')?.value || 2),
      idfMul: Number(aside.querySelector('[data-sim="idf-mul"]')?.value || 100),
      limit: Number(aside.querySelector('[data-sim="limit"]')?.value || 500),
      ngramMin: Number(aside.querySelector('[data-sim="ngram-min"]')?.value || 1),
      ngramMax: Number(aside.querySelector('[data-sim="ngram-max"]')?.value || 3),
      alpha: Number(aside.querySelector('[data-sim="alpha"]')?.value || 60)
    };
  };

  aside.querySelectorAll('input[data-sim], select[data-sim]').forEach(el => {
    el.addEventListener('input', () => { persistSettings(); run(); });
    el.addEventListener('change', () => { persistSettings(); run(); });
  });

  // Toggling either source re-runs (and prebuilds text index if needed)
  const tagMetricSel = aside.querySelector('[data-sim="tag-metric"]');
  const descMetricSel = aside.querySelector('[data-sim="desc-metric"]');
  function rerunSimilarity(){
    if (descMetricSel?.value !== 'none') CardsBackend.ensureTextIndex();
    run();
  }
  tagMetricSel?.addEventListener('change', rerunSimilarity);
  descMetricSel?.addEventListener('change', rerunSimilarity);

  // If page opens with text ON, prebuild once
  if (descMetricSel?.value !== 'none') CardsBackend.ensureTextIndex();

  run();
}



function exitSimilarityMode(){
  // remove similarity panel
  const sim = document.querySelector('aside.sidebar.similarity');
  if (sim) sim.remove();

  // show normal sidebar again
  const normalAside = document.querySelector('aside.sidebar');
  if (normalAside) normalAside.style.display = '';

  // restore the usual pipeline
  apply(); // your existing filter/apply path:contentReference[oaicite:8]{index=8}
}


function attachTagDatalist() {
  const B = window.CardsBackend;
  if (!B?.store || !ctl.tagBundle) return;

  let dl = document.getElementById("tags-list");
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = "tags-list";

    for (const t of B.store.tagUniverse) {
      const opt = document.createElement("option");
      opt.value = t;
      dl.appendChild(opt);
    }
    document.body.appendChild(dl);
  }

  ctl.tagBundle.setAttribute("list", "tags-list");
}

  function renderNextChunk(){
    if (!stream.rows || stream.idx >= stream.rows.length) return;
    const end = Math.min(stream.idx + (stream.idx ? stream.more : stream.page), stream.rows.length);
    const frag = document.createDocumentFragment();
    for (let i = stream.idx; i < end; i++){
      frag.appendChild(makeCard(stream.rows[i], stream.weights));
    }
    // Insert before sentinel
    ctl.grid.insertBefore(frag, ctl.sentinel);
    stream.idx = end;
  }

function ensureObserver(force=false){
  if (stream.observer && !force) return;
  if (stream.observer) { try { stream.observer.disconnect(); } catch {} }
  stream.observer = new IntersectionObserver((entries)=>{
    for (const e of entries){
      if (e.isIntersecting){
        renderNextChunk();
      }
    }
  }, { root: null, rootMargin: '800px 0px', threshold: 0.0 });
  if (ctl.sentinel) stream.observer.observe(ctl.sentinel);
}

function sentinelVisible(){
  if (!ctl.sentinel) return false;
  const r = ctl.sentinel.getBoundingClientRect();
  return r.top < (window.innerHeight || document.documentElement.clientHeight);
}

// global-ish stream state
const stream = {
  rows: [],
  weights: null,
  idx: 0,
  page: 40,   // first load size
  more: 60,   // subsequent chunk size
  observer: null
};

function resetStream(rows, weights){
  stream.rows = rows || [];
  stream.weights = weights || null;
  stream.idx = 0;

  // Clear grid except sentinel
  if (ctl.grid){
    Array.from(ctl.grid.children).forEach(el=>{
      if (!el.classList.contains('sentinel')) el.remove();
    });
  }
}

function updateMetrics(total, afterBool, afterM){
  if (!ctl.metrics) return;
  clear(ctl.metrics);
  ctl.metrics.appendChild(chip(`Candidates: ${fmtNum(total)}`));
  ctl.metrics.appendChild(chip(`After Boolean: ${fmtNum(afterBool)}`));
  ctl.metrics.appendChild(chip(`After M from List: ${fmtNum(afterM)}`));
  // add more if you want (e.g. After Frequency, Sorted by …)
}

function collectState(){
  return {
    search: ctl.search?.value.trim() || "",
    sort: getSortChoice(),
    expr: ctl.boolExpr?.value.trim() || "",
    tags: parseTagBundle(ctl.tagBundle?.value || ""),
    m: parseInt(ctl.mInput?.value || "0", 10),
    kMin: parseInt(ctl.kMin?.value || "0", 10),
    kMax: parseInt(ctl.kMax?.value || "9999", 10),
    rMin: parseFloat(ctl.rMin?.value || "0"), 
    weightsInput: ctl.weights?.value.trim() || ""
  };
}

function apply(){
  const B = window.CardsBackend; 
  if (!B || !B.store) return;
  const { store, query } = B;
  const st = collectState();

  // 1) Boolean filter + k-range + rarity min
  const filtered = query.filter({
    expr: st.expr,
    tagCountMin: st.kMin,
    tagCountMax: st.kMax,
    rarityMin: isFinite(st.rMin) ? st.rMin : 0
  });

  // 2) Token/text search with weighting
  const text = String(st.search || "").trim().toLowerCase();
  const idSet = query.searchTokens(st.search);

  // Tunable weights
  const W_NAME   = 8;
  const W_TOKEN  = 3;
  const W_NOTES  = 1;
  const W_DESC   = 1;

  let rows;
  if (!text){
    // No free-text → keep all filtered rows, neutral score
    rows = filtered.slice();
  } else {
    const scored = [];
    for (const r of filtered){
      let s = 0;

      // Name match (boost hard)
      const name = String(r.name || "").toLowerCase();
      if (name && name.includes(text)) s += W_NAME;

      // Token index membership
      if (idSet.has(r.id)) s += W_TOKEN;

      // Body matches (notes + description)
      const notes = String(r.creator_notes || "").toLowerCase();
      const desc  = String(r.description   || "").toLowerCase();
      if (notes.includes(text)) s += W_NOTES;
      if (desc.includes(text))  s += W_DESC;

      if (s > 0){
        r._searchScore = s;
        scored.push(r);
      }
    }

    // Sort by weighted relevance, then stable tie-breaker by name
    scored.sort((a,b)=> (b._searchScore - a._searchScore) ||
                        String(a.name||'').localeCompare(String(b.name||'')));
    rows = scored;
  }

  // Live tag frequency over rows the user is actually seeing
  computeTagFreq(rows);

  // 3) M from list
  let afterM = rows.length;
  if (st.tags.length && st.m > 0){
    const set = new Set(st.tags.map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => {
      let c = 0; 
      for (const t of r.tags) { if (set.has(t)) { c++; if (c >= st.m) break; } }
      return c >= st.m;
    });
    afterM = rows.length;
  }

  // 4) Sort
  // IMPORTANT: preserve search relevance order when a search term is active.
  if (!text){
    // Only apply user sort when there is no active text search
    query.sort(rows, { by: st.sort.by, dir: st.sort.dir, weightsInput: st.weightsInput });
  }
  // else: keep the relevance order produced above

  // 5) Stream render + metrics
  const weights = B.parseWeights(st.weightsInput);
  resetStream(rows, weights);
  ensureObserver(true);
  while (stream.idx < stream.rows.length && sentinelVisible()) renderNextChunk();

  updateMetrics(store.rows.length, filtered.length, afterM);
  ensureObserver();
}



const applyDebounced = debounce(apply, 200);

function bindEvents() {
  const els = [
    ctl.search, ctl.sortSelect, ctl.boolExpr, ctl.tagBundle,
    ctl.mInput, ctl.kMin, ctl.kMax, ctl.rMin,        // <— add ctl.rMin
    ctl.weights
  ];
  for (const el of els) if (el) el.addEventListener("input", applyDebounced);

  if (ctl.grid) {
    const mo = new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          n.querySelectorAll("button").forEach(b => b.addEventListener("click", applyDebounced));
        }
      }));
    });
    mo.observe(ctl.grid, { childList: true });
  }

}

function initAutocomplete(){
  const B = window.CardsBackend;
  const jq = window.jQuery;
  if(!B?.store || !jq?.ui?.autocomplete) return;

  // Boolean rule textarea
  jq(document.querySelector('textarea[placeholder*="AND"]')).autocomplete({
    minLength: 1,
    appendTo: 'body',
    position: { my:'left top+6', at:'left bottom', collision:'flipfit' },
    search: function(){
      const ta = this;
      const pos = ta.selectionStart ?? ta.value.length;
      const left = ta.value.slice(0,pos);
      const m = /(?:"([^"]*)"|'([^']*)'|([^\s()!&|]+))$/.exec(left);
      const raw = (m && (m[1] ?? m[2] ?? m[3])) || '';
      jq(this).autocomplete('option','source', (_req,res)=>{
        res(suggestTags(raw, 200));   // <-- from live freq cache
      });
    },
    focus: ()=>false,
    select: function(_ev, ui){
      const ta = this;
      const pos = ta.selectionStart ?? ta.value.length;
      const s = ta.value;
      const left = s.slice(0,pos);
      const m = /(?:"([^"]*)"|'([^']*)'|([^\s()!&|]+))$/.exec(left);
      const start = m ? left.lastIndexOf(m[0]) : pos;
      const value = ui.item.value;
      const quoted = /\s/.test(value) ? `"${value}"` : value;
      ta.value = s.slice(0,start) + quoted + s.slice(pos);
      const newPos = start + quoted.length;
      ta.setSelectionRange(newPos,newPos);
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      return false;
    }
  });

  // Tag bundle input
  jq(document.querySelector('input[aria-label="tag bundle"]'))
    .on('keydown', e=>{ if(e.key==='Enter') e.preventDefault(); })
    .autocomplete({
      minLength: 1,
      appendTo: 'body',
      position: { my:'left top+6', at:'left bottom', collision:'flipfit' },
      source: function(req,res){
        const parts = req.term.split(/,\s*/);
        const last = (parts[parts.length-1]||'').toLowerCase();
        res(suggestTags(last, 200));  // <-- from live freq cache
      },
      focus: ()=>false,
      select: function(_ev, ui){
        let terms = this.value.split(/,\s*/);
        terms.pop(); terms.push(ui.item.value);
        this.value = terms.join(', ') + ', ';
        this.dispatchEvent(new Event('input',{bubbles:true}));
        return false;
      }
    });
}


window.addEventListener('cards:ready', () => { 
  bindEvents(); 
  apply(); 
  initAutocomplete();
  insertNgramButton();
});


  if (window.CardsBackend && window.CardsBackend.store){ attachTagDatalist(); bindEvents(); apply();   initAutocomplete(); }
  if (window.CardsBackend?.store) insertNgramButton();

})();
