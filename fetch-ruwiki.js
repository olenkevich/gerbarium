#!/usr/bin/env node
/**
 * Fetches coats of arms from two Russian Wikipedia sources:
 *  1. Категория:Гербы_городов_России  — 430 Russian city coat-of-arms articles
 *  2. Гербы_субъектов_Российской_Федерации — top-level emblems of 85 federal subjects
 *
 * Merges new entries into existing data/catalog.json without re-downloading.
 * Usage: node fetch-ruwiki.js
 */

import { readFileSync, writeFileSync } from "fs";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const RU_API      = "https://ru.wikipedia.org/w/api.php";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiGet(endpoint, params, retries = 3) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...params, format: "json", origin: "*" });
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(4000 * attempt);
    try {
      const res = await fetch(url);
      return JSON.parse(await res.text());
    } catch { if (attempt === retries - 1) throw new Error(`Failed: ${url}`); }
  }
}

// Get all pages in a category (follows cmcontinue)
async function getCategoryPages(title) {
  const pages = [];
  let cont;
  do {
    const data = await apiGet(RU_API, {
      action: "query", list: "categorymembers",
      cmtitle: title, cmtype: "page", cmlimit: "500",
      ...(cont ? { cmcontinue: cont } : {}),
    });
    pages.push(...(data.query?.categorymembers ?? []));
    cont = data.continue?.cmcontinue;
  } while (cont);
  return pages;
}

// Get all images for a batch of article titles (ru.wikipedia)
// Normalizes "Файл:" → "File:" so Commons lookups work
async function getArticleImages(titles) {
  const data = await apiGet(RU_API, {
    action: "query", prop: "images",
    titles: titles.join("|"), imlimit: "50",
  });
  const result = {};
  for (const page of Object.values(data.query?.pages ?? {})) {
    result[page.title] = (page.images ?? []).map(i =>
      i.title.replace(/^Файл:/i, "File:")
    );
  }
  return result;
}

// Get imageinfo (url + size) for a batch of file titles from Commons
async function getCommonsInfo(fileTitles) {
  if (!fileTitles.length) return {};
  const data = await apiGet(COMMONS_API, {
    action: "query", titles: fileTitles.join("|"),
    prop: "imageinfo", iiprop: "url|size",
  });
  const result = {};
  for (const page of Object.values(data.query?.pages ?? {})) {
    if (page.imageinfo?.[0]?.url) {
      result[page.title] = {
        title: page.title,
        url:    page.imageinfo[0].url,
        width:  page.imageinfo[0].width ?? 0,
        height: page.imageinfo[0].height ?? 0,
        ext:    page.title.split(".").pop().toLowerCase(),
      };
    }
  }
  return result;
}

// ── Image selection ───────────────────────────────────────────────────────────

const EXCLUDE = /(\b18\d\d\b|\b19[0-7]\d\b|soviet|ussr|gorky|stamp|badge|coin|fictional|proposal|sketch|old|draft|blason|armoiries|wappen|герб.*\d{4}|Image-silk|^Images\.|silk\.png|placeholder)/i;
const JUNK    = /commons|logo|icon|wiki|интервики|gear|Images\.png|Image-silk/i;

function pickBest(infos) {
  const clean = infos.filter(f => f && f.url && !EXCLUDE.test(f.title));
  if (!clean.length) return null;
  const svgs = clean.filter(f => f.ext === "svg");
  if (svgs.length) return svgs.sort((a, b) => b.width - a.width)[0];
  const pngs = clean.filter(f => f.ext === "png" && f.width >= 200 && f.height >= 200);
  if (pngs.length) return pngs.sort((a, b) => b.width - a.width)[0];
  return null;
}

// ── Name / region extraction ──────────────────────────────────────────────────

// From Commons image filename → English city/subject name
function extractName(fileTitle) {
  // Strip "Файл:" or "File:" prefix
  const t = fileTitle.replace(/^(?:Файл|File):/i, "").replace(/_/g, " ");
  // "Coat of Arms of Azov.svg", "Coat of Arms of Aldan (Yakutia).png"
  let m = t.match(/Coat\s+of\s+[Aa]rms?\s+of\s+(.+?)(?:\s*\(|\.\w+$)/i);
  if (m) return m[1].trim();
  m = t.match(/Coat\s+of\s+[Aa]rms?\s+of\s+(.+)/i);
  if (m) return m[1].replace(/\.\w+$/, "").trim();
  // "CoA of Abakan.svg"
  m = t.match(/CoA\s+of\s+(.+?)(?:\s*\(|\.\w+$)/i);
  if (m) return m[1].trim();
  return null;
}

// From Commons image filename → region hint (if present in parentheses)
function extractRegionHint(fileTitle) {
  const t = fileTitle.replace(/^(?:Файл|File):/i, "").replace(/_/g, " ");
  const m = t.match(/\(([^)]+)\)/);
  if (!m) return null;
  const hint = m[1].trim();
  if (/^\d{4}$/.test(hint)) return null; // skip bare year hints
  return hint;
}

// Map English region hint (from filenames) → canonical parent name
const EN_REGION_MAP = {
  "Yakutia":                    "Sakha Republic",
  "Sakha":                      "Sakha Republic",
  "Chukotka":                   "Chukotka Autonomous Okrug",
  "Chukotka AO":                "Chukotka Autonomous Okrug",
  "Murmansk oblast":            "Murmansk Oblast",
  "Murmansk Oblast":            "Murmansk Oblast",
  "Krasnodar krai":             "Krasnodar Krai",
  "Krasnodar Krai":             "Krasnodar Krai",
  "Krasnoyarsk krai":           "Krasnoyarsk Krai",
  "Krasnoyarsk Krai":           "Krasnoyarsk Krai",
  "Khakassia":                  "Republic of Khakassia",
  "Tatarstan":                  "Republic of Tatarstan",
  "Bashkortostan":              "Republic of Bashkortostan",
  "Buryatia":                   "Republic of Buryatia",
  "Kalmykia":                   "Republic of Kalmykia",
  "Mordovia":                   "Republic of Mordovia",
  "Ingushetia":                 "Republic of Ingushetia",
  "Adygea":                     "Republic of Adygea",
  "Kabardino-Balkaria":         "Kabardino-Balkar Republic",
  "Karachay-Cherkessia":        "Karachay-Cherkess Republic",
  "North Ossetia":              "Republic of North Ossetia–Alania",
  "Chechnya":                   "Chechen Republic",
  "Karelia":                    "Republic of Karelia",
  "Komi":                       "Komi Republic",
  "Udmurtia":                   "Udmurt Republic",
  "Mari El":                    "Mari El Republic",
  "Chuvashia":                  "Chuvash Republic",
  "Dagestan":                   "Republic of Dagestan",
  "Altai Republic":             "Republic of Altai",
  "Altai Krai":                 "Altai Krai",
  "Primorsky krai":             "Primorsky Krai",
  "Primorsky Krai":             "Primorsky Krai",
  "Khabarovsk Krai":            "Khabarovsk Krai",
  "Stavropol krai":             "Stavropol Krai",
  "Stavropol Krai":             "Stavropol Krai",
  "Perm krai":                  "Perm Krai",
  "Perm Krai":                  "Perm Krai",
  "Zabaykalsky Krai":           "Zabaykalsky Krai",
  "Kamchatka":                  "Kamchatka Krai",
  "Sverdlovsk oblast":          "Sverdlovsk Oblast",
  "Sverdlovsk Oblast":          "Sverdlovsk Oblast",
  "Nizhny Novgorod oblast":     "Nizhny Novgorod Oblast",
  "Nizhny Novgorod Oblast":     "Nizhny Novgorod Oblast",
  "Moscow Oblast":              "Moscow Oblast",
  "Moscow oblast":              "Moscow Oblast",
  "Leningrad Oblast":           "Leningrad Oblast",
  "Leningrad oblast":           "Leningrad Oblast",
  "Vladimir Oblast":            "Vladimir Oblast",
  "Vladimir oblast":            "Vladimir Oblast",
  "Chelyabinsk oblast":         "Chelyabinsk Oblast",
  "Chelyabinsk Oblast":         "Chelyabinsk Oblast",
  "Yaroslavl Oblast":           "Yaroslavl Oblast",
  "Yaroslavl oblast":           "Yaroslavl Oblast",
  "Orenburg Oblast":            "Orenburg Oblast",
  "Saratov Oblast":             "Saratov Oblast",
  "Volgograd Oblast":           "Volgograd Oblast",
  "Ivanovo Oblast":             "Ivanovo Oblast",
  "Tver Oblast":                "Tver Oblast",
  "Tver oblast":                "Tver Oblast",
  "Kirov Oblast":               "Kirov Oblast",
  "Kostroma Oblast":            "Kostroma Oblast",
  "Ryazan Oblast":              "Ryazan Oblast",
  "Kursk Oblast":               "Kursk Oblast",
  "Voronezh Oblast":            "Voronezh Oblast",
  "Belgorod Oblast":            "Belgorod Oblast",
  "Lipetsk Oblast":             "Lipetsk Oblast",
  "Tula Oblast":                "Tula Oblast",
  "Bryansk Oblast":             "Bryansk Oblast",
  "Smolensk Oblast":            "Smolensk Oblast",
  "Kaluga Oblast":              "Kaluga Oblast",
  "Oryol Oblast":               "Orel Oblast",
  "Orel Oblast":                "Orel Oblast",
  "Tambov Oblast":              "Tambov Oblast",
  "Penza Oblast":               "Penza Oblast",
  "Ulyanovsk Oblast":           "Ulyanovsk Oblast",
  "Samara Oblast":              "Samara Oblast",
  "Astrakhan Oblast":           "Astrakhan Oblast",
  "Rostov Oblast":              "Rostov Oblast",
  "Vologda Oblast":             "Vologda Oblast",
  "Arkhangelsk Oblast":         "Arkhangelsk Oblast",
  "Arkhangelsk oblast":         "Arkhangelsk Oblast",
  "Novgorod Oblast":            "Novgorod Oblast",
  "Pskov Oblast":               "Pskov Oblast",
  "Kaliningrad Oblast":         "Kaliningrad Oblast",
  "Tyumen Oblast":              "Tyumen Oblast",
  "Omsk Oblast":                "Omsk Oblast",
  "Tomsk Oblast":               "Tomsk Oblast",
  "Novosibirsk Oblast":         "Novosibirsk Oblast",
  "Kemerovo Oblast":            "Kemerovo Oblast",
  "Irkutsk Oblast":             "Irkutsk Oblast",
  "Amur Oblast":                "Amur Oblast",
  "Magadan Oblast":             "Magadan Oblast",
  "Sakhalin":                   "Sakhalin Oblast",
  "Yamalo-Nenets":              "Yamalo-Nenets Autonomous Okrug",
  "Khanty-Mansia":              "Khanty-Mansi Autonomous Okrug",
  "Khanty-Mansiysk":            "Khanty-Mansi Autonomous Okrug",
  "Jewish Autonomous Oblast":   "Jewish Autonomous Oblast",
  "Zabaykalsky":                "Zabaykalsky Krai",
  "Kurgan Oblast":              "Kurgan Oblast",
};

// Map Russian region name (from article title disambiguation) → canonical English
const RU_REGION_MAP = {
  "Амурская область":       "Amur Oblast",
  "Архангельская область":  "Arkhangelsk Oblast",
  "Белгородская область":   "Belgorod Oblast",
  "Брянская область":       "Bryansk Oblast",
  "Владимирская область":   "Vladimir Oblast",
  "Калужская область":      "Kaluga Oblast",
  "Кировская область":      "Kirov Oblast",
  "Красноярский край":      "Krasnoyarsk Krai",
  "Мирнинский район":       "Sakha Republic",
  "Московская область":     "Moscow Oblast",
  "Россия":                 "Russia",
  "Свердловская область":   "Sverdlovsk Oblast",
  "Ставропольский край":    "Stavropol Krai",
  "Татарстан":              "Republic of Tatarstan",
  "Тульская область":       "Tula Oblast",
};

// Canonical name map for federal subjects (from image name fragment → catalog name)
const SUBJECT_CANONICAL = {
  "Altai Krai":              { name: "Altai Krai",                         type: "krai" },
  "Altai Republic":          { name: "Republic of Altai",                  type: "republic" },
  "Amur Oblast":             { name: "Amur Oblast",                        type: "oblast" },
  "Arkhangelsk oblast":      { name: "Arkhangelsk Oblast",                 type: "oblast" },
  "Arkhangelsk Oblast":      { name: "Arkhangelsk Oblast",                 type: "oblast" },
  "Astrakhan Oblast":        { name: "Astrakhan Oblast",                   type: "oblast" },
  "Bashkortostan":           { name: "Republic of Bashkortostan",          type: "republic" },
  "Belgorod Oblast":         { name: "Belgorod Oblast",                    type: "oblast" },
  "Bryansk Oblast":          { name: "Bryansk Oblast",                     type: "oblast" },
  "Buryatia":                { name: "Republic of Buryatia",               type: "republic" },
  "Chelyabinsk Oblast":      { name: "Chelyabinsk Oblast",                 type: "oblast" },
  "Chukotka":                { name: "Chukotka Autonomous Okrug",          type: "autonomous_okrug" },
  "Chuvashia":               { name: "Chuvash Republic",                   type: "republic" },
  "Dagestan":                { name: "Republic of Dagestan",               type: "republic" },
  "Ingushetia":              { name: "Republic of Ingushetia",             type: "republic" },
  "Ivanovo Oblast":          { name: "Ivanovo Oblast",                     type: "oblast" },
  "Kabardino-Balkaria":      { name: "Kabardino-Balkar Republic",          type: "republic" },
  "Kaliningrad Oblast":      { name: "Kaliningrad Oblast",                 type: "oblast" },
  "Kalmykia":                { name: "Republic of Kalmykia",               type: "republic" },
  "Kamchatka Krai":          { name: "Kamchatka Krai",                     type: "krai" },
  "Karachay-Cherkessia":     { name: "Karachay-Cherkess Republic",         type: "republic" },
  "Kemerovo Oblast":         { name: "Kemerovo Oblast",                    type: "oblast" },
  "Khabarovsk Krai":         { name: "Khabarovsk Krai",                    type: "krai" },
  "Khakassia":               { name: "Republic of Khakassia",              type: "republic" },
  "Kirov Region":            { name: "Kirov Oblast",                       type: "oblast" },
  "Komi Republic":           { name: "Komi Republic",                      type: "republic" },
  "Kostroma Oblast":         { name: "Kostroma Oblast",                    type: "oblast" },
  "Krasnodar Krai":          { name: "Krasnodar Krai",                     type: "krai" },
  "Krasnoyarsk Krai":        { name: "Krasnoyarsk Krai",                   type: "krai" },
  "Kurgan Oblast":           { name: "Kurgan Oblast",                      type: "oblast" },
  "Kursk oblast":            { name: "Kursk Oblast",                       type: "oblast" },
  "Leningrad Oblast":        { name: "Leningrad Oblast",                   type: "oblast" },
  "Lipetsk oblast":          { name: "Lipetsk Oblast",                     type: "oblast" },
  "Magadan oblast":          { name: "Magadan Oblast",                     type: "oblast" },
  "Mari El":                 { name: "Mari El Republic",                   type: "republic" },
  "Mordovia":                { name: "Republic of Mordovia",               type: "republic" },
  "Moscow Oblast":           { name: "Moscow Oblast",                      type: "oblast" },
  "Nenets Autonomous Okrug": { name: "Nenets Autonomous Okrug",            type: "autonomous_okrug" },
  "Nizhny Novgorod Region":  { name: "Nizhny Novgorod Oblast",             type: "oblast" },
  "Novgorod Oblast":         { name: "Novgorod Oblast",                    type: "oblast" },
  "Novosibirsk oblast":      { name: "Novosibirsk Oblast",                 type: "oblast" },
  "Omsk Oblast":             { name: "Omsk Oblast",                        type: "oblast" },
  "Orenburg Oblast":         { name: "Orenburg Oblast",                    type: "oblast" },
  "Oryol Oblast":            { name: "Orel Oblast",                        type: "oblast" },
  "Penza Oblast":            { name: "Penza Oblast",                       type: "oblast" },
  "Perm Krai":               { name: "Perm Krai",                          type: "krai" },
  "Primorsky Krai":          { name: "Primorsky Krai",                     type: "krai" },
  "Pskov Oblast":            { name: "Pskov Oblast",                       type: "oblast" },
  "Rostov Oblast":           { name: "Rostov Oblast",                      type: "oblast" },
  "Ryazan Oblast":           { name: "Ryazan Oblast",                      type: "oblast" },
  "Sakha (Yakutia)":         { name: "Sakha Republic",                     type: "republic" },
  "Sakhalin Oblast":         { name: "Sakhalin Oblast",                    type: "oblast" },
  "Samara Oblast":           { name: "Samara Oblast",                      type: "oblast" },
  "Saratov oblast":          { name: "Saratov Oblast",                     type: "oblast" },
  "Smolensk oblast":         { name: "Smolensk Oblast",                    type: "oblast" },
  "Stavropol Krai":          { name: "Stavropol Krai",                     type: "krai" },
  "Sverdlovsk oblast":       { name: "Sverdlovsk Oblast",                  type: "oblast" },
  "Tambov Oblast":           { name: "Tambov Oblast",                      type: "oblast" },
  "Tatarstan":               { name: "Republic of Tatarstan",              type: "republic" },
  "Tomsk Oblast, Russia":    { name: "Tomsk Oblast",                       type: "oblast" },
  "Tula oblast":             { name: "Tula Oblast",                        type: "oblast" },
  "Tuva":                    { name: "Tuva Republic",                      type: "republic" },
  "Tver oblast":             { name: "Tver Oblast",                        type: "oblast" },
  "Tyumen Oblast":           { name: "Tyumen Oblast",                      type: "oblast" },
  "Udmurtia":                { name: "Udmurt Republic",                    type: "republic" },
  "Ulyanovsk Oblast":        { name: "Ulyanovsk Oblast",                   type: "oblast" },
  "Vladimiri Oblast":        { name: "Vladimir Oblast",                    type: "oblast" },
  "Volgograd oblast":        { name: "Volgograd Oblast",                   type: "oblast" },
  "Vologda oblast":          { name: "Vologda Oblast",                     type: "oblast" },
  "Voronezh Oblast":         { name: "Voronezh Oblast",                    type: "oblast" },
  "Yaroslavl Oblast":        { name: "Yaroslavl Oblast",                   type: "oblast" },
  "Yamal Nenetsia":          { name: "Yamalo-Nenets Autonomous Okrug",     type: "autonomous_okrug" },
  "Yugra (Khanty-Mansia)":   { name: "Khanty-Mansi Autonomous Okrug",     type: "autonomous_okrug" },
  "Zabaykalsky Krai":        { name: "Zabaykalsky Krai",                   type: "krai" },
  "Karelia":                 { name: "Republic of Karelia",                type: "republic" },
  "Jewish Autonomous Oblast":{ name: "Jewish Autonomous Oblast",           type: "autonomous_oblast" },
  "North Ossetia":           { name: "Republic of North Ossetia–Alania",  type: "republic" },
  "Adygea":                  { name: "Republic of Adygea",                 type: "republic" },
  "Ingushetia":              { name: "Republic of Ingushetia",             type: "republic" },
};

function inferParentType(parent) {
  if (parent === "Russia") return "country";
  if (parent === "Moscow" || parent === "Saint Petersburg") return "federal_city";
  if (/\bkrai\b/i.test(parent)) return "krai";
  if (/autonomous okrug/i.test(parent)) return "autonomous_okrug";
  if (/autonomous oblast/i.test(parent)) return "autonomous_oblast";
  if (/\boblast\b/i.test(parent)) return "oblast";
  if (/republic|tatarstan|bashkortostan|udmurt|chuvash|mordov|ingushet|adygea|buryatia|khakass|dagestan|kabardino|karelia|\bkomi\b|mari|kalmyk|karachay|altai repub|tuva/i.test(parent)) return "republic";
  return "oblast";
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const existing = JSON.parse(readFileSync("data/catalog.json", "utf8"));
  const existingKeys = new Set(existing.map(e => `${e.name}|${e.parent}`));
  // Also deduplicate by name alone for city-level (different regions may share names)
  const existingNames = new Set(existing.map(e => e.name.toLowerCase()));
  console.log(`Existing catalog: ${existing.length} entries\n`);

  const newEntries = [];

  // ── PART 1: Federal Subjects ──────────────────────────────────────────────
  console.log("── Federal subjects (Гербы субъектов РФ) ──");
  const subjectArticle = "Гербы_субъектов_Российской_Федерации";
  const subjectData = await apiGet(RU_API, {
    action: "query", prop: "images",
    titles: subjectArticle, imlimit: "500",
  });
  const subjectPage = Object.values(subjectData.query?.pages ?? {})[0];
  const subjectFiles = (subjectPage?.images ?? [])
    .map(i => i.title.replace(/^Файл:/i, "File:"))
    .filter(t => /coat|arms|COA|герб/i.test(t) && !JUNK.test(t));

  // Resolve URLs for all subject images at once
  const subjectInfoMap = {};
  for (let i = 0; i < subjectFiles.length; i += 50) {
    await sleep(500);
    Object.assign(subjectInfoMap, await getCommonsInfo(subjectFiles.slice(i, i + 50)));
  }

  let subjectAdded = 0;
  for (const fileTitle of subjectFiles) {
    const info = subjectInfoMap[fileTitle];
    if (!info || EXCLUDE.test(fileTitle)) continue;
    const rawName = extractName(fileTitle);
    if (!rawName) continue;
    const canon = SUBJECT_CANONICAL[rawName];
    if (!canon) continue;
    const key = `${canon.name}|Russia`;
    if (existingKeys.has(key)) continue;
    newEntries.push({
      name: canon.name,
      admin_type: canon.type,
      parent: "Russia",
      parent_type: "country",
      country: "Russia",
      image_url: info.url,
      image_format: info.ext,
    });
    existingKeys.add(key);
    subjectAdded++;
  }
  console.log(`✓ ${subjectAdded} new federal subject emblems\n`);

  // ── PART 2: City coat-of-arms articles ───────────────────────────────────
  console.log("── City coat-of-arms articles (Гербы городов России) ──");
  const cityPages = await getCategoryPages("Категория:Гербы_городов_России");
  console.log(`Found ${cityPages.length} articles`);

  // Batch-fetch all images for all articles
  const articleImageMap = {};  // articleTitle → [fileTitle, ...]
  for (let i = 0; i < cityPages.length; i += 50) {
    await sleep(800);
    const batch = cityPages.slice(i, i + 50).map(p => p.title);
    const batchResult = await getArticleImages(batch);
    Object.assign(articleImageMap, batchResult);
    process.stdout.write(`  Fetched article images ${Math.min(i + 50, cityPages.length)}/${cityPages.length}\r`);
  }
  console.log();

  // Collect all unique candidate file titles
  const allCandidates = new Set();
  for (const [articleTitle, files] of Object.entries(articleImageMap)) {
    for (const f of files) {
      if (!JUNK.test(f)) allCandidates.add(f);
    }
  }
  console.log(`Resolving ${allCandidates.size} candidate images via Commons…`);

  // Resolve all candidate image URLs from Commons
  const commonsInfoMap = {};
  const candidateArr = [...allCandidates];
  for (let i = 0; i < candidateArr.length; i += 50) {
    await sleep(600);
    Object.assign(commonsInfoMap, await getCommonsInfo(candidateArr.slice(i, i + 50)));
    process.stdout.write(`  Resolved ${Math.min(i + 50, candidateArr.length)}/${candidateArr.length}\r`);
  }
  console.log();

  // Process each article
  let cityAdded = 0, skipped = 0, noImage = 0, noName = 0;
  for (const page of cityPages) {
    const articleTitle = page.title;
    const files = (articleImageMap[articleTitle] ?? []).filter(f => !JUNK.test(f));

    // Resolve to imageinfo objects
    const infos = files.map(f => commonsInfoMap[f]).filter(Boolean);
    const best = pickBest(infos);
    if (!best) { noImage++; continue; }

    // Extract English name from image filename
    const name = extractName(best.title);
    if (!name || name.length < 2) { noName++; continue; }

    // Extract parent region
    // 1. From article title parenthetical (Russian)
    let parent = null;
    const ruMatch = articleTitle.match(/\(([^)]+)\)/);
    if (ruMatch) parent = RU_REGION_MAP[ruMatch[1]] ?? null;

    // 2. From image filename parenthetical (English region hint)
    if (!parent) {
      const hint = extractRegionHint(best.title);
      if (hint) parent = EN_REGION_MAP[hint] ?? null;
    }

    // 3. Fallback: "Russia" (city-level, unknown region)
    if (!parent) parent = "Russia";

    const key = `${name}|${parent}`;
    if (existingKeys.has(key)) { skipped++; continue; }
    // Also skip if name (lowercase) already in catalog to avoid near-duplicates
    if (existingNames.has(name.toLowerCase()) && parent === "Russia") { skipped++; continue; }

    newEntries.push({
      name,
      admin_type: "city",
      parent,
      parent_type: inferParentType(parent),
      country: "Russia",
      image_url: best.url,
      image_format: best.ext,
    });
    existingKeys.add(key);
    existingNames.add(name.toLowerCase());
    cityAdded++;
  }

  console.log(`✓ ${cityAdded} new cities added (${skipped} already in catalog, ${noImage} no image, ${noName} no name)\n`);

  // ── Write catalog ─────────────────────────────────────────────────────────
  if (!newEntries.length) { console.log("No new entries."); return; }

  const merged = [...existing, ...newEntries];
  writeFileSync("data/catalog.json", JSON.stringify(merged, null, 2));
  console.log(`✓ Added ${newEntries.length} entries → catalog now has ${merged.length} total`);

  const byParent = {};
  newEntries.forEach(e => { byParent[e.parent] = (byParent[e.parent] ?? 0) + 1; });
  Object.entries(byParent).sort(([,a],[,b]) => b-a).slice(0, 20).forEach(([p,n]) => console.log(`  ${p}: +${n}`));
}

main().catch(e => { console.error(e); process.exit(1); });
