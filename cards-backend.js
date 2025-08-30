/**
 * cards-backend.js
 * Backend/data layer for the Tag Explorer SPA.
 *
 * - Listens on BroadcastChannel('cards-data')
 * - Sends {type:'ps-ready'} handshake (same channel)
 * - Accepts a single payload: { characters: Character[], tags: TagRecord[], tag_map: Record<string,string[]> }
 * - Dedupes by `id` (falls back to derived key if missing, with warning)
 * - Computes derived metrics client-side: tagCount (k), idf per tag, Σidf per character
 * - Builds fast indexes (by id, name, creator, tags; inverted tag → ids)
 * - Parses expressions: boolean tag expression + weights assignment
 * - Blocks UI with a full-screen overlay during indexing; updates progress bar
 * - Exposes window.CardsBackend with store, indexes, query helpers, and events
 *
 * NOTE: This is framework-agnostic; if window.afterData exists, it will be invoked on completion.
 */

/* ============================= Utilities ============================= */


const now = () => performance && performance.now ? performance.now() : Date.now();

function clamp01(x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

function $(sel){ return document.querySelector(sel); }

function byId(id){ return document.getElementById(id); }

function text(el, t){
  if (!el) return;
  el.textContent = t == null ? "" : String(t);
}

function normalizeTagsLower(arr){
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (let t of arr){
    if (t == null) continue;
    t = String(t).trim().toLowerCase();
    if (t) out.add(t);
  }
  return Array.from(out);
}

function create(tag, attrs={}, children=[]){
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)){
    if (k === "style" && typeof v === "object"){
      Object.assign(el.style, v);
    } else if (k.startsWith("on") && typeof v === "function"){
      el.addEventListener(k.slice(2), v);
    } else if (v != null){
      el.setAttribute(k, v);
    }
  }
  for (const c of (Array.isArray(children) ? children : [children])){
    if (c == null) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function hashString(s){
  // DJB2-ish, deterministic 32-bit
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function normalizeTag(t){
  // UI shows quotes for spaces; internally normalize in a case-insensitive, trimmed form
  if (typeof t !== "string") return "";
  return t.trim().toLowerCase();
}

function safeGet(obj, path, fallback){
  try{
    return path.split(".").reduce((o,p)=>o && o[p], obj) ?? fallback;
  }catch{ return fallback; }
}

/* =================== Blocking overlay & progress UI =================== */

let overlay, progressBar, progressMsg, loadStatus;
function ensureOverlay(){
  if (overlay) return overlay;
  overlay = create("div", { id: "blockingOverlay", style: {
    position: "fixed", inset: "0", background: "rgba(3,6,12,.84)",
    display: "none", zIndex: "9999", backdropFilter: "blur(3px)",
  }});
  const panel = create("div", { style: {
    position:"absolute", inset:"0", display:"grid", placeItems:"center"
  }});
  const card = create("div", { style: {
    minWidth:"320px", maxWidth:"min(640px,80vw)", background:"#0c1117", border:"1px solid #1f2937",
    borderRadius:"12px", padding:"18px 16px", boxShadow:"0 8px 40px rgba(0,0,0,.45)", color:"#e5e7eb",
    fontFamily:"ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
  }});
  const h = create("div", { style:{marginBottom:"8px", fontWeight:"600", letterSpacing:".2px"}}, "Loading…");
  loadStatus = create("div", { id:"loadStatus", style:{ marginBottom:"12px", fontSize:"13px", color:"#9aa6b2" }}, "Preparing");
  const barWrap = create("div", { style:{ height:"8px", background:"#111827", borderRadius:"999px", overflow:"hidden", border:"1px solid #1f2937" }});
  progressBar = create("div", { style:{ height:"100%", width:"0%", background:"#60a5fa", transition:"width .15s ease" }});
  barWrap.appendChild(progressBar);
  progressMsg = create("div", { style:{ marginTop:"8px", fontSize:"12px", color:"#93c5fd" }}, "Starting…");
  card.append(h, loadStatus, barWrap, progressMsg);
  panel.appendChild(card);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  return overlay;
}

function setBlocking(on){
  ensureOverlay();
  overlay.style.display = on ? "block" : "none";
}
function setProgress(p, msg){
  ensureOverlay();
  progressBar.style.width = `${Math.round(clamp01(p)*100)}%`;
  if (msg) progressMsg.textContent = msg;
}
function setLoadStatusText(t){
  ensureOverlay();
  loadStatus.textContent = t;
}

/* ========================= Schema validation ========================= */

function validatePayload(payload){
  const errors = [];
  if (!payload || typeof payload !== "object") errors.push("Payload must be an object");
  const chars = payload.characters;
  if (!Array.isArray(chars)) errors.push("`characters` must be an array");

  const tags = payload.tags;
  if (!Array.isArray(tags)) errors.push("`tags` must be an array");

  const tag_map = payload.tag_map;
  if (!tag_map || typeof tag_map !== "object") errors.push("`tag_map` must be an object");

  if (errors.length) throw new Error("Invalid payload: " + errors.join("; "));

  // Spot-check a few character fields (lenient: we only log warnings)
  for (let i=0;i<Math.min(chars.length, 3);i++){
    const c = chars[i];
    if (typeof c.name !== "string") console.warn("[cards-backend] char missing string `name`", c);
    if (!Array.isArray(c.tags)) console.warn("[cards-backend] char missing array `tags`", c);
  }
  return { characters: chars, tags, tag_map };
}

/* ======================= Normalization & indexing ===================== */

function deriveId(c){
  // Prefer provided id, else stable fallback (avatar || name || JSON hash)
  if (c.id != null) return String(c.id);
  const basis = String(c.avatar || c.name || "").trim() || JSON.stringify({n:c.name, a:c.avatar});
  const id = "x_" + hashString(basis);
  // Warn once per session that id was missing
  if (!deriveId._warned){ console.warn("[cards-backend] Character missing `id` — using derived id from avatar/name"); deriveId._warned = true; }
  return id;
}

function computeIdf(tagToDf, totalDocs){
  const idf = Object.create(null);
  const N = totalDocs;
  for (const [tag, df] of Object.entries(tagToDf)){
    const v = Math.log((N + 1) / (df + 1)) + 1; // natural log w/ smoothing
    idf[tag] = v;
  }
  return idf;
}

// ---- Relaxed mode: allow a small, safe subset of HTML ----
// Allowed tags: basic formatting + lists + code + blockquote + links + <br>
const ALLOWED_TAGS = new Set([
  "b","strong","i","em","u","s","br",
  "p","ul","ol","li",
  "code","pre","blockquote",
  "a","span","small"
]);

// Allowed attributes per tag (keep this tight)
const ALLOWED_ATTRS = {
  a: new Set(["href","title","target","rel"])
  // Everything else: no attributes
};


// ---- Minimal utilities: safe URL + escaping ----
function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeUrl(href) {
  try {
    const u = new URL(href, location.origin);
    // Allow only http(s), mailto, tel; block javascript:, data:, vbscript:
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function sanitizeToText(html) {
  return escapeHTML(html ?? "");
}

function sanitizeHTML_relaxed(dirty) {
  if (!dirty) return "";

  // 1) Parse in a detached document
  const doc = new DOMParser().parseFromString(String(dirty), "text/html");

  // 2) Kill comments up front
  const walkerComments = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT, null);
  const toZapComments = [];
  while (walkerComments.nextNode()) toZapComments.push(walkerComments.currentNode);
  toZapComments.forEach(n => n.remove());

  // 3) Remove known-dangerous / structural tags entirely (not even text)
  // (These can break your outer template or carry heavy styling/layout)
  doc.querySelectorAll(
    "script,style,link,meta,iframe,frame,frameset," +
    "object,embed,form,input,button,select,textarea," +
    "img,svg,math,video,audio,source,track,canvas," +
    // extra structural containers banned hard:
    "div,section,article,header,footer,nav,aside,main," +
    // tables & rules are layout-y and unnecessary in cards:
    "table,thead,tbody,tfoot,tr,th,td,hr"
  ).forEach(n => n.remove());

  // 4) Walk remaining elements and enforce allow-list & attr rules
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, null);
  const toRemove = [];

  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = el.tagName.toLowerCase();

    // Allowed inline-ish tags only
    if (!ALLOWED_TAGS.has(tag)) {
      // Replace the element with its *text* (escaped automatically),
      // so any inner HTML turns into literal text safely.
      const text = doc.createTextNode(el.textContent || "");
      el.replaceWith(text);
      continue;
    }

    // Strip *all* attributes except a tiny allow-list per tag
    for (const { name, value } of Array.from(el.attributes)) {
      const lname = name.toLowerCase();

      // Remove obvious trouble & presentation/state attributes
      if (
        lname.startsWith("on") || lname === "style" || lname === "class" || lname === "id" ||
        lname.startsWith("aria-") || lname.startsWith("data-")
      ) {
        el.removeAttribute(name);
        continue;
      }

      // Only <a> keeps a small attr set; everything else gets nothing
      const allow = (ALLOWED_ATTRS[tag] && ALLOWED_ATTRS[tag].has(lname));
      if (!allow) {
        el.removeAttribute(name);
        continue;
      }

      // Extra check for <a href="...">
      if (tag === "a" && lname === "href") {
        if (!isSafeUrl(value)) {
          el.removeAttribute(name);
          continue;
        }
      }
    }

    // Normalize anchors
    if (tag === "a") {
      // If no href after sanitization, unwrap link into plain text
      if (!el.getAttribute("href")) {
        el.replaceWith(doc.createTextNode(el.textContent || ""));
        continue;
      }
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    }

    // Remove empty spans/smalls (noise)
    if ((tag === "span" || tag === "small") && !el.textContent.trim()) {
      toRemove.push(el);
    }
  }

  toRemove.forEach(n => n.remove());

  // 5) Return safe HTML (only the small allowed subset remains)
  return doc.body.innerHTML;
}

// === Text-sim helpers (unigram+bigram TF-IDF) ===
function htmlToPlainText(html){
  if (!html) return "";
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function tokenizeText(s, { minN = 1, maxN = 3 } = {}){
  const toks = String(s)
  .toLowerCase()
  .split(/[^\p{L}\p{N}]+/u)
  .filter(Boolean);

  const out = [];
  for (let n = minN; n <= maxN; n++){
    for (let i = 0; i + n <= toks.length; i++){
      out.push(toks.slice(i, i + n).join(" "));
    }
  }
  return out; // duplicates preserved => OK for TF
}

function cosineSimSparse(ma, mb){
  if (!ma || !mb) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const v of ma.values()) na += v*v;
  for (const v of mb.values()) nb += v*v;
  const [small, big] = (ma.size < mb.size) ? [ma, mb] : [mb, ma];
  for (const [k, va] of small){
    const vb = big.get(k);
    if (vb) dot += va*vb;
  }
  if (!dot || !na || !nb) return 0;
  return dot / Math.sqrt(na*nb);
}



function buildStore(payload){
  const t0 = now();
  setLoadStatusText("Validating payload…"); setProgress(.06, "Checking schema");
  const { characters, tags, tag_map } = validatePayload(payload);

  setLoadStatusText("Normalizing & de-duplicating…"); setProgress(.12, "Normalizing rows");
  const byId = new Map();
  const rows = [];
  const errors = [];
  let missingTags = 0;

  // Normalize tags universe
  const tagUniverse = new Set();
  for (const tr of tags){
    const name = normalizeTag(tr?.name ?? tr?.id ?? "");
    if (name) tagUniverse.add(name);
  }

  for (const c of characters){
    try{
      const id = deriveId(c);
      if (byId.has(id)) continue; // dedupe by id
      const tagList = Array.isArray(c.tags) ? c.tags.map(normalizeTag).filter(Boolean) : [];
      for (const t of tagList) tagUniverse.add(t);
      const creator = safeGet(c, "data.creator", "") || "";
      const creator_notes = sanitizeHTML_relaxed(safeGet(c, "data.creator_notes", "") || "");
      const description = sanitizeHTML_relaxed(safeGet(c, "data.description", "") || "");
      const fav = !!safeGet(c, "data.extensions.fav", safeGet(c, "extensions.fav", false));
      const dateAdded = Number(c.date_added || 0) || 0;
      const lastChat = Number(c.date_last_chat || 0) || 0;
      const chatSize = Number(c.chat_size || 0) || 0;
      const dataSize = Number(c.data_size || 0) || 0;

      const row = {
        id, shallow: !!c.shallow, name: String(c.name || ""),
        avatar: c.avatar || null, chat: c.chat || "",
        date_added: dateAdded, date_last_chat: lastChat,
        chat_size: chatSize, data_size: dataSize,
        tags: (() => {
          const selfTags = normalizeTagsLower(c.tags || []);

          // tag_map: avatar -> string[] (Map or plain object)
          const avatarKey =
            c.avatar ||
            (c.data && c.data.avatar) ||
            c.image ||
            "";

          // safe fetch: Map.get(...) OR object[...] OR fallback to [].
          const fromMapRaw =
            (tag_map && typeof tag_map.get === "function" && tag_map.get(avatarKey)) ||
            (tag_map && typeof tag_map === "object" && tag_map[avatarKey]) ||
            [];

          const mapTags = normalizeTagsLower(fromMapRaw);

          // Union, lowercased, deduped
          return Array.from(new Set([...selfTags, ...mapTags]));
        })(),

        creator, creator_notes, description,
        fav, raw: c
      };
      rows.push(row); byId.set(id, row);
    }catch(e){
      errors.push(e.message || String(e));
    }
  }

  // DF map and inverted index
  setLoadStatusText("Building tag indexes…"); setProgress(.28, "Inverted index");
  const tagToIds = new Map(); // tag -> Set(ids)
  const tagToDf = Object.create(null);
  for (const r of rows){
    const seen = new Set();
    for (const t of r.tags){
      if (seen.has(t)) continue;
      seen.add(t);
      let s = tagToIds.get(t);
      if (!s){ s = new Set(); tagToIds.set(t, s); }
      s.add(r.id);
      tagToDf[t] = (tagToDf[t] || 0) + 1;
    }
  }

  // Compute idf + Σidf + tagCount (k)
  setLoadStatusText("Computing rarity (Σidf)…"); setProgress(.44, "IDF & rarity");
  const idf = computeIdf(tagToDf, rows.length);
  for (const r of rows){
    let sum = 0;
    for (const t of r.tags) sum += (idf[t] || 0);
    r.tag_count = r.tags.length;
    r.sigma_idf = sum;
  }

  // Name/creator tiny search index (token → ids)
  setLoadStatusText("Indexing names & creators…"); setProgress(.58, "String index");
  const tokenMap = new Map();
  const addTok = (tok, id)=>{
    tok = tok.trim(); if (!tok) return;
    let s = tokenMap.get(tok); if (!s){ s = new Set(); tokenMap.set(tok, s); }
    s.add(id);
  };
  for (const r of rows){
    const nameToks = String(r.name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const creatorToks = String(r.creator).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (const t of new Set([...nameToks, ...creatorToks])) addTok(t, r.id);
  }

  // tag_map normalization (optional use by UI)
  const assetToTags = Object.create(null);
  for (const [k, arr] of Object.entries(tag_map || {})){
    assetToTags[k] = Array.isArray(arr) ? arr.map(normalizeTag).filter(Boolean) : [];
    for (const t of assetToTags[k]) tagUniverse.add(t);
  }

  // Final store
  const store = {
    rows, byId, tagToIds, idf, tagUniverse: Array.from(tagUniverse).sort(),
    tokenMap, assetToTags, errors
  };

  setLoadStatusText("Finalizing…"); setProgress(.72, "Warming caches");

  // Potential warmup (no-op hooks here, reserved for future)
  const t1 = now();
  console.log(`[cards-backend] Store built in ${(t1 - t0).toFixed(1)}ms: ${rows.length} rows, ${store.tagUniverse.length} tags`);
  return store;
}

/* ========================= Expressions (parsers) ========================= */

/** Boolean tag expression: supports quoted tags, AND/OR/NOT, &, |, !, parentheses. */
function parseBoolExpr(input){
  const s = String(input || "").trim();
  if (!s) return { eval: (_store, _id, r) => true, ast: null };
  // Tokenize quoted strings and operators
  const tokens = [];
  let i = 0;
  while (i < s.length){
    const ch = s[i];
    if (/\s/.test(ch)){ i++; continue; }
    if (ch === '"' || ch === "'"){
      const q = ch; i++;
      let buf = "";
      while (i < s.length && s[i] !== q){ buf += s[i++]; }
      i++; tokens.push({type:"tag", val: normalizeTag(buf)});
      continue;
    }
    if (/[()]/.test(ch)){ tokens.push({type:ch}); i++; continue; }
    if (/[!&|]/.test(ch)){
      tokens.push({type: ch === "!" ? "NOT" : (ch === "&" ? "AND" : "OR")});
      i++; continue;
    }
    // words: AND OR NOT / bare tag (until space or operator)
    let j = i;
    while (j < s.length && !/[\s()!&|]/.test(s[j])) j++;
    const word = s.slice(i, j);
    const up = word.toUpperCase();
    if (up === "AND" || up === "OR" || up === "NOT") tokens.push({type: up});
    else tokens.push({type:"tag", val: normalizeTag(word)});
    i = j;
  }
  // Shunting-yard to RPN
  const prec = { "NOT":3, "AND":2, "OR":1 };
  const out = []; const ops = [];
  for (const t of tokens){
    if (t.type === "tag") out.push(t);
    else if (t.type === "NOT" || t.type === "AND" || t.type === "OR"){
      while (ops.length){
        const top = ops[ops.length-1];
        if ((top.type === "NOT" || top.type === "AND" || top.type === "OR") && prec[top.type] >= prec[t.type]) out.push(ops.pop());
        else break;
      }
      ops.push(t);
    } else if (t.type === "(") ops.push(t);
    else if (t.type === ")"){
      while (ops.length && ops[ops.length-1].type !== "(") out.push(ops.pop());
      if (ops.length && ops[ops.length-1].type === "(") ops.pop();
    }
  }
  while (ops.length) out.push(ops.pop());

  return {
    ast: out,
    eval: (store, _id, row) => {
      const stack = [];
      for (const n of out){
        if (n.type === "tag"){
          stack.push(row.tags.includes(n.val));
        } else if (n.type === "NOT"){
          const a = stack.pop() || false; stack.push(!a);
        } else if (n.type === "AND"){
          const b = stack.pop() || false, a = stack.pop() || false; stack.push(a && b);
        } else if (n.type === "OR"){
          const b = stack.pop() || false, a = stack.pop() || false; stack.push(a || b);
        }
      }
      return !!stack.pop();
    }
  };
}

/** Weights assignment parser: 'weight("Female") = 0.3; weight("obscure")=2.0' → Map */
function parseWeights(input){
  const s = String(input || "").trim();
  const weights = new Map();
  if (!s) return weights;
  const re = /weight\s*\(\s*("([^"]+)"|'([^']+)')\s*\)\s*=\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(s))){
    const tag = normalizeTag(m[2] || m[3] || "");
    const val = parseFloat(m[4]);
    if (tag) weights.set(tag, isFinite(val) ? val : 0);
  }
  return weights;
}

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","to","in","on","with","for","of","at",
  "by","from","up","out","over","under","then","so","than","too","very","can",
  "will","just","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","i","you","he","she","it","we","they","them","this","that",
  "these","those"
]);

function tokenizeForIndex(text){
  const raw = String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  const toks = [];
  for (let i = 0; i < raw.length; i++){
    const w1 = raw[i]; if (!STOPWORDS.has(w1)) toks.push(w1);         // unigram
    if (i + 1 < raw.length){
      const w2 = raw[i+1];
      if (!STOPWORDS.has(w1) && !STOPWORDS.has(w2)) toks.push(w1+" "+w2); // bigram
    }
  }
  return toks; // duplicates kept for TF
}


function buildTextIndex(storeOrCharacters, {reportProgress=true} = {}){
  // Determine rows from the argument only
  let rows, cacheTarget = null;
  if (storeOrCharacters && Array.isArray(storeOrCharacters.rows)) {
    rows = storeOrCharacters.rows;
    cacheTarget = storeOrCharacters;              // where we'll cache textIndex
    if (cacheTarget.textIndex && cacheTarget.textIndex.built) return cacheTarget.textIndex;
  } else if (Array.isArray(storeOrCharacters)) {
    rows = storeOrCharacters.map(c => ({
      id: c.id ?? c.name ?? String(Math.random()),
      creator_notes: c?.data?.creator_notes || "",
      description:   c?.data?.description   || ""
    }));
  } else {
    console.error("[buildTextIndex] invalid input:", storeOrCharacters);
    return { idf:new Map(), vecs:new Map(), built:true, docs:0, vocabSize:0 };
  }

  if (reportProgress){ setLoadStatusText("Indexing descriptions…"); setProgress(.76, "Token DF pass"); }

  // Collect per-doc TF and DF with weighting (desc 2× vs notes 1×)
  const df = new Map();
  const docs = [];
  let totalLen = 0;

  for (const r of rows){
    const notes = String(r.creator_notes || "");
    const desc  = String(r.description   || "");
    const weighted = (notes + " " + notes + " " + desc + " " + desc).trim();

    const toks = tokenizeForIndex(weighted);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);

    const seen = new Set();
    for (const t of tf.keys()){
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) || 0) + 1);
    }

    docs.push({ id: r.id, tf, len: toks.length });
    totalLen += toks.length;
  }

  // IDF with cutoffs (drop DF==1 and DF/N > 1%)
  if (reportProgress){ setProgress(.82, "Computing text IDF"); }
  const N = Math.max(1, docs.length);
  const idf = new Map();
  for (const [t, dfi] of df.entries()){
    if (dfi <= 1) continue;
    if ((dfi / N) > 0.01) continue;
    idf.set(t, Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5)));
  }

  // BM25 vectors
  if (reportProgress){ setProgress(.86, "Building BM25 vectors"); }
  const vecs = new Map();
  const k1 = 1.5, b = 0.75;
  const avgdl = totalLen / N;

  for (const {id, tf, len} of docs){
    const m = new Map();
    for (const [t, f] of tf.entries()){
      const itf = idf.get(t);
      if (!itf) continue;
      const denom = f + k1 * (1 - b + b * (len / avgdl));
      const w = itf * (f * (k1 + 1)) / denom;
      m.set(t, w);
    }
    vecs.set(id, m);
  }

  const out = { idf, vecs, built:true, docs:N, vocabSize:idf.size };
  if (cacheTarget) cacheTarget.textIndex = out;  // cache only on the passed-in store
  return out;
}






/* ============================ Query helpers ============================ */

function makeQueryAPI(store){
  function scoreRow(row, weights){
    if (!weights || !weights.size) return 0;
    let s = 0;
    for (const t of row.tags){
      const w = weights.get(t);
      if (w) s += w;
    }
    return s;
  }
  return {
    tagSimilarity(a, b, { mode = "jaccard", weightTags = true, idfMul = 1 } = {}){
      const A = new Set(a.tags);
      const B = new Set(b.tags);

      if (mode === "none") return 0;

      if (mode === "overlap"){
        // IDF-boosted overlap: sum weights on intersection
        // weight = 1 + IDF*(idfMul - 1) when weightTags, else 1
        let s = 0;
        for (const t of A){
          if (!B.has(t)) continue;
          if (weightTags){
            const idf = store.idf[t] || 0;
            s += 1 + idf * (idfMul - 1);
          } else {
            s += 1;
          }
        }
        return s;
      }

      if (mode === "jaccard"){
        let inter = 0, uni = new Set([...A, ...B]).size;
        for (const t of A) if (B.has(t)) inter++;
        return uni ? inter / uni : 0;
      }

      if (mode === "dice"){
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const total = A.size + B.size;
        return total ? (2 * inter) / total : 0;
      }

      if (mode === "tanimoto"){
        // Tanimoto is equivalent to Jaccard for binary sets
        let inter = 0, uni = new Set([...A, ...B]).size;
        for (const t of A) if (B.has(t)) inter++;
        return uni ? inter / uni : 0;
      }

      if (mode === "ochiai"){
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const denom = Math.sqrt(A.size * B.size);
        return denom ? inter / denom : 0;
      }

      if (mode === "simpson"){
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const minSize = Math.min(A.size, B.size);
        return minSize ? inter / minSize : 0;
      }

      if (mode === "braun-blanquet"){
        let inter = 0;
        for (const t of A) if (B.has(t)) inter++;
        const maxSize = Math.max(A.size, B.size);
        return maxSize ? inter / maxSize : 0;
      }

      if (mode === "hamming"){
        // Hamming distance (normalized): count of differing positions
        const union = new Set([...A, ...B]);
        let diff = 0;
        for (const t of union){
          if (A.has(t) !== B.has(t)) diff++;
        }
        return union.size ? 1 - (diff / union.size) : 1;
      }

      if (mode === "manhattan"){
        // Manhattan distance (normalized): sum of absolute differences
        const union = new Set([...A, ...B]);
        let dist = 0;
        for (const t of union){
          const aHas = A.has(t) ? 1 : 0;
          const bHas = B.has(t) ? 1 : 0;
          dist += Math.abs(aHas - bHas);
        }
        return union.size ? 1 - (dist / union.size) : 1;
      }

      if (mode === "euclidean"){
        // Euclidean distance (normalized): sqrt of sum of squared differences
        const union = new Set([...A, ...B]);
        let dist = 0;
        for (const t of union){
          const aHas = A.has(t) ? 1 : 0;
          const bHas = B.has(t) ? 1 : 0;
          dist += Math.pow(aHas - bHas, 2);
        }
        const maxDist = Math.sqrt(union.size);
        return maxDist ? 1 - (Math.sqrt(dist) / maxDist) : 1;
      }

      // Default: cosine over sparse tag vectors (optionally IDF-weighted)
      const wa = new Map(), wb = new Map();
      for (const t of A) wa.set(t, weightTags ? (store.idf[t] || 1) : 1);
      for (const t of B) wb.set(t, weightTags ? (store.idf[t] || 1) : 1);
      return cosineSimSparse(wa, wb);
    },

    textSimilarityById(aId, bId, { mode = "cosine", ngramMin = 1, ngramMax = 3 } = {}){
      if (mode === "none") return 0;

      const A = store.byId.get(aId), B = store.byId.get(bId);
      if (!A || !B) return 0;

      const textA = (A.creator_notes || "") + " " + (A.description || "");
      const textB = (B.creator_notes || "") + " " + (B.description || "");

      if (!textA.trim() || !textB.trim()) return 0;

      if (mode.startsWith("cosine")){
        // Extract n-gram range from mode name
        let minN = ngramMin, maxN = ngramMax;
        if (mode.includes("-1gram")) { minN = 1; maxN = 1; }
        else if (mode.includes("-2gram")) { minN = 1; maxN = 2; }
        else if (mode.includes("-3gram")) { minN = 1; maxN = 3; }
        else if (mode.includes("-4gram")) { minN = 1; maxN = 4; }

        const toksA = tokenizeText(textA, { minN, maxN });
        const toksB = tokenizeText(textB, { minN, maxN });

        const tfA = new Map(), tfB = new Map();
        for (const t of toksA) tfA.set(t, (tfA.get(t) || 0) + 1);
        for (const t of toksB) tfB.set(t, (tfB.get(t) || 0) + 1);

        return cosineSimSparse(tfA, tfB);
      }

      if (mode.startsWith("bm25")){
        // Use existing BM25 index for BM25 similarity
        const ti = store.textIndex?.built ? store.textIndex : buildTextIndex(store, {reportProgress:true});
        const va = ti.vecs.get(aId), vb = ti.vecs.get(bId);
        return cosineSimSparse(va, vb);
      }

      if (mode.startsWith("jaccard")){
        let minN = ngramMin, maxN = ngramMax;
        if (mode.includes("-2gram")) { minN = 2; maxN = 2; }
        else if (mode.includes("-3gram")) { minN = 3; maxN = 3; }
        else if (mode.includes("-4gram")) { minN = 4; maxN = 4; }
        else if (mode === "jaccard-text") { minN = 1; maxN = 1; }

        const setA = new Set(tokenizeText(textA, { minN, maxN }));
        const setB = new Set(tokenizeText(textB, { minN, maxN }));
        const inter = new Set([...setA].filter(x => setB.has(x))).size;
        const union = new Set([...setA, ...setB]).size;
        return union ? inter / union : 0;
      }

      if (mode === "dice-text"){
        const setA = new Set(tokenizeText(textA, { minN: 1, maxN: 1 }));
        const setB = new Set(tokenizeText(textB, { minN: 1, maxN: 1 }));
        const inter = new Set([...setA].filter(x => setB.has(x))).size;
        return (setA.size + setB.size) ? (2 * inter) / (setA.size + setB.size) : 0;
      }

      if (mode === "overlap-text"){
        const setA = new Set(tokenizeText(textA, { minN: 1, maxN: 1 }));
        const setB = new Set(tokenizeText(textB, { minN: 1, maxN: 1 }));
        return new Set([...setA].filter(x => setB.has(x))).size;
      }

      if (mode === "levenshtein"){
        return this.levenshteinSimilarity(textA, textB);
      }

      if (mode === "jaro-winkler"){
        return this.jaroWinklerSimilarity(textA, textB);
      }

      if (mode === "lcs"){
        return this.lcsSimilarity(textA, textB);
      }

      if (mode === "semantic-hash"){
        return this.semanticHashSimilarity(textA, textB);
      }

      // Default: cosine with TF-IDF
      const ti = store.textIndex?.built ? store.textIndex : buildTextIndex(store, {reportProgress:true});
      const va = ti.vecs.get(aId), vb = ti.vecs.get(bId);
      return cosineSimSparse(va, vb);
    },

    levenshteinSimilarity(a, b){
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) return 1;
      const dist = this.levenshteinDistance(a, b);
      return 1 - (dist / maxLen);
    },

    levenshteinDistance(a, b){
      const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
      for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
      for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
      for (let j = 1; j <= b.length; j++){
        for (let i = 1; i <= a.length; i++){
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          matrix[j][i] = Math.min(
            matrix[j][i - 1] + 1,
            matrix[j - 1][i] + 1,
            matrix[j - 1][i - 1] + cost
          );
        }
      }
      return matrix[b.length][a.length];
    },

    jaroWinklerSimilarity(a, b){
      const jaro = this.jaroSimilarity(a, b);
      if (jaro < 0.7) return jaro;
      let prefix = 0;
      for (let i = 0; i < Math.min(a.length, b.length, 4); i++){
        if (a[i] === b[i]) prefix++;
        else break;
      }
      return jaro + (0.1 * prefix * (1 - jaro));
    },

    jaroSimilarity(a, b){
      if (a === b) return 1;
      const len1 = a.length, len2 = b.length;
      if (len1 === 0 || len2 === 0) return 0;
      const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
      const matches1 = new Array(len1).fill(false);
      const matches2 = new Array(len2).fill(false);
      let matches = 0, transpositions = 0;
      for (let i = 0; i < len1; i++){
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, len2);
        for (let j = start; j < end; j++){
          if (matches2[j] || a[i] !== b[j]) continue;
          matches1[i] = matches2[j] = true;
          matches++;
          break;
        }
      }
      if (matches === 0) return 0;
      let k = 0;
      for (let i = 0; i < len1; i++){
        if (!matches1[i]) continue;
        while (!matches2[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
      }
      return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
    },

    lcsSimilarity(a, b){
      const lcs = this.longestCommonSubsequence(a, b);
      const maxLen = Math.max(a.length, b.length);
      return maxLen ? lcs / maxLen : 1;
    },

    longestCommonSubsequence(a, b){
      const m = a.length, n = b.length;
      const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++){
        for (let j = 1; j <= n; j++){
          if (a[i - 1] === b[j - 1]){
            dp[i][j] = dp[i - 1][j - 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
          }
        }
      }
      return dp[m][n];
    },

    semanticHashSimilarity(a, b){
      const hashA = this.simpleSemanticHash(a);
      const hashB = this.simpleSemanticHash(b);
      let matches = 0;
      for (let i = 0; i < Math.min(hashA.length, hashB.length); i++){
        if (hashA[i] === hashB[i]) matches++;
      }
      return Math.max(hashA.length, hashB.length) ? matches / Math.max(hashA.length, hashB.length) : 0;
    },

    simpleSemanticHash(text){
      const words = text.toLowerCase().split(/\W+/).filter(Boolean);
      const features = new Map();
      for (const word of words){
        features.set(word, (features.get(word) || 0) + 1);
      }
      const sorted = Array.from(features.entries()).sort((a, b) => b[1] - a[1]);
      return sorted.slice(0, 32).map(([word]) => word).join('');
    },


    /** Combined similarity: alpha*tag + (1-alpha)*text
        opts: { tagMode:'jaccard'|'cosine', descMode:'cosine', weightTags:true, includeText:true, alpha:0.6, ngramMin:1, ngramMax:3 } */
    combinedSimilarity(aId, bId, opts = {}){
      const {
        tagMode = 'cosine',
        descMode = 'cosine',
        weightTags = true,
        includeText = true,
        includeTags = true,
        alpha = 0.6,
        idfMul = 1,
        ngramMin = 1,
        ngramMax = 3
      } = opts;

      const A = store.byId.get(aId), B = store.byId.get(bId);
      if (!A || !B) return 0;

      let sTag = 0, sText = 0;

      if (includeTags){
        sTag = this.tagSimilarity(A, B, { mode: tagMode, weightTags, idfMul });
      }
      if (includeText){
        sText = this.textSimilarityById(aId, bId, { mode: descMode, ngramMin, ngramMax });
      }

      if (includeTags && includeText) return alpha * sTag + (1 - alpha) * sText;
      if (includeTags) return sTag;
      if (includeText) return sText;
      return 0;
    },


    /** Filter rows by boolean tag expression (string), then optional tag count range and rarity range. */
    filter({ expr, tagCountMin = 0, tagCountMax = 1e9, rarityMin = -1e9, rarityMax = 1e9 }){
      const be = parseBoolExpr(expr);
      const out = [];
      for (const r of store.rows){
        if (!be.eval(store, r.id, r)) continue;
        if (r.tag_count < tagCountMin || r.tag_count > tagCountMax) continue;
        if (r.sigma_idf < rarityMin || r.sigma_idf > rarityMax) continue;
        out.push(r);
      }
      return out;
    },
    /** Sort rows with weights (affects score only); accepts field keys too (name, creator, tag_count, sigma_idf, date_added, date_last_chat, chat_size, data_size) */
    sort(rows, { by = "score", dir = "desc", weightsInput = "" } = {}){
      const weights = parseWeights(weightsInput);
      const mul = (dir === "asc" ? 1 : -1);
      rows.sort((a,b)=>{
        if (by === "score"){
          const sa = scoreRow(a, weights), sb = scoreRow(b, weights);
          return mul * (sa - sb || a.name.localeCompare(b.name));
        } else if (by === "name" || by === "creator"){
          return mul * (String(a[by]||"").localeCompare(String(b[by]||"")));
        } else {
          return mul * ((a[by]||0) - (b[by]||0));
        }
      });
      return rows;
    },
    /** Simple token search on name/creator */
    searchTokens(q){
      const toks = String(q||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (!toks.length) return new Set(store.rows.map(r=>r.id));
      let current;
      for (const t of toks){
        const s = store.tokenMap.get(t) || new Set();
        current = current ? new Set([...current].filter(x => s.has(x))) : new Set(s);
        if (!current.size) break;
      }
      return current || new Set();
    }
  };
}

/* =============================== Channel =============================== */

const CHANNEL_NAME = "cards-data";
let processed = false;

function sendReady(){
  try {
    // post {type:'ps-ready'} on the same channel (producer listens to it)
    channel?.postMessage({ type: "ps-ready" });
  } catch {}
}

function attachChannel(){
  if (!("BroadcastChannel" in window)) {
    console.error("[cards-backend] BroadcastChannel not supported");
    return;
  }
  window.channel = new BroadcastChannel(CHANNEL_NAME);
  // handshake ASAP
  setTimeout(sendReady, 0);

  const channel = window.channel;

  channel.onmessage = (ev) => {
    const d = ev?.data;
    // Ignore control/handshake messages
    if (!d || (d.type && d.type !== "payload" && !d.characters)) return;
    if (processed) { console.debug("[cards-backend] Payload already processed; ignoring subsequent broadcast"); return; }

    // Start blocking + progress
    setLoadStatusText("loading…"); setProgress(.05, "Parsing incoming payload…"); setBlocking(true);
    try {
      processed = true;
      const store = buildStore(d);

      // Expose & notify
      window.CardsBackend = {
        store,
        query: makeQueryAPI(store),
        parseBoolExpr,
        parseWeights,
        setBlocking, setProgress, setLoadStatusText,
        ensureTextIndex: () => buildTextIndex(store, {reportProgress:true}), // <-- add this
      };

      // Dispatch event for the SPA to hook into
      window.dispatchEvent(new CustomEvent("cards:ready", { detail: { store } }));

      // Back-compat hook
      if (typeof window.afterData === "function"){
        try { window.afterData(store); } catch (e){ console.error("[cards-backend] afterData error", e); }
      }

      setProgress(.98, "Ready"); setLoadStatusText("Ready"); setTimeout(()=>setBlocking(false), 80);
    } catch (err){
      console.error("[cards-backend] Ingest failed:", err);
      setLoadStatusText("Failed to load data"); setProgress(1, String(err?.message || err));
      // Unblock but keep overlay briefly to show error
      setTimeout(()=>setBlocking(false), 600);
      // Notify producer about error for visibility
      try{ channel?.postMessage({ type:"error", message: String(err?.message || err) }); }catch{}
    }
  };
}

/* ============================== Bootstrap ============================== */

(function bootstrap(){
  ensureOverlay();
  setBlocking(true);
  // Allow apps to opt-in to listening before we attach (just in case)
  setTimeout(attachChannel, 0);
})();

// End of module
