import { getRequestHeaders } from "../../../../script.js";

// ================== INSTÄLLNINGAR ==================
const MODULE_NAME = "wiNameColorizer";
const defaultSettings = {
    enabled: true,
    bookNames: ["MGOT", "GOTLB"],
    defaultColor: "#ffd700",
    entryColors: {}, // { "bokNamn::uid": "#rrggbb" }
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
const nameToEntryId = new Map();
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
            nameToEntryId.clear();
            const names = [];

            for (const bookName of settings.bookNames) {
                const data = await loadBook(bookName);
                if (!data?.entries) continue;

                for (const entry of Object.values(data.entries)) {
                    if (entry.disable) continue;

                    const allKeys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])]
                        .map(k => String(k).trim())
                        .filter(Boolean);

                    if (allKeys.length === 0) continue;

                    const entryId = `${bookName}::${entry.uid}`;

                    for (const key of allKeys) {
                        const namesToAdd = isPlainKey(key)
                            ? [key]
                            : extractNamesFromRegexKey(key);

                        for (const name of namesToAdd) {
                            const lower = name.toLowerCase();
                            if (nameToColor.has(lower)) continue;
                            nameToColor.set(lower, settings.defaultColor);
                            nameToEntryId.set(lower, entryId);
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
                `(?<![\\p{L}\\p{N}_])(${escaped.join("|")})(['\u2019]s?)?(?![\\p{L}\\p{N}_])`,
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
    const lower = String(name).toLowerCase();
    const entryId = nameToEntryId.get(lower);
    if (entryId && settings.entryColors[entryId]) {
        return settings.entryColors[entryId];
    }
    return nameToColor.get(lower) || settings.defaultColor;
}

// ---------- Säker färgläggning ----------
function colorizeElement(el) {
    if (!el || !masterRegex || !settings.enabled) return;

    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (["SCRIPT", "STYLE", "CODE", "PRE", "A"].includes(tag)) {
                return NodeFilter.FILTER_REJECT;
            }
            if (tag === "SPAN") {
                return NodeFilter.FILTER_REJECT;
            }
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

// ---------- WI Editor: Injecta färgknappar ----------
let wiEditorObserver = null;
let wiPopupObserver = null;

function getCurrentEditorBookName() {
    const select = document.getElementById('world_editor_select');
    if (!select) return null;
    const selected = select.options[select.selectedIndex];
    return selected ? selected.text : null;
}

function getEntryUid(entryEl) {
    // Försök flera sätt att hitta uid
    const uid = entryEl.getAttribute('uid');
    if (uid !== null) return uid;
    
    const uidData = entryEl.dataset.uid;
    if (uidData !== undefined) return uidData;
    
    // Leta i närmaste world_entry-elements uid
    const parent = entryEl.closest('.world_entry[uid]') || entryEl.closest('[uid]');
    if (parent) return parent.getAttribute('uid');
    
    return null;
}

function injectColorPickerIntoEntry(entryEl) {
    if (!entryEl || entryEl.querySelector('.wnc-entry-color-btn')) return;
    
    const uid = getEntryUid(entryEl);
    if (uid === null || uid === undefined || uid === '') return;
    
    const bookName = getCurrentEditorBookName();
    if (!bookName) return;
    
    const entryId = `${bookName}::${uid}`;
    const currentColor = settings.entryColors[entryId] || settings.defaultColor;
    
    // Hitta rätt plats att injicera knappen
    // Försök först .WIEnteryHeaderControls, sedan brevid entryStateSelector
    let targetContainer = 
        entryEl.querySelector('.WIEnteryHeaderControls') ||
        entryEl.querySelector('.WIEntryHeaderControls'); // ST har ibland stavat fel
    
    if (!targetContainer) {
        const stateSelector = entryEl.querySelector('select[name="entryStateSelector"]');
        if (stateSelector?.parentElement) {
            targetContainer = stateSelector.parentElement;
        }
    }
    
    if (!targetContainer) {
        // Sista utväg: lägg bredvid comment-fältet
        const commentField = entryEl.querySelector('textarea[name="comment"]');
        if (commentField?.parentElement) {
            targetContainer = commentField.parentElement;
        }
    }
    
    if (!targetContainer) return;
    
    // Skapa wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'wnc-entry-color-wrapper';
    wrapper.style.cssText = 'display:flex; align-items:center; gap:4px; margin-left:4px;';
    
    // Skapa etikett
    const label = document.createElement('span');
    label.textContent = '🎨';
    label.title = 'Färg för namn i chatten (högerklicka = återställ)';
    label.style.cssText = 'font-size:0.9em; cursor:help;';
    
    // Skapa färgknapp
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'wnc-entry-color-btn';
    colorInput.value = currentColor;
    colorInput.title = 'Färg för namn i chatten (högerklicka = återställ)';
    colorInput.style.cssText = `
        width: 28px;
        height: 24px;
        padding: 0;
        cursor: pointer;
        border: 1px solid var(--SmartThemeBorderColor, #666);
        border-radius: 4px;
        background: transparent;
        flex-shrink: 0;
    `;
    
    // Uppdatera färg vid ändring
    colorInput.addEventListener('input', () => {
        settings.entryColors[entryId] = colorInput.value;
        saveSettingsDebounced();
        
        // Auto-lägg till boken i bookNames om den inte finns
        if (!settings.bookNames.includes(bookName)) {
            settings.bookNames.push(bookName);
            saveSettingsDebounced();
            buildFromWorldInfo().then(() => {
                colorizeAllVisible();
                updateBooksInputField();
            });
        } else {
            colorizeAllVisible();
        }
    });
    
    // Högerklicka för att återställa
    colorInput.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        delete settings.entryColors[entryId];
        colorInput.value = settings.defaultColor;
        saveSettingsDebounced();
        colorizeAllVisible();
    });
    
    wrapper.appendChild(label);
    wrapper.appendChild(colorInput);
    targetContainer.appendChild(wrapper);
}

function scanAndInjectColorPickers() {
    // Hitta alla entry-element i WI-editorn
    const entries = document.querySelectorAll('#world_popup_entries_list .world_entry');
    entries.forEach(injectColorPickerIntoEntry);
}

function setupWIEditorObserver() {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return false;
    
    if (wiEditorObserver) wiEditorObserver.disconnect();
    
    const debouncedScan = debounce(scanAndInjectColorPickers, 200);
    
    wiEditorObserver = new MutationObserver(debouncedScan);
    wiEditorObserver.observe(list, { 
        childList: true, 
        subtree: true,
        attributes: true,
        attributeFilter: ['uid']
    });
    
    scanAndInjectColorPickers();
    return true;
}

function setupWIPopupObserver() {
    // Observera hela body för att upptäcka när WI-editorn öppnas
    if (wiPopupObserver) wiPopupObserver.disconnect();
    
    wiPopupObserver = new MutationObserver(debounce(() => {
        const list = document.getElementById('world_popup_entries_list');
        if (list && list.children.length > 0) {
            if (!wiEditorObserver) {
                setupWIEditorObserver();
            }
        }
    }, 300));
    
    wiPopupObserver.observe(document.body, { 
        childList: true, 
        subtree: true 
    });
}

// Uppdatera bok-listan i inställningspanelen
function updateBooksInputField() {
    const input = document.getElementById('wnc_books');
    if (input) {
        input.value = settings.bookNames.join(', ');
    }
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

                <label>Default-färg</label>
                <input type="color" id="wnc_default_color" value="${settings.defaultColor}">

                <button id="wnc_rebuild" class="menu_button" style="margin-top:8px;">Bygg om från World Info</button>

                <div style="margin-top:8px; padding:6px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor); font-size:0.85em; opacity:0.8;">
                    💡 Färgknappar finns nu direkt i WI-editorn bredvid varje entry. 
                    Högerklicka på en färgknapp för att återställa till Default.
                    Böcker läggs till automatiskt när du sätter en färg.
                </div>
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
        // Uppdatera alla färgknappar i WI-editorn som inte har egen färg
        document.querySelectorAll('.wnc-entry-color-btn').forEach(btn => {
            const entryEl = btn.closest('.world_entry');
            const uid = getEntryUid(entryEl);
            const bookName = getCurrentEditorBookName();
            if (uid && bookName) {
                const entryId = `${bookName}::${uid}`;
                if (!settings.entryColors[entryId]) {
                    btn.value = settings.defaultColor;
                }
            }
        });
    });

    document.getElementById("wnc_rebuild")?.addEventListener("click", async () => {
        await buildFromWorldInfo();
        colorizeAllVisible();
        scanAndInjectColorPickers();
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
    scanAndInjectColorPickers();
}, 300);

eventSource.on(eventTypes.APP_READY, async () => {
    injectSettingsPanel();
    setupChatObserver();
    setupWIPopupObserver();
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHAT_CHANGED, () => debouncedBuild());
eventSource.on(eventTypes.WORLDINFO_UPDATED, (name) => debouncedBuild(name));
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

// Initiera
injectSettingsPanel();
setupChatObserver();
setupWIPopupObserver();
buildFromWorldInfo().then(() => {
    colorizeAllVisible();
    scanAndInjectColorPickers();
});
