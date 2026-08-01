import { getRequestHeaders } from "../../../../script.js";

// ================== INSTÄLLNINGAR ==================
const MODULE_NAME = "wiNameColorizer";

const defaultSettings = {
    enabled: true,
    bookNames: ["MGOT", "GOTLB"],
    defaultColor: "#ffd700",
};
// =====================================================

const context = SillyTavern.getContext();
const { eventSource, eventTypes, extensionSettings, saveSettingsDebounced } = context;

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extensionSettings[MODULE_NAME];
}

const settings = getSettings();

const nameToColor = new Map();
let masterRegex = null;
let buildPromise = null;

// ---------- Hjälpfunktioner ----------

function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainKey(key) {
    const k = String(key).trim();
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

function extractNamesFromRegexKey(key) {
    const k = String(key).trim();
    const names = [];
    for (const m of k.matchAll(/\(([^)]+)\)/g)) {
        names.push(
            ...m[1]
                .split("|")
                .map(s => s.trim())
                .filter(s => s && !s.includes("\\") && !s.includes("[") && s.length > 1)
        );
    }
    return names;
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

// ---------- Kärnlogik ----------

async function buildFromWorldInfo() {
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        try {
            nameToColor.clear();
            const names = [];

            for (const bookName of settings.bookNames) {
                const data = await loadBook(bookName);
                if (!data?.entries) continue;

                for (const entry of Object.values(data.entries)) {
                    if (entry.disable) continue;

                    const allKeys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])];

                    for (const raw of allKeys) {
                        const key = String(raw).trim();
                        if (!key) continue;

                        const namesToAdd = isPlainKey(key)
                            ? [key]
                            : extractNamesFromRegexKey(key);

                        for (const name of namesToAdd) {
                            const lower = name.toLowerCase();
                            if (nameToColor.has(lower)) continue;

                            nameToColor.set(lower, settings.defaultColor);
                            names.push(name);
                        }
                    }
                }
            }

            if (names.length === 0) {
                masterRegex = null;
                console.log("[WI Name Colorizer] Inga namn hittades.");
                return;
            }

            const sorted = [...names].sort((a, b) => b.length - a.length);
            const escaped = sorted.map(escapeRegex);

            masterRegex = new RegExp(
                `(?<![\\p{L}\\p{N}_])(${escaped.join("|")})(['’]s?)?(?![\\p{L}\\p{N}_])`,
                "giu"
            );

            console.log(`[WI Name Colorizer] Byggde regex med ${names.length} namn.`);
        } catch (err) {
            console.error("[WI Name Colorizer] Fel:", err);
        }
    })();

    try {
        await buildPromise;
    } finally {
        buildPromise = null;
    }
}

function getColor(name) {
    return nameToColor.get(String(name).toLowerCase()) || settings.defaultColor;
}

// ---------- Säker färgläggning (Regex har prioritet) ----------

function colorizeElement(el) {
    if (!el || !masterRegex || !settings.enabled) return;

    // Ta bort våra egna tidigare färgmarkeringar
    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;

            const tag = parent.tagName;

            // Rör inte kod, länkar, script osv.
            if (["SCRIPT", "STYLE", "CODE", "PRE", "A"].includes(tag)) {
                return NodeFilter.FILTER_REJECT;
            }

            // Ge Regex prioritet: om texten redan ligger inuti en <span> → lämna den
            if (tag === "SPAN") {
                return NodeFilter.FILTER_REJECT;
            }

            // Extra säkerhet uppåt i trädet
            if (parent.closest("span:not([data-wi-color])")) {
                return NodeFilter.FILTER_REJECT;
            }

            return NodeFilter.FILTER_ACCEPT;
        },
    });

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const textNode of textNodes) {
        const text = textNode.nodeValue;
        masterRegex.lastIndex = 0;
        if (!masterRegex.test(text)) continue;
        masterRegex.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        let match;
        while ((match = masterRegex.exec(text))) {
            const [full, name] = match;
            if (match.index > lastIndex) {
                frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }
            const span = document.createElement("span");
            span.dataset.wiColor = "";
            span.style.color = getColor(name);
            span.style.fontWeight = "bold";
            span.textContent = full;
            frag.appendChild(span);
            lastIndex = match.index + full.length;
        }
        frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.replaceWith(frag);
    }
}

function colorizeAllVisible() {
    document.querySelectorAll("#chat .mes_text").forEach(colorizeElement);
}

function onMessageRendered(mesId) {
    const el = document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`);
    colorizeElement(el);
}

// ---------- Settings-panel ----------

function injectSettingsPanel() {
    if (document.getElementById("wnc_panel")) return;

    const panel = document.createElement("div");
    panel.id = "wnc_panel";
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>WI Name Colorizer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="wnc_enabled" ${settings.enabled ? "checked" : ""}>
                    Aktivera färgläggning
                </label>
                <label>World Info-böcker (kommaseparerat)</label>
                <input type="text" id="wnc_books" class="text_pole" value="${settings.bookNames.join(", ")}">
                <label>Färg</label>
                <input type="color" id="wnc_default_color" value="${settings.defaultColor}">
                <button id="wnc_rebuild" class="menu_button" style="margin-top:8px;">Bygg om från World Info</button>
            </div>
        </div>
    `;

    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.appendChild(panel);

    document.getElementById("wnc_enabled")?.addEventListener("change", (e) => {
        settings.enabled = e.target.checked;
        saveSettingsDebounced();
        if (settings.enabled) {
            colorizeAllVisible();
        } else {
            document.querySelectorAll("#chat span[data-wi-color]").forEach(span => {
                span.replaceWith(document.createTextNode(span.textContent));
            });
        }
    });

    document.getElementById("wnc_books")?.addEventListener("change", (e) => {
        settings.bookNames = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
        saveSettingsDebounced();
        buildFromWorldInfo().then(colorizeAllVisible);
    });

    document.getElementById("wnc_default_color")?.addEventListener("change", (e) => {
        settings.defaultColor = e.target.value;
        saveSettingsDebounced();
        for (const key of nameToColor.keys()) {
            nameToColor.set(key, settings.defaultColor);
        }
        colorizeAllVisible();
    });

    document.getElementById("wnc_rebuild")?.addEventListener("click", async () => {
        await buildFromWorldInfo();
        colorizeAllVisible();
    });
}

// ---------- Chat-observer ----------

let chatObserver = null;

function setupChatObserver() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    const debouncedRecolor = debounce(() => {
        chatObserver?.disconnect();
        colorizeAllVisible();
        chatObserver?.observe(chat, { childList: true, subtree: true, characterData: true });
    }, 250);

    chatObserver = new MutationObserver(debouncedRecolor);
    chatObserver.observe(chat, { childList: true, subtree: true, characterData: true });
}

// ---------- Events ----------

const debouncedBuild = debounce(async (bookName) => {
    if (bookName && !settings.bookNames.includes(bookName)) return;
    await buildFromWorldInfo();
    colorizeAllVisible();
}, 300);

eventSource.on(eventTypes.APP_READY, async () => {
    injectSettingsPanel();
    setupChatObserver();
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHAT_CHANGED, () => debouncedBuild());
eventSource.on(eventTypes.WORLDINFO_UPDATED, (name) => debouncedBuild(name));
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

buildFromWorldInfo().then(colorizeAllVisible);
