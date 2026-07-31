import { getRequestHeaders } from "../../../../script.js";

// ========== KONFIGURATION ==========
const DEFAULT_COLOR = "#b0b0b0";   // Ljusgrått om ingen färg anges
// ===================================

const nameToColor = new Map(); // lowercase name → color
let masterRegex = null;

function extractColor(comment) {
    if (!comment) return DEFAULT_COLOR;
    const match = String(comment).match(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
    return match ? `#${match[1]}` : DEFAULT_COLOR;
}

function isPlainKey(key) {
    const k = String(key).trim();
    // Hoppa över rena regex-nycklar
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

async function getActiveBookNames() {
    try {
        // Försök hämta listan över valda/globala böcker
        const response = await fetch("/api/settings/get", {
            method: "POST",
            headers: getRequestHeaders(),
        });

        if (!response.ok) return [];

        const data = await response.json();
        // selected_world_info finns i de flesta versioner
        const selected = data?.selected_world_info ?? data?.world_info?.selected ?? [];
        return Array.isArray(selected) ? selected.filter(Boolean) : [];
    } catch (err) {
        console.warn("[WI Name Colorizer] Kunde inte hämta aktiva böcker:", err);
        return [];
    }
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

async function buildFromWorldInfo() {
    try {
        const bookNames = await getActiveBookNames();

        if (bookNames.length === 0) {
            console.log("[WI Name Colorizer] Inga aktiva World Info-böcker hittades.");
            masterRegex = null;
            return;
        }

        console.log("[WI Name Colorizer] Aktiva böcker:", bookNames.join(", "));

        nameToColor.clear();
        const names = [];

        for (const bookName of bookNames) {
            const data = await loadBook(bookName);
            if (!data?.entries) continue;

            for (const entry of Object.values(data.entries)) {
                if (entry.disable) continue;

                const color = extractColor(entry.comment);
                const allKeys = [...(entry.key ?? []), ...(entry.keysecondary ?? [])];

                for (const raw of allKeys) {
                    if (!isPlainKey(raw)) continue;
                    const name = String(raw).trim();
                    if (!name) continue;

                    const lower = name.toLowerCase();
                    if (!nameToColor.has(lower)) {
                        nameToColor.set(lower, color);
                        names.push(name);
                    }
                }
            }
        }

        if (names.length === 0) {
            masterRegex = null;
            console.log("[WI Name Colorizer] Inga namn hittades i de aktiva böckerna.");
            return;
        }

        // Längsta namn först
        names.sort((a, b) => b.length - a.length);

        const escaped = names.map(n =>
            n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        );

        masterRegex = new RegExp(
            `\\b(${escaped.join("|")})(['’]s?)?(?!\\w)`,
            "gi"
        );

        console.log(`[WI Name Colorizer] Byggde regex med ${names.length} namn från ${bookNames.length} bok(ar).`);
    } catch (err) {
        console.error("[WI Name Colorizer] Fel:", err);
    }
}

function getColor(name) {
    return nameToColor.get(String(name).toLowerCase()) || DEFAULT_COLOR;
}

function colorizeElement(el) {
    if (!el || !masterRegex) return;

    // Ta bort tidigare färgmarkeringar
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

// ========== Event-lyssnare ==========
const context = SillyTavern.getContext();
const { eventSource, eventTypes } = context;

eventSource.on(eventTypes.APP_READY, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHAT_CHANGED, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.WORLDINFO_UPDATED, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

// Kör en gång direkt
buildFromWorldInfo().then(colorizeAllVisible);
