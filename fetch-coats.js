#!/usr/bin/env node
/**
 * Builds data/catalog.json
 *
 * Schema per entry:
 *   name         — place name (bare, without admin suffix)
 *   admin_type   — federal_city | city | rayon | municipal_okrug | city_district
 *   parent       — direct administrative parent name
 *   parent_type  — country | federal_city | oblast | krai | republic | autonomous_okrug
 *   country      — always "Russia"
 *   image_url    — Wikimedia Commons direct image URL
 *   image_format — svg | png | gif | jpg
 *
 * Usage: node fetch-coats.js
 */

import { writeFileSync, mkdirSync } from "fs";

const API = "https://commons.wikimedia.org/w/api.php";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(params, retries = 3) {
  const url = new URL(API);
  url.search = new URLSearchParams({ ...params, format: "json", origin: "*" });
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(4000 * attempt);
    const res = await fetch(url);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (attempt === retries - 1) throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
    }
  }
}

async function getFiles(category) {
  const files = [];
  let cont;
  do {
    const data = await apiGet({
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
  const data = await apiGet({
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
  for (let i = 0; i < titles.length; i += 50) {
    results.push(...await getImageInfo(titles.slice(i, i + 50)));
  }
  return results;
}

const MIN_PX = 300;

// Pick best image: prefer SVG, then hi-res PNG, exclude historical/junk
function pickBest(infos) {
  const EXCLUDE = /(\b18\d\d\b|\b19[0-7]\d\b|soviet|ussr|gorky|stamp|badge|coin|fictional|proposal|sketch|old|draft|blason|armoiries|wappen|герб.*\d{4})/i;
  const clean = infos.filter(f => f.url && !EXCLUDE.test(f.title));
  if (!clean.length) return infos.find(f => f.url) ?? null;
  const svgs = clean.filter(f => f.ext === "svg");
  if (svgs.length) return svgs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const pngs = clean.filter(f => f.ext === "png" && (f.width ?? 0) >= MIN_PX && (f.height ?? 0) >= MIN_PX);
  if (pngs.length) return pngs.sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return null;
}

// Infer parent_type from the parent's name
function inferParentType(parent) {
  if (parent === "Russia") return "country";
  if (parent === "Moscow" || parent === "Saint Petersburg") return "federal_city";
  if (/\bkrai\b/i.test(parent)) return "krai";
  if (/\boblast\b/i.test(parent)) return "oblast";
  if (/autonomous okrug/i.test(parent)) return "autonomous_okrug";
  if (/republic|tatarstan|bashkortostan|udmurt|chuvash|mordov|ingushet|adygea|buryatia|khakass|dagestan|kabardino|karelia|\bkomi\b|mari/i.test(parent)) return "republic";
  return "oblast";
}

// ── MANUAL OVERRIDES ────────────────────────────────────────────────────────
// Key: "name|parent"  →  null = exclude entirely, string = replace image_url
const OVERRIDES = {
  "Zheleznogorsk|Kursk Oblast": null, // wrong image uploaded on Wikimedia Commons
};

// ── SOURCE DEFINITIONS ──────────────────────────────────────────────────────

// Helper for the standard "Coat of Arms of X (REGION)" pattern
// Falls back to plain "Coat_of_Arms_of_X" filenames (safe: file comes from a known-region category)
const mkSrc = (parent, categories, regionRx, adminType = "rayon") => ({
  adminType,
  parent,
  parentType: inferParentType(parent),
  categories: Array.isArray(categories) ? categories : [categories],
  nameExtract: title => {
    const m = title.match(
      new RegExp(String.raw`Coat\s+of\s+[Aa]rms?\s+of\s+(.+?)\s*(?:rayon|district|region|okrug)?\s*\(${regionRx}\)`, "i")
    );
    if (m) return m[1].trim();
    // Fallback: plain "Coat_of_Arms_of_CityName.ext" without region qualifier
    const m2 = title.match(/Coat[_\s]of[_\s][Aa]rms?[_\s]of[_\s](.+?)(?:\.\w+)?$/i);
    return m2 ? m2[1].replace(/_/g, " ").trim() : null;
  },
});

const SOURCES = [
  // ── Moscow ─────────────────────────────────────────────────────────────────
  {
    adminType: "municipal_okrug",
    parent: "Moscow",
    parentType: "federal_city",
    categories: [
      "SVG_coats_of_arms_of_municipal_divisions_of_Moscow",
      "Coats_of_arms_of_municipal_divisions_of_Moscow",
    ],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*\(municipality\s+in\s+Moscow\)/i);
      if (!m) return null;
      // Normalize Russian directional transliterations → English so duplicates merge
      return m[1].trim()
        .replace(/\bSevero-Vostochnoye\b/gi, "North-East")
        .replace(/\bSevero-Zapadnoye\b/gi,   "North-West")
        .replace(/\bYugo-Vostochnoye\b/gi,   "South-East")
        .replace(/\bYugo-Zapadnoye\b/gi,     "South-West")
        .replace(/\bVostochnoye\b/gi,        "East")
        .replace(/\bZapadnoye\b/gi,          "West")
        .replace(/\bSevernoye\b/gi,          "North")
        .replace(/\bYuzhnoye\b/gi,           "South");
    },
  },

  // ── Saint Petersburg ───────────────────────────────────────────────────────
  mkSrc("Saint Petersburg", "Coats_of_arms_of_municipal_divisions_of_Saint_Petersburg",
    String.raw`municipality\s+in\s+St\.?\s*Petersburg`, "municipal_okrug"),

  // ── Nizhny Novgorod city districts ────────────────────────────────────────
  {
    adminType: "city_district",
    parent: "Nizhny Novgorod",
    parentType: "city",
    categories: ["Coats_of_arms_of_districts_of_Nizhny_Novgorod"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s+(?:district|city\s+district)/i);
      return m ? m[1].trim() + " District" : null;
    },
  },

  // ── Moscow Oblast ──────────────────────────────────────────────────────────
  {
    adminType: "municipal_okrug",
    parent: "Moscow Oblast",
    parentType: "oblast",
    categories: ["Coats_of_arms_of_districts_of_Moscow_Oblast"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*(?:\(Municipal\s+Okrug\)|\(Moscow\s+oblast\)|\(Moscow\s+Oblast\))/i);
      return m ? m[1].trim() : null;
    },
  },

  // ── Tatarstan ──────────────────────────────────────────────────────────────
  {
    adminType: "rayon",
    parent: "Republic of Tatarstan",
    parentType: "republic",
    categories: ["Coats_of_arms_of_districts_of_Tatarstan"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*(?:rayon|district)\s*\(Tatarstan\)/i);
      return m ? m[1].trim() + " Rayon" : null;
    },
  },
  {
    adminType: "city",
    parent: "Republic of Tatarstan",
    parentType: "republic",
    categories: ["Coats_of_arms_of_cities_and_villages_of_Tatarstan"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*\(Tatarstan\)/i);
      return m ? m[1].trim() : null;
    },
  },

  // ── Chelyabinsk Oblast ─────────────────────────────────────────────────────
  {
    adminType: "rayon",
    parent: "Chelyabinsk Oblast",
    parentType: "oblast",
    categories: ["Coats_of_arms_of_districts_of_Chelyabinsk_Oblast"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*(?:rayon|district)\s*\(Chelyabinsk\s+oblast\)/i);
      return m ? m[1].trim() + " Rayon" : null;
    },
  },
  {
    adminType: "city",
    parent: "Chelyabinsk Oblast",
    parentType: "oblast",
    categories: ["Coats_of_arms_of_cities_and_villages_of_Chelyabinsk_Oblast"],
    nameExtract: title => {
      const m = title.match(/Coat\s+of\s+Arms\s+of\s+(.+?)\s*\(Chelyabinsk\s+oblast\)/i);
      return m ? m[1].trim() : null;
    },
  },

  // ── Oblasts ────────────────────────────────────────────────────────────────
  mkSrc("Nizhny Novgorod Oblast",  "Coats_of_arms_of_districts_of_Nizhny_Novgorod_Oblast",           String.raw`Nizhny\s+Novgorod\s+oblast`),
  mkSrc("Nizhny Novgorod Oblast",  "Coats_of_arms_of_cities_and_villages_of_Nizhny_Novgorod_Oblast",  String.raw`Nizhny\s+Novgorod\s+(?:oblast|region)`, "city"),
  mkSrc("Rostov Oblast",           "Coats_of_arms_of_districts_of_Rostov_Oblast",                     String.raw`Rostov\s+oblast`),
  mkSrc("Rostov Oblast",           "Coats_of_arms_of_cities_and_villages_of_Rostov_Oblast",           String.raw`Rostov\s+oblast`, "city"),
  mkSrc("Omsk Oblast",             "Coats_of_arms_of_districts_of_Omsk_Oblast",                       String.raw`Omsk\s+[Oo]blast`),
  mkSrc("Omsk Oblast",             "Coats_of_arms_of_cities_and_villages_of_Omsk_Oblast",             String.raw`Omsk\s+[Oo]blast`, "city"),
  mkSrc("Orenburg Oblast",         "Coats_of_arms_of_districts_of_Orenburg_Oblast",                   String.raw`Orenburg\s+[Oo]blast`),
  mkSrc("Orenburg Oblast",         "Coats_of_arms_of_cities_and_villages_of_Orenburg_Oblast",         String.raw`Orenburg\s+[Oo]blast`, "city"),
  mkSrc("Sverdlovsk Oblast",       "Coats_of_arms_of_districts_of_Sverdlovsk_Oblast",                 String.raw`Sverdlovsk\s+oblast`),
  mkSrc("Sverdlovsk Oblast",       "Coats_of_arms_of_cities_and_villages_of_Sverdlovsk_Oblast",       String.raw`Sverdlovsk\s+oblast`, "city"),
  mkSrc("Kirov Oblast",            "Coats_of_arms_of_districts_of_Kirov_Oblast",                      String.raw`Kirov\s+(?:region|oblast)`),
  mkSrc("Kirov Oblast",            "Coats_of_arms_of_cities_and_villages_of_Kirov_Oblast",            String.raw`Kirov\s+(?:region|oblast)`, "city"),
  mkSrc("Voronezh Oblast",         "Coats_of_arms_of_districts_of_Voronezh_Oblast",                   String.raw`Voronezh\s+oblast`),
  mkSrc("Voronezh Oblast",         "Coats_of_arms_of_cities_and_villages_of_Voronezh_Oblast",         String.raw`Voronezh\s+oblast`, "city"),
  mkSrc("Bryansk Oblast",          "Coats_of_arms_of_districts_of_Bryansk_Oblast",                    String.raw`Bryansk\s+(?:oblast|region)`),
  mkSrc("Bryansk Oblast",          "Coats_of_arms_of_cities_and_villages_of_Bryansk_Oblast",          String.raw`Bryansk\s+(?:oblast|region)`, "city"),
  mkSrc("Ryazan Oblast",           "Coats_of_arms_of_districts_of_Ryazan_Oblast",                     String.raw`Ryazan\s+oblast`),
  mkSrc("Ryazan Oblast",           "Coats_of_arms_of_cities_and_villages_of_Ryazan_Oblast",           String.raw`Ryazan\s+oblast`, "city"),
  mkSrc("Kursk Oblast",            "Coats_of_arms_of_districts_of_Kursk_Oblast",                      String.raw`Kursk\s+oblast`),
  mkSrc("Kursk Oblast",            "Coats_of_arms_of_cities_and_villages_of_Kursk_Oblast",            String.raw`Kursk\s+oblast`, "city"),
  mkSrc("Samara Oblast",           "Coats_of_arms_of_districts_of_Samara_Oblast",                     String.raw`Samara\s+oblast`),
  mkSrc("Samara Oblast",           "Coats_of_arms_of_cities_and_villages_of_Samara_Oblast",           String.raw`Samara\s+oblast`, "city"),
  mkSrc("Saratov Oblast",          "Coats_of_arms_of_districts_of_Saratov_Oblast",                    String.raw`Saratov\s+oblast`),
  mkSrc("Saratov Oblast",          "Coats_of_arms_of_cities_and_villages_of_Saratov_Oblast",          String.raw`Saratov\s+oblast`, "city"),
  mkSrc("Yaroslavl Oblast",        "Coats_of_arms_of_districts_of_Yaroslavl_Oblast",                  String.raw`Yaroslavl\s+oblast`),
  mkSrc("Yaroslavl Oblast",        "Coats_of_arms_of_cities_and_villages_of_Yaroslavl_Oblast",        String.raw`Yaroslavl\s+(?:oblast|region|gubernia)`, "city"),
  mkSrc("Vologda Oblast",          "Coats_of_arms_of_districts_of_Vologda_Oblast",                    String.raw`Vologda\s+oblast`),
  mkSrc("Vologda Oblast",          "Coats_of_arms_of_cities_and_villages_of_Vologda_Oblast",          String.raw`Vologda\s+oblast`, "city"),
  mkSrc("Novosibirsk Oblast",      "Coats_of_arms_of_districts_of_Novosibirsk_Oblast",                String.raw`Novosibirsk\s+oblast`),
  mkSrc("Novosibirsk Oblast",      "Coats_of_arms_of_cities_and_villages_of_Novosibirsk_Oblast",      String.raw`Novosibirsk\s+oblast`, "city"),
  mkSrc("Penza Oblast",            "Coats_of_arms_of_districts_of_Penza_Oblast",                      String.raw`Penza\s+oblast`),
  mkSrc("Penza Oblast",            "Coats_of_arms_of_cities_and_villages_of_Penza_Oblast",            String.raw`Penza\s+oblast`, "city"),
  mkSrc("Novgorod Oblast",         "Coats_of_arms_of_districts_of_Novgorod_Oblast",                   String.raw`Novgorod\s+oblast`),
  mkSrc("Novgorod Oblast",         "Coats_of_arms_of_cities_and_villages_of_Novgorod_Oblast",         String.raw`Novgorod\s+oblast`, "city"),
  mkSrc("Arkhangelsk Oblast",      "Coats_of_arms_of_districts_of_Arkhangelsk_Oblast",                String.raw`Arkhangelsk\s+oblast`),
  mkSrc("Arkhangelsk Oblast",      "Coats_of_arms_of_cities_and_villages_of_Arkhangelsk_Oblast",      String.raw`Arkhangelsk\s+oblast`, "city"),
  mkSrc("Lipetsk Oblast",          "Coats_of_arms_of_districts_of_Lipetsk_Oblast",                    String.raw`Lipetsk\s+oblast`),
  mkSrc("Lipetsk Oblast",          "Coats_of_arms_of_cities_and_villages_of_Lipetsk_Oblast",          String.raw`Lipetsk\s+oblast`, "city"),
  mkSrc("Irkutsk Oblast",          "Coats_of_arms_of_districts_of_Irkutsk_Oblast",                    String.raw`Irkutsk\s+oblast`),
  mkSrc("Irkutsk Oblast",          "Coats_of_arms_of_cities_and_villages_of_Irkutsk_Oblast",          String.raw`Irkutsk\s+oblast`, "city"),
  mkSrc("Tver Oblast",             "Coats_of_arms_of_districts_of_Tver_Oblast",                       String.raw`Tver\s+oblast`),
  mkSrc("Tver Oblast",             "Coats_of_arms_of_cities_and_villages_of_Tver_Oblast",             String.raw`Tver\s+oblast`, "city"),
  mkSrc("Ivanovo Oblast",          "Coats_of_arms_of_districts_of_Ivanovo_Oblast",                    String.raw`Ivanovo\s+oblast`),
  mkSrc("Ivanovo Oblast",          "Coats_of_arms_of_cities_and_villages_of_Ivanovo_Oblast",          String.raw`Ivanovo\s+oblast`, "city"),
  mkSrc("Smolensk Oblast",         "Coats_of_arms_of_districts_of_Smolensk_Oblast",                   String.raw`Smolensk\s+oblast`),
  mkSrc("Smolensk Oblast",         "Coats_of_arms_of_cities_and_villages_of_Smolensk_Oblast",         String.raw`Smolensk\s+oblast`, "city"),
  mkSrc("Kostroma Oblast",         "Coats_of_arms_of_districts_of_Kostroma_Oblast",                   String.raw`Kostroma\s+oblast`),
  mkSrc("Kostroma Oblast",         "Coats_of_arms_of_cities_and_villages_of_Kostroma_Oblast",         String.raw`Kostroma\s+oblast`, "city"),
  mkSrc("Kemerovo Oblast",         "Coats_of_arms_of_districts_of_Kemerovo_Oblast",                   String.raw`Kemerovo\s+oblast`),
  mkSrc("Kemerovo Oblast",         "Coats_of_arms_of_cities_and_villages_of_Kemerovo_Oblast",         String.raw`Kemerovo\s+oblast`, "city"),
  mkSrc("Tambov Oblast",           "Coats_of_arms_of_districts_of_Tambov_Oblast",                     String.raw`Tambov\s+oblast`),
  mkSrc("Tambov Oblast",           "Coats_of_arms_of_cities_and_villages_of_Tambov_Oblast",           String.raw`Tambov\s+(?:oblast|region|gubernia)`, "city"),
  mkSrc("Amur Oblast",             "Coats_of_arms_of_districts_of_Amur_Oblast",                       String.raw`Amur\s+oblast`),
  mkSrc("Amur Oblast",             "Coats_of_arms_of_cities_and_villages_of_Amur_Oblast",             String.raw`Amur\s+oblast`, "city"),
  mkSrc("Kaluga Oblast",           "Coats_of_arms_of_districts_of_Kaluga_Oblast",                     String.raw`Kaluga\s+oblast`),
  mkSrc("Kaluga Oblast",           "Coats_of_arms_of_cities_and_villages_of_Kaluga_Oblast",           String.raw`Kaluga\s+oblast`, "city"),
  mkSrc("Vladimir Oblast",         "Coats_of_arms_of_districts_of_Vladimir_Oblast",                   String.raw`Vladimir\s+oblast`),
  mkSrc("Vladimir Oblast",         "Coats_of_arms_of_cities_and_villages_of_Vladimir_Oblast",         String.raw`Vladimir\s+(?:oblast|region|gubernia)`, "city"),
  mkSrc("Tyumen Oblast",           "Coats_of_arms_of_districts_of_Tyumen_Oblast",                     String.raw`Tyumen\s+oblast`),
  mkSrc("Tyumen Oblast",           "Coats_of_arms_of_cities_and_villages_of_Tyumen_Oblast",           String.raw`Tyumen\s+oblast`, "city"),
  mkSrc("Leningrad Oblast",        "Coats_of_arms_of_districts_of_Leningrad_Oblast",                  String.raw`Leningrad\s+oblast`),
  mkSrc("Leningrad Oblast",        "Coats_of_arms_of_cities_and_villages_of_Leningrad_Oblast",        String.raw`Leningrad\s+oblast`, "city"),
  mkSrc("Kaliningrad Oblast",      "Coats_of_arms_of_districts_of_Kaliningrad_Oblast",                String.raw`Kaliningrad\s+oblast`),
  mkSrc("Kaliningrad Oblast",      "Coats_of_arms_of_cities_and_villages_of_Kaliningrad_Oblast",      String.raw`Kaliningrad\s+oblast`, "city"),
  mkSrc("Tula Oblast",             "Coats_of_arms_of_districts_of_Tula_Oblast",                       String.raw`Tula\s+oblast`),
  mkSrc("Tula Oblast",             "Coats_of_arms_of_cities_and_villages_of_Tula_Oblast",             String.raw`Tula\s+oblast`, "city"),
  mkSrc("Pskov Oblast",            "Coats_of_arms_of_districts_of_Pskov_Oblast",                      String.raw`Pskov\s+oblast`),
  mkSrc("Pskov Oblast",            "Coats_of_arms_of_cities_and_villages_of_Pskov_Oblast",            String.raw`Pskov\s+oblast`, "city"),
  mkSrc("Tomsk Oblast",            "Coats_of_arms_of_districts_of_Tomsk_Oblast",                      String.raw`Tomsk\s+oblast`),
  mkSrc("Tomsk Oblast",            "Coats_of_arms_of_cities_and_villages_of_Tomsk_Oblast",            String.raw`Tomsk\s+oblast`, "city"),
  mkSrc("Astrakhan Oblast",        "Coats_of_arms_of_districts_of_Astrakhan_Oblast",                  String.raw`Astrakhan\s+oblast`),
  mkSrc("Astrakhan Oblast",        "Coats_of_arms_of_cities_and_villages_of_Astrakhan_Oblast",        String.raw`Astrakhan\s+oblast`, "city"),
  mkSrc("Belgorod Oblast",         "Coats_of_arms_of_districts_of_Belgorod_Oblast",                   String.raw`Belgorod\s+oblast`),
  mkSrc("Belgorod Oblast",         "Coats_of_arms_of_cities_and_villages_of_Belgorod_Oblast",         String.raw`Belgorod\s+oblast`, "city"),
  mkSrc("Murmansk Oblast",         "Coats_of_arms_of_cities_and_villages_of_Murmansk_Oblast",         String.raw`Murmansk\s+oblast`, "city"),
  mkSrc("Sakhalin Oblast",         "Coats_of_arms_of_districts_of_Sakhalin_Oblast",                   "Sakhalin"),
  mkSrc("Sakhalin Oblast",         "Coats_of_arms_of_cities_and_villages_of_Sakhalin_Oblast",         "Sakhalin", "city"),
  mkSrc("Magadan Oblast",          "Coats_of_arms_of_districts_of_Magadan_Oblast",                    "Magadan"),
  mkSrc("Magadan Oblast",          "Coats_of_arms_of_cities_and_villages_of_Magadan_Oblast",          "Magadan", "city"),
  mkSrc("Volgograd Oblast",        "Coats_of_arms_of_districts_of_Volgograd_Oblast",                  String.raw`Volgograd\s+oblast`),
  mkSrc("Volgograd Oblast",        "Coats_of_arms_of_cities_and_villages_of_Volgograd_Oblast",        String.raw`Volgograd\s+oblast`, "city"),
  mkSrc("Ulyanovsk Oblast",        "Coats_of_arms_of_districts_of_Ulyanovsk_Oblast",                  String.raw`Ulyanovsk\s+oblast`),
  mkSrc("Ulyanovsk Oblast",        "Coats_of_arms_of_cities_and_villages_of_Ulyanovsk_Oblast",        String.raw`Ulyanovsk\s+oblast`, "city"),
  mkSrc("Krasnoyarsk Krai",        "Coats_of_arms_of_districts_of_Krasnoyarsk_Krai",                  String.raw`Krasnoyarsk\s+[Kk]rai`),
  mkSrc("Krasnoyarsk Krai",        "Coats_of_arms_of_cities_and_villages_of_Krasnoyarsk_Krai",        String.raw`Krasnoyarsk\s+[Kk]rai`, "city"),

  // ── Krais ──────────────────────────────────────────────────────────────────
  mkSrc("Perm Krai",               "Coats_of_arms_of_districts_of_Perm_Krai",                         String.raw`Perm\s+krai`),
  mkSrc("Perm Krai",               "Coats_of_arms_of_cities_and_villages_of_Perm_Krai",               String.raw`Perm\s+krai`, "city"),
  mkSrc("Krasnodar Krai",          "Coats_of_arms_of_districts_of_Krasnodar_Krai",                    String.raw`Krasnodar\s+krai`),
  mkSrc("Krasnodar Krai",          "Coats_of_arms_of_cities_and_villages_of_Krasnodar_Krai",          String.raw`Krasnodar\s+krai`, "city"),
  mkSrc("Stavropol Krai",          "Coats_of_arms_of_districts_of_Stavropol_Krai",                    String.raw`Stavropol\s+[Kk]rai`),
  mkSrc("Stavropol Krai",          "Coats_of_arms_of_cities_and_villages_of_Stavropol_Krai",          String.raw`Stavropol\s+[Kk]rai`, "city"),
  mkSrc("Khabarovsk Krai",         "Coats_of_arms_of_districts_of_Khabarovsk_Krai",                   String.raw`Khabarovsk\s+[Kk]rai`),
  mkSrc("Khabarovsk Krai",         "Coats_of_arms_of_cities_and_villages_of_Khabarovsk_Krai",         String.raw`Khabarovsk\s+[Kk]rai`, "city"),
  mkSrc("Altai Krai",              "Coats_of_arms_of_districts_of_Altai_Krai",                        String.raw`Altai\s+[Kk]rai`),
  mkSrc("Altai Krai",              "Coats_of_arms_of_cities_and_villages_of_Altai_Krai",              String.raw`Altai\s+[Kk]rai`, "city"),
  mkSrc("Zabaykalsky Krai",        "Coats_of_arms_of_districts_of_Zabaykalsky_Krai",                  String.raw`Zabaykalsky\s+[Kk]rai`),
  mkSrc("Zabaykalsky Krai",        "Coats_of_arms_of_cities_and_villages_of_Zabaykalsky_Krai",        String.raw`Zabaykalsky\s+[Kk]rai`, "city"),
  mkSrc("Kamchatka Krai",          "Coats_of_arms_of_districts_of_Kamchatka_Krai",                    "Kamchatka"),
  mkSrc("Kamchatka Krai",          "Coats_of_arms_of_cities_and_villages_of_Kamchatka_Krai",          "Kamchatka", "city"),
  mkSrc("Primorsky Krai",          "Coats_of_arms_of_districts_of_Primorsky_Krai",                    String.raw`Primorsky\s+[Kk]rai`),
  mkSrc("Primorsky Krai",          "Coats_of_arms_of_cities_and_villages_of_Primorsky_Krai",          String.raw`Primorsky\s+[Kk]rai`, "city"),

  // ── Republics ──────────────────────────────────────────────────────────────
  mkSrc("Republic of Bashkortostan", "Coats_of_arms_of_districts_of_Bashkortostan",                   "Bashkortostan"),
  mkSrc("Republic of Bashkortostan", "Coats_of_arms_of_cities_and_villages_of_Bashkortostan",         "Bashkortostan", "city"),
  mkSrc("Chuvash Republic",        "Coats_of_arms_of_districts_of_Chuvashia",                         "Chuvashia"),
  mkSrc("Chuvash Republic",        "Coats_of_arms_of_cities_and_villages_of_Chuvashia",               "Chuvashia", "city"),
  mkSrc("Republic of Dagestan",    "Coats_of_arms_of_districts_of_Dagestan",                          "Dagestan"),
  mkSrc("Republic of Dagestan",    "Coats_of_arms_of_cities_and_villages_of_Dagestan",                "Dagestan", "city"),
  mkSrc("Udmurt Republic",         "Coats_of_arms_of_districts_of_Udmurtia",                          "Udmurtia"),
  mkSrc("Udmurt Republic",         "Coats_of_arms_of_cities_and_villages_of_Udmurtia",                "Udmurtia", "city"),
  mkSrc("Komi Republic",           "Coats_of_arms_of_districts_of_Komi",                              "Komi"),
  mkSrc("Komi Republic",           "Coats_of_arms_of_cities_and_villages_of_Komi",                    "Komi", "city"),
  mkSrc("Mari El Republic",        "Coats_of_arms_of_districts_of_Mari_El",                           String.raw`Mari\s+El`),
  mkSrc("Mari El Republic",        "Coats_of_arms_of_cities_and_villages_of_Mari_El",                 String.raw`Mari\s+El`, "city"),
  mkSrc("Republic of Adygea",      "Coats_of_arms_of_districts_of_Adygea",                            "Adygea"),
  mkSrc("Republic of Adygea",      "Coats_of_arms_of_cities_and_villages_of_Adygea",                  "Adygea", "city"),
  mkSrc("Kabardino-Balkar Republic","Coats_of_arms_of_districts_of_Kabardino-Balkaria",               String.raw`Kabardino[-–]Balkaria`),
  mkSrc("Kabardino-Balkar Republic","Coats_of_arms_of_cities_and_villages_of_Kabardino-Balkaria",     String.raw`Kabardino[-–]Balkaria`, "city"),
  mkSrc("Republic of Khakassia",   "Coats_of_arms_of_districts_of_Khakassia",                        "Khakassia"),
  mkSrc("Republic of Khakassia",   "Coats_of_arms_of_cities_and_villages_of_Khakassia",              "Khakassia", "city"),
  mkSrc("Republic of Mordovia",    "Coats_of_arms_of_districts_of_Mordovia",                          "Mordovia"),
  mkSrc("Republic of Mordovia",    "Coats_of_arms_of_cities_and_villages_of_Mordovia",                "Mordovia", "city"),
  mkSrc("Republic of Ingushetia",  "Coats_of_arms_of_districts_of_Ingushetia",                        "Ingushetia"),
  mkSrc("Republic of Ingushetia",  "Coats_of_arms_of_cities_and_villages_of_Ingushetia",              "Ingushetia", "city"),
  mkSrc("Republic of Buryatia",    "Coats_of_arms_of_districts_of_Buryatia",                          "Buryatia"),
  mkSrc("Republic of Buryatia",    "Coats_of_arms_of_cities_and_villages_of_Buryatia",                "Buryatia", "city"),
  mkSrc("Republic of Karelia",     "Coats_of_arms_of_districts_of_the_Republic_of_Karelia",           String.raw`(?:Republic\s+of\s+)?Karelia`),
  mkSrc("Republic of Karelia",     "Coats_of_arms_of_cities_and_villages_of_the_Republic_of_Karelia", String.raw`(?:Republic\s+of\s+)?Karelia`, "city"),
  mkSrc("Sakha Republic",          "Coats_of_arms_of_districts_of_the_Sakha_Republic",                String.raw`(?:Sakha|Yakutia)`),
  mkSrc("Sakha Republic",          "Coats_of_arms_of_cities_and_villages_of_the_Sakha_Republic",      String.raw`(?:Sakha|Yakutia)`, "city"),
  mkSrc("Republic of North Ossetia–Alania", "Coats_of_arms_of_districts_of_North_Ossetia",            String.raw`North\s+Ossetia`),
  mkSrc("Republic of North Ossetia–Alania", "Coats_of_arms_of_cities_and_villages_of_North_Ossetia",  String.raw`North\s+Ossetia`, "city"),
  mkSrc("Chechen Republic",        "Coats_of_arms_of_districts_of_Chechnya",                          "Chechnya"),
  mkSrc("Republic of Altai",       "Coats_of_arms_of_districts_of_the_Altai_Republic",                String.raw`Altai\s+Republic`),
  mkSrc("Tuva Republic",           "Coats_of_arms_of_districts_of_Tuva",                              "Tuva"),

  // ── Autonomous Okrugs ──────────────────────────────────────────────────────
  mkSrc("Yamalo-Nenets Autonomous Okrug", "Coats_of_arms_of_districts_of_Yamalo-Nenets_Autonomous_Okrug", String.raw`Yamalo[-–]Nenets`),
  mkSrc("Yamalo-Nenets Autonomous Okrug", "Coats_of_arms_of_cities_and_villages_of_Yamalo-Nenets_Autonomous_Okrug", String.raw`Yamalo[-–]Nenets`, "city"),
  mkSrc("Khanty-Mansi Autonomous Okrug",  "Coats_of_arms_of_districts_of_Khanty-Mansi_Autonomous_Okrug", String.raw`Khanty[-–]Mansi`),
  mkSrc("Khanty-Mansi Autonomous Okrug",  "Coats_of_arms_of_cities_and_villages_of_Khanty-Mansi_Autonomous_Okrug", String.raw`Khanty[-–]Mansi`, "city"),

  // ── Major cities (top-level coat of arms) ──────────────────────────────────
  ...([
    { name: "Moscow",           adminType: "federal_city", parent: "Russia",                      cat: "Coats_of_arms_of_Moscow" },
    { name: "Saint Petersburg", adminType: "federal_city", parent: "Russia",                      cat: "Coat_of_arms_of_Saint_Petersburg" },
    { name: "Novosibirsk",      adminType: "city",         parent: "Novosibirsk Oblast",           cat: "Coats_of_arms_of_Novosibirsk" },
    { name: "Yekaterinburg",    adminType: "city",         parent: "Sverdlovsk Oblast",            cat: "Coats_of_arms_of_Yekaterinburg" },
    { name: "Kazan",            adminType: "city",         parent: "Republic of Tatarstan",        cat: "Coats_of_arms_of_Kazan" },
    { name: "Nizhny Novgorod",  adminType: "city",         parent: "Nizhny Novgorod Oblast",       cat: "Coats_of_arms_of_Nizhny_Novgorod" },
    { name: "Chelyabinsk",      adminType: "city",         parent: "Chelyabinsk Oblast",           cat: "Coats_of_arms_of_Chelyabinsk" },
    { name: "Omsk",             adminType: "city",         parent: "Omsk Oblast",                  cat: "Coats_of_arms_of_Omsk" },
    { name: "Samara",           adminType: "city",         parent: "Samara Oblast",                cat: "Coats_of_arms_of_Samara" },
    { name: "Rostov-on-Don",    adminType: "city",         parent: "Rostov Oblast",                cat: "Coats_of_arms_of_Rostov-on-Don" },
    { name: "Ufa",              adminType: "city",         parent: "Republic of Bashkortostan",    cat: "Coats_of_arms_of_Ufa" },
    { name: "Krasnoyarsk",      adminType: "city",         parent: "Krasnoyarsk Krai",             cat: "Coats_of_arms_of_Krasnoyarsk" },
    { name: "Perm",             adminType: "city",         parent: "Perm Krai",                    cat: "Coats_of_arms_of_Perm" },
    { name: "Voronezh",         adminType: "city",         parent: "Voronezh Oblast",              cat: "Coats_of_arms_of_Voronezh" },
    { name: "Volgograd",        adminType: "city",         parent: "Volgograd Oblast",             cat: "Coats_of_arms_of_Volgograd" },
  ].map(c => ({
    ...c,
    parentType: inferParentType(c.parent),
    categories: [c.cat],
    nameExtract: () => c.name,
  }))),
];

// ── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const catalog = [];

  for (const src of SOURCES) {
    const label = src.adminType === "federal_city" || src.adminType === "city"
      ? `${src.name ?? src.parent} (${src.adminType})`
      : `${src.parent} (${src.adminType})`;
    process.stdout.write(`Fetching ${label}… `);
    await sleep(1000);

    const allTitles = [...new Set(
      (await Promise.all(src.categories.map(getFiles))).flat()
    )];
    const infos = await fetchInfoBatched(allTitles);

    // City-level: pick single best image
    if (src.name !== undefined) {
      const best = pickBest(infos);
      if (best?.url) {
        catalog.push({
          name: src.name,
          admin_type: src.adminType,
          parent: src.parent,
          parent_type: src.parentType,
          country: "Russia",
          image_url: best.url,
          image_format: best.ext,
        });
        console.log(`✓ (${best.ext})`);
      } else {
        console.log("✗ no image");
      }
      continue;
    }

    // District/okrug/city-within-region: group by extracted name, pick best per entry
    const byName = {};
    for (const info of infos) {
      const name = src.nameExtract(info.title);
      if (!name || !info.url) continue;
      if (!byName[name]) byName[name] = [];
      byName[name].push(info);
    }
    const entries = Object.entries(byName)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, files]) => {
        const best = pickBest(files);
        if (!best?.url) return [];
        return [{ name, admin_type: src.adminType, parent: src.parent, parent_type: src.parentType, country: "Russia", image_url: best.url, image_format: best.ext }];
      });
    catalog.push(...entries);
    console.log(`✓ ${entries.length}`);
  }

  // ── Deduplicate by name+parent, keeping best image (SVG > PNG > other) ──
  const deduped = [];
  const seen = {};
  const rank = e => e.image_format === "svg" ? 2 : e.image_format === "png" ? 1 : 0;
  for (const e of catalog) {
    const key = `${e.name}|${e.parent}`;
    const override = OVERRIDES[key];
    if (override === null) continue;
    if (typeof override === "string") {
      e.image_url = override;
      e.image_format = override.split(".").pop().toLowerCase();
    }
    if (!seen[key]) { seen[key] = e; deduped.push(e); continue; }
    if (rank(e) > rank(seen[key])) {
      deduped[deduped.indexOf(seen[key])] = e;
      seen[key] = e;
    }
  }

  // ── Warn: name not found in filename ──
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const suspicious = deduped.filter(e => {
    if (e.admin_type === "federal_city") return false;
    const file = norm(decodeURIComponent(e.image_url.split("/").pop()));
    const n = norm(e.name);
    return n.length > 3 && !file.includes(n);
  });
  if (suspicious.length) {
    console.log(`\n⚠ ${suspicious.length} possible mismatches (name not in filename):`);
    suspicious.forEach(e =>
      console.log(`  [${e.admin_type}] ${e.name} (${e.parent}) → ${e.image_url.split("/").pop()}`)
    );
  }

  mkdirSync("data", { recursive: true });
  writeFileSync("data/catalog.json", JSON.stringify(deduped, null, 2));
  console.log(`\nTotal: ${deduped.length} entries (${catalog.length - deduped.length} dupes removed) → data/catalog.json`);

  const byParent = {};
  deduped.forEach(e => { byParent[e.parent] = (byParent[e.parent] ?? 0) + 1; });
  Object.entries(byParent).sort(([, a], [, b]) => b - a)
    .forEach(([p, n]) => console.log(`  ${p}: ${n}`));
}

main().catch(e => { console.error(e); process.exit(1); });
