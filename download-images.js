#!/usr/bin/env node
/**
 * Downloads all coat-of-arms images from catalog.json to data/images/
 * Renames files to: <name>.<ext>  (lowercase, spaces → underscores)
 * Rewrites catalog.json with an added `image_path` field pointing to local file.
 * Respects Retry-After headers from Wikimedia CDN.
 *
 * Usage: node download-images.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dir, "data", "catalog.json");
const IMAGES_DIR   = join(__dir, "data", "images");

// Wikimedia guidelines: respect Retry-After, don't exceed 1 req/s
const BETWEEN_REQ  = 1500;   // ms between requests
const DEFAULT_WAIT = 60000;  // ms to wait when 429 with no Retry-After header
const RETRY_MAX    = 6;

mkdirSync(IMAGES_DIR, { recursive: true });

const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));

function toFilename(name, ext) {
  return name.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "_") + "." + ext;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function downloadOne(entry, idx, total) {
  const { image_url, image_format, name } = entry;
  if (!image_url) return null;

  const filename = toFilename(name, image_format || "svg");
  const dest     = join(IMAGES_DIR, filename);

  if (existsSync(dest)) {
    process.stdout.write(`[${idx+1}/${total}] cached  ${filename}\n`);
    return filename;
  }

  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    try {
      const res = await fetch(image_url, {
        headers: {
          // Wikimedia-friendly User-Agent per https://www.mediawiki.org/wiki/API:Etiquette
          "User-Agent": "CoatsOfArmsCatalog/1.0 (https://github.com/local; educational) node-fetch",
          "Accept": "image/svg+xml,image/png,image/gif,*/*",
        }
      });

      if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        const wait = ra ? (parseInt(ra) || 60) * 1000 : DEFAULT_WAIT;
        process.stdout.write(`[${idx+1}/${total}] 429 — waiting ${wait/1000}s (attempt ${attempt+1})\n`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buf = await res.arrayBuffer();
      writeFileSync(dest, Buffer.from(buf));
      process.stdout.write(`[${idx+1}/${total}] ok      ${filename}\n`);
      await sleep(BETWEEN_REQ);
      return filename;

    } catch (e) {
      if (e.message.startsWith("HTTP")) throw e; // rethrow non-429 HTTP errors
      process.stdout.write(`[${idx+1}/${total}] error attempt ${attempt+1}: ${e.message}\n`);
      await sleep(5000 * (attempt + 1));
    }
  }

  process.stdout.write(`[${idx+1}/${total}] FAILED  ${name}\n`);
  return null;
}

async function run() {
  // Save catalog periodically so progress isn't lost if interrupted
  const results = new Array(catalog.length).fill(null);

  // Pre-fill cached entries
  for (let i = 0; i < catalog.length; i++) {
    const { name, image_format } = catalog[i];
    const filename = toFilename(name, image_format || "svg");
    if (existsSync(join(IMAGES_DIR, filename))) {
      results[i] = filename;
      catalog[i].image_path = "data/images/" + filename;
    }
  }

  let done = results.filter(Boolean).length;
  process.stdout.write(`Starting: ${done} already cached, ${catalog.length - done} to download\n\n`);

  for (let i = 0; i < catalog.length; i++) {
    if (results[i]) continue; // already cached
    try {
      results[i] = await downloadOne(catalog[i], i, catalog.length);
      if (results[i]) {
        catalog[i].image_path = "data/images/" + results[i];
        done++;
      }
      // Save progress every 50 downloads
      if (done % 50 === 0) {
        writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
        process.stdout.write(`\n--- Progress saved: ${done}/${catalog.length} ---\n\n`);
      }
    } catch (e) {
      process.stdout.write(`[${i+1}/${catalog.length}] SKIP (error): ${catalog[i].name}: ${e.message}\n`);
    }
  }

  const failed = results.filter(r => !r).length;
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  process.stdout.write(`\nDone. ${done} downloaded/cached, ${failed} failed. catalog.json updated.\n`);
}

run().catch(e => { console.error(e); process.exit(1); });
