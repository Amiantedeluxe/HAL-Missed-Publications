const API = "https://api.archives-ouvertes.fr";
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const asList = v => v == null ? [] : Array.isArray(v) ? v : [v];
const normName = s => (s || "").replace(/\s*\[[^\]]*\]\s*$/, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const safeUrl = u => /^https?:\/\//.test(u || "");
const COLS = [["statut","Statut"],["halId","Notice"],["auteur","Auteur non affilié"],["annee","Année"],["fenetre","Période"],["titre","Titre"],["type","Type"],["doi","DOI"],["deposant","Déposant"]];
const HELP = {
  statut: "✓ déjà tamponnée, ✗ à ne pas tamponner. Enregistré dans ce navigateur.",
  halId: "Identifiant de la notice HAL.",
  auteur: "Auteur présent sur la notice sans aucune affiliation.",
  annee: "Année de production de la notice.",
  fenetre: "Première et dernière année où cet auteur apparaît affilié à la structure. Seules les notices proches de cette période sont retenues (avec la marge).",
  titre: "Titre de la notice ; le lien ouvre la notice.",
  type: "Type de document HAL (article, communication, ouvrage…).",
  doi: "DOI de la notice, cliquable.",
  deposant: "Personne qui a déposé la notice.",
  disc: "Discipline : ✓ identique à celles de l'auteur, ~ comparable, ≠ différente. Indicatif.",
  hom: "Nombre d'autres personnes de même nom ayant une fiche HAL parmi les notices examinées. Plus il est élevé, plus le risque d'homonyme est grand."
};
const CSV_COLS = [["src","Méthode"], ...COLS, ["disc","Disc."], ["hom","Hom."], ["url","Lien"]];
const cols = () => tab === "nom" ? [...COLS.slice(0, 3), ["disc","Disc."], ["hom","Hom."], ...COLS.slice(3)] : COLS;
const DISC = {"✓": "Même discipline fine que l'auteur", "~": "Discipline fine non comparable", "≠": "Discipline fine différente de celles de l'auteur"};
const NORM = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
const profil = (m, n) => new Set([...m].filter(([, c]) => c / n >= 0.2).map(([k]) => k));
const inter = (a, b) => a.some(x => b.has(x));
const STATUS = {todo: "À traiter", done: "Tamponnée", skip: "À ne pas tamponner"};
const lsGet = (k, d) => { try { const v = localStorage.getItem("halmp-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem("halmp-" + k, JSON.stringify(v)); } catch {} };
const statuses = lsGet("status", {});
let stopFlag = false, rows = [], shown = 0, sortKey = "auteur", sortDir = 1, tab = "id";

function portalPrefix(){
  return $("portal").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.hal\.science.*$/, "").replace(/[^a-z0-9-]/g, "");
}
function displayUrl(r){
  if (!safeUrl(r.url)) return "";
  const p = portalPrefix();
  if (!p) return r.url;
  try { return `https://${p}.hal.science${new URL(r.url).pathname}`; } catch { return r.url; }
}
function showCount(){
  const inTab = rows.filter(r => r.src === tab);
  $("count").textContent = `${shown} / ${inTab.length} notices · ${inTab.filter(r => r.statut === "todo").length} à traiter`;
}
function statusButtons(r, tr){
  const box = document.createElement("div");
  box.className = "st";
  const mk = (val, sym, label) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = sym; b.title = label; b.dataset.v = val;
    b.setAttribute("aria-label", label + " : " + r.halId);
    b.setAttribute("aria-pressed", String(r.statut === val));
    b.onclick = () => {
      r.statut = r.statut === val ? "todo" : val;
      if (r.statut === "todo") delete statuses[r.key]; else statuses[r.key] = r.statut;
      lsSet("status", statuses);
      tr.dataset.s = r.statut;
      for (const x of box.children) x.setAttribute("aria-pressed", String(x.dataset.v === r.statut));
      if ($("sfilter").value) render(); else showCount();
    };
    return b;
  };
  box.append(mk("done", "✓", "Tamponnée"), mk("skip", "✗", "À ne pas tamponner"));
  return box;
}

function log(m){ const el = $("log"); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; }
function status(m){ $("status").textContent = m; }
function progress(v, max){ const b = $("bar"); b.hidden = false; b.max = max || 1; b.value = v; }

async function getJson(path, params){
  const url = API + path + "?" + new URLSearchParams(params);
  for (let i = 0; i < 4; i++){
    if (stopFlag && path === "/search/") throw new Error("Analyse arrêtée");
    try {
      const r = await fetch(url);
      if (!r.ok){ const er = new Error("HTTP " + r.status); er.noRetry = r.status >= 400 && r.status < 500 && r.status !== 429; throw er; }
      return await r.json();
    } catch (e) {
      if (e.noRetry) throw e;
      log("! " + e.message + " — nouvel essai");
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error("Échec répété de l'API HAL");
}

async function paginate(params, onDocs){
  let cursor = "*";
  while (true){
    const data = await getJson("/search/", {...params, rows: 500, sort: "docid asc", wt: "json", cursorMark: cursor});
    const docs = data.response.docs;
    onDocs(docs, data.response.numFound);
    const next = data.nextCursorMark;
    if (!docs.length || !next || next === cursor) break;
    cursor = next;
    await sleep(200);
  }
}

// "<idForme>-<idPersonne>_FacetSep_<Nom>_JoinSep_<idStructure>_FacetSep_<NomStructure>"
const cut = (s, sep) => { const i = s.indexOf(sep); if (i < 0) throw 0; return [s.slice(0, i), s.slice(i + sep.length)]; };
function parseAuthStruct(v){
  try {
    const [left, right] = cut(v, "_JoinSep_");
    const [token, name] = cut(left, "_FacetSep_");
    const [sid, sname] = cut(right, "_FacetSep_");
    const pid = token.includes("-") ? parseInt(token.split("-")[1], 10) : parseInt(token, 10);
    const s = parseInt(sid, 10);
    if (Number.isNaN(pid) || Number.isNaN(s)) return null;
    return [pid, name, s, sname, token];
  } catch { return null; }
}
function docYear(d){ const y = d.producedDateY_i || d.publicationDateY_i; return y ? parseInt(y, 10) : null; }

async function resolveStructures(code){
  const d = await getJson("/ref/structure/", {q: `code_s:"${code}" OR acronym_s:"${code}"`, fl: "docid,label_s,acronym_s,code_s,valid_s", rows: 20, wt: "json"});
  return d.response.docs || [];
}

async function buildSeed(coll, ids, targetName){
  const entries = [], names = new Map(), counts = new Map();
  let nDocs = 0, bad = 0, noPerson = 0;
  await paginate({q: "*:*", fq: "collCode_s:" + coll, fl: "docid,authIdHasStructure_fs,producedDateY_i,publicationDateY_i,level0_domain_s,level1_domain_s"}, (docs, total) => {
    for (const d of docs){
      nDocs++;
      const y = docYear(d), seen = new Set();
      for (const v of asList(d.authIdHasStructure_fs)){
        const p = parseAuthStruct(v);
        if (!p){ bad++; continue; }
        const [pid, name, sid, sname] = p;
        names.set(sid, sname); seen.add(sid);
        if (pid <= 0){ noPerson++; continue; }
        entries.push([pid, name, sid, y, d.docid, asList(d.level0_domain_s), asList(d.level1_domain_s)]);
      }
      for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
    }
    progress(nDocs, total);
    status(`Lecture de la collection : ${nDocs} / ${total} notices`);
  });
  log(`${nDocs} notices lues dans la collection.`);
  if (bad) log(`! ${bad} valeurs authIdHasStructure_fs illisibles`);
  if (noPerson) log(`${noPerson} affiliations sans profil HAL ignorées.`);
  log("Structures les plus présentes :");
  [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([s, n]) => log(`  ${s}  ${names.get(s) || "?"}  (${n} notices)`));

  const targets = new Set(ids);
  if (targetName) for (const [s, nm] of names) if (normName(nm) === targetName && !targets.has(s)){ targets.add(s); log("Identifiant de même nom ajouté : " + s); }
  log("Structures cibles : " + [...targets].join(", "));

  const authors = new Map(), seenPD = new Set();
  for (const [pid, name, sid, y, did, d0, d1] of entries){
    if (!targets.has(sid)) continue;
    const a = authors.get(pid) || {name, names: new Set(), min: null, max: null, d0: new Map(), d1: new Map(), n: 0};
    a.names.add(name);
    if (y){ a.min = a.min == null ? y : Math.min(a.min, y); a.max = a.max == null ? y : Math.max(a.max, y); }
    const k = did + "-" + pid;
    if (!seenPD.has(k)){
      seenPD.add(k); a.n++;
      for (const x of d0) a.d0.set(x, (a.d0.get(x) || 0) + 1);
      for (const x of d1) a.d1.set(x, (a.d1.get(x) || 0) + 1);
    }
    authors.set(pid, a);
  }
  log(`${authors.size} auteurs affiliés retenus.`);
  return authors;
}

async function findCandidates(coll, authors, margin){
  const ids = [...authors.keys()], size = 30, nb = Math.ceil(ids.length / size), found = new Map();
  let total = 0;
  for (let i = 0; i < ids.length; i += size){
    const batch = ids.slice(i, i + size), set = new Set(batch);
    status(`Recherche hors collection : lot ${i / size + 1} / ${nb}`);
    progress(i / size, nb);
    await paginate({
      q: "authIdPerson_i:(" + batch.join(" OR ") + ")",
      fq: "-collCode_s:" + coll,
      fl: "docid,halId_s,uri_s,title_s,docType_s,producedDateY_i,publicationDateY_i,doiId_s,contributorFullName_s,authIdPerson_i,authIdHasStructure_fs"
    }, docs => {
      for (const d of docs){
        total++;
        const y = docYear(d);
        const persons = new Set(asList(d.authIdPerson_i).map(Number)); persons.delete(0);
        const aff = new Set();
        for (const v of asList(d.authIdHasStructure_fs)){ const p = parseAuthStruct(v); if (p) aff.add(p[0]); }
        for (const pid of persons){
          if (!set.has(pid) || aff.has(pid)) continue;
          const a = authors.get(pid);
          if (y != null && a.min != null && (y < a.min - margin || y > a.max + margin)) continue;
          const key = d.docid + "-" + pid;
          found.set(key, {
            key, src: "id", statut: statuses[key] || "todo",
            halId: d.halId_s || "",
            url: d.uri_s || (d.halId_s ? "https://hal.science/" + d.halId_s : ""),
            annee: y || "", type: d.docType_s || "", titre: asList(d.title_s)[0] || "",
            doi: d.doiId_s || "", deposant: d.contributorFullName_s || "",
            auteur: a.name, fenetre: `${a.min}–${a.max}`
          });
        }
      }
    });
  }
  log(`${total} notices hors collection examinées.`);
  if (!total) log("! Aucune notice hors collection : le champ authIdPerson_i n'est peut-être pas interrogeable.");
  return [...found.values()];
}

async function findByName(coll, authors, margin){
  const byName = new Map(), forms = new Map();
  for (const [pid, a] of authors) for (const nm of a.names){
    const k = NORM(nm); if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(pid);
    if (!forms.has(k)) forms.set(k, nm);
  }
  const names = [...forms.values()], size = 15, nb = Math.ceil(names.length / size);
  const persons = new Map(), cands = [];
  let field = "authFullName_t", total = 0;
  const fl = "docid,halId_s,uri_s,title_s,docType_s,producedDateY_i,publicationDateY_i,doiId_s,contributorFullName_s,authIdHasStructure_fs,authFullNameFormIDPersonIDIDHal_fs,level0_domain_s,level1_domain_s";
  for (let i = 0; i < names.length; i += size){
    status(`Recherche par nom : lot ${i / size + 1} / ${nb}`); progress(i / size, nb);
    for (let attempt = 0; attempt < 2; attempt++){
      const q = field + ":(" + names.slice(i, i + size).map(n => '"' + n.replace(/["\\]/g, " ") + '"').join(" OR ") + ")";
      try {
        await paginate({q, fq: "-collCode_s:" + coll, fl}, docs => {
          for (const d of docs){
            total++;
            const aff = new Set();
            for (const v of asList(d.authIdHasStructure_fs)){ const p = parseAuthStruct(v); if (p) aff.add(p[4]); }
            for (const v of asList(d.authFullNameFormIDPersonIDIDHal_fs)){
              const [nm, token] = v.split("_FacetSep_");
              if (!token) continue;
              const pid = parseInt(token.split("-")[1], 10), k = NORM(nm);
              if (pid > 0){ if (!persons.has(k)) persons.set(k, new Set()); persons.get(k).add(pid); continue; }
              if (pid !== 0 || aff.has(token) || !byName.has(k)) continue;
              cands.push({key: "n:" + d.docid + "-" + token, d, k, y: docYear(d), l0: asList(d.level0_domain_s), l1: asList(d.level1_domain_s), nm});
            }
          }
        });
        break;
      } catch (e) {
        if (attempt === 0 && e.noRetry && field === "authFullName_t"){ log("Champ authFullName_t refusé, essai avec authFullName_s."); field = "authFullName_s"; continue; }
        throw e;
      }
    }
  }
  const out = new Map();
  for (const c of cands){
    for (const pid of byName.get(c.k)){
      const a = authors.get(pid);
      if (c.y != null && a.min != null && (c.y < a.min - margin || c.y > a.max + margin)) continue;
      const p0 = profil(a.d0, a.n), p1 = profil(a.d1, a.n);
      if (c.l0.length && p0.size && !inter(c.l0, p0)) continue;
      const disc = c.l1.length && p1.size ? (inter(c.l1, p1) ? "✓" : "≠") : "~";
      const hom = [...(persons.get(c.k) || [])].filter(x => !authors.has(x)).length;
      const d = c.d;
      out.set(c.key, {
        key: c.key, src: "nom", statut: statuses[c.key] || "todo",
        halId: d.halId_s || "", url: d.uri_s || (d.halId_s ? "https://hal.science/" + d.halId_s : ""),
        annee: c.y || "", type: d.docType_s || "", titre: asList(d.title_s)[0] || "",
        doi: d.doiId_s || "", deposant: d.contributorFullName_s || "",
        auteur: c.nm, fenetre: `${a.min}–${a.max}`, disc, hom
      });
      break;
    }
  }
  log(`${total} notices examinées par nom, ${out.size} candidates retenues.`);
  return [...out.values()];
}

function updateTabs(){
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === tab)));
  $("n-id").textContent = `(${rows.filter(r => r.src === "id").length})`;
  $("n-nom").textContent = `(${rows.filter(r => r.src === "nom").length})`;
}

function checkOverflow(){
  const w = document.querySelector(".wrap");
  $("hscroll").hidden = w.scrollWidth <= w.clientWidth + 1;
}

function head(){
  const tr = $("head"); tr.replaceChildren();
  for (const [k, l] of cols()){
    const th = document.createElement("th"), b = document.createElement("button");
    th.className = "c-" + k;
    b.type = "button";
    b.title = HELP[k] || "";
    b.textContent = l + (k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : "");
    b.onclick = () => { sortDir = k === sortKey ? -sortDir : 1; sortKey = k; head(); render(); };
    th.append(b); tr.append(th);
  }
}

function link(href, text){
  const a = document.createElement("a");
  a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
  return a;
}

function render(){
  const f = $("filter").value.trim().toLowerCase();
  const sf = $("sfilter").value;
  const list = rows.filter(r => r.src === tab && (!sf || r.statut === sf) && (!f || cols().map(([k]) => r[k]).join(" ").toLowerCase().includes(f)));
  const sv = r => sortKey === "disc" ? "✓~≠".indexOf(r.disc) : r[sortKey] ?? "";
  list.sort((a, b) => String(sv(a)).localeCompare(String(sv(b)), "fr", {numeric: true}) * sortDir);
  shown = list.length; showCount();
  const body = $("body"); body.replaceChildren();
  if (!list.length){
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = cols().length; td.className = "empty"; td.textContent = "Aucune notice à afficher.";
    tr.append(td); body.append(tr); checkOverflow(); return;
  }
  for (const r of list){
    const tr = document.createElement("tr");
    tr.dataset.s = r.statut;
    for (const [k] of cols()){
      const td = document.createElement("td");
      td.className = "c-" + k;
      const u = displayUrl(r);
      if (k === "statut") td.append(statusButtons(r, tr));
      else if (k === "disc"){ td.textContent = r.disc; td.title = DISC[r.disc] || ""; }
      else if ((k === "halId" || k === "titre") && u) td.append(link(u, r[k] || r.halId));
      else if (k === "doi" && r.doi){ td.title = r.doi; td.append(link("https://doi.org/" + encodeURI(r.doi), r.doi)); }
      else { td.textContent = r[k]; if (k === "deposant") td.title = r[k]; }
      tr.append(td);
    }
    body.append(tr);
  }
  checkOverflow();
}

function exportCsv(){
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [CSV_COLS.map(c => esc(c[1])).join(",")];
  const cell = (r, k) => k === "statut" ? STATUS[r.statut] : k === "url" ? displayUrl(r) : k === "src" ? (r.src === "nom" ? "nom" : "identifiant") : r[k] ?? "";
  for (const r of rows) lines.push(CSV_COLS.map(([k]) => esc(cell(r, k))).join(","));
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], {type: "text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `non_tamponnees_${$("coll").value.trim()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

let picked = [], suggTimer = 0, suggSeq = 0, suggItems = [], suggIdx = -1;

async function suggestStructures(term){
  const words = term.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(w => w.length > 1);
  const up = term.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const fl = "docid,label_s,acronym_s,code_s,type_s,valid_s,parentName_s";
  const run = async (q, rows) => {
    try { return (await getJson("/ref/structure/", {q, fl, rows, wt: "json"})).response.docs || []; }
    catch (e) { if (e.noRetry) return []; throw e; }
  };
  const qs = [];
  if (/^\d+$/.test(term)) qs.push(["docid:" + term, 5]);
  if (up.length > 1){
    qs.push([`acronym_s:"${up}" OR code_s:"${up}"`, 20]);
    qs.push([`acronym_s:${up}* OR code_s:${up}*`, 30]);
  }
  if (words.length) qs.push([words.map(w => w + "*").join(" AND "), 50]);
  const res = await Promise.all(qs.map(([q, n]) => run(q, n)));
  const seen = new Set(), all = [];
  for (const docs of res) for (const sg of docs) if (!seen.has(sg.docid)){ seen.add(sg.docid); all.push(sg); }
  const rank = sg => ({VALID: 0, OLD: 1, INCOMING: 2}[sg.valid_s] ?? 3);
  const exact = sg => [sg.acronym_s, sg.code_s].some(x => x && String(x).toUpperCase() === up) ? 0 : 1;
  return all.sort((x, y) => rank(x) - rank(y) || exact(x) - exact(y)).slice(0, 25);
}

function renderChips(){
  const box = $("chips"); box.replaceChildren();
  for (const p of picked){
    const c = document.createElement("span"); c.className = "chip"; c.dataset.v = p.valid || "";
    c.append(document.createTextNode(`${p.acronym || p.label} · ${p.id}`));
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.title = "Retirer";
    x.setAttribute("aria-label", "Retirer " + (p.acronym || p.label));
    x.onclick = () => { picked = picked.filter(q => q.id !== p.id); renderChips(); };
    c.append(x); box.append(c);
  }
}
function closeSugg(){ $("sugg").hidden = true; $("ids").setAttribute("aria-expanded", "false"); suggIdx = -1; }
function pick(sg){
  const id = Number(sg.docid);
  if (!picked.some(p => p.id === id)) picked.push({id, label: sg.label_s || "", acronym: sg.acronym_s || "", valid: sg.valid_s || ""});
  $("ids").value = ""; renderChips(); closeSugg(); $("ids").focus();
}
function showSugg(list, msg){
  const ul = $("sugg"); ul.replaceChildren(); suggItems = list; suggIdx = -1;
  if (!list.length){
    const li = document.createElement("li"); li.className = "none"; li.textContent = msg || "Aucune structure trouvée"; ul.append(li);
  }
  for (const sg of list){
    const li = document.createElement("li"); li.setAttribute("role", "option");
    li.textContent = sg.label_s || sg.acronym_s || String(sg.docid);
    const sm = document.createElement("small");
    const tag = document.createElement("span");
    tag.className = "tag " + ({VALID: "v", OLD: "o", INCOMING: "i"}[sg.valid_s] || "");
    tag.textContent = sg.valid_s || "?";
    sm.append(tag, " " + [sg.type_s, sg.parentName_s, sg.docid].filter(Boolean).join(" · "));
    li.append(sm);
    li.onmousedown = e => { e.preventDefault(); pick(sg); };
    ul.append(li);
  }
  ul.hidden = false; $("ids").setAttribute("aria-expanded", "true");
}
async function runSuggest(term){
  const seq = ++suggSeq;
  try {
    const list = await suggestStructures(term);
    if (seq === suggSeq) showSugg(list);
  } catch (e) { if (seq === suggSeq) showSugg([], "Suggestions indisponibles : " + e.message); }
}
$("ids").addEventListener("input", () => {
  clearTimeout(suggTimer);
  const t = $("ids").value.trim();
  if (t.length < 2){ closeSugg(); return; }
  suggTimer = setTimeout(() => runSuggest(t), 300);
});
$("ids").addEventListener("focus", () => {
  const c = $("coll").value.trim();
  if (!$("ids").value.trim() && c) runSuggest(c);
});
$("ids").addEventListener("blur", closeSugg);
$("ids").addEventListener("keydown", e => {
  const opts = [...$("sugg").querySelectorAll("li[role=option]")];
  if ($("sugg").hidden || !opts.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp"){
    e.preventDefault();
    suggIdx = e.key === "ArrowDown" ? (suggIdx + 1) % opts.length : (suggIdx <= 0 ? opts.length - 1 : suggIdx - 1);
    opts.forEach((o, i) => o.setAttribute("aria-selected", String(i === suggIdx)));
    opts[suggIdx].scrollIntoView({block: "nearest"});
  } else if (e.key === "Enter" && suggIdx >= 0){
    e.preventDefault(); pick(suggItems[suggIdx]);
  } else if (e.key === "Escape") closeSugg();
});

$("f").addEventListener("submit", async e => {
  e.preventDefault();
  const coll = $("coll").value.trim();
  const margin = Math.max(0, parseInt($("margin").value, 10) || 0);
  const typed = $("ids").value.trim();
  if (typed && !/^[\d\s,;]+$/.test(typed)){ status("Erreur : choisis une structure dans la liste de suggestions, ou vide le champ."); return; }
  const ids = [...new Set([...picked.map(p => p.id), ...(typed.match(/\d+/g) || []).map(Number)])];
  stopFlag = false; rows = []; $("log").textContent = ""; $("results").style.display = "none";
  $("go").disabled = true; $("stop").disabled = false;
  try {
    let struct = ids, targetName = null;
    if (!ids.length){
      status("Recherche de la structure…");
      const found = await resolveStructures(coll);
      const valid = found.filter(s => s.valid_s === "VALID");
      const pick = valid.length ? valid : found;
      if (pick.length !== 1){
        log("Structures candidates :");
        found.forEach(s => log(`  ${s.docid}  ${s.label_s}  [${s.valid_s}]`));
        throw new Error(found.length ? "Plusieurs structures possibles : renseigne un ou plusieurs identifiants (voir le journal)." : "Aucune structure trouvée : renseigne les identifiants de structure.");
      }
      struct = [Number(pick[0].docid)];
      targetName = normName(pick[0].label_s);
      log(`Structure retenue : ${pick[0].label_s} (${pick[0].docid})`);
    }
    const authors = await buildSeed(coll, struct, targetName);
    if (!authors.size) throw new Error("Aucun auteur trouvé : renseigne un identifiant de structure listé dans le journal.");
    rows = await findCandidates(coll, authors, margin);
    const byname = $("byname").checked;
    if (byname) rows = rows.concat(await findByName(coll, authors, margin));
    const nId = rows.filter(r => r.src === "id").length, nNom = rows.length - nId;
    status(`Terminé : ${nId} notices par identifiant` + (byname ? `, ${nNom} par nom (à vérifier).` : "."));
    tab = "id"; sortKey = "auteur"; $("tabs").hidden = !byname; updateTabs();
    head(); render(); $("results").style.display = "block";
  } catch (err) {
    status("Erreur : " + err.message);
  } finally {
    $("go").disabled = false; $("stop").disabled = true; $("bar").hidden = true;
  }
});
$("stop").onclick = () => { stopFlag = true; };
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => { tab = b.dataset.t; sortKey = "auteur"; updateTabs(); head(); render(); });
$("filter").oninput = render;
$("csv").onclick = exportCsv;
$("sfilter").onchange = render;
window.addEventListener("resize", checkOverflow);
$("portal").value = lsGet("portal", "");
$("portal").oninput = () => { lsSet("portal", $("portal").value); render(); };
