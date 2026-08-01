import { getRequestHeaders } from "../../../../script.js";

// ================== INSTÄLLNINGAR ==================
const MODULE_NAME = "wiNameColorizer";
const defaultSettings = {
    enabled: true,
    bookNames: ["MGOT", "GOTLB"],
    defaultColor: "#ffd700",
    entryColors: {},
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

// ---------- Färgkonvertering ----------
function hexToHsl(hex) {
    let r = parseInt(hex.slice(1, 3), 16) / 255;
    let g = parseInt(hex.slice(3, 5), 16) / 255;
    let b = parseInt(hex.slice(5, 7), 16) / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
            case g: h = ((b - r) / d + 2); break;
            case b: h = ((r - g) / d + 4); break;
        }
        h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToHex(h, s, l) {
    h = h / 360; s = s / 100; l = l / 100;
    let r, g, b;
    if (s === 0) { r = g = b = l; } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        let p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    const toHex = (x) => {
        const hex = Math.round(x * 255).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function isValidHex(str) {
    return /^#[0-9a-fA-F]{6}$/.test(str);
}

function rgbToHex(rgb) {
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return '#ffffff';
    return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

// ---------- Markeringsskydd ----------
// Returnerar true om det finns en aktiv (ej kollapsad) textmarkering
// som overlap-par med det givna elementet.
function hasActiveSelection(el) {
    try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
        const range = sel.getRangeAt(0);
        return el.contains(range.startContainer) || el.contains(range.endContainer);
    } catch { return false; }
}

// ---------- Custom Color Picker ----------
const PRESET_COLORS = [
    "#ff4444", "#ff8800", "#ffdd00", "#88ff00",
    "#00ff88", "#00ddff", "#0088ff", "#4400ff",
    "#8800ff", "#ff00aa", "#ff0044", "#ff6688",
    "#ffaa44", "#ffee88", "#aaffaa", "#44ddaa",
    "#66ccff", "#aa88ff", "#ddaaff", "#ff88cc",
    "#ffffff", "#cccccc", "#888888", "#444444",
    "#e74c3c", "#e67e22", "#f1c40f", "#2ecc71",
    "#1abc9c", "#3498db", "#9b59b6", "#e91e63",
];

let activeColorPicker = null;

// ---- Capture-phase interceptor ----
// VIKTIGT: Dessa listeners registreras nu ENDAST när pickern är öppen
// och avregistreras när den stängs. När pickern är stängd körs INGEN
// interceptor alls → noll påverkan på textmarkering/skroll etc.
const INTERCEPT_EVENTS = ['mousedown', 'pointerdown', 'touchstart'];

function colorPickerInterceptor(e) {
    if (!activeColorPicker) return;
    if (activeColorPicker.contains(e.target)) {
        e.stopPropagation();
        return;
    }
    if (!e.target.closest || !e.target.closest('.wnc-color-picker-popup')) {
        closeColorPicker();
    }
}

function registerInterceptor() {
    INTERCEPT_EVENTS.forEach(evt => {
        document.addEventListener(evt, colorPickerInterceptor, true);
    });
}

function unregisterInterceptor() {
    INTERCEPT_EVENTS.forEach(evt => {
        document.removeEventListener(evt, colorPickerInterceptor, true);
    });
}

function closeColorPicker() {
    if (activeColorPicker) {
        activeColorPicker.remove();
        activeColorPicker = null;
        unregisterInterceptor();
    }
}

function openColorPicker(anchorEl, currentColor, onSelect, onReset) {
    closeColorPicker();

    const popup = document.createElement('div');
    popup.className = 'wnc-color-picker-popup';
    popup.style.cssText = `
        position: fixed; z-index: 999999;
        background: var(--SmartThemeBlurTintColor, #1a1a2e);
        border: 1px solid var(--SmartThemeBorderColor, #555);
        border-radius: 8px; padding: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.7);
        width: 240px; font-size: 13px;
        color: var(--SmartThemeBodyColor, #eee);
    `;

    // Palett
    const paletteSection = document.createElement('div');
    paletteSection.style.cssText = 'display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; margin-bottom: 10px;';
    PRESET_COLORS.forEach(color => {
        const swatch = document.createElement('div');
        swatch.style.cssText = `width: 100%; aspect-ratio: 1; background: ${color}; border-radius: 4px; cursor: pointer; border: 1px solid rgba(255,255,255,0.15); transition: transform 0.1s;`;
        swatch.addEventListener('mouseenter', () => swatch.style.transform = 'scale(1.15)');
        swatch.addEventListener('mouseleave', () => swatch.style.transform = 'scale(1)');
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            onSelect(color);
            closeColorPicker();
        });
        paletteSection.appendChild(swatch);
    });
    popup.appendChild(paletteSection);

    const sep1 = document.createElement('hr');
    sep1.style.cssText = 'border: 0; border-top: 1px solid var(--SmartThemeBorderColor, #444); margin: 8px 0;';
    popup.appendChild(sep1);

    // HSL sliders
    let [h, s, l] = hexToHsl(currentColor);
    const sliderContainer = document.createElement('div');
    sliderContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    let hexInput, preview;

    function makeSlider(label, max, getValue, onChange, gradient) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        const lab = document.createElement('span');
        lab.textContent = label;
        lab.style.cssText = 'width: 12px; font-size: 11px; opacity: 0.7;';
        row.appendChild(lab);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = String(max);
        slider.value = String(getValue());
        slider.style.cssText = `flex: 1; height: 16px; -webkit-appearance: none; appearance: none; background: ${gradient}; border-radius: 8px; outline: none; cursor: pointer;`;
        slider.addEventListener('input', (e) => {
            e.stopPropagation();
            onChange(parseInt(slider.value));
            const newColor = hslToHex(h, s, l);
            hexInput.value = newColor;
            preview.style.background = newColor;
        });
        row.appendChild(slider);
        return { row, slider };
    }

    const hueGradient = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)';
    const hueSlider = makeSlider('H', 360, () => h, (v) => { h = v; updateSliders(); }, hueGradient);
    const satSlider = makeSlider('S', 100, () => s, (v) => { s = v; updateSliders(); }, `linear-gradient(to right, hsl(${h},0%,${l}%), hsl(${h},100%,${l}%))`);
    const lightSlider = makeSlider('L', 100, () => l, (v) => { l = v; updateSliders(); }, `linear-gradient(to right, #000, hsl(${h},${s}%,50%), #fff)`);

    function updateSliders() {
        satSlider.slider.style.background = `linear-gradient(to right, hsl(${h},0%,${l}%), hsl(${h},100%,${l}%))`;
        lightSlider.slider.style.background = `linear-gradient(to right, #000, hsl(${h},${s}%,50%), #fff)`;
    }

    sliderContainer.appendChild(hueSlider.row);
    sliderContainer.appendChild(satSlider.row);
    sliderContainer.appendChild(lightSlider.row);
    popup.appendChild(sliderContainer);

    const sep2 = document.createElement('hr');
    sep2.style.cssText = 'border: 0; border-top: 1px solid var(--SmartThemeBorderColor, #444); margin: 8px 0;';
    popup.appendChild(sep2);

    // Hex + preview
    const bottomRow = document.createElement('div');
    bottomRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
    preview = document.createElement('div');
    preview.style.cssText = `width: 28px; height: 28px; border-radius: 4px; background: ${currentColor}; border: 1px solid rgba(255,255,255,0.2); flex-shrink: 0;`;
    bottomRow.appendChild(preview);

    hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.value = currentColor;
    hexInput.maxLength = 7;
    hexInput.style.cssText = `flex: 1; background: var(--SmartThemeBlurTintColor, #222); color: var(--SmartThemeBodyColor, #eee); border: 1px solid var(--SmartThemeBorderColor, #555); border-radius: 4px; padding: 4px 6px; font-size: 12px; font-family: monospace; text-transform: lowercase; outline: none;`;
    hexInput.addEventListener('input', (e) => {
        e.stopPropagation();
        let val = hexInput.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (isValidHex(val)) {
            [h, s, l] = hexToHsl(val);
            hueSlider.slider.value = String(h);
            satSlider.slider.value = String(s);
            lightSlider.slider.value = String(l);
            updateSliders();
            preview.style.background = val;
        }
    });
    hexInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
            let val = hexInput.value.trim();
            if (!val.startsWith('#')) val = '#' + val;
            if (isValidHex(val)) { onSelect(val); closeColorPicker(); }
        }
    });
    bottomRow.appendChild(hexInput);

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '✓';
    confirmBtn.className = 'menu_button';
    confirmBtn.style.cssText = 'padding: 4px 10px; font-size: 14px; flex-shrink: 0;';
    confirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        let val = hexInput.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (isValidHex(val)) { onSelect(val); closeColorPicker(); }
    });
    bottomRow.appendChild(confirmBtn);
    popup.appendChild(bottomRow);

    if (onReset) {
        const resetBtn = document.createElement('button');
        resetBtn.textContent = '↺ Återställ till Default';
        resetBtn.className = 'menu_button';
        resetBtn.style.cssText = 'width: 100%; margin-top: 8px; font-size: 12px; padding: 4px;';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); onReset(); closeColorPicker(); });
        popup.appendChild(resetBtn);
    }

    // ---- Registrera interceptorn FÖRST (innan popupen visas) ----
    registerInterceptor();

    // Append till body
    document.body.appendChild(popup);
    activeColorPicker = popup;

    // Positionera
    const rect = anchorEl.getBoundingClientRect();
    requestAnimationFrame(() => {
        const popupRect = popup.getBoundingClientRect();
        let left = rect.left;
        let top = rect.bottom + 4;
        if (left + popupRect.width > window.innerWidth - 8) {
            left = rect.right - popupRect.width;
        }
        if (left < 8) left = 8;
        if (top + popupRect.height > window.innerHeight - 8) {
            top = rect.top - popupRect.height - 4;
        }
        if (top < 8) top = 8;
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
    });
}

// ---------- Skapa färgknapp ----------
function createColorButton(currentColor, onSelect, onReset) {
    const btn = document.createElement('div');
    btn.className = 'wnc-color-trigger';
    btn.style.cssText = `
        width: 28px;
        height: 28px;
        min-width: 28px;
        min-height: 28px;
        border-radius: 6px;
        background: ${currentColor};
        border: 2px solid rgba(255,255,255,0.3);
        cursor: pointer;
        flex-shrink: 0;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        transition: transform 0.1s, box-shadow 0.1s;
    `;

    btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.15)';
        btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.6)';
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'scale(1)';
        btn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
    });

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const bgColor = btn.style.backgroundColor || btn.style.background || currentColor;
        const hexColor = bgColor.startsWith('rgb') ? rgbToHex(bgColor) : (bgColor.startsWith('#') ? bgColor : currentColor);
        openColorPicker(btn, hexColor,
            (newColor) => {
                btn.style.background = newColor;
                btn.style.backgroundColor = newColor;
                onSelect(newColor);
            },
            () => {
                btn.style.background = settings.defaultColor;
                btn.style.backgroundColor = settings.defaultColor;
                onReset();
            }
        );
    });

    btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.style.background = settings.defaultColor;
        btn.style.backgroundColor = settings.defaultColor;
        onReset();
    });

    let touchTimer = null;
    btn.addEventListener('touchstart', (e) => {
        touchTimer = setTimeout(() => {
            e.preventDefault();
            btn.style.background = settings.defaultColor;
            btn.style.backgroundColor = settings.defaultColor;
            onReset();
        }, 600);
    });
    btn.addEventListener('touchend', () => clearTimeout(touchTimer));
    btn.addEventListener('touchmove', () => clearTimeout(touchTimer));

    return btn;
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
                        .map(k => String(k).trim()).filter(Boolean);
                    if (allKeys.length === 0) continue;
                    const entryId = `${bookName}::${entry.uid}`;
                    for (const key of allKeys) {
                        const namesToAdd = isPlainKey(key) ? [key] : extractNamesFromRegexKey(key);
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
    try { await buildPromise; } finally { buildPromise = null; }
}

function getColor(name) {
    const lower = String(name).toLowerCase();
    const entryId = nameToEntryId.get(lower);
    if (entryId && settings.entryColors[entryId]) return settings.entryColors[entryId];
    return nameToColor.get(lower) || settings.defaultColor;
}

// ---------- Säker färgläggning ----------
function colorizeElement(el) {
    if (!el || !masterRegex || !settings.enabled) return;
    // ⬇️ Hoppa över om användaren håller på att markera text i detta element
    if (hasActiveSelection(el)) return;

    el.querySelectorAll("span[data-wi-color]").forEach(span => {
        span.replaceWith(document.createTextNode(span.textContent));
    });
    el.normalize();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName;
            if (["SCRIPT", "STYLE", "CODE", "PRE", "A"].includes(tag)) return NodeFilter.FILTER_REJECT;
            if (tag === "SPAN") return NodeFilter.FILTER_REJECT;
            if (parent.closest("span:not([data-wi-color])")) return NodeFilter.FILTER_REJECT;
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
    if (select && select.selectedIndex >= 0) {
        const selected = select.options[select.selectedIndex];
        if (selected) return selected.text || selected.value;
    }
    const header = document.querySelector('#world_popup_title') || document.querySelector('.world_info_editor_title');
    if (header) return header.textContent.trim();
    return null;
}

function getEntryUid(entryEl) {
    const uid = entryEl.getAttribute('uid');
    if (uid !== null && uid !== '') return uid;
    const uidData = entryEl.dataset?.uid;
    if (uidData !== undefined && uidData !== '') return uidData;
    const parent = entryEl.closest('[uid]') || entryEl.closest('.world_entry[uid]');
    if (parent) {
        const pUid = parent.getAttribute('uid');
        if (pUid !== null && pUid !== '') return pUid;
    }
    const uidInput = entryEl.querySelector('input[name="uid"], [data-uid]');
    if (uidInput) {
        const val = uidInput.value || uidInput.dataset.uid;
        if (val) return val;
    }
    return null;
}

function findInjectionTarget(entryEl) {
    const selectors = [
        '.WIEnteryHeaderControls',
        '.WIEntryHeaderControls',
        '.world_entry_header_controls',
        '.entry_header_controls',
    ];
    for (const sel of selectors) {
        const el = entryEl.querySelector(sel);
        if (el) return el;
    }
    const stateSelector = entryEl.querySelector('select[name="entryStateSelector"]');
    if (stateSelector?.parentElement) return stateSelector.parentElement;
    const commentField = entryEl.querySelector('textarea[name="comment"]');
    if (commentField?.parentElement) return commentField.parentElement;
    const flexContainer = entryEl.querySelector('.flex-container, .flex');
    if (flexContainer) return flexContainer;
    return entryEl;
}

function injectColorPickerIntoEntry(entryEl) {
    if (!entryEl) return false;
    if (entryEl.querySelector('.wnc-entry-color-wrapper')) return false;

    const uid = getEntryUid(entryEl);
    if (uid === null || uid === undefined || uid === '') return false;

    const bookName = getCurrentEditorBookName();
    if (!bookName) return false;

    const entryId = `${bookName}::${uid}`;
    const currentColor = settings.entryColors[entryId] || settings.defaultColor;

    const targetContainer = findInjectionTarget(entryEl);
    if (!targetContainer) return false;

    const wrapper = document.createElement('div');
    wrapper.className = 'wnc-entry-color-wrapper';
    wrapper.style.cssText = `
        display: flex !important;
        align-items: center !important;
        gap: 4px !important;
        margin-left: 6px !important;
        flex-shrink: 0 !important;
        visibility: visible !important;
        opacity: 1 !important;
    `;

    const label = document.createElement('span');
    label.textContent = '🎨';
    label.title = 'Färg för namn i chatten (klicka = välj, högerklicka = återställ)';
    label.style.cssText = 'font-size: 1em; cursor: help; flex-shrink: 0;';

    const colorBtn = createColorButton(
        currentColor,
        (newColor) => {
            settings.entryColors[entryId] = newColor;
            saveSettingsDebounced();
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
        },
        () => {
            delete settings.entryColors[entryId];
            saveSettingsDebounced();
            colorizeAllVisible();
        }
    );

    wrapper.appendChild(label);
    wrapper.appendChild(colorBtn);
    targetContainer.appendChild(wrapper);
    return true;
}

function scanAndInjectColorPickers() {
    const allEntries = document.querySelectorAll('.world_entry');
    let injected = 0;
    allEntries.forEach(entry => {
        if (injectColorPickerIntoEntry(entry)) injected++;
    });
    if (injected > 0) {
        console.log(`[WI Name Colorizer] Injicerade färgknappar i ${injected} entries.`);
    }
}

function setupWIEditorObserver() {
    const list = document.getElementById('world_popup_entries_list')
        || document.getElementById('world_editor_entries')
        || document.querySelector('.world_info_entries_list')
        || document.querySelector('#WorldInfo .world_info_entries');

    if (list) {
        if (wiEditorObserver) wiEditorObserver.disconnect();
        const debouncedScan = debounce(scanAndInjectColorPickers, 200);
        wiEditorObserver = new MutationObserver(debouncedScan);
        wiEditorObserver.observe(list, {
            childList: true,
            subtree: true,
        });
        scanAndInjectColorPickers();
        return true;
    }
    return false;
}

function setupWIPopupObserver() {
    if (wiPopupObserver) wiPopupObserver.disconnect();
    wiPopupObserver = new MutationObserver(debounce(() => {
        const hasEntries = document.querySelector('.world_entry');
        const wiVisible = document.querySelector('#WorldInfo:not([style*="display: none"])')
            || document.querySelector('#world_popup[style*="display: flex"]')
            || document.querySelector('#world_popup:not([style*="display: none"])');

        if (hasEntries && wiVisible) {
            if (!wiEditorObserver || !wiEditorObserver.isConnected) {
                setupWIEditorObserver();
            }
            scanAndInjectColorPickers();
        }
    }, 300));
    wiPopupObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function updateBooksInputField() {
    const input = document.getElementById('wnc_books');
    if (input) input.value = settings.bookNames.join(', ');
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
                <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
                    <label style="flex:1;">Default-färg</label>
                    <div id="wnc_default_color_holder"></div>
                </div>
                <button id="wnc_rebuild" class="menu_button" style="margin-top:8px;">Bygg om från World Info</button>
                <button id="wnc_rescan" class="menu_button" style="margin-top:4px;">Skanna WI-editor igen</button>
                <div style="margin-top:8px; padding:6px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor); font-size:0.85em; opacity:0.8;">
                    💡 Färgknappar finns direkt i WI-editorn bredvid varje entry.<br>
                    Klicka på 🎨 för att öppna color pickern.<br>
                    Högerklicka / long-press = återställ till Default.<br>
                    Böcker läggs till automatiskt när du sätter en färg.<br><br>
                    <b>Om knappen inte syns:</b> Klicka på "Skanna WI-editor igen".
                </div>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.appendChild(panel);

    const defaultColorHolder = document.getElementById('wnc_default_color_holder');
    const defaultColorBtn = createColorButton(
        settings.defaultColor,
        (newColor) => {
            settings.defaultColor = newColor;
            saveSettingsDebounced();
            for (const key of nameToColor.keys()) {
                nameToColor.set(key, settings.defaultColor);
            }
            colorizeAllVisible();
            document.querySelectorAll('.wnc-entry-color-wrapper').forEach(wrapper => {
                const entryEl = wrapper.closest('.world_entry');
                const uid = getEntryUid(entryEl);
                const bookName = getCurrentEditorBookName();
                if (uid && bookName) {
                    const entryId = `${bookName}::${uid}`;
                    if (!settings.entryColors[entryId]) {
                        const btn = wrapper.querySelector('.wnc-color-trigger');
                        if (btn) {
                            btn.style.background = settings.defaultColor;
                            btn.style.backgroundColor = settings.defaultColor;
                        }
                    }
                }
            });
        },
        () => {}
    );
    defaultColorHolder.appendChild(defaultColorBtn);

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

    document.getElementById("wnc_rebuild")?.addEventListener("click", async () => {
        await buildFromWorldInfo();
        colorizeAllVisible();
        scanAndInjectColorPickers();
    });

    document.getElementById("wnc_rescan")?.addEventListener("click", () => {
        scanAndInjectColorPickers();
    });
}

// ---------- Chat-observer (smart, ej global refresh) ----------
let chatObserver = null;
function setupChatObserver() {
    const chat = document.getElementById("chat");
    if (!chat) return;

    const debouncedRecolor = debounce((mutations) => {
        // ⬇️ Hoppa över helt om användaren markerar text i chatten
        if (hasActiveSelection(chat)) return;

        chatObserver?.disconnect();

        // ⬇️ Färglägg ENDAST tillagda noder, inte hela chatten
        if (mutations) {
            const toColorize = new Set();
            for (const mut of mutations) {
                mut.addedNodes.forEach(node => {
                    if (node.nodeType === 1) {
                        if (node.matches && node.matches('.mes_text')) toColorize.add(node);
                        if (node.querySelectorAll) {
                            node.querySelectorAll('.mes_text').forEach(n => toColorize.add(n));
                        }
                    }
                });
            }
            toColorize.forEach(colorizeElement);
        }

        chatObserver?.observe(chat, { childList: true, subtree: true });
    }, 300);

    chatObserver = new MutationObserver(debouncedRecolor);
    // ⬇️ Enbart childList + subtree. INTE characterData (det triggar för mycket).
    chatObserver.observe(chat, { childList: true, subtree: true });
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

// Backup-skanning: var 2:e sekund i 30 sekunder efter start
let backupScanCount = 0;
const backupScanInterval = setInterval(() => {
    scanAndInjectColorPickers();
    backupScanCount++;
    if (backupScanCount >= 15) clearInterval(backupScanInterval);
}, 2000);
