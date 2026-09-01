const CEFR_LEVELS = ["A1", "A2.1", "A2.2", "B1.1", "B1.2", "B2"];
const SESSION_SIZE = 10;
// Leitner box → days until due again. Box 0 = due immediately (next session).
const LEITNER_INTERVALS_MS = [0, 1, 3, 7, 16].map(d => d * 24 * 60 * 60 * 1000);

let vocabularyDB = null;
let grammarDB = null;

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
    vocab: [],
    session: [],
    idx: 0,
    score: 0,
    lives: 5,
    checked: false,
    currentLevel: null,
    mode: "choice", // "choice" (multiple choice) or "type" (type the answer)
};

const grammarState = {
    topic: null,
    items: [],
    idx: 0,
    score: 0,
    checked: false,
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

const SCREENS = ["home-screen", "game-screen", "result-screen", "grammar-lesson-screen", "grammar-exercise-screen"];

function showScreen(id) {
    SCREENS.forEach(s => {
        const el = $(s);
        if (el) el.classList.add("hidden");
    });
    const footer = $("feedback-footer");
    if (footer) footer.classList.remove("show");
    const screen = $(id);
    if (screen) screen.classList.remove("hidden");
    window.scrollTo(0, 0);
}

function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
}

// ─── Shuffle ──────────────────────────────────────────────────────────────────

function shuffled(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Normalizes a typed answer for comparison: trims/lowercases and accepts the
// keyboard-friendly ASCII spellings of umlauts and ß, so "Apfel"/"apfel" and
// "gross"/"groß" both match — but the article still has to be right.
function normalizeAnswer(s) {
    return s
        .trim()
        .toLowerCase()
        .replace(/ß/g, "ss")
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue");
}

// ─── Local storage (best-effort — the app works fine without it) ────────────

function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
}
function storageGetJSON(key, fallback) {
    const raw = storageGet(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

// ─── Dark mode ────────────────────────────────────────────────────────────────

function applyTheme(isDark) {
    document.documentElement.classList.toggle("dark", isDark);
    const icon = $("theme-icon");
    icon.className = isDark ? "fas fa-sun text-lg" : "fas fa-moon text-lg";
}

function toggleDarkMode() {
    const isDark = !document.documentElement.classList.contains("dark");
    applyTheme(isDark);
    storageSet("cotorra_theme", isDark ? "dark" : "light");
}

// ─── Progress tracking (spaced repetition, Leitner-style) ───────────────────
//
// Every word a learner answers is tracked per level, keyed by its German
// answer. A correct answer promotes it to a longer review interval; a wrong
// answer drops it back to box 0 so it resurfaces in the very next session.

function loadProgress(level) {
    const all = storageGetJSON("cotorra_progress_v1", {});
    return all[level] || {};
}

function saveProgress(level, progress) {
    const all = storageGetJSON("cotorra_progress_v1", {});
    all[level] = progress;
    storageSet("cotorra_progress_v1", JSON.stringify(all));
}

function updateProgress(level, de, isCorrect) {
    const progress = loadProgress(level);
    const entry = progress[de] || { box: 0, due: 0 };
    entry.box = isCorrect ? Math.min(entry.box + 1, LEITNER_INTERVALS_MS.length - 1) : 0;
    entry.due = Date.now() + LEITNER_INTERVALS_MS[entry.box];
    progress[de] = entry;
    saveProgress(level, progress);
}

function dueCount(level, vocab) {
    const progress = loadProgress(level);
    const now = Date.now();
    return vocab.reduce((n, w) => {
        const p = progress[w.de];
        return n + (p && p.due <= now ? 1 : 0);
    }, 0);
}

// Builds a session: words due for review first, then never-seen words, then
// already-comfortable words as filler — so practice time goes where it helps.
function selectSessionWords(level, vocab, size) {
    const progress = loadProgress(level);
    const now = Date.now();
    const due = [], fresh = [], resting = [];
    for (const w of vocab) {
        const p = progress[w.de];
        if (!p) fresh.push(w);
        else if (p.due <= now) due.push(w);
        else resting.push(w);
    }
    const pool = [...shuffled(due), ...shuffled(fresh), ...shuffled(resting)];
    return pool.slice(0, size);
}

// A word counts as "learned" once it's been answered correctly enough times
// in a row to reach a week-plus review interval (Leitner box 3+).
const MASTERY_BOX = 3;

function computeMasteryStats() {
    let learned = 0, total = 0;
    if (!vocabularyDB) return { learned, total };
    for (const level of CEFR_LEVELS) {
        const vocab = vocabularyDB[level] || [];
        total += vocab.length;
        const progress = loadProgress(level);
        for (const w of vocab) {
            const p = progress[w.de];
            if (p && p.box >= MASTERY_BOX) learned++;
        }
    }
    return { learned, total };
}

// ─── Game logic ───────────────────────────────────────────────────────────────

function startSession(level) {
    const src = vocabularyDB[level];
    state.vocab = src;
    state.currentLevel = level;
    state.session = selectSessionWords(level, src, SESSION_SIZE);
    state.idx = 0;
    state.score = 0;
    state.lives = 5;
    state.checked = false;
    updateLivesUI();
    showScreen("game-screen");
    renderQuestion();
}

function renderQuestion() {
    state.checked = false;
    const word = state.session[state.idx];

    $("english-word").textContent = word.source;
    $("progress-bar").style.width = (state.idx / state.session.length) * 100 + "%";

    if (state.mode === "type") {
        renderTypeQuestion(word);
    } else {
        renderChoiceQuestion(word);
    }
}

function renderChoiceQuestion(word) {
    $("type-form").classList.add("hidden");
    const container = $("options-container");
    container.classList.remove("hidden");
    container.innerHTML = "";

    // Build distractors of the same word type
    const currentType = word.type;
    let sameType = state.vocab.filter(v => v.de !== word.de && v.type === currentType);
    if (sameType.length < 3) {
        sameType = [...sameType, ...state.vocab.filter(v => v.de !== word.de && v.type !== currentType)];
    }

    const optionSet = new Set([word.de]);
    for (const d of shuffled(sameType)) {
        if (optionSet.size >= 4) break;
        optionSet.add(d.de);
    }

    shuffled([...optionSet]).forEach(opt => {
        const btn = document.createElement("button");
        btn.className = "btn-premium btn-option w-full py-4 px-6 rounded-lg text-sm text-center break-words shadow-sm";
        btn.textContent = opt;
        btn.addEventListener("click", () => {
            const isCorrect = submitAnswer(opt, word.de);
            document.querySelectorAll(".btn-option").forEach(b => {
                b.disabled = true;
                if (b.textContent === word.de) b.classList.add("correct");
            });
            if (!isCorrect) btn.classList.add("wrong");
            showFeedback(isCorrect, word.de);
        });
        container.appendChild(btn);
    });
}

function renderTypeQuestion(word) {
    $("options-container").classList.add("hidden");
    const form = $("type-form");
    form.classList.remove("hidden");

    const input = $("type-input");
    input.value = "";
    input.disabled = false;
    input.classList.remove("correct", "wrong");
    setTimeout(() => input.focus(), 50);

    form.onsubmit = e => {
        e.preventDefault();
        if (state.checked || !input.value.trim()) return;
        const isCorrect = submitAnswer(input.value, word.de);
        input.disabled = true;
        input.classList.add(isCorrect ? "correct" : "wrong");
        if (!isCorrect) input.value = word.de;
        showFeedback(isCorrect, word.de);
    };
}

// Scores the answer and updates spaced-repetition progress. Shared by both
// practice modes; UI feedback is handled separately by the caller.
function submitAnswer(selected, correct) {
    if (state.checked) return false;
    state.checked = true;

    const isCorrect = normalizeAnswer(selected) === normalizeAnswer(correct);
    if (isCorrect) {
        state.score++;
    } else {
        state.lives--;
    }
    updateProgress(state.currentLevel, correct, isCorrect);
    updateLivesUI();
    return isCorrect;
}

function showFeedback(isCorrect, correct) {
    const icon = $("feedback-icon");
    const msg = $("feedback-message");

    icon.className = "text-xl mr-4 shrink-0 " + (isCorrect ? "text-emerald-500" : "text-red-500");
    icon.innerHTML = `<i class="fas fa-${isCorrect ? "check-circle" : "times-circle"}"></i>`;
    msg.textContent = isCorrect ? "Correct" : correct;
    msg.className = "text-sm font-medium " + (isCorrect ? "text-emerald-500" : "text-red-500");

    $("feedback-footer").classList.add("show");
}

function nextQuestion() {
    state.idx++;
    const sessionOver = state.lives <= 0 || state.idx >= state.session.length;

    if (sessionOver) {
        $("final-score").textContent = `${state.score}/${state.session.length}`;
        $("final-accuracy").textContent = `${Math.round((state.score / state.session.length) * 100)}%`;
        $("result-title").textContent = state.lives <= 0 ? "Session Ended." : "Sehr Gut";
        showScreen("result-screen");
    } else {
        $("feedback-footer").classList.remove("show");
        renderQuestion();
    }
}

function updateLivesUI() {
    $("heart-count").querySelector("span").textContent = state.lives;
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function startQuickLesson() {
    const sliderValue = $("level-slider").value;
    storageSet("cotorra_last_level", sliderValue);
    startSession(CEFR_LEVELS[sliderValue]);
}

function repeatLesson() {
    if (state.currentLevel) {
        startSession(state.currentLevel);
    } else {
        showScreen("home-screen");
    }
}

function showHome() {
    showScreen("home-screen");
    updateReviewHint();
    updateMasteryStat();
}

function setMode(mode) {
    state.mode = mode;
    storageSet("cotorra_mode", mode);
    document.querySelectorAll(".mode-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.mode === mode);
    });
}

function endSession() {
    $("quit-modal").classList.remove("hidden");
}

function confirmEndSession() {
    $("quit-modal").classList.add("hidden");
    showHome();
}

function updateReviewHint() {
    const slider = $("level-slider");
    const level = CEFR_LEVELS[slider.value];
    const hint = $("review-hint");
    if (!vocabularyDB || !vocabularyDB[level]) return;
    const n = dueCount(level, vocabularyDB[level]);
    if (n > 0) {
        hint.textContent = `${n} word${n === 1 ? "" : "s"} due for review`;
        hint.classList.remove("hidden");
    } else {
        hint.classList.add("hidden");
    }
}

function updateMasteryStat() {
    const { learned, total } = computeMasteryStats();
    if (total === 0) return;
    $("mastery-stat").textContent = `${learned} / ${total} words learned`;
}

function setSection(section) {
    document.querySelectorAll(".section-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.section === section);
    });
    $("vocab-panel").classList.toggle("hidden", section !== "vocab");
    $("grammar-panel").classList.toggle("hidden", section !== "grammar");
    storageSet("cotorra_section", section);
}

// ─── Grammar ──────────────────────────────────────────────────────────────────
//
// A separate, self-contained section: short lessons (explanation + table +
// examples) per grammar topic, each followed by a small practice quiz. Best
// score per topic is remembered in localStorage so progress is visible.

function loadGrammarProgress() {
    return storageGetJSON("cotorra_grammar_progress", {});
}

function saveGrammarTopicResult(topicId, score, total) {
    const all = loadGrammarProgress();
    const prev = all[topicId];
    if (!prev || score > prev.score) {
        all[topicId] = { score, total, completedAt: Date.now() };
    }
    storageSet("cotorra_grammar_progress", JSON.stringify(all));
}

function renderGrammarTopicList() {
    const list = $("grammar-topic-list");
    if (!grammarDB || !list) return;
    list.innerHTML = "";
    const progress = loadGrammarProgress();
    const levels = [...new Set(grammarDB.map(t => t.level))];

    levels.forEach((level, i) => {
        const heading = document.createElement("div");
        heading.className = "text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1 transition-colors" + (i > 0 ? " mt-4" : "");
        heading.textContent = level;
        list.appendChild(heading);

        grammarDB.filter(t => t.level === level).forEach(topic => {
            const p = progress[topic.id];
            const card = document.createElement("button");
            card.className = "btn-premium w-full text-left p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-3 transition-colors";
            card.innerHTML = `
                <span class="min-w-0">
                    <span class="block text-sm font-medium text-slate-900 dark:text-white truncate">${escapeHtml(topic.title)}</span>
                    <span class="block text-xs text-slate-400 dark:text-slate-500 mt-0.5">${escapeHtml(topic.summary)}</span>
                </span>
                <span class="shrink-0 text-xs font-medium ${p ? "text-emerald-500" : "text-slate-300 dark:text-slate-700"}">${p ? `${p.score}/${p.total}` : ""}</span>
            `;
            card.addEventListener("click", () => openGrammarLesson(topic));
            list.appendChild(card);
        });
    });
}

function renderGrammarTable(table) {
    const caption = table.caption ? `<p class="text-xs text-slate-400 dark:text-slate-500 mb-2 transition-colors">${escapeHtml(table.caption)}</p>` : "";
    const head = `<tr>${table.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
    const rows = table.rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
    return `${caption}<table class="grammar-table">${head}${rows}</table>`;
}

function openGrammarLesson(topic) {
    grammarState.topic = topic;

    $("grammar-lesson-level").textContent = topic.level;
    $("grammar-lesson-title").textContent = topic.title;
    $("grammar-lesson-explanation").innerHTML = topic.explanation.map(p => `<p>${escapeHtml(p)}</p>`).join("");

    const tableWrap = $("grammar-lesson-table-wrap");
    if (topic.table) {
        tableWrap.innerHTML = renderGrammarTable(topic.table);
        tableWrap.classList.remove("hidden");
    } else {
        tableWrap.innerHTML = "";
        tableWrap.classList.add("hidden");
    }

    $("grammar-lesson-examples").innerHTML = topic.examples.map(ex => `
        <div class="border-l-2 border-slate-200 dark:border-slate-800 pl-4 transition-colors">
            <p class="text-sm font-medium text-slate-900 dark:text-white transition-colors">${escapeHtml(ex.de)}</p>
            <p class="text-xs text-slate-400 dark:text-slate-500 mt-1 transition-colors">${escapeHtml(ex.note)}</p>
        </div>
    `).join("");

    showScreen("grammar-lesson-screen");
}

function showGrammarList() {
    showScreen("home-screen");
    setSection("grammar");
    renderGrammarTopicList();
}

function startGrammarPractice() {
    grammarState.items = shuffled(grammarState.topic.exercises);
    grammarState.idx = 0;
    grammarState.score = 0;
    grammarState.checked = false;
    $("grammar-quiz-body").classList.remove("hidden");
    $("grammar-quiz-summary").classList.add("hidden");
    showScreen("grammar-exercise-screen");
    renderGrammarQuestion();
}

function renderGrammarQuestion() {
    grammarState.checked = false;
    const item = grammarState.items[grammarState.idx];

    $("grammar-question-count").textContent = `${grammarState.idx + 1}/${grammarState.items.length}`;
    $("grammar-progress-bar").style.width = (grammarState.idx / grammarState.items.length) * 100 + "%";
    $("grammar-prompt").textContent = item.prompt;

    const note = $("grammar-feedback-note");
    note.classList.add("hidden");
    $("btn-grammar-next").classList.add("hidden");

    const area = $("grammar-answer-area");
    area.innerHTML = "";

    if (item.type === "choice") {
        shuffled(item.options).forEach(opt => {
            const btn = document.createElement("button");
            btn.className = "btn-premium btn-option w-full py-4 px-6 rounded-lg text-sm text-center break-words shadow-sm";
            btn.textContent = opt;
            btn.addEventListener("click", () => answerGrammarQuestion(opt, item, btn));
            area.appendChild(btn);
        });
    } else {
        const form = document.createElement("form");
        form.className = "flex flex-col gap-4";
        form.innerHTML = `
            <input type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
                class="input-answer w-full py-4 px-6 rounded-lg text-lg text-center break-words" placeholder="Deine Antwort…">
            <button type="submit" class="w-full btn-premium bg-slate-900 dark:bg-white text-white dark:text-slate-900 py-4 rounded-lg font-medium transition-colors shadow-sm">Check</button>
        `;
        const input = form.querySelector("input");
        form.addEventListener("submit", e => {
            e.preventDefault();
            if (!input.value.trim()) return;
            answerGrammarQuestion(input.value, item, input);
        });
        area.appendChild(form);
        setTimeout(() => input.focus(), 50);
    }
}

function answerGrammarQuestion(selected, item, el) {
    if (grammarState.checked) return;
    grammarState.checked = true;

    const isCorrect = normalizeAnswer(selected) === normalizeAnswer(item.answer);
    if (isCorrect) grammarState.score++;

    if (item.type === "choice") {
        document.querySelectorAll("#grammar-answer-area .btn-option").forEach(b => {
            b.disabled = true;
            if (b.textContent === item.answer) b.classList.add("correct");
        });
        if (!isCorrect) el.classList.add("wrong");
    } else {
        el.disabled = true;
        el.classList.add(isCorrect ? "correct" : "wrong");
        if (!isCorrect) el.value = item.answer;
    }

    const note = $("grammar-feedback-note");
    note.textContent = (isCorrect ? "✓ " : `✗ Correct answer: ${item.answer} — `) + item.explanation;
    note.className = "text-sm leading-relaxed text-center mt-6 transition-colors " + (isCorrect ? "text-emerald-500" : "text-red-500");
    note.classList.remove("hidden");

    const nextBtn = $("btn-grammar-next");
    nextBtn.textContent = grammarState.idx + 1 >= grammarState.items.length ? "See Results" : "Next";
    nextBtn.classList.remove("hidden");
}

function nextGrammarQuestion() {
    grammarState.idx++;
    if (grammarState.idx >= grammarState.items.length) {
        finishGrammarPractice();
    } else {
        renderGrammarQuestion();
    }
}

function finishGrammarPractice() {
    saveGrammarTopicResult(grammarState.topic.id, grammarState.score, grammarState.items.length);
    $("grammar-quiz-body").classList.add("hidden");
    $("grammar-quiz-summary").classList.remove("hidden");
    $("grammar-summary-score").textContent = `${grammarState.score}/${grammarState.items.length}`;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
    try {
        const [vocabRes, grammarRes] = await Promise.all([fetch("vocabulary.json"), fetch("grammar.json")]);
        vocabularyDB = await vocabRes.json();
        grammarDB = await grammarRes.json();
    } catch (e) {
        console.error("Failed to load app data:", e);
        return;
    }

    // Theme icon reflects whatever theme was already applied before first paint
    applyTheme(document.documentElement.classList.contains("dark"));

    // Slider — restore the last level trained, default to A1
    const slider = $("level-slider");
    const display = $("level-display");
    const savedLevel = storageGet("cotorra_last_level");
    if (savedLevel !== null && CEFR_LEVELS[savedLevel] !== undefined) {
        slider.value = savedLevel;
    }
    display.textContent = CEFR_LEVELS[slider.value];
    updateReviewHint();
    updateMasteryStat();
    slider.addEventListener("input", e => {
        display.textContent = CEFR_LEVELS[e.target.value];
        updateReviewHint();
    });

    // Practice mode — restore the last mode used, default to multiple choice
    const savedMode = storageGet("cotorra_mode");
    setMode(savedMode === "type" ? "type" : "choice");
    $("btn-mode-choice").addEventListener("click", () => setMode("choice"));
    $("btn-mode-type").addEventListener("click", () => setMode("type"));

    // Section — restore the last section (Vocabulary/Grammar) used
    const savedSection = storageGet("cotorra_section");
    setSection(savedSection === "grammar" ? "grammar" : "vocab");
    renderGrammarTopicList();
    $("btn-section-vocab").addEventListener("click", () => setSection("vocab"));
    $("btn-section-grammar").addEventListener("click", () => { setSection("grammar"); renderGrammarTopicList(); });

    // Buttons — wire up all event listeners here, not in HTML
    $("btn-start").addEventListener("click", startQuickLesson);
    $("btn-continue").addEventListener("click", nextQuestion);
    $("btn-back").addEventListener("click", endSession);
    $("btn-repeat").addEventListener("click", repeatLesson);
    $("btn-change-level").addEventListener("click", showHome);
    $("btn-confirm-end").addEventListener("click", confirmEndSession);
    $("btn-cancel-end").addEventListener("click", () => $("quit-modal").classList.add("hidden"));
    $("btn-theme").addEventListener("click", toggleDarkMode);

    $("btn-grammar-lesson-back").addEventListener("click", showGrammarList);
    $("btn-grammar-practice").addEventListener("click", startGrammarPractice);
    $("btn-grammar-next").addEventListener("click", nextGrammarQuestion);
    $("btn-grammar-exit").addEventListener("click", () => openGrammarLesson(grammarState.topic));
    $("btn-grammar-retry").addEventListener("click", startGrammarPractice);
    $("btn-grammar-back-to-lesson").addEventListener("click", () => openGrammarLesson(grammarState.topic));
}

document.addEventListener("DOMContentLoaded", init);
