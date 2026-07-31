import { getRequestHeaders } from "../../../../script.js";

// ========== KONFIGURATION ==========
const BOOK_NAME = "Karaktärsnamn";   // Ändra till namnet på din World Info-bok
const DEFAULT_COLOR = "#b0b0b0";     // Ljusgrått om ingen färg anges
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
    // Hoppa över rena regex-nycklar (börjar och slutar med /)
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

async function buildFromWorldInfo() {
    try {
        const response = await fetch("/api/worldinfo/get", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: BOOK_NAME }),
        });

        if (!response.ok) {
            console.warn(`[WI Name Colorizer] Kunde inte hämta boken "${BOOK_NAME}"`);
            return;
        }

        const data = await response.json();
        const entries = data?.entries ?? {};

        nameToColor.clear();
        const names = [];

        for (const entry of Object.values(entries)) {
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

        if (names.length === 0) {
            masterRegex = null;
            console.log("[WI Name Colorizer] Inga namn hittades.");
            return;
        }

        // Längsta namn först så att "The Crown" matchas före "Crown"
        names.sort((a, b) => b.length - a.length);

        const escaped = names.map(n =>
            n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        );

        masterRegex = new RegExp(
            `\\b(${escaped.join("|")})(['’]s?)?(?!\\w)`,
            "gi"
        );

        console.log(`[WI Name Colorizer] Byggde regex med ${names.length} namn.`);
    } catch (err) {
        console.error("[WI Name Colorizer] Fel:", err);
    }
}

function getColor(name) {
    return nameToColor.get(String(name).toLowerCase()) || DEFAULT_COLOR;
}

function colorizeElement(el) {
    if (!el || !masterRegex) return;

    // Ta bort tidigare färgmarkeringar för att undvika nästlade span
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

// Uppdatera automatiskt när World Info ändras
eventSource.on(eventTypes.WORLDINFO_UPDATED, async () => {
    await buildFromWorldInfo();
    colorizeAllVisible();
});

eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);

// Kör en gång direkt
buildFromWorldInfo().then(colorizeAllVisible);