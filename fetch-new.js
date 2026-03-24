#!/usr/bin/env node
/**
 * Fetches ONLY the missing regions and merges them into the existing catalog.json.
 * Does NOT re-fetch already-cataloged regions.
 * Falls back to Commons search and then Russian Wikipedia for missing/low-res images.
 *
 * Usage: node fetch-new.js
 */

import { readFileSync, writeFileSync } from "fs";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const RU_API      = "https://ru.wikipedia.org/w/api.php";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(endpoint, params, retries = 3) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...params, format: "json", origin: "*" });
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(4000 * attempt);
    const res = await fetch(url);
    const text = await res.text();
    try { return JSON.parse(text); } catch {
      if (attempt === retries - 1) throw new Error(`Non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

async function getFiles(category) {
  const files = [];
  let cont;
  do {
    const data = await apiGet(COMMONS_API, {
      action: "query", list: "categorymembers",
      cmtitle: `Category:${category}`, cmtype: "file", cmlimit: "500",
      ...(cont ? { cmcontinue: cont } : {}),
    });
    files.push(...(data.query?.categorymembers ?? []).map(f => f.title));
    cont = data.continue?.cmcontinue;
  } while (cont);
  return files;
}

async function getImageInfo(titles) {
  const data = await apiGet(COMMONS_API, {
    action: "query", titles: titles.join("|"),
    prop: "imageinfo", iiprop: "url|size",
  });
  return Object.values(data.query?.pages ?? {}).map(p => ({
    title: p.title,
    url: p.imageinfo?.[0]?.url ?? null,
    width: p.imageinfo?.[0]?.width ?? null,
    height: p.imageinfo?.[0]?.height ?? null,
    ext: p.title.split(".").pop().toLowerCase(),
  }));
}

async function fetchInfoBatched(titles) {
  const results = [];
  for (let i = 0; i < titles.length; i += 50)
    results.push(...await getImageInfo(titles.slice(i, i + 50)));
  return results;
}

const MIN_PX = 300;
const EXCLUDE = /(\b18\d\d\b|\b19[0-7]\d\b|soviet|ussr|gorky|stamp|badge|coin|fictional|proposal|sketch|old|draft|blason|armoiries|wappen|герб.*\d{4})/i;

function pickBest(infos) {
  const clean = infos.filter(f => f.url && !EXCLUDE.test(f.title));
  if (!clean.length) return null;
  const svgs = clean.filter(f => f.ext === "svg");
  if (svgs.length) return svgs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const pngs = clean.filter(f => f.ext === "png" && (f.width ?? 0) >= MIN_PX && (f.height ?? 0) >= MIN_PX);
  if (pngs.length) return pngs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return null;
}

// Fallback 1: Commons full-text search for coat of arms by name
async function searchCommons(name, region) {
  const query = `coat of arms ${name} ${region}`;
  const data = await apiGet(COMMONS_API, {
    action: "query", generator: "search",
    gsrnamespace: "6", gsrsearch: query, gsrlimit: "20",
    prop: "imageinfo", iiprop: "url|size",
  });
  const infos = Object.values(data.query?.pages ?? {}).map(p => ({
    title: p.title ?? "",
    url: p.imageinfo?.[0]?.url ?? null,
    width: p.imageinfo?.[0]?.width ?? null,
    height: p.imageinfo?.[0]?.height ?? null,
    ext: (p.title ?? "").split(".").pop().toLowerCase(),
  }));
  return pickBest(infos);
}

// Fallback 2: Russian Wikipedia – get the main image for a district/city article
async function searchRuWiki(name, region) {
  // Try common patterns for Russian Wikipedia article titles
  const candidates = [
    `${name} (${region})`,
    `${name}, ${region}`,
    name,
  ];
  for (const title of candidates) {
    const data = await apiGet(RU_API, {
      action: "query", titles: title,
      prop: "images", imlimit: "10",
    });
    const page = Object.values(data.query?.pages ?? {})[0];
    if (!page || page.missing !== undefined) continue;
    const images = (page.images ?? [])
      .map(i => i.title)
      .filter(t => /coat|arms|герб/i.test(t) && !EXCLUDE.test(t));
    if (!images.length) continue;
    // Resolve these Commons file titles to URLs
    const infos = await getImageInfo(images);
    const best = pickBest(infos);
    if (best) return best;
  }
  return null;
}

function inferParentType(parent) {
  if (parent === "Russia") return "country";
  if (parent === "Moscow" || parent === "Saint Petersburg") return "federal_city";
  if (/\bkrai\b/i.test(parent)) return "krai";
  if (/autonomous okrug/i.test(parent)) return "autonomous_okrug";
  if (/autonomous oblast/i.test(parent)) return "autonomous_oblast";
  if (/\boblast\b/i.test(parent)) return "oblast";
  if (/republic|tatarstan|bashkortostan|udmurt|chuvash|mordov|ingushet|adygea|buryatia|khakass|dagestan|kabardino|karelia|\bkomi\b|mari|kalmyk|karachay/i.test(parent)) return "republic";
  return "oblast";
}

const mkSrc = (parent, categories, regionRx, adminType = "rayon") => ({
  adminType, parent,
  parentType: inferParentType(parent),
  categories: Array.isArray(categories) ? categories : [categories],
  nameExtract: title => {
    const m = title.match(
      new RegExp(String.raw`Coat\s+of\s+[Aa]rms?\s+of\s+(.+?)\s*(?:rayon|district|region|okrug)?\s*\(${regionRx}\)`, "i")
    );
    if (m) return m[1].trim();
    const m2 = title.match(/Coat[_\s]of[_\s][Aa]rms?[_\s]of[_\s](.+?)(?:\.\w+)?$/i);
    return m2 ? m2[1].replace(/_/g, " ").trim() : null;
  },
});

const NEW_SOURCES = [
  // ── Missing Oblasts ────────────────────────────────────────────────────────
  mkSrc("Kurgan Oblast",   "Coats_of_arms_of_districts_of_Kurgan_Oblast",               String.raw`Kurgan\s+[Oo]blast`),
  mkSrc("Kurgan Oblast",   "Coats_of_arms_of_cities_and_villages_of_Kurgan_Oblast",     String.raw`Kurgan\s+[Oo]blast`, "city"),
  mkSrc("Orel Oblast",     "Coats_of_arms_of_districts_of_Oryol_Oblast",                String.raw`(?:Orel|Oryol)`),
  mkSrc("Orel Oblast",     "Coats_of_arms_of_cities_and_villages_of_Oryol_Oblast",      String.raw`(?:Orel|Oryol)`, "city"),
  // Murmansk: add missing districts (cities already in catalog)
  mkSrc("Murmansk Oblast", "Coats_of_arms_of_districts_of_Murmansk_Oblast",             String.raw`Murmansk\s+[Oo]blast`),

  // ── Missing Republics ──────────────────────────────────────────────────────
  mkSrc("Republic of Kalmykia",       "Coats_of_arms_of_districts_of_Kalmykia",                      "Kalmykia"),
  mkSrc("Republic of Kalmykia",       "Coats_of_arms_of_cities_and_villages_of_Kalmykia",            "Kalmykia", "city"),
  mkSrc("Karachay-Cherkess Republic", "Coats_of_arms_of_districts_of_Karachay-Cherkessia",           String.raw`Karachay[-–]Cherkess`),
  mkSrc("Karachay-Cherkess Republic", "Coats_of_arms_of_cities_and_villages_of_Karachay-Cherkessia", String.raw`Karachay[-–]Cherkess`, "city"),

  // ── Missing Autonomous Okrugs ──────────────────────────────────────────────
  mkSrc("Nenets Autonomous Okrug",    "Coats_of_arms_of_districts_of_Nenets_Autonomous_Okrug",       "Nenets"),
  mkSrc("Nenets Autonomous Okrug",    "Coats_of_arms_of_cities_and_villages_of_Nenets_Autonomous_Okrug", "Nenets", "city"),
  mkSrc("Chukotka Autonomous Okrug",  "Coats_of_arms_of_districts_of_Chukotka_Autonomous_Okrug",    "Chukotka"),
  mkSrc("Chukotka Autonomous Okrug",  "Coats_of_arms_of_cities_and_villages_of_Chukotka_Autonomous_Okrug", "Chukotka", "city"),

  // ── Missing Autonomous Oblast ──────────────────────────────────────────────
  mkSrc("Jewish Autonomous Oblast",   "Coats_of_arms_of_districts_of_the_Jewish_Autonomous_Oblast",  String.raw`Jewish\s+Autonomous`),
  mkSrc("Jewish Autonomous Oblast",   "Coats_of_arms_of_cities_and_villages_of_the_Jewish_Autonomous_Oblast", String.raw`Jewish\s+Autonomous`, "city"),
];

async function main() {
  const existing = JSON.parse(readFileSync("data/catalog.json", "utf8"));
  const existingKeys = new Set(existing.map(e => `${e.name}|${e.parent}`));
  console.log(`Existing catalog: ${existing.length} entries\n`);

  const newEntries = [];

  for (const src of NEW_SOURCES) {
    const label = `${src.parent} (${src.adminType})`;
    process.stdout.write(`Fetching ${label}… `);
    await sleep(1000);

    const allTitles = [...new Set(
      (await Promise.all(src.categories.map(getFiles))).flat()
    )];
    const infos = await fetchInfoBatched(allTitles);

    const byName = {};
    for (const info of infos) {
      const name = src.nameExtract(info.title);
      if (!name || !info.url) continue;
      if (!byName[name]) byName[name] = [];
      byName[name].push(info);
    }

    let added = 0, fallbacks = 0;
    for (const [name, files] of Object.entries(byName).sort(([a], [b]) => a.localeCompare(b))) {
      const key = `${name}|${src.parent}`;
      if (existingKeys.has(key)) continue; // already in catalog

      let best = pickBest(files);

      // Fallback 1: Commons search
      if (!best) {
        await sleep(500);
        best = await searchCommons(name, src.parent);
        if (best) fallbacks++;
      }

      // Fallback 2: Russian Wikipedia
      if (!best) {
        await sleep(500);
        best = await searchRuWiki(name, src.parent);
        if (best) fallbacks++;
      }

      if (!best?.url) continue;

      newEntries.push({
        name,
        admin_type: src.adminType,
        parent: src.parent,
        parent_type: src.parentType,
        country: "Russia",
        image_url: best.url,
        image_format: best.ext,
      });
      existingKeys.add(key);
      added++;
    }

    console.log(`✓ ${added} new${fallbacks ? ` (${fallbacks} via fallback)` : ""}`);
  }

  if (newEntries.length === 0) {
    console.log("\nNo new entries found.");
    return;
  }

  const merged = [...existing, ...newEntries];
  writeFileSync("data/catalog.json", JSON.stringify(merged, null, 2));
  console.log(`\n✓ Added ${newEntries.length} new entries → catalog now has ${merged.length} total`);
  const byParent = {};
  newEntries.forEach(e => { byParent[e.parent] = (byParent[e.parent] ?? 0) + 1; });
  Object.entries(byParent).sort(([,a],[,b]) => b-a).forEach(([p,n]) => console.log(`  ${p}: +${n}`));
}

main().catch(e => { console.error(e); process.exit(1); });
