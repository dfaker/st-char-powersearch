
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
    if (!sel) return { by:'score', dir:'desc' };
    const label = sel.value || sel.getAttribute('selected') || '';
    return sortMap.get(label) || { by:'score', dir:'desc' };
  }
  function parseTagBundle(s){
    const out = []; const re = /"([^"]+)"|'([^']+)'|([^,\s][^,]*)/g; let m;
    while ((m = re.exec(String(s||"")))){ const tag=(m[1]||m[2]||m[3]||'').trim(); if (tag) out.push(tag); }
    return out;
  }


  // --- N-gram probable-tags (minimal, non-blocking) -----------------------
  function insertNgramButton(){
    if (!ctl.boolExpr) return;
    const btn = document.createElement('a');
    btn.href = "#";
    btn.className = "btn";
    btn.textContent = "Generate Ngram Probable tags THIS IS SLOW!";
    btn.style.marginTop = "8px";
    btn.addEventListener('click', (e)=>{ e.preventDefault(); runNgramProbableTags(); });
    // place right under the Boolean-rule textarea
    const host = document.getElementById('finalSection')
    if(host){
      host.appendChild(btn);
    }
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




function makeCard(r, weights){
  const score = (() => {
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
        <a href="#" class="btn" role="button" data-action="view-similar">View Similar</a>
        <a href="#" class="btn" role="button" data-action="start-chat">Start Chat</a>
      </div>
    </div>
  `;

  // Avatar
  const av = node.querySelector('[data-avatar]');
  if (r.avatar){
    av.style.backgroundImage = `url(/thumbnail?type=avatar&file=${r.avatar})`;
    av.style.backgroundSize = 'cover';
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

  aside.innerHTML = `
    <section class="section">
      <header>
        <h3>Similarity mode</h3>
        <span class="micro">Reference: <strong>${(refRow.name||'—')}</strong></span>
      </header>
      <div class="body">
        <div class="hint" style="margin-bottom:8px">
          Compare by tag overlap, Jaccard, or Cosine. Overlap can be rarity-boosted (IDF).
        </div>

        <label class="hint">Metric</label>
        <select data-sim="metric" style="margin-bottom:10px">
          <option value="overlap">Tag overlap (IDF-boostable)</option>
          <option value="jaccard" selected>Weighted Jaccard (IDF)</option>
          <option value="cosine">Cosine (TF-IDF on tags)</option>
        </select>

        <label class="hint">Min shared tags</label>
        <input type="range" min="0" max="64" value="2" step="1" data-sim="min-shared"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="min-shared-val">2</span></div>

        <label class="hint" id="invdf">Rarity boost (× IDF)</label>
        <input type="range" min="0" max="200" value="100" step="5" data-sim="idf-mul"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="idf-mul-val">1.0×</span></div>

        <label class="hint">Limit results</label>
        <input type="range" min="50" max="2000" value="500" step="50" data-sim="limit"/>
        <div class="hint" style="margin-bottom:10px"><span data-sim="limit-val">500</span></div>

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

  const minShared = aside.querySelector('[data-sim="min-shared"]');
  const minSharedVal = aside.querySelector('[data-sim="min-shared-val"]');
  minShared?.addEventListener('input', ()=> minSharedVal.textContent = String(minShared.value));

  const idfMul = aside.querySelector('[data-sim="idf-mul"]');
  const idfMulhint = aside.querySelector('#invdf')
  const idfMulVal = aside.querySelector('[data-sim="idf-mul-val"]');
  idfMul?.addEventListener('input', ()=> idfMulVal.textContent = (Number(idfMul.value)/100).toFixed(1) + '×');

  const limit = aside.querySelector('[data-sim="limit"]');
  const limitVal = aside.querySelector('[data-sim="limit-val"]');
  limit?.addEventListener('input', ()=> limitVal.textContent = String(limit.value));

  aside.querySelector('[data-sim="back"]')?.addEventListener('click', (e)=>{
    e.preventDefault();
    exitSimilarityMode();
  });

  // Hide IDF boost when metric != overlap (only overlap uses the per-tag 1+IDF*(mul-1) trick):contentReference[oaicite:3]{index=3}
  const metricSel = aside.querySelector('[data-sim="metric"]');
  const idfBlockInputs = [idfMul, idfMulhint, idfMulVal?.parentElement?.previousElementSibling, idfMul?.nextElementSibling];
  const toggleIdfVisibility = ()=>{
    const show = metricSel?.value === 'overlap';
    idfBlockInputs.forEach(el => { if (el && el instanceof HTMLElement) el.style.display = show ? '' : 'none'; });
  };
  metricSel?.addEventListener('change', toggleIdfVisibility);
  toggleIdfVisibility();

  return aside;
}


function enterSimilarityMode(refRow){
  const B = window.CardsBackend;
  if (!B?.store || !B?.query) return;

  const aside = createSimilarityAside(refRow);

  const run = () => {
    const { store } = B;

    const metric = aside.querySelector('[data-sim="metric"]')?.value || 'jaccard';
    const minShared = Number(aside.querySelector('[data-sim="min-shared"]')?.value || 0);
    const idfMul = Number(aside.querySelector('[data-sim="idf-mul"]')?.value || 100) / 100;
    const limit = Number(aside.querySelector('[data-sim="limit"]')?.value || 500);

    const refSet = new Set((refRow.tags || []).map(String));

    // Filter candidates by min shared tags first (fast pass)
    let candidates = B.store.rows.filter(x => x.id !== refRow.id).filter(x => {
      if (!minShared) return true;
      let c = 0; for (const t of x.tags) if (refSet.has(t)) { c++; if (c>=minShared) break; }
      return c >= minShared;
    });

    // Score + sort with requested metric
    const scored = computeSimilarityScores(metric, refRow, candidates, store, idfMul);
    let rows = scored.map(s => s.row);

    if (isFinite(limit) && rows.length > limit) rows = rows.slice(0, limit);

    // Stream render using existing infra:contentReference[oaicite:4]{index=4}
    resetStream(rows, null);
    ensureObserver(true);
    while (stream.idx < stream.rows.length && sentinelVisible()) renderNextChunk();
    ensureObserver();

    // Live tag cloud
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

    // header metrics
    updateMetrics(B.store.rows.length, rows.length, rows.length);
  };

  aside.querySelectorAll('input[data-sim], select[data-sim]').forEach(el => {
    el.addEventListener('input', run);
    el.addEventListener('change', run);
  });

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
  const B = window.CardsBackend; if (!B || !B.store) return;
  const { store, query } = B;
  const st = collectState();

  // 1) Boolean filter + k-range + rarity min
  const filtered = query.filter({
    expr: st.expr,
    tagCountMin: st.kMin,
    tagCountMax: st.kMax,
    rarityMin: isFinite(st.rMin) ? st.rMin : 0   // <— now applied
  });

  // 2) Token/text search
  let idSet = query.searchTokens(st.search);
  const text = String(st.search||'').toLowerCase();
  const rows1 = filtered.filter(r => idSet.has(r.id));
  const rows2 = (text
    ? filtered.filter(r =>
        !idSet.has(r.id) &&
        ((r.creator_notes||'').toLowerCase().includes(text) ||
         (r.description||'').toLowerCase().includes(text)))
    : []);
  let rows = rows1.concat(rows2);

  // Live tag frequency over rows the user is actually seeing
  computeTagFreq(rows);

  // 3) M from list
  let afterM = rows.length;
  if (st.tags.length && st.m > 0){
    const set = new Set(st.tags.map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => { let c = 0; for (const t of r.tags) if (set.has(t)) c++; return c >= st.m; });
    afterM = rows.length;
  }

  // 4) Sort
  query.sort(rows, { by: st.sort.by, dir: st.sort.dir, weightsInput: st.weightsInput });

  // 5) Stream render + metrics
  const weights = B.parseWeights(st.weightsInput);
  resetStream(rows, weights);
  ensureObserver(true);
  while (stream.idx < stream.rows.length && sentinelVisible()) renderNextChunk();

  // Update metrics to include rarity step for clarity
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
