function isPlainKey(key) {
    const k = String(key).trim();
    return k && !(k.startsWith("/") && k.lastIndexOf("/") > 0);
}

function extractNamesFromRegexKey(key) {
    const k = String(key).trim();
    // Försök hitta en alternation-grupp: (Name1|Name2|Name3)
    const match = k.match(/\(([^)]+)\)/);
    if (!match) return [];

    return match[1]
        .split("|")
        .map(s => s.trim())
        .filter(s => s && !s.includes("\\") && !s.includes("[") && s.length > 1);
}

// Inuti buildFromWorldInfo(), byt ut nyckel-loopen mot detta:
for (const raw of allKeys) {
    const key = String(raw).trim();
    if (!key) continue;

    let namesToAdd = [];

    if (isPlainKey(key)) {
        namesToAdd = [key];
    } else {
        // Det är en regex → försök extrahera namnen
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
