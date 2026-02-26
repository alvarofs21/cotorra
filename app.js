const CEFR_LEVELS = ["A1", "A2.1", "A2.2", "B1.1", "B1.2", "B2"];

let vocabularyDB = null;

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
    vocab: [],
    session: [],
    idx: 0,
    score: 0,
    lives: 5,
    checked: false,
    currentLevel: null,
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showScreen(id) {
    ["home-screen", "game-screen", "result-screen"].forEach(s => {
        const el = $(s);
        if (el) el.classList.add("hidden");
    });
    const footer = $("feedback-footer");
    if (footer) footer.classList.remove("show");
    const screen = $(id);
    if (screen) screen.classList.remove("hidden");
    window.scrollTo(0, 0);
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

// ─── Dark mode ────────────────────────────────────────────────────────────────

function toggleDarkMode() {
    document.documentElement.classList.toggle("dark");
    const icon = $("theme-icon");
    icon.className = document.documentElement.classList.contains("dark")
        ? "fas fa-sun text-lg"
        : "fas fa-moon text-lg";
}

// ─── Game logic ───────────────────────────────────────────────────────────────

function startSession(src) {
    const pool = shuffled(src);
    state.vocab = src;
    state.session = pool.slice(0, 10);
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

    const container = $("options-container");
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
        btn.addEventListener("click", () => checkAnswer(opt, word.de, btn));
        container.appendChild(btn);
    });
}

function checkAnswer(selected, correct, btn) {
    if (state.checked) return;
    state.checked = true;

    const isCorrect = selected === correct;
    if (isCorrect) {
        state.score++;
    } else {
        state.lives--;
    }

    // Highlight all buttons
    document.querySelectorAll(".btn-option").forEach(b => {
        b.disabled = true;
        if (b.textContent === correct) b.classList.add("correct");
    });
    if (!isCorrect) btn.classList.add("wrong");

    // Show feedback footer
    const icon = $("feedback-icon");
    const msg = $("feedback-message");

    icon.className = "text-xl mr-4 shrink-0 " + (isCorrect ? "text-emerald-500" : "text-red-500");
    icon.innerHTML = `<i class="fas fa-${isCorrect ? "check-circle" : "times-circle"}"></i>`;
    msg.textContent = isCorrect ? "Correct" : correct;
    msg.className = "text-sm font-medium " + (isCorrect ? "text-emerald-500" : "text-red-500");

    $("feedback-footer").classList.add("show");
    updateLivesUI();
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
    const level = CEFR_LEVELS[sliderValue];
    state.currentLevel = level;
    startSession(vocabularyDB[level]);
}

function repeatLesson() {
    if (state.currentLevel) {
        startSession(vocabularyDB[state.currentLevel]);
    } else {
        showScreen("home-screen");
    }
}

function showHome() {
    showScreen("home-screen");
}

function endSession() {
    $("quit-modal").classList.remove("hidden");
}

function confirmEndSession() {
    $("quit-modal").classList.add("hidden");
    showScreen("home-screen");
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
    try {
        const res = await fetch("vocabulary.json");
        vocabularyDB = await res.json();
    } catch (e) {
        console.error("Failed to load vocabulary:", e);
        return;
    }

    // Slider
    const slider = $("level-slider");
    const display = $("level-display");
    display.textContent = CEFR_LEVELS[slider.value];
    slider.addEventListener("input", e => {
        display.textContent = CEFR_LEVELS[e.target.value];
    });

    // Buttons — wire up all event listeners here, not in HTML
    $("btn-start").addEventListener("click", startQuickLesson);
    $("btn-continue").addEventListener("click", nextQuestion);
    $("btn-back").addEventListener("click", endSession);
    $("btn-repeat").addEventListener("click", repeatLesson);
    $("btn-change-level").addEventListener("click", showHome);
    $("btn-confirm-end").addEventListener("click", confirmEndSession);
    $("btn-cancel-end").addEventListener("click", () => $("quit-modal").classList.add("hidden"));
    $("btn-theme").addEventListener("click", toggleDarkMode);
}

document.addEventListener("DOMContentLoaded", init);
