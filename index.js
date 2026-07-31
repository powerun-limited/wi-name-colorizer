import { getRequestHeaders } from "../../../../script.js";

// ========== KONFIGURATION ==========
const BOOK_NAMES = [
    "MGOT",
    "GOTLB"
];

const DEFAULT_COLOR = "#b0b0b0";
// ===================================

const nameToColor = new Map();
let masterRegex = null;

// ---------- Färglogik (chat) ----------

function extractColorFromComment(comment) {
    if (!comment) return null;
    const match = String(comment).match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
    return match ? `#${match[1]}` : null;
}

function getEntryColor(entry) {
    // 1. Först den sparade färgen från färgknappen
    if (entry.extensions?.wiNameColor) {
        return entry.extensions.wiNameColor;
    }
    // 2. Fallback: hex i Title/Memo
    const fromComment = extractColorFromComment(entry.comment);
    if (fromComment) return fromComment;
    // 3. Standard
    return DEFAULT_COLOR;
}

function isPlainKey(key) {
    const k = String(key).trim();
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

function extractNamesFromRegexKey(key) {
    const k = String(key).trim();
    const match = k.match(/\(([^)]+)\)/);
    if (!match) return [];
    return match[1]
        .split("|")
        .map(s => s.trim())
        .filter(s => s && !s.includes("\\") && !s.includes("[") && s.length > 1);
}

async function loadBook(name) {
    try {
        const response = await fetch("/api/worldinfo/get", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!response.ok) {
            console.warn(`[WI Name Colorizer] Kunde inte hämta boken "${name}"`);
            return null;
        }
        return await response.json();
    } catch (err) {
        console.error(`[WI Name Colorizer] Fel vid hämtning av "${name}":`, err);
        return null;
    }
}

async function saveBook(name, data) {
    try {
        await fetch("/api/worldinfo/edit", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data }),
        });
    } catch (err) {
        console.error(`[WI Name Colorizer] Kunde inte spara boken "${name}":`, err);
    }
}

async function buildFromWorldInfo() {
    try {
        nameToColor.clear();
        const names = [];

        for (const bookName of BOOK_NAMES) {
            const data = await loadBook(bookName);
            if (!data?.entries) continue;

            for (const entry of Object.values(data.entries)) {
                if (entry.disable) continue;

                const color = getEntryColor(entry);
                const allKeys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])];

                for (const raw of allKeys) {
                    const key = String(raw).trim();
                    if (!key) continue;

                    let namesToAdd = [];

                    if (isPlainKey(key)) {
                        namesToAdd = [key];
                    } else {
                        namesToAdd = extractNamesFromRegexKey(key);
                    }

                    for (const name of namesToAdd) {
                        const lower = name.toLowerCase();
                        if (!nameToColor.has(lower)) {
                            nameToColor.set(lower, color);
                            names.push(name);
                        }
                    }
                }
            }
        }

        if (names.length === 0) {
            masterRegex = null;
            console.log("[WI Name Colorizer] Inga namn hittades.");
            return;
        }

        names.sort((a, b) => b.length - a.length);

        const escaped = names.map(n =>
            n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        );

        masterRegex = new RegExp(
            `\\b(${escaped.join("|")})(['’]s?)?(?!\\w)`,
            "gi"
        );

        console.log(`[WI Name Colorizer] Byggde regex med ${names.length} namn från ${BOOK_NAMES.length} bok(ar).`);
    } catch (err) {
        console.error("[WI Name Colorizer] Fel:", err);
    }
}

function getColor(name) {
    return nameToColor.get(String(name).toLowerCase()) || DEFAULT_COLOR;
}

function colorizeElement(el) {
    if (!el || !masterRegex) return;

    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(...span.childNodes);
    });

    el.innerHTML = el.innerHTML.replace(masterRegex, (match, name, poss) => {
        const color = getColor(name);
        return `<span data-wi-color style="color:${color}; font-weight:bold;">${name}${poss || ""}</span>`;
    });
}

function colorizeAllVisible() {
    document.querySelectorAll("#chat .mes_text").forEach(colorizeElement);
}

function onMessageRendered(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    colorizeElement(el);
}

// ---------- Färgknapp i World Info-editorn ----------

function createColorPicker(currentColor, onChange) {
    const wrapper = document.createElement("div");
    wrapper.className = "wi-name-color-picker";
    wrapper.style.cssText = "display:inline-flex; align-items:center; gap:6px; margin-left:8px; vertical-align:middle;";

    const label = document.createElement("span");
    label.textContent = "Färg:";
    label.style.cssText = "font-size:12px; opacity:0.85;";

    const input = document.createElement("input");
    input.type = "color";
    input.value = currentColor || DEFAULT_COLOR;
    input.title = "Välj färg för detta namn i chatten";
    input.style.cssText = "width:28px; height:22px; padding:0; border:1px solid #666; cursor:pointer; background:none;";

    input.addEventListener("change", () => onChange(input.value));

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    return wrapper;
}

async function handleColorChange(bookName, uid, newColor) {
    const data = await loadBook(bookName);
    if (!data?.entries?.[uid]) {
        console.warn("[WI Name Colorizer] Hittade inte entry", uid, "i", bookName);
        return;
    }

    if (!data.entries[uid].extensions) {
        data.entries[uid].extensions = {};
    }
    data.entries[uid].extensions.wiNameColor = newColor;

    await saveBook(bookName, data);
    console.log(`[WI Name Colorizer] Sparade färg ${newColor} på UID ${uid}`);

    await buildFromWorldInfo();
    colorizeAllVisible();
}

function injectColorPickers() {
    // Den mest stabila selektorn just nu
    const commentFields = document.querySelectorAll(".world_entry textarea[name=\"comment\"]");

    commentFields.forEach(textarea => {
        if (textarea.dataset.wiColorInjected) return;
        textarea.dataset.wiColorInjected = "1";

        const entryEl = textarea.closest(".world_entry");
        if (!entryEl) return;

        const uid = entryEl.getAttribute("uid") || entryEl.dataset.uid;
        if (!uid) return;

        // Hitta vilken bok som är vald i editorn
        const bookSelect = document.querySelector("#world_editor_select");
        const bookName = bookSelect?.value || BOOK_NAMES[0];

        if (!bookName) return;

        // Hämta nuvarande färg och lägg till knappen
        loadBook(bookName).then(data => {
            const entry = data?.entries?.[uid];
            const currentColor = entry ? getEntryColor(entry) : DEFAULT_COLOR;

            const picker = createColorPicker(currentColor, (newColor) => {
                handleColorChange(bookName, uid, newColor);
            });

            // Placera knappen direkt efter textarea (enklast och mest synligt)
            textarea.parentNode.insertBefore(picker, textarea.nextSibling);
        });
    });
}

// Observer + manuell trigger
const wiObserver = new MutationObserver(() => {
    // Liten fördröjning så att SillyTavern hinner rita klart
    setTimeout(injectColorPickers, 150);
});

function startWiObserver() {
    const target = document.body;
    wiObserver.observe(target, { childList: true, subtree: true });
    // Kör också direkt
    setTimeout(injectColorPickers, 500);
}

// ---------- Event-lyssnare ----------

const context = SillyTavern.getContext();
const { eventSource, eventTypes } = context;

eventSource.on(eventTypes.APP_READY, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
    startWiObserver();
});

eventSource.on(eventTypes.CHAT_CHANGED, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.WORLDINFO_UPDATED, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
    setTimeout(injectColorPickers, 300); // Ge editorn tid att ritas om
});

eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

// Start
buildFromWorldInfo().then(colorizeAllVisible);
startWiObserver();
