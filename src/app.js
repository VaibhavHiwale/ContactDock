const { invoke } = window.__TAURI__.core;

window.addEventListener("error", (e) => {
  console.error(e.error || e.message);
  showToast(`Error: ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  showToast(`Error: ${e.reason?.message || e.reason}`);
});

/* ---------- state ---------- */

let contacts = [];
let selectedId = null;
let sortMode = "first";
let searchQuery = "";
let sourceFilter = "__all__";
let saveTimer = null;
let undoSnapshot = null;
let ignoredGroupKeys = new Set();
let ignoredPairs = new Set();
let selectionMode = false;
let selectedForMerge = new Set();

/* ---------- undo ---------- */

function snapshotForUndo() {
  undoSnapshot = JSON.stringify(contacts);
}

function updateUndoButton() {
  document.getElementById("btn-undo").hidden = !undoSnapshot;
}

function performUndo() {
  if (!undoSnapshot) return;
  contacts = JSON.parse(undoSnapshot);
  undoSnapshot = null;
  updateUndoButton();
  persist();
  renderList();
  renderDetail();
  renderDupModal();
  showToast("Reverted");
}

/* ---------- persistence ---------- */

async function loadContacts() {
  const json = await invoke("load_contacts");
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    data = [];
  }
  if (Array.isArray(data)) {
    // pre-existing plain-array format from earlier versions
    contacts = data;
    ignoredGroupKeys = new Set();
    ignoredPairs = new Set();
  } else if (data && typeof data === "object") {
    contacts = Array.isArray(data.contacts) ? data.contacts : [];
    ignoredGroupKeys = new Set(data.ignoredGroupKeys || []);
    ignoredPairs = new Set(data.ignoredPairs || []);
  } else {
    contacts = [];
    ignoredGroupKeys = new Set();
    ignoredPairs = new Set();
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 150);
}

async function flushSave() {
  clearTimeout(saveTimer);
  const payload = JSON.stringify({
    contacts,
    ignoredGroupKeys: [...ignoredGroupKeys],
    ignoredPairs: [...ignoredPairs],
  });
  await invoke("save_contacts", { json: payload });
}

/* ---------- model helpers ---------- */

function newId() {
  return crypto.randomUUID();
}

function blankContact() {
  const now = Date.now();
  return {
    id: newId(),
    firstName: "",
    lastName: "",
    org: "",
    notes: "",
    phones: [{ type: "mobile", value: "" }],
    emails: [{ type: "home", value: "" }],
    source: "Manual",
    favorite: false,
    createdAt: now,
    updatedAt: now,
  };
}

function displayName(c) {
  const n = `${c.firstName || ""} ${c.lastName || ""}`.trim();
  return n || c.org || "(no name)";
}

function initials(c) {
  const f = (c.firstName || "").trim()[0] || "";
  const l = (c.lastName || "").trim()[0] || "";
  return (f + l).toUpperCase() || (c.org || "?")[0].toUpperCase();
}

/* ---------- normalization for dedupe ---------- */

function normPhone(v) {
  let digits = (v || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

function normEmail(v) {
  return (v || "").trim().toLowerCase();
}

function normName(v) {
  return (v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

/* ---------- union-find duplicate detection ---------- */

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]++;
  }
}

function pairKey(id1, id2) {
  return id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
}

function findDuplicateGroups() {
  const n = contacts.length;
  const uf = new UnionFind(n);
  const byPhone = new Map();
  const byEmail = new Map();
  const byName = new Map();

  const tryUnion = (i, j) => {
    if (ignoredPairs.has(pairKey(contacts[i].id, contacts[j].id))) return;
    uf.union(i, j);
  };

  contacts.forEach((c, i) => {
    for (const p of c.phones) {
      const key = normPhone(p.value);
      if (!key) continue;
      if (byPhone.has(key)) tryUnion(i, byPhone.get(key));
      else byPhone.set(key, i);
    }
    for (const e of c.emails) {
      const key = normEmail(e.value);
      if (!key) continue;
      if (byEmail.has(key)) tryUnion(i, byEmail.get(key));
      else byEmail.set(key, i);
    }
    const key = normName(`${c.firstName} ${c.lastName}`);
    if (key) {
      if (byName.has(key)) tryUnion(i, byName.get(key));
      else byName.set(key, i);
    }
  });

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(contacts[i]);
  }
  return [...groups.values()].filter((g) => g.length > 1 && !ignoredGroupKeys.has(groupKey(g)));
}

function groupKey(group) {
  return group
    .map((c) => c.id)
    .sort()
    .join(",");
}

/* ---------- merge ---------- */

function computeMergedDraft(group) {
  const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
  const base = sorted[0];
  return {
    id: base.id,
    firstName: sorted.find((c) => c.firstName)?.firstName || "",
    lastName: sorted.find((c) => c.lastName)?.lastName || "",
    org: sorted.find((c) => c.org)?.org || "",
    notes: [...new Set(sorted.map((c) => c.notes).filter(Boolean))].join("\n"),
    phones: dedupeFields(sorted.flatMap((c) => c.phones), normPhone),
    emails: dedupeFields(sorted.flatMap((c) => c.emails), normEmail),
    source: [...new Set(sorted.map((c) => c.source).filter(Boolean))].join(" + "),
    favorite: sorted.some((c) => c.favorite),
    createdAt: base.createdAt,
    updatedAt: Date.now(),
  };
}

function applyMerge(group, mergedContact) {
  if (group.some((c) => c.id === selectedId)) selectedId = mergedContact.id;
  contacts = contacts.filter((c) => !group.includes(c));
  contacts.push(mergedContact);
}

function dedupeFields(fields, normFn) {
  const seen = new Set();
  const out = [];
  for (const f of fields) {
    const key = normFn(f.value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out.length ? out : fields.slice(0, 1);
}

/* ---------- vCard import ---------- */

function unfoldLines(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeVcardValue(v) {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function splitUnescaped(str, sep) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\" && i + 1 < str.length) {
      cur += str[i] + str[i + 1];
      i++;
    } else if (str[i] === sep) {
      parts.push(cur);
      cur = "";
    } else {
      cur += str[i];
    }
  }
  parts.push(cur);
  return parts;
}

function parseTypeParam(params) {
  for (const p of params) {
    const [key, val] = p.split("=");
    if (!val) continue; // bare token like "CELL" (vCard 2.1 style) handled below
    if (key.toUpperCase() === "TYPE") {
      return val
        .split(",")
        .map((t) => t.trim().toLowerCase())[0];
    }
  }
  const knownTypes = ["home", "work", "cell", "mobile", "fax", "voice", "other"];
  for (const p of params) {
    const bare = p.trim().toLowerCase();
    if (knownTypes.includes(bare)) return bare === "cell" ? "mobile" : bare;
  }
  return "other";
}

function parseVcf(text, sourceLabel = "Imported") {
  const lines = unfoldLines(text);
  const results = [];
  let cur = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) {
      cur = blankContact();
      cur.phones = [];
      cur.emails = [];
      cur.source = sourceLabel;
      continue;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (cur) {
        if (!cur.phones.length) cur.phones = [{ type: "mobile", value: "" }];
        if (!cur.emails.length) cur.emails = [{ type: "home", value: "" }];
        results.push(cur);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const propPart = line.slice(0, colonIdx);
    const valuePart = line.slice(colonIdx + 1);
    const propTokens = propPart.split(";");
    const propName = propTokens[0].split(".").pop().toUpperCase();
    const params = propTokens.slice(1);

    switch (propName) {
      case "FN":
        cur._fn = unescapeVcardValue(valuePart);
        break;
      case "N": {
        const parts = splitUnescaped(valuePart, ";").map(unescapeVcardValue);
        cur.lastName = parts[0] || cur.lastName;
        cur.firstName = parts[1] || cur.firstName;
        break;
      }
      case "ORG":
        cur.org = unescapeVcardValue(splitUnescaped(valuePart, ";")[0] || "");
        break;
      case "TEL":
        cur.phones.push({ type: parseTypeParam(params), value: unescapeVcardValue(valuePart) });
        break;
      case "EMAIL":
        cur.emails.push({ type: parseTypeParam(params), value: unescapeVcardValue(valuePart) });
        break;
      case "NOTE":
        cur.notes = unescapeVcardValue(valuePart);
        break;
      default:
        break;
    }
  }

  for (const c of results) {
    if ((!c.firstName && !c.lastName) && c._fn) {
      const bits = c._fn.split(" ");
      c.firstName = bits[0] || "";
      c.lastName = bits.slice(1).join(" ");
    }
    delete c._fn;
  }
  return results;
}

/* ---------- vCard export ---------- */

function escapeVcardValue(v) {
  return String(v || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function contactToVcf(c) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  lines.push(`N:${escapeVcardValue(c.lastName)};${escapeVcardValue(c.firstName)};;;`);
  lines.push(`FN:${escapeVcardValue(displayName(c))}`);
  if (c.org) lines.push(`ORG:${escapeVcardValue(c.org)}`);
  for (const p of c.phones) {
    if (!p.value) continue;
    lines.push(`TEL;TYPE=${p.type.toUpperCase()}:${escapeVcardValue(p.value)}`);
  }
  for (const e of c.emails) {
    if (!e.value) continue;
    lines.push(`EMAIL;TYPE=${e.type.toUpperCase()}:${escapeVcardValue(e.value)}`);
  }
  if (c.notes) lines.push(`NOTE:${escapeVcardValue(c.notes)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

async function exportAllVcf() {
  const path = await invoke("plugin:dialog|save", {
    options: {
      title: "Export contacts",
      defaultPath: "contacts.vcf",
      filters: [{ name: "vCard", extensions: ["vcf"] }],
    },
  });
  if (!path) return;
  const text = contacts.map(contactToVcf).join("\r\n");
  await invoke("write_file", { path, content: text });
  showToast(`Exported to ${path}`);
}

/* ---------- rendering: list ---------- */

const listEl = document.getElementById("contact-list");
const emptyStateEl = document.getElementById("empty-state");
const countEl = document.getElementById("contact-count");
const dupBadge = document.getElementById("dup-badge");
const azRailEl = document.getElementById("az-rail");
const sourceSelect = document.getElementById("source-select");
const btnRemoveSource = document.getElementById("btn-remove-source");
const AZ_LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function allSources() {
  return [...new Set(contacts.map((c) => c.source).filter(Boolean))].sort();
}

function filteredSorted() {
  const q = searchQuery.trim().toLowerCase();
  let list = contacts.filter((c) => {
    if (sourceFilter !== "__all__" && c.source !== sourceFilter) return false;
    if (!q) return true;
    const hay = [
      c.firstName,
      c.lastName,
      c.org,
      ...c.phones.map((p) => p.value),
      ...c.emails.map((e) => e.value),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const byNameKey = (c, useLast) => {
    const primary = useLast ? c.lastName : c.firstName;
    const secondary = useLast ? c.firstName : c.lastName;
    return `${(primary || "").toLowerCase()} ${(secondary || "").toLowerCase()}`;
  };

  switch (sortMode) {
    case "last":
      list.sort((a, b) => byNameKey(a, true).localeCompare(byNameKey(b, true)));
      break;
    case "recent":
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      break;
    case "favorites":
      list.sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return byNameKey(a, false).localeCompare(byNameKey(b, false));
      });
      break;
    default:
      list.sort((a, b) => byNameKey(a, false).localeCompare(byNameKey(b, false)));
  }
  return list;
}

function renderList() {
  renderSourceSelect();
  const list = filteredSorted();
  listEl.innerHTML = "";
  emptyStateEl.hidden = contacts.length !== 0;
  const shown = list.length;
  countEl.textContent =
    sourceFilter === "__all__" && !searchQuery.trim()
      ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"}`
      : `${shown} of ${contacts.length} contacts`;

  const dupCount = findDuplicateGroups().reduce((n, g) => n + g.length, 0);
  dupBadge.hidden = dupCount === 0;
  dupBadge.textContent = dupCount;

  renderAzRail(sortMode === "first" || sortMode === "last" ? new Set() : null);
  if (!list.length) return;

  let lastGroupLabel = null;
  const showFavGroup = sortMode === "favorites";
  const alphabetical = sortMode === "first" || sortMode === "last";
  const groupHeaders = {};
  const presentLetters = new Set();
  const multiSource = allSources().length > 1;

  for (const c of list) {
    let label;
    if (showFavGroup && c.favorite) {
      label = "★ Favorites";
    } else if (sortMode === "recent") {
      label = "Recently updated";
    } else {
      const letterSrc = sortMode === "last" ? c.lastName : c.firstName;
      label = (letterSrc || c.org || "#").trim()[0]?.toUpperCase() || "#";
      if (!AZ_LETTERS.includes(label)) label = "#";
    }
    if (label !== lastGroupLabel) {
      const h = document.createElement("div");
      h.className = "list-group-header";
      h.textContent = label;
      listEl.appendChild(h);
      lastGroupLabel = label;
      if (alphabetical) {
        groupHeaders[label] = h;
        presentLetters.add(label);
      }
    }

    const row = document.createElement("div");
    const isChecked = selectedForMerge.has(c.id);
    row.className =
      "contact-row" + (c.id === selectedId ? " selected" : "") + (selectionMode && isChecked ? " checked-for-merge" : "");
    row.setAttribute("role", "option");
    row.dataset.id = c.id;

    const sub = c.phones.find((p) => p.value)?.value || c.emails.find((e) => e.value)?.value || c.org || "";
    const showSourceTag = multiSource && sourceFilter === "__all__";

    row.innerHTML = `
      ${selectionMode ? `<input type="checkbox" class="row-checkbox" ${isChecked ? "checked" : ""} tabindex="-1" />` : ""}
      <div class="row-avatar">${initials(c)}</div>
      <div class="row-text">
        <div class="row-name">${escapeHtml(displayName(c))}</div>
        <div class="row-sub">${escapeHtml(sub)}${showSourceTag ? ` · ${escapeHtml(c.source || "")}` : ""}</div>
      </div>
      ${c.favorite ? '<div class="row-star">★</div>' : ""}
    `;
    if (selectionMode) {
      row.addEventListener("click", () => {
        if (selectedForMerge.has(c.id)) selectedForMerge.delete(c.id);
        else selectedForMerge.add(c.id);
        renderList();
        updateSelectionBar();
      });
    } else {
      row.addEventListener("click", () => selectContact(c.id));
    }
    listEl.appendChild(row);
  }

  if (alphabetical) renderAzRail(presentLetters, groupHeaders);
}

function renderSourceSelect() {
  const sources = allSources();
  const multi = sources.length > 1;
  sourceSelect.closest(".sidebar-controls").hidden = !multi;
  if (!multi) {
    sourceFilter = "__all__";
    return;
  }
  const prev = sourceFilter;
  sourceSelect.innerHTML = '<option value="__all__">All sources</option>';
  for (const s of sources) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    sourceSelect.appendChild(opt);
  }
  sourceSelect.value = sources.includes(prev) ? prev : "__all__";
  sourceFilter = sourceSelect.value;
  btnRemoveSource.hidden = sourceFilter === "__all__";
}

function renderAzRail(presentLetters, groupHeaders) {
  if (!presentLetters) {
    azRailEl.innerHTML = "";
    azRailEl.hidden = true;
    return;
  }
  azRailEl.hidden = false;
  azRailEl.innerHTML = "";
  for (const letter of AZ_LETTERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = letter;
    const present = presentLetters.has(letter);
    btn.disabled = !present;
    if (present) {
      btn.addEventListener("click", () => {
        groupHeaders[letter].scrollIntoView({ block: "start" });
      });
    }
    azRailEl.appendChild(btn);
  }
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

/* ---------- rendering: detail ---------- */

const placeholderEl = document.getElementById("detail-placeholder");
const formEl = document.getElementById("contact-form");
const fieldFirst = document.getElementById("field-first");
const fieldLast = document.getElementById("field-last");
const fieldOrg = document.getElementById("field-org");
const fieldNotes = document.getElementById("field-notes");
const phonesListEl = document.getElementById("phones-list");
const emailsListEl = document.getElementById("emails-list");
const formAvatar = document.getElementById("form-avatar");
const btnFavorite = document.getElementById("btn-favorite");
const formMeta = document.getElementById("form-meta");

function selectContact(id) {
  selectedId = id;
  renderList();
  renderDetail();
}

function currentContact() {
  return contacts.find((c) => c.id === selectedId) || null;
}

function renderFieldRows(container, fields, kind, hooks = {}) {
  const onInput = hooks.onInput || (() => commitDetailChange({ skipRender: true }));
  const onStructureChange = hooks.onStructureChange || (() => commitDetailChange());

  container.innerHTML = "";
  const typeOptions =
    kind === "phone"
      ? ["mobile", "home", "work", "fax", "other"]
      : ["home", "work", "other"];

  fields.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "field-row";

    const select = document.createElement("select");
    for (const t of typeOptions) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t[0].toUpperCase() + t.slice(1);
      if (t === f.type) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      f.type = select.value;
      onStructureChange();
    });

    const input = document.createElement("input");
    input.type = kind === "phone" ? "tel" : "email";
    input.value = f.value;
    input.placeholder = kind === "phone" ? "Phone number" : "Email address";
    input.addEventListener("input", () => {
      f.value = input.value;
      onInput();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove-field";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      fields.splice(i, 1);
      onStructureChange();
    });

    row.append(select, input, removeBtn);
    container.appendChild(row);
  });
}

function renderDetail() {
  const c = currentContact();
  if (!c) {
    placeholderEl.hidden = false;
    formEl.hidden = true;
    return;
  }
  placeholderEl.hidden = true;
  formEl.hidden = false;

  fieldFirst.value = c.firstName;
  fieldLast.value = c.lastName;
  fieldOrg.value = c.org;
  fieldNotes.value = c.notes;
  formAvatar.textContent = initials(c);
  btnFavorite.classList.toggle("active", !!c.favorite);
  btnFavorite.setAttribute("aria-pressed", String(!!c.favorite));

  const created = new Date(c.createdAt).toLocaleDateString();
  const updated = new Date(c.updatedAt).toLocaleString();
  const sourceBit = c.source && c.source !== "Manual" ? ` · Source: ${c.source}` : "";
  formMeta.textContent = `Added ${created} · Updated ${updated}${sourceBit}`;

  renderFieldRows(phonesListEl, c.phones, "phone");
  renderFieldRows(emailsListEl, c.emails, "email");
}

function commitDetailChange(opts = {}) {
  const c = currentContact();
  if (!c) return;
  c.firstName = fieldFirst.value;
  c.lastName = fieldLast.value;
  c.org = fieldOrg.value;
  c.notes = fieldNotes.value;
  c.updatedAt = Date.now();
  persist();
  if (!opts.skipRender) renderDetail();
  renderList();
}

[fieldFirst, fieldLast, fieldOrg, fieldNotes].forEach((el) => {
  el.addEventListener("input", () => commitDetailChange({ skipRender: true }));
});

document.querySelectorAll(".btn-add-field").forEach((btn) => {
  btn.addEventListener("click", () => {
    const c = currentContact();
    if (!c) return;
    if (btn.dataset.add === "phone") c.phones.push({ type: "mobile", value: "" });
    else c.emails.push({ type: "home", value: "" });
    commitDetailChange();
  });
});

btnFavorite.addEventListener("click", () => {
  const c = currentContact();
  if (!c) return;
  c.favorite = !c.favorite;
  c.updatedAt = Date.now();
  persist();
  renderDetail();
  renderList();
});

document.getElementById("btn-delete").addEventListener("click", () => {
  const c = currentContact();
  if (!c) return;
  if (!confirm(`Delete ${displayName(c)}?`)) return;
  snapshotForUndo();
  contacts = contacts.filter((x) => x.id !== c.id);
  selectedId = null;
  updateUndoButton();
  persist();
  renderList();
  renderDetail();
});

document.getElementById("btn-save-close").addEventListener("click", async () => {
  const c = currentContact();
  if (!c) return;
  await flushSave();
  selectedId = null;
  renderList();
  renderDetail();
  showToast("Saved");
});

/* ---------- new contact ---------- */

function createContact() {
  const c = blankContact();
  contacts.unshift(c);
  selectedId = c.id;
  persist();
  renderList();
  renderDetail();
  fieldFirst.focus();
}

document.getElementById("btn-new").addEventListener("click", createContact);
document.getElementById("btn-empty-new").addEventListener("click", createContact);

document.getElementById("btn-refresh").addEventListener("click", async () => {
  await flushSave();
  await loadContacts();
  if (!contacts.find((c) => c.id === selectedId)) selectedId = null;
  undoSnapshot = null;
  updateUndoButton();
  renderList();
  renderDetail();
  showToast("Contacts refreshed from disk");
});

/* ---------- manual merge selection ---------- */

const selectionBarEl = document.getElementById("selection-bar");
const selectionCountEl = document.getElementById("selection-count");
const btnSelectModeEl = document.getElementById("btn-select-mode");
const btnMergeSelectedEl = document.getElementById("btn-merge-selected");

function updateSelectionBar() {
  const n = selectedForMerge.size;
  selectionCountEl.textContent = `${n} selected`;
  btnMergeSelectedEl.disabled = n < 2;
}

function setSelectionMode(on) {
  selectionMode = on;
  selectedForMerge.clear();
  selectionBarEl.hidden = !on;
  btnSelectModeEl.classList.toggle("active", on);
  updateSelectionBar();
  renderList();
}

btnSelectModeEl.addEventListener("click", () => setSelectionMode(!selectionMode));
document.getElementById("btn-cancel-select").addEventListener("click", () => setSelectionMode(false));

btnMergeSelectedEl.addEventListener("click", () => {
  const group = contacts.filter((c) => selectedForMerge.has(c.id));
  if (group.length < 2) return;
  setSelectionMode(false);
  openMergeReview(group);
});

/* ---------- search / sort ---------- */

document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderList();
});

document.getElementById("sort-select").addEventListener("change", (e) => {
  sortMode = e.target.value;
  renderList();
});

sourceSelect.addEventListener("change", (e) => {
  sourceFilter = e.target.value;
  btnRemoveSource.hidden = sourceFilter === "__all__";
  renderList();
});

btnRemoveSource.addEventListener("click", () => {
  if (sourceFilter === "__all__") return;
  const n = contacts.filter((c) => c.source === sourceFilter).length;
  if (!confirm(`Remove all ${n} contact${n === 1 ? "" : "s"} from source "${sourceFilter}"?`)) return;
  snapshotForUndo();
  contacts = contacts.filter((c) => c.source !== sourceFilter);
  if (!contacts.find((c) => c.id === selectedId)) selectedId = null;
  sourceFilter = "__all__";
  updateUndoButton();
  persist();
  renderList();
  renderDetail();
  showToast("Source removed");
});

document.getElementById("btn-undo").addEventListener("click", performUndo);

document.getElementById("btn-clear-all").addEventListener("click", () => {
  if (!contacts.length) return;
  if (!confirm(`Delete all ${contacts.length} contacts? You can undo this afterward.`)) return;
  snapshotForUndo();
  contacts = [];
  selectedId = null;
  sourceFilter = "__all__";
  updateUndoButton();
  persist();
  renderList();
  renderDetail();
  showToast("All contacts cleared");
});

/* ---------- import / export ---------- */

const importInput = document.getElementById("import-file-input");
document.getElementById("btn-import").addEventListener("click", () => importInput.click());

importInput.addEventListener("change", async () => {
  const files = [...importInput.files];
  if (!files.length) return;
  let imported = 0;
  for (const file of files) {
    const text = await file.text();
    const sourceLabel = file.name.replace(/\.vcf$/i, "");
    const parsed = parseVcf(text, sourceLabel);
    contacts.push(...parsed);
    imported += parsed.length;
  }
  importInput.value = "";
  persist();
  renderList();
  renderDetail();
  showToast(`Imported ${imported} contact${imported === 1 ? "" : "s"}`);
});

document.getElementById("btn-export").addEventListener("click", () => {
  if (!contacts.length) {
    showToast("No contacts to export");
    return;
  }
  exportAllVcf();
});

/* ---------- duplicates modal ---------- */

const dupModal = document.getElementById("dup-modal");
const dupBody = document.getElementById("dup-body");

function openDupModal() {
  renderDupModal();
  dupModal.hidden = false;
}

function renderDupModal() {
  const groups = findDuplicateGroups();
  document.getElementById("btn-merge-all").hidden = groups.length === 0;
  dupBody.innerHTML = "";
  if (!groups.length) {
    dupBody.innerHTML = '<div class="dup-empty">No duplicates found.</div>';
    return;
  }
  groups.forEach((group, gi) => {
    const box = document.createElement("div");
    box.className = "dup-group";
    box.innerHTML = `
      <div class="dup-group-head">
        <h4>${group.length} matching contacts</h4>
        <div class="dup-group-actions">
          <button class="btn" data-ignore="${gi}">Not a duplicate</button>
          <button class="btn btn-accent" data-review="${gi}">Merge…</button>
        </div>
      </div>
      <div class="dup-members"></div>
    `;
    box.querySelector("[data-ignore]").addEventListener("click", () => {
      ignoredGroupKeys.add(groupKey(group));
      persist();
      renderDupModal();
      renderList();
      showToast("Won't be suggested as a duplicate again");
    });
    const membersEl = box.querySelector(".dup-members");
    for (const c of group) {
      const m = document.createElement("div");
      m.className = "dup-member";
      const phone = c.phones.find((p) => p.value)?.value || "—";
      const email = c.emails.find((e) => e.value)?.value || "—";
      m.innerHTML = `
        <div class="dup-member-text">
          <div class="dm-name">${escapeHtml(displayName(c))}</div>
          <div class="dm-detail">${escapeHtml(phone)} · ${escapeHtml(email)}${c.org ? " · " + escapeHtml(c.org) : ""}</div>
        </div>
        <button type="button" class="btn-edit-member" title="Edit this contact">Edit</button>
        <button type="button" class="btn-not-match" title="This contact isn't a duplicate of the others here — keeps it, just stops the match">Not a match</button>
        <button type="button" class="btn-remove-field" title="Delete this contact">✕</button>
      `;
      m.querySelector(".btn-edit-member").addEventListener("click", () => openMemberEdit(c));
      m.querySelector(".btn-not-match").addEventListener("click", () => {
        for (const other of group) {
          if (other.id === c.id) continue;
          ignoredPairs.add(pairKey(c.id, other.id));
        }
        persist();
        renderDupModal();
        renderList();
        showToast(`${displayName(c)} won't be matched with these contacts again`);
      });
      m.querySelector(".btn-remove-field").addEventListener("click", () => {
        if (!confirm(`Delete ${displayName(c)}? This permanently removes this one contact. Duplicate matches will be recalculated afterward.`))
          return;
        snapshotForUndo();
        contacts = contacts.filter((x) => x.id !== c.id);
        if (selectedId === c.id) selectedId = null;
        updateUndoButton();
        persist();
        renderList();
        renderDetail();
        renderDupModal();
        showToast("1 contact deleted");
      });
      membersEl.appendChild(m);
    }
    box.querySelector("[data-review]").addEventListener("click", () => openMergeReview(group));
    dupBody.appendChild(box);
  });
}

document.getElementById("btn-duplicates").addEventListener("click", openDupModal);
document.getElementById("btn-dup-refresh").addEventListener("click", () => {
  renderDupModal();
  renderList();
  showToast("Duplicates rechecked");
});
document.getElementById("btn-dup-close").addEventListener("click", () => (dupModal.hidden = true));
dupModal.addEventListener("click", (e) => {
  if (e.target === dupModal) dupModal.hidden = true;
});

document.getElementById("btn-merge-all").addEventListener("click", () => {
  const groups = findDuplicateGroups();
  if (!groups.length) return;
  const totalContacts = groups.reduce((n, g) => n + g.length, 0);
  const groupWord = groups.length === 1 ? "group" : "groups";
  if (
    !confirm(
      `Automatically merge ${groups.length} duplicate ${groupWord} (${totalContacts} contacts)? You can undo this afterward.`
    )
  )
    return;
  snapshotForUndo();
  for (const group of groups) {
    const draft = computeMergedDraft(group);
    applyMerge(group, draft);
  }
  updateUndoButton();
  persist();
  renderList();
  renderDetail();
  renderDupModal();
  showToast(`Merged ${groups.length} ${groupWord}`);
});

/* ---------- member edit overlay (stacks over the duplicates modal) ---------- */

const memberEditModal = document.getElementById("member-edit-modal");
const meFirst = document.getElementById("me-first");
const meLast = document.getElementById("me-last");
const meOrg = document.getElementById("me-org");
const meNotesEl = document.getElementById("me-notes");
const meAvatarEl = document.getElementById("me-avatar");
const meFavoriteBtn = document.getElementById("me-favorite");
const mePhonesListEl = document.getElementById("me-phones-list");
const meEmailsListEl = document.getElementById("me-emails-list");

let memberEdit = null; // { draft }

function openMemberEdit(c) {
  memberEdit = { draft: JSON.parse(JSON.stringify(c)) };
  renderMemberEdit();
  memberEditModal.hidden = false;
}

function renderMemberEdit() {
  const { draft } = memberEdit;
  meFirst.value = draft.firstName;
  meLast.value = draft.lastName;
  meOrg.value = draft.org;
  meNotesEl.value = draft.notes;
  meAvatarEl.textContent = initials(draft);
  meFavoriteBtn.classList.toggle("active", !!draft.favorite);
  meFavoriteBtn.setAttribute("aria-pressed", String(!!draft.favorite));

  const hooks = { onInput: () => {}, onStructureChange: renderMemberEdit };
  renderFieldRows(mePhonesListEl, draft.phones, "phone", hooks);
  renderFieldRows(meEmailsListEl, draft.emails, "email", hooks);
}

[meFirst, meLast, meOrg, meNotesEl].forEach((el) => {
  el.addEventListener("input", () => {
    if (!memberEdit) return;
    memberEdit.draft.firstName = meFirst.value;
    memberEdit.draft.lastName = meLast.value;
    memberEdit.draft.org = meOrg.value;
    memberEdit.draft.notes = meNotesEl.value;
  });
});

meFavoriteBtn.addEventListener("click", () => {
  if (!memberEdit) return;
  memberEdit.draft.favorite = !memberEdit.draft.favorite;
  meFavoriteBtn.classList.toggle("active", memberEdit.draft.favorite);
  meFavoriteBtn.setAttribute("aria-pressed", String(memberEdit.draft.favorite));
});

document.getElementById("me-add-phone").addEventListener("click", () => {
  if (!memberEdit) return;
  memberEdit.draft.phones.push({ type: "mobile", value: "" });
  renderMemberEdit();
});

document.getElementById("me-add-email").addEventListener("click", () => {
  if (!memberEdit) return;
  memberEdit.draft.emails.push({ type: "home", value: "" });
  renderMemberEdit();
});

function closeMemberEdit() {
  memberEdit = null;
  memberEditModal.hidden = true;
}

document.getElementById("btn-me-cancel").addEventListener("click", closeMemberEdit);
document.getElementById("btn-me-close").addEventListener("click", closeMemberEdit);
memberEditModal.addEventListener("click", (e) => {
  if (e.target === memberEditModal) closeMemberEdit();
});

document.getElementById("btn-me-save").addEventListener("click", () => {
  if (!memberEdit) return;
  const { draft } = memberEdit;
  draft.updatedAt = Date.now();
  const idx = contacts.findIndex((x) => x.id === draft.id);
  if (idx !== -1) contacts[idx] = draft;
  persist();
  closeMemberEdit();
  renderList();
  renderDetail();
  renderDupModal();
  showToast("Saved");
});

/* ---------- merge review modal ---------- */

const mergeModal = document.getElementById("merge-modal");
const mergeFirst = document.getElementById("merge-first");
const mergeLast = document.getElementById("merge-last");
const mergeOrg = document.getElementById("merge-org");
const mergeNotesEl = document.getElementById("merge-notes");
const mergeAvatarEl = document.getElementById("merge-avatar");
const mergeFavoriteBtn = document.getElementById("merge-favorite");
const mergePhonesListEl = document.getElementById("merge-phones-list");
const mergeEmailsListEl = document.getElementById("merge-emails-list");
const mergeParticipantsEl = document.getElementById("merge-participants");
const btnMergeConfirmEl = document.getElementById("btn-merge-confirm");

let mergeReview = null; // { workingSet, draft }

function openMergeReview(group) {
  mergeReview = { workingSet: [...group], draft: computeMergedDraft(group) };
  renderMergeReview();
  mergeModal.hidden = false;
}

function renderMergeReview() {
  const { draft, workingSet } = mergeReview;

  mergeParticipantsEl.innerHTML = "";
  for (const c of workingSet) {
    const chip = document.createElement("div");
    chip.className = "merge-chip";
    chip.innerHTML = `<span>${escapeHtml(displayName(c))}</span>`;
    if (workingSet.length > 1) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.title = "Remove from this merge (keeps the contact, just won't be merged)";
      rm.textContent = "✕";
      rm.addEventListener("click", () => {
        mergeReview.workingSet = mergeReview.workingSet.filter((x) => x.id !== c.id);
        mergeReview.draft = computeMergedDraft(mergeReview.workingSet);
        renderMergeReview();
      });
      chip.appendChild(rm);
    }
    mergeParticipantsEl.appendChild(chip);
  }

  btnMergeConfirmEl.disabled = workingSet.length < 2;
  btnMergeConfirmEl.title = workingSet.length < 2 ? "Select at least 2 contacts to merge" : "";

  mergeFirst.value = draft.firstName;
  mergeLast.value = draft.lastName;
  mergeOrg.value = draft.org;
  mergeNotesEl.value = draft.notes;
  mergeAvatarEl.textContent = initials(draft);
  mergeFavoriteBtn.classList.toggle("active", !!draft.favorite);
  mergeFavoriteBtn.setAttribute("aria-pressed", String(!!draft.favorite));

  const structureHooks = { onInput: () => {}, onStructureChange: renderMergeReview };
  renderFieldRows(mergePhonesListEl, draft.phones, "phone", structureHooks);
  renderFieldRows(mergeEmailsListEl, draft.emails, "email", structureHooks);
}

[mergeFirst, mergeLast, mergeOrg, mergeNotesEl].forEach((el) => {
  el.addEventListener("input", () => {
    if (!mergeReview) return;
    mergeReview.draft.firstName = mergeFirst.value;
    mergeReview.draft.lastName = mergeLast.value;
    mergeReview.draft.org = mergeOrg.value;
    mergeReview.draft.notes = mergeNotesEl.value;
  });
});

mergeFavoriteBtn.addEventListener("click", () => {
  if (!mergeReview) return;
  mergeReview.draft.favorite = !mergeReview.draft.favorite;
  mergeFavoriteBtn.classList.toggle("active", mergeReview.draft.favorite);
  mergeFavoriteBtn.setAttribute("aria-pressed", String(mergeReview.draft.favorite));
});

document.getElementById("merge-add-phone").addEventListener("click", () => {
  if (!mergeReview) return;
  mergeReview.draft.phones.push({ type: "mobile", value: "" });
  renderMergeReview();
});

document.getElementById("merge-add-email").addEventListener("click", () => {
  if (!mergeReview) return;
  mergeReview.draft.emails.push({ type: "home", value: "" });
  renderMergeReview();
});

function closeMergeReview() {
  mergeReview = null;
  mergeModal.hidden = true;
}

document.getElementById("btn-merge-cancel").addEventListener("click", closeMergeReview);
document.getElementById("btn-merge-close").addEventListener("click", closeMergeReview);
mergeModal.addEventListener("click", (e) => {
  if (e.target === mergeModal) closeMergeReview();
});

document.getElementById("btn-merge-confirm").addEventListener("click", () => {
  if (!mergeReview) return;
  const { workingSet, draft } = mergeReview;
  if (workingSet.length < 2) return;
  draft.updatedAt = Date.now();
  snapshotForUndo();
  applyMerge(workingSet, draft);
  updateUndoButton();
  persist();
  closeMergeReview();
  renderList();
  renderDetail();
  renderDupModal();
  showToast("Merged");
});

/* ---------- data location ---------- */

document.getElementById("btn-data-location").addEventListener("click", async () => {
  const dir = await invoke("data_dir");
  await invoke("plugin:opener|reveal_item_in_dir", { path: dir });
});

document.getElementById("btn-report-bug").addEventListener("click", async () => {
  await invoke("plugin:opener|open_url", {
    url: "https://github.com/VaibhavHiwale/ContactDock/issues/new",
  });
});

/* ---------- toast ---------- */

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

/* ---------- init ---------- */

(async function init() {
  await loadContacts();
  renderList();
  renderDetail();
})();
