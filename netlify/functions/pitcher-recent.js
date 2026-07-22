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
function num(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === "null" || text.toLowerCase() === "nan") return null;
  const n = Number(text); return Number.isFinite(n) ? n : null;
}
function normalizePersonName(value) {
  const raw = String(value || "").trim();
  const parts = raw.split(",").map(x => x.trim()).filter(Boolean);
  const ordered = parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw;
  return ordered.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function normalizeGameDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  return raw;
}
function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** digits; return Math.round(value * p) / p;
}
function clamp(n, min = 0, max = 100) { return Math.min(max, Math.max(min, n)); }

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  try {
    const date = event.queryStringParameters?.date;
    const days = Math.min(45, Math.max(14, Number(event.queryStringParameters?.days) || 30));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { statusCode: 400, body: JSON.stringify({ error: "A valid slate date is required." }) };

    const endDate = addDays(date, -1);
    const startDate = addDays(date, -days);
    // Use the full Baseball Savant detail-search parameter set.
    const season = String(Number(date.slice(0, 4)));
    const params = new URLSearchParams({
      all: "true",
      type: "details",
      player_type: "pitcher",
      game_date_gt: startDate,
      game_date_lt: endDate,
      hfSea: `${season}|`,
      hfGT: "R|PO|S|",
      min_pitches: "0",
      min_results: "0",
      min_pas: "0",
      group_by: "name",
      sort_col: "pitches",
      player_event_sort: "h_launch_speed",
      sort_order: "desc"
    });
    const upstream = await fetch(`${SAVANT_CSV}?${params.toString()}`, {
      headers: { Accept: "text/csv,*/*", "User-Agent": "Mozilla/5.0 (compatible; RealBodmonHR/6.0)" }
    });
    if (!upstream.ok) throw new Error(`Baseball Savant returned ${upstream.status}: ${(await upstream.text()).slice(0, 250)}`);
    const rawText = await upstream.text();
    const rows = parseCSV(rawText);
    if (rows.length < 2) return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ startDate, endDate, days, pitchers: [], debug: { source: SAVANT_CSV, query: params.toString(), contentType: upstream.headers.get("content-type"), bytes: rawText.length, parsedRows: Math.max(0, rows.length - 1), pitcherCount: 0, rawPreview: rawText.slice(0, 500) } }) };

    const header = rows[0].map(h => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    for (const col of ["game_date", "pitcher", "events", "plate_x", "plate_z", "launch_speed", "launch_speed_angle", "bb_type", "player_name"]) {
      if (!(col in idx)) throw new Error(`Baseball Savant CSV is missing the ${col} column.`);
    }

    const byPitcher = new Map();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const gameDate = normalizeGameDate(row[idx.game_date]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || gameDate < startDate || gameDate > endDate) continue;
      const playerId = String(row[idx.pitcher] || "").trim();
      if (!playerId) continue;
      let p = byPitcher.get(playerId);
      if (!p) {
        p = { playerId, playerName: String(row[idx.player_name] || "").trim(), pitches: 0, zone: 0, heart: 0, meatball: 0, pa: 0, homeRuns: 0, bbe: 0, barrels: 0, hardHit: 0, hardAir: 0 };
        byPitcher.set(playerId, p);
      }
      p.pitches++;
      const x = num(row[idx.plate_x]);
      const z = num(row[idx.plate_z]);
      const zoneTop = idx.sz_top !== undefined ? num(row[idx.sz_top]) : null;
      const zoneBot = idx.sz_bot !== undefined ? num(row[idx.sz_bot]) : null;
      if (x !== null && z !== null) {
        const inZone = Math.abs(x) <= 0.83 && z >= (zoneBot ?? 1.5) && z <= (zoneTop ?? 3.5);
        if (inZone) p.zone++;
        const heart = Math.abs(x) <= 0.55 && z >= Math.max(zoneBot ?? 1.5, 2.0) && z <= Math.min(zoneTop ?? 3.5, 3.5);
        if (heart) p.heart++;
        const meatball = Math.abs(x) <= 0.35 && z >= Math.max(zoneBot ?? 1.5, 2.25) && z <= Math.min(zoneTop ?? 3.5, 3.25);
        if (meatball) p.meatball++;
      }
      const eventName = String(row[idx.events] || "").trim();
      if (eventName) p.pa++;
      if (eventName === "home_run") p.homeRuns++;
      const ev = num(row[idx.launch_speed]);
      if (ev === null) continue;
      p.bbe++;
      if (num(row[idx.launch_speed_angle]) === 6) p.barrels++;
      if (ev >= 95) p.hardHit++;
      const angle = idx.launch_angle !== undefined ? num(row[idx.launch_angle]) : null;
      const bbType = String(row[idx.bb_type] || "").trim();
      const airborne = bbType === "fly_ball" || bbType === "line_drive" || (angle !== null && angle >= 10);
      if (airborne && ev >= 95) p.hardAir++;
    }

    const pitchers = [...byPitcher.values()].map(p => {
      const zonePct = p.pitches ? (p.zone / p.pitches) * 100 : null;
      const heartPct = p.pitches ? (p.heart / p.pitches) * 100 : null;
      const meatballPct = p.pitches ? (p.meatball / p.pitches) * 100 : null;
      const barrelPct = p.bbe ? (p.barrels / p.bbe) * 100 : null;
      const hardHitPct = p.bbe ? (p.hardHit / p.bbe) * 100 : null;
      const hardAirPct = p.bbe ? (p.hardAir / p.bbe) * 100 : null;
      const hrPer100PA = p.pa ? (p.homeRuns / p.pa) * 100 : null;
      // Zone% alone is only a small ingredient. Heart/meatball and damage allowed drive the score.
      const zoneScore = zonePct === null ? 50 : clamp((zonePct - 40) / 15 * 100);
      const heartScore = heartPct === null ? 50 : clamp((heartPct - 18) / 18 * 100);
      const meatballScore = meatballPct === null ? 50 : clamp((meatballPct - 5) / 10 * 100);
      const barrelScore = barrelPct === null ? 50 : clamp((barrelPct - 4) / 12 * 100);
      const hardHitScore = hardHitPct === null ? 50 : clamp((hardHitPct - 25) / 30 * 100);
      const hardAirScore = hardAirPct === null ? 50 : clamp((hardAirPct - 12) / 25 * 100);
      const hrScore = hrPer100PA === null ? 50 : clamp((hrPer100PA - 1.5) / 5 * 100);
      const raw = zoneScore * .05 + heartScore * .20 + meatballScore * .20 + barrelScore * .20 + hardHitScore * .10 + hardAirScore * .10 + hrScore * .15;
      const reliability = Math.min(p.pa / 100, 1);
      const attackScore = 50 + reliability * (raw - 50);
      return {
        playerId: p.playerId, playerName: p.playerName, normalizedName: normalizePersonName(p.playerName), pitches: p.pitches, pa: p.pa, bbe: p.bbe,
        zonePct: round(zonePct), heartPct: round(heartPct), meatballPct: round(meatballPct),
        barrelPct: round(barrelPct), hardHitPct: round(hardHitPct), hardAirPct: round(hardAirPct),
        homeRuns: p.homeRuns, hrPer100PA: round(hrPer100PA), attackScore: round(clamp(attackScore), 0)
      };
    });

    const sampleDates = [...new Set(rows.slice(1, 31).map(r => normalizeGameDate(r[idx.game_date])).filter(Boolean))].slice(0, 10);
    const debug = {
      source: SAVANT_CSV,
      query: params.toString(),
      contentType: upstream.headers.get("content-type"),
      bytes: rawText.length,
      parsedRows: Math.max(0, rows.length - 1),
      pitcherCount: pitchers.length,
      headerCount: header.length,
      firstHeaders: header.slice(0, 15),
      sampleDates,
      samplePitchers: pitchers.slice(0, 5).map(x => ({ playerId: x.playerId, playerName: x.playerName, normalizedName: x.normalizedName, pitches: x.pitches, pa: x.pa }))
    };
    return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0, s-maxage=0" }, body: JSON.stringify({ startDate, endDate, days, pitchers, debug }) };
  } catch (error) {
    return { statusCode: 500, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: error?.message || "Pitcher Statcast request failed." }) };
  }
};
