import { getRequestHeaders } from "../../../../script.js";

// ================== INSTÄLLNINGAR ==================
const MODULE_NAME = "wiNameColorizer";

const defaultSettings = {
    enabled: true,
    bookNames: ["MGOT", "GOTLB"],
    defaultColor: "#b0b0b0",
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

function extractColorFromComment(comment) {
    if (!comment) return null;
    const match = String(comment).match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
    return match ? `#${match[1]}` : null;
}

function getEntryColor(entry) {
    // Hex i Title/Memo har högst prioritet
    const fromComment = extractColorFromComment(entry.comment);
    if (fromComment) return fromComment;
    return settings.defaultColor;
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

// ---------- Kärnlogik: färg per ENTRY ----------

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

                    // EN färg för hela entryt
                    const entryColor = getEntryColor(entry);
                    const allKeys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])];

                    for (const raw of allKeys) {
                        const key = String(raw).trim();
                        if (!key) continue;

                        const namesToAdd = isPlainKey(key)
                            ? [key]
                            : extractNamesFromRegexKey(key);

                        for (const name of namesToAdd) {
                            const lower = name.toLowerCase();
                            // Första entryn som har namnet vinner
                            if (nameToColor.has(lower)) continue;

                            nameToColor.set(lower, entryColor);
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

            console.log(`[WI Name Colorizer] Byggde regex med ${names.length} namn från ${settings.bookNames.length} bok(ar).`);
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

// ---------- Säker färgläggning ----------

function colorizeElement(el) {
    if (!el || !masterRegex || !settings.enabled) return;

    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const tag = node.parentElement?.tagName;
            if (["SCRIPT", "STYLE", "CODE", "PRE", "A"].includes(tag)) {
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

// ---------- Färgknapp i World Info (skriver hex i Title/Memo) ----------

function createColorPicker(currentColor, onChange) {
    const wrapper = document.createElement("div");
    wrapper.className = "wi-name-color-picker";
    wrapper.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:8px;vertical-align:middle;";

    const label = document.createElement("span");
    label.textContent = "Färg:";
    label.style.cssText = "font-size:12px;opacity:0.85;";

    const input = document.createElement("input");
    input.type = "color";
    input.value = currentColor || settings.defaultColor;
    input.title = "Färg för alla nycklar i denna entry";
    input.style.cssText = "width:28px;height:22px;padding:0;border:1px solid #666;cursor:pointer;background:none;";

    input.addEventListener("change", () => onChange(input.value));

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    return wrapper;
}

function handleColorChange(textarea, newColor) {
    // Ta bort eventuell gammal hex-kod
    let value = textarea.value || "";
    value = value.replace(/\s*#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g, "").trim();

    // Lägg den nya färgen i slutet
    if (value) {
        value = value + " " + newColor;
    } else {
        value = newColor;
    }

    textarea.value = value;

    // Trigga SillyTaverns egen sparning
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));

    // Bygg om efter en kort stund
    setTimeout(async () => {
        await buildFromWorldInfo();
        colorizeAllVisible();
    }, 700);
}

function injectColorPickers() {
    const fields = document.querySelectorAll('.world_entry textarea[name="comment"]');
    let injected = 0;

    fields.forEach(textarea => {
        if (textarea.dataset.wiColorInjected) return;
        textarea.dataset.wiColorInjected = "1";
        injected++;

        // Hämta nuvarande färg från fältet
        const currentMatch = (textarea.value || "").match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
        const currentColor = currentMatch ? `#${currentMatch[1]}` : settings.defaultColor;

        const picker = createColorPicker(currentColor, (newColor) => {
            handleColorChange(textarea, newColor);
        });

        textarea.parentNode.insertBefore(picker, textarea.nextSibling);
    });

    if (injected > 0) {
        console.log(`[WI Name Colorizer] Injicerade ${injected} färgknappar`);
    }
}

function startWiObserver() {
    setTimeout(injectColorPickers, 400);
    setTimeout(injectColorPickers, 1000);
    setTimeout(injectColorPickers, 2000);

    const observer = new MutationObserver(() => {
        setTimeout(injectColorPickers, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// ---------- Enkel settings-panel ----------

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
                <label>Standardfärg</label>
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
        if (settings.enabled) colorizeAllVisible();
        else {
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
        buildFromWorldInfo().then(colorizeAllVisible);
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
    startWiObserver();
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHAT_CHANGED, () => debouncedBuild());
eventSource.on(eventTypes.WORLDINFO_UPDATED, (name) => debouncedBuild(name));
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

buildFromWorldInfo().then(colorizeAllVisible);
startWiObserver();
