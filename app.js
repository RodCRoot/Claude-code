/* Line Coach — client-side rehearsal app.
   All state lives in localStorage; no server, no accounts. */

(() => {
  "use strict";

  const STORE_KEY = "lineCoach.v1";
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------- State ---------------- */
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn("Could not load saved data", e);
    }
    return { scripts: {}, activeId: null, view: "library" };
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save", e);
    }
  }

  const uid = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const activeScript = () => (state.activeId ? state.scripts[state.activeId] : null);

  /* ---------------- Script parsing ----------------
     Recognises "CHARACTER: dialogue". A speaker token is text before the first
     colon that looks like a name/role (letters, spaces, &, ., -, digits, up to
     ~40 chars). Continuation lines without a speaker attach to the previous
     speech. Lines with no speaker that look like stage directions are kept as
     context (type: "stage"). */
  const SPEAKER_RE = /^\s*([A-Za-z0-9][A-Za-z0-9 .,'’&\-/()]{0,39}?)\s*:\s*(.*)$/;

  function parseScript(raw) {
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const speeches = [];
    let current = null;

    const flush = () => {
      if (current) {
        current.text = current.text.trim();
        if (current.text || current.type === "stage") speeches.push(current);
      }
      current = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.trim()) { flush(); continue; }

      const m = line.match(SPEAKER_RE);
      // Treat as a speaker line only if the token has letters (avoid "12:30").
      const looksLikeSpeaker = m && /[A-Za-z]/.test(m[1]);

      // A line fully wrapped in (), [] or italics markers = stage direction.
      const isStage = /^\s*[\(\[].*[\)\]]\s*$/.test(line) && !looksLikeSpeaker;

      if (isStage) {
        flush();
        speeches.push({ type: "stage", speaker: "", text: line.trim() });
      } else if (looksLikeSpeaker) {
        flush();
        current = { type: "line", speaker: normalizeName(m[1]), text: m[2] };
      } else if (current) {
        current.text += " " + line.trim();
      } else {
        // Orphan line before any speaker — keep as stage/context.
        speeches.push({ type: "stage", speaker: "", text: line.trim() });
      }
    }
    flush();
    return speeches;
  }

  function normalizeName(n) {
    return n.trim().replace(/\s+/g, " ");
  }

  function charactersOf(speeches) {
    const set = new Map();
    for (const s of speeches) {
      if (s.type === "line" && s.speaker) {
        const count = set.get(s.speaker) || 0;
        set.set(s.speaker, count + 1);
      }
    }
    return Array.from(set.entries()).sort((a, b) => b[1] - a[1]);
  }

  /* ---------------- View routing ---------------- */
  function setView(view) {
    state.view = view;
    save();
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
    if (view === "library") renderLibrary();
    if (view === "script") renderEditor();
    if (view === "rehearse") renderRehearse();
    if (view === "cues") renderCues();
  }

  $("#tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) setView(tab.dataset.view);
  });

  /* ---------------- Library ---------------- */
  function renderLibrary() {
    const list = $("#script-list");
    const ids = Object.keys(state.scripts);
    list.innerHTML = "";
    $("#library-empty").hidden = ids.length > 0;

    for (const id of ids) {
      const sc = state.scripts[id];
      const li = document.createElement("li");
      li.className = "script-item" + (id === state.activeId ? " active" : "");
      const chars = charactersOf(sc.speeches || []).length;
      li.innerHTML = `
        <div>
          <div class="si-title"></div>
          <div class="si-meta">${(sc.speeches || []).filter(s => s.type === "line").length} speeches · ${chars} characters · you: ${sc.myCharacter || "—"}</div>
        </div>
        <button class="btn" data-open="${id}">Open ›</button>`;
      li.querySelector(".si-title").textContent = sc.title || "Untitled";
      li.addEventListener("click", () => { state.activeId = id; save(); setView("script"); });
      list.appendChild(li);
    }
    updateFooter();
  }

  $("#new-script-btn").addEventListener("click", () => {
    const id = uid();
    state.scripts[id] = { title: "Untitled scene", raw: "", speeches: [], myCharacter: "", cueProgress: {} };
    state.activeId = id;
    save();
    setView("script");
  });

  $("#load-sample-btn").addEventListener("click", () => {
    const id = uid();
    state.scripts[id] = {
      title: "Romeo & Juliet — Balcony (sample)",
      raw: SAMPLE,
      speeches: parseScript(SAMPLE),
      myCharacter: "ROMEO",
      cueProgress: {},
    };
    state.activeId = id;
    save();
    setView("script");
  });

  /* ---------------- Editor ---------------- */
  function renderEditor() {
    const sc = activeScript();
    if (!sc) { setView("library"); return; }
    $("#script-title").value = sc.title || "";
    $("#script-title-display").textContent = sc.title || "Script";
    $("#script-raw").value = sc.raw || "";
    renderCharacterPicker(sc);
    renderParseSummary(sc);
    updateFooter();
  }

  function renderCharacterPicker(sc) {
    const wrap = $("#character-picker-wrap");
    const sel = $("#my-character");
    const chars = charactersOf(sc.speeches || []);
    if (!chars.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    sel.innerHTML = chars
      .map(([name, n]) => `<option value="${escAttr(name)}">${escHtml(name)} (${n})</option>`)
      .join("");
    if (sc.myCharacter) sel.value = sc.myCharacter;
    else { sc.myCharacter = chars[0][0]; sel.value = chars[0][0]; save(); }
  }

  function renderParseSummary(sc) {
    const el = $("#parse-summary");
    const speeches = sc.speeches || [];
    if (!speeches.length) { el.hidden = true; return; }
    const chars = charactersOf(speeches);
    const mine = speeches.filter((s) => s.type === "line" && s.speaker === sc.myCharacter).length;
    el.hidden = false;
    el.textContent =
      `Parsed ${speeches.filter(s => s.type === "line").length} speeches across ${chars.length} characters. ` +
      `You have ${mine} line${mine === 1 ? "" : "s"} as ${sc.myCharacter || "—"}.`;
  }

  $("#script-title").addEventListener("input", (e) => {
    const sc = activeScript(); if (!sc) return;
    sc.title = e.target.value;
    $("#script-title-display").textContent = sc.title || "Script";
    save();
  });

  $("#parse-btn").addEventListener("click", () => {
    const sc = activeScript(); if (!sc) return;
    sc.raw = $("#script-raw").value;
    sc.speeches = parseScript(sc.raw);
    // Reset cue progress when the text changes meaningfully.
    sc.cueProgress = sc.cueProgress || {};
    const chars = charactersOf(sc.speeches);
    if (!chars.some(([n]) => n === sc.myCharacter)) sc.myCharacter = chars[0] ? chars[0][0] : "";
    save();
    renderCharacterPicker(sc);
    renderParseSummary(sc);
  });

  $("#my-character").addEventListener("change", (e) => {
    const sc = activeScript(); if (!sc) return;
    sc.myCharacter = e.target.value;
    save();
    renderParseSummary(sc);
  });

  $("#delete-script-btn").addEventListener("click", () => {
    const sc = activeScript(); if (!sc) return;
    if (!confirm(`Delete "${sc.title || "Untitled"}"? This can't be undone.`)) return;
    delete state.scripts[state.activeId];
    state.activeId = Object.keys(state.scripts)[0] || null;
    save();
    setView("library");
  });

  /* ---------------- Import / Export ---------------- */
  $("#export-btn").addEventListener("click", () => {
    const sc = activeScript(); if (!sc) return;
    const blob = new Blob([JSON.stringify(sc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (sc.title || "script").replace(/[^\w]+/g, "_").toLowerCase() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const id = uid();
        state.scripts[id] = {
          title: data.title || "Imported script",
          raw: data.raw || "",
          speeches: Array.isArray(data.speeches) && data.speeches.length ? data.speeches : parseScript(data.raw || ""),
          myCharacter: data.myCharacter || "",
          cueProgress: data.cueProgress || {},
        };
        state.activeId = id;
        save();
        setView("script");
      } catch (err) {
        alert("That file couldn't be read as a Line Coach script.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  /* ---------------- Rehearse ---------------- */
  function renderRehearse() {
    const sc = activeScript();
    const empty = $("#rehearse-empty");
    const transcript = $("#transcript");
    transcript.innerHTML = "";
    if (!sc || !(sc.speeches || []).length) {
      empty.hidden = false;
      $("#rehearse-meta").textContent = "";
      updateFooter();
      return;
    }
    empty.hidden = true;
    const hideMine = $("#hide-mine").checked;
    const showCues = $("#auto-reveal-cue").checked;
    const mineName = sc.myCharacter;
    const lineSpeeches = sc.speeches;

    $("#rehearse-meta").textContent =
      `${sc.title} — playing ${mineName || "—"}. ${hideMine ? "Your lines are hidden; tap to reveal." : ""}`;

    lineSpeeches.forEach((s, i) => {
      const div = document.createElement("div");
      const isMine = s.type === "line" && s.speaker === mineName;
      // A cue is the speech immediately before one of my lines.
      const nextIsMine = lineSpeeches[i + 1] &&
        lineSpeeches[i + 1].type === "line" &&
        lineSpeeches[i + 1].speaker === mineName;
      div.className = "speech" +
        (s.type === "stage" ? " stage" : "") +
        (isMine ? " is-mine" : "") +
        (showCues && nextIsMine && !isMine ? " is-cue" : "");

      const who = document.createElement("div");
      who.className = "who";
      who.textContent = s.speaker || "stage";
      const what = document.createElement("div");
      what.className = "what";

      if (isMine && hideMine) {
        what.classList.add("line-hidden");
        what.textContent = s.text;
        what.addEventListener("click", () => what.classList.toggle("revealed"));
      } else {
        what.textContent = s.text;
      }
      div.appendChild(who);
      div.appendChild(what);
      transcript.appendChild(div);
    });
    updateFooter();
  }

  $("#hide-mine").addEventListener("change", renderRehearse);
  $("#auto-reveal-cue").addEventListener("change", renderRehearse);

  /* ---------------- Cue Cards ----------------
     Each "card" is one of my lines, prompted by the preceding speech (my cue). */
  let cueDeck = [];   // array of indices into cards
  let cuePos = 0;

  function buildCards(sc) {
    const cards = [];
    const sp = sc.speeches || [];
    sp.forEach((s, i) => {
      if (s.type === "line" && s.speaker === sc.myCharacter) {
        // find previous non-empty speech as the cue
        let cue = null;
        for (let j = i - 1; j >= 0; j--) {
          if (sp[j].text) { cue = sp[j]; break; }
        }
        cards.push({
          key: String(i),
          cueSpeaker: cue ? cue.speaker : "",
          cueText: cue ? cue.text : "(top of scene — you begin)",
          answer: s.text,
        });
      }
    });
    return cards;
  }

  let cueCards = [];

  function renderCues() {
    const sc = activeScript();
    const empty = $("#cues-empty");
    const stage = $("#cue-stage");
    if (!sc || !sc.myCharacter) {
      empty.hidden = false;
      stage.style.display = "none";
      $("#cue-progress").textContent = "0 / 0";
      return;
    }
    cueCards = buildCards(sc);
    if (!cueCards.length) {
      empty.hidden = false;
      empty.textContent = `No lines found for ${sc.myCharacter}. Check your character selection on the Script tab.`;
      stage.style.display = "none";
      $("#cue-progress").textContent = "0 / 0";
      return;
    }
    empty.hidden = true;
    stage.style.display = "";
    rebuildDeck(sc);
    showCard();
  }

  function rebuildDeck(sc) {
    const onlyMissed = $("#cue-only-missed").checked;
    sc.cueProgress = sc.cueProgress || {};
    cueDeck = cueCards
      .map((_, i) => i)
      .filter((i) => !onlyMissed || sc.cueProgress[cueCards[i].key] === "missed");
    if (!cueDeck.length) cueDeck = cueCards.map((_, i) => i);
    if (cuePos >= cueDeck.length) cuePos = 0;
  }

  function showCard() {
    const sc = activeScript();
    const card = cueCards[cueDeck[cuePos]];
    if (!card) return;
    $("#cue-answer").hidden = true;
    const prompt = $("#cue-prompt");
    prompt.innerHTML = "";
    const who = document.createElement("span");
    who.className = "cue-who";
    who.textContent = card.cueSpeaker || "—";
    const txt = document.createElement("span");
    txt.textContent = card.cueText;
    prompt.appendChild(who);
    prompt.appendChild(txt);
    $("#cue-answer-text").textContent = card.answer;

    // progress count = how many marked "got"
    const got = Object.values(sc.cueProgress || {}).filter((v) => v === "got").length;
    $("#cue-progress").textContent = `${got} / ${cueCards.length} memorised`;

    // tint card by status
    const status = (sc.cueProgress || {})[card.key];
    const cardEl = $("#cue-card");
    cardEl.style.borderColor =
      status === "got" ? "var(--good)" : status === "missed" ? "var(--warn)" : "var(--line)";
  }

  function mark(status) {
    const sc = activeScript();
    const card = cueCards[cueDeck[cuePos]];
    if (!sc || !card) return;
    sc.cueProgress = sc.cueProgress || {};
    sc.cueProgress[card.key] = status;
    save();
    nextCard();
  }

  function nextCard() {
    cuePos = (cuePos + 1) % cueDeck.length;
    showCard();
  }
  function prevCard() {
    cuePos = (cuePos - 1 + cueDeck.length) % cueDeck.length;
    showCard();
  }

  $("#cue-reveal").addEventListener("click", () => { $("#cue-answer").hidden = false; });
  $("#cue-next").addEventListener("click", nextCard);
  $("#cue-prev").addEventListener("click", prevCard);
  $("#cue-got").addEventListener("click", () => mark("got"));
  $("#cue-miss").addEventListener("click", () => mark("missed"));
  $("#cue-shuffle").addEventListener("click", () => {
    for (let i = cueDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cueDeck[i], cueDeck[j]] = [cueDeck[j], cueDeck[i]];
    }
    cuePos = 0;
    showCard();
  });
  $("#cue-reset").addEventListener("click", () => {
    const sc = activeScript(); if (!sc) return;
    if (!confirm("Reset all memorisation progress for this script?")) return;
    sc.cueProgress = {};
    save();
    rebuildDeck(sc);
    cuePos = 0;
    showCard();
  });
  $("#cue-only-missed").addEventListener("change", () => {
    const sc = activeScript(); if (!sc) return;
    rebuildDeck(sc);
    cuePos = 0;
    showCard();
  });

  // Keyboard shortcuts on the cue view
  document.addEventListener("keydown", (e) => {
    if (state.view !== "cues") return;
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); $("#cue-answer").hidden = false; }
    else if (e.key === "ArrowRight") nextCard();
    else if (e.key === "ArrowLeft") prevCard();
    else if (e.key.toLowerCase() === "g") mark("got");
    else if (e.key.toLowerCase() === "m") mark("missed");
  });

  /* ---------------- Footer ---------------- */
  function updateFooter() {
    const sc = activeScript();
    $("#active-script-name").textContent = sc ? sc.title || "Untitled" : "No script selected";
  }

  /* ---------------- helpers ---------------- */
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escAttr(s) { return escHtml(s); }

  /* ---------------- Sample text ---------------- */
  const SAMPLE = `(Capulet's orchard. JULIET appears above at a window.)
ROMEO: But, soft! what light through yonder window breaks? It is the east, and Juliet is the sun.
JULIET: O Romeo, Romeo! wherefore art thou Romeo? Deny thy father and refuse thy name.
ROMEO: Shall I hear more, or shall I speak at this?
JULIET: 'Tis but thy name that is my enemy; thou art thyself, though not a Montague.
ROMEO: I take thee at thy word: call me but love, and I'll be new baptized.
JULIET: What man art thou that thus bescreen'd in night so stumblest on my counsel?
ROMEO: By a name I know not how to tell thee who I am: my name, dear saint, is hateful to myself.
JULIET: My ears have not yet drunk a hundred words of that tongue's utterance, yet I know the sound.
ROMEO: Neither, fair saint, if either thee dislike.`;

  /* ---------------- Boot ---------------- */
  setView(state.view || "library");
})();
