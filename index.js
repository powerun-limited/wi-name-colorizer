import { getRequestHeaders } from "../../../../script.js";

// ================== INSTÄLLNINGAR ==================
const MODULE_NAME = "wiNameColorizer";

const defaultSettings = {
    enabled: true,
    bookNames: ["MGOT", "GOTLB"],
    defaultColor: "#b0b0b0",
    colors: {}, // { "namn (lowercase)": "#rrggbb" } – dina egna färgval, har alltid högst prioritet
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

// ---------- Runtime-state ----------
const nameToColor = new Map();   // lowercase namn -> aktiv färg
let masterRegex = null;
let discoveredNames = [];        // originalstavning, för UI-listan
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

function extractColor(comment) {
    if (!comment) return null;
    const match = String(comment).match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
    return match ? `#${match[1]}` : null;
}

function isPlainKey(key) {
    const k = String(key).trim();
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

function extractNamesFromRegexKey(key) {
    const k = String(key).trim();
    const names = [];
    // Hämtar ALLA parentesgrupper, inte bara den första
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
    // Skydd mot parallella/dubbla anrop
    if (buildPromise) return buildPromise;

    buildPromise = (async () => {
        try {
            nameToColor.clear();
            discoveredNames = [];

            for (const bookName of settings.bookNames) {
                const data = await loadBook(bookName);
                if (!data?.entries) continue;

                for (const entry of Object.values(data.entries)) {
                    if (entry.disable) continue;

                    const wiColor = extractColor(entry.comment);
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

                            // Prioritet: användarens egen färg > WI-kommentar > global standardfärg
                            const color = settings.colors[lower] ?? wiColor ?? settings.defaultColor;

                            nameToColor.set(lower, color);
                            discoveredNames.push(name);
                        }
                    }
                }
            }

            if (discoveredNames.length === 0) {
                masterRegex = null;
                console.log("[WI Name Colorizer] Inga namn hittades.");
                return;
            }

            const sorted = [...discoveredNames].sort((a, b) => b.length - a.length);
            const escaped = sorted.map(escapeRegex);

            // Unicode-medvetna ordgränser (funkar även med å/ä/ö/é osv., till skillnad från \b)
            masterRegex = new RegExp(
                `(?<![\\p{L}\\p{N}_])(${escaped.join("|")})(['’]s?)?(?![\\p{L}\\p{N}_])`,
                "giu"
            );

            console.log(`[WI Name Colorizer] Byggde regex med ${discoveredNames.length} namn från ${settings.bookNames.length} bok(ar).`);
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

// ---------- Säker färgläggning (ingen innerHTML) ----------

function colorizeElement(el) {
    if (!el || !masterRegex || !settings.enabled) return;

    // Packa upp gamla highlight-spans utan att röra annan markup
    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const tag = node.parentElement?.tagName;
            // Rör inte kod, länkar eller redan formaterad text
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
            const [full, name, poss] = match;
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

// ---------- Inställningspanel (UI med färgväljare) ----------

function renderNameList() {
    const $list = $("#wnc_name_list");
    if (!$list.length) return;
    $list.empty();

    const sorted = [...discoveredNames].sort((a, b) => a.localeCompare(b));
    for (const name of sorted) {
        const lower = name.toLowerCase();
        const color = nameToColor.get(lower) || settings.defaultColor;
        const overridden = Object.hasOwn(settings.colors, lower);

        const row = $(`
            <div class="wnc-row" style="display:flex;align-items:center;gap:8px;margin:4px 0;">
                <input type="color" class="wnc-color-input" value="${color}" data-name="${lower}" style="width:36px;height:24px;padding:0;border:none;">
                <span style="flex:1;">${name}${overridden ? " ✏️" : ""}</span>
                <button class="menu_button wnc-reset" data-name="${lower}" title="Återställ till WI/standard">↺</button>
            </div>
        `);
        $list.append(row);
    }
}

function bindSettingsEvents() {
    // Fungerar både på input och change (viktigt på mobil)
    $(document).on("input change", ".wnc-color-input", function () {
        const lower = $(this).data("name");
        const color = $(this).val();
        if (!lower || !color) return;

        settings.colors[lower] = color;
        nameToColor.set(lower, color);
        saveSettingsDebounced();
        colorizeAllVisible();

        // Uppdatera ✏️-markeringen i listan
        const $row = $(this).closest(".wnc-row");
        $row.find("span").first().text(
            $row.find("span").first().text().replace(" ✏️", "") + " ✏️"
        );
    });

    $(document).on("click", ".wnc-reset", function () {
        const lower = $(this).data("name");
        delete settings.colors[lower];
        saveSettingsDebounced();
        buildFromWorldInfo().then(() => {
            renderNameList();
            colorizeAllVisible();
        });
    });

    $(document).on("change", "#wnc_enabled", function () {
        settings.enabled = $(this).is(":checked");
        saveSettingsDebounced();
        if (settings.enabled) {
            colorizeAllVisible();
        } else {
            document.querySelectorAll("#chat span[data-wi-color]").forEach(span => {
                span.replaceWith(document.createTextNode(span.textContent));
            });
        }
    });

    $(document).on("change", "#wnc_default_color", function () {
        settings.defaultColor = $(this).val();
        saveSettingsDebounced();
        buildFromWorldInfo().then(() => {
            renderNameList();
            colorizeAllVisible();
        });
    });

    $(document).on("change", "#wnc_books", function () {
        settings.bookNames = $(this)
            .val()
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
        saveSettingsDebounced();
        buildFromWorldInfo().then(() => {
            renderNameList();
            colorizeAllVisible();
        });
    });

    $(document).on("click", "#wnc_rebuild", async () => {
        await buildFromWorldInfo();
        renderNameList();
        colorizeAllVisible();
    });
}

function injectSettingsPanel() {
    if ($("#wnc_panel").length) return;

    const panel = $(`
        <div id="wnc_panel">
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

                    <label>Standardfärg (om inget annat anges)</label>
                    <input type="color" id="wnc_default_color" value="${settings.defaultColor}">

                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
                        <b>Namn &amp; färger</b>
                        <button id="wnc_rebuild" class="menu_button">Bygg om från World Info</button>
                    </div>
                    <div id="wnc_name_list" style="max-height:300px;overflow-y:auto;margin-top:6px;"></div>
                </div>
            </div>
        </div>
    `);

    $("#extensions_settings2").append(panel);
    renderNameList();
}

// ---------- Live-uppdatering, även under streaming ----------

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

// ---------- Event-lyssnare ----------

const debouncedBuild = debounce(async (bookName) => {
    if (bookName && !settings.bookNames.includes(bookName)) return;
    await buildFromWorldInfo();
    renderNameList();
    colorizeAllVisible();
}, 300);

eventSource.on(eventTypes.APP_READY, async () => {
    injectSettingsPanel();
    bindSettingsEvents();
    setupChatObserver();
    await buildFromWorldInfo();
    renderNameList();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHAT_CHANGED, () => debouncedBuild());
eventSource.on(eventTypes.WORLDINFO_UPDATED, (name) => debouncedBuild(name));

eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);
