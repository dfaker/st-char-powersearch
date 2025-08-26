import { renderExtensionTemplateAsync } from "../../../extensions.js";
import { tags as tagsStore, tag_map } from "../../../tags.js";
import { characters as charactersStore, selectCharacterById } from "../../../../script.js";

async function initSettings() {
  const html = await renderExtensionTemplateAsync("third-party/st-char-powersearch", "settings");
  jQuery(document.getElementById("extensions_settings")).append(html);
  bindOpenButton();

  const $groupBtn = jQuery("#rm_button_group_chats");
  if ($groupBtn.length && !document.getElementById("pwr_charsearch")) {
    const $psBtn = jQuery(`
      <div id="pwr_charsearch"
           title="Character Powersearch"
           data-i18n="[title]Character Powersearch"
           class="menu_button fa-solid fa-search-plus interactable"
           tabindex="0"></div>
    `);
    $groupBtn.after($psBtn);

    $psBtn.on("click", () => {
      jQuery("#char-powersearch_open").trigger("click");
    });
  }
}

jQuery(() => { 
  initSettings(); 
});

// ---------------- Open SPA + Broadcast (RAW, unchanged) ----------------
function bindOpenButton(){
  const $btn = jQuery("#char-powersearch_open");
  if (!$btn.length) return;
  $btn.off("click.charPowersearch").on("click.charPowersearch", ()=>{
    const url = "/scripts/extensions/third-party/st-char-powersearch/char_powersearch.html";
    const win = window.open(url, "_blank");

const payload = structuredClone
  ? structuredClone({ characters: charactersStore, tags: tagsStore, tag_map })
  : { characters: JSON.parse(JSON.stringify(charactersStore)),
      tags: JSON.parse(JSON.stringify(tagsStore)),
      tag_map: JSON.parse(JSON.stringify(tag_map)) };

  for (let i = 0; i < payload.characters.length; i++) {
    payload.characters[i].id = i;
  }

  if (!("BroadcastChannel" in window)) { alert("BroadcastChannel not supported in this browser"); return; }

  const chan = new BroadcastChannel("cards-data");

  let gotReady = false;
  let tries = 0;
  const intervalMs = 250;

  // 1) Send once immediately to avoid a race where ready arrives first
  try { chan.postMessage(payload); } catch {}

  chan.onmessage = (ev) => {
    console.log(ev)

    const d = ev?.data;
    if (!d) return;

    

    if (d.type === "ps-ready") {
      gotReady = true;
      try { chan.postMessage(payload); } catch {}
      return;
    }

    if (d.type === "select" && d.id != null) {
      try {
          selectCharacterById(d.id);
      } catch (e) {
        console.error("[Powersearch] selectCharacter failed:", e);
      }
    }
  };

  // 3) Keep retrying for ~20s, but allow early exit once ready & a few sends have happened
  const extraSendsAfterReady = 3;
  let postReadyCount = 0;

  const timer = setInterval(() => {
    try {
      // if the popup was closed or we've hit limits, stop
      if (!win || win.closed) {
        clearInterval(timer); try { chan.close?.(); } catch {}
        return;
      }

      // While not ready, keep broadcasting
      // After ready, do a few more sends (covers transient timing issues)
      if (!gotReady || postReadyCount < extraSendsAfterReady) {
        chan.postMessage(payload);
        tries++;
        if (gotReady) postReadyCount++;
      }
    } catch (err) {
      console.warn("[Powersearch] broadcast error, stopping", err);
      clearInterval(timer); try { chan.close?.(); } catch {}
    }
  }, intervalMs);



  });
}

globalThis.selectCharacterById = selectCharacterById;
globalThis.__ps_chars = charactersStore;
globalThis.__ps_tags = tagsStore;
globalThis.__ps_tag_map = tag_map;