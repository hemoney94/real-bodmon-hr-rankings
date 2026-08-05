const { getStore } = require("@netlify/blobs");

// Automatic Blobs context injection isn't available in this environment,
// so the store is configured manually with a Site ID and access token.
// Set BLOBS_SITE_ID and BLOBS_TOKEN in Netlify's site environment variables
// (Site configuration > Environment variables). Must match the values used
// in log-rankings.js, or this function will read from a different store
// and never find what was logged.
function backtestStore() {
  return getStore({
    name: "backtest",
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN
  });
}

const SAVANT_CSV = "https://baseballsavant.mlb.com/statcast_search/csv";

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
function parseCSV(text) {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ""; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}
function normalizeGameDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return raw;
}

// Fetch every batter who recorded a home run on the given calendar date.
async function fetchHomerunsForDate(date) {
  const season = String(Number(date.slice(0, 4)));
  const params = new URLSearchParams({
    all: "true",
    type: "details",
    player_type: "batter",
    game_date_gt: addDays(date, -1),
    game_date_lt: addDays(date, 1),
    hfSea: `${season}|`,
    hfGT: "R|PO|S|",
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "pitches",
    sort_order: "desc"
  });
  const upstream = await fetch(`${SAVANT_CSV}?${params.toString()}`, {
    headers: { Accept: "text/csv,*/*", "User-Agent": "Mozilla/5.0 (compatible; RealBodmonHR-Backtest/1.0)" }
  });
  if (!upstream.ok) throw new Error(`Baseball Savant returned ${upstream.status}`);
  const rawText = await upstream.text();
  const rows = parseCSV(rawText);
  if (rows.length < 2) return new Set();

  const header = rows[0].map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of ["game_date", "batter", "events"]) {
    if (!(col in idx)) throw new Error(`Baseball Savant CSV is missing the ${col} column.`);
  }

  const homerunIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const gameDate = normalizeGameDate(row[idx.game_date]);
    if (gameDate !== date) continue;
    if (String(row[idx.events] || "").trim() === "home_run") {
      homerunIds.add(String(row[idx.batter] || "").trim());
    }
  }
  return homerunIds;
}

// Bucket a predicted percentage the same way the app's verdict() does, so
// tier hit-rates line up with what the person actually saw in the UI.
function tierFor(pct) {
  if (pct >= 7) return "elite";
  if (pct >= 5) return "top";
  if (pct >= 3.5) return "sneaky";
  return "neutral";
}

function emptySummary() {
  return {
    datesGraded: 0,
    byTier: {
      elite: { predictions: 0, hits: 0 },
      top: { predictions: 0, hits: 0 },
      sneaky: { predictions: 0, hits: 0 },
      neutral: { predictions: 0, hits: 0 }
    },
    // Calibration buckets: does a 5% prediction actually hit ~5% of the time?
    byPctBucket: {
      "0-2": { predictions: 0, hits: 0 },
      "2-4": { predictions: 0, hits: 0 },
      "4-6": { predictions: 0, hits: 0 },
      "6-8": { predictions: 0, hits: 0 },
      "8+": { predictions: 0, hits: 0 }
    }
  };
}
function bucketFor(pct) {
  if (pct < 2) return "0-2";
  if (pct < 4) return "2-4";
  if (pct < 6) return "4-6";
  if (pct < 8) return "6-8";
  return "8+";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const store = backtestStore();
    const date = event.queryStringParameters?.date;
    const mode = event.queryStringParameters?.mode || (date ? "date" : "summary");

    if (mode === "summary") {
      const summaryRaw = await store.get("summary:alltime", { type: "json" }).catch(() => null);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify(summaryRaw || emptySummary())
      };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return { statusCode: 400, body: JSON.stringify({ error: "A valid date (YYYY-MM-DD) is required." }) };
    }

    // Already graded? Return the cached per-date result instead of
    // re-fetching Savant and double-counting into the all-time summary.
    const existingResult = await store.get(`results:${date}`, { type: "json" }).catch(() => null);
    if (existingResult) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: JSON.stringify({ ...existingResult, cached: true })
      };
    }

    const logged = await store.get(`rankings:${date}`, { type: "json" }).catch(() => null);
    if (!logged || !Array.isArray(logged.rows) || !logged.rows.length) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: `No logged rankings found for ${date}. Rankings are only saved when "Load HR Rankings" is run for that slate date.` })
      };
    }

    const homerunIds = await fetchHomerunsForDate(date);

    const graded = logged.rows.map(r => ({
      ...r,
      actualHomerun: homerunIds.has(String(r.playerId))
    }));

    const dayTierCounts = {
      elite: { predictions: 0, hits: 0 },
      top: { predictions: 0, hits: 0 },
      sneaky: { predictions: 0, hits: 0 },
      neutral: { predictions: 0, hits: 0 }
    };
    const dayBucketCounts = {
      "0-2": { predictions: 0, hits: 0 },
      "2-4": { predictions: 0, hits: 0 },
      "4-6": { predictions: 0, hits: 0 },
      "6-8": { predictions: 0, hits: 0 },
      "8+": { predictions: 0, hits: 0 }
    };
    for (const r of graded) {
      const pct = Number(r.finalPct);
      if (!Number.isFinite(pct)) continue;
      const tier = tierFor(pct);
      dayTierCounts[tier].predictions++;
      if (r.actualHomerun) dayTierCounts[tier].hits++;
      const bucket = bucketFor(pct);
      dayBucketCounts[bucket].predictions++;
      if (r.actualHomerun) dayBucketCounts[bucket].hits++;
    }

    const totalHomeruns = homerunIds.size;
    const predictedHomeruns = graded.filter(r => r.actualHomerun).length;

    const dayResult = {
      date,
      gradedAt: new Date().toISOString(),
      totalPlayersLogged: graded.length,
      totalHomerunsThatDay: totalHomeruns,
      loggedPlayersWhoHomered: predictedHomeruns,
      byTier: dayTierCounts,
      byPctBucket: dayBucketCounts,
      players: graded
        .filter(r => r.actualHomerun)
        .map(r => ({ playerName: r.playerName, team: r.team, finalPct: r.finalPct }))
    };

    await store.set(`results:${date}`, JSON.stringify(dayResult));

    // Roll into the all-time summary.
    const summary = (await store.get("summary:alltime", { type: "json" }).catch(() => null)) || emptySummary();
    summary.datesGraded++;
    for (const tier of Object.keys(summary.byTier)) {
      summary.byTier[tier].predictions += dayTierCounts[tier].predictions;
      summary.byTier[tier].hits += dayTierCounts[tier].hits;
    }
    for (const bucket of Object.keys(summary.byPctBucket)) {
      summary.byPctBucket[bucket].predictions += dayBucketCounts[bucket].predictions;
      summary.byPctBucket[bucket].hits += dayBucketCounts[bucket].hits;
    }
    await store.set("summary:alltime", JSON.stringify(summary));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(dayResult)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "Failed to check results." })
    };
  }
};
