const SAVANT_CSV = "https://baseballsavant.mlb.com/statcast_search/csv";

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
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
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
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
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const date = event.queryStringParameters?.date;
    const days = Math.min(10, Math.max(3, Number(event.queryStringParameters?.days) || 5));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return { statusCode: 400, body: JSON.stringify({ error: "A valid slate date is required." }) };
    }

    // Use the previous N calendar days, excluding the selected slate date.
    const endDate = addDays(date, -1);
    const startDate = addDays(date, -days);
    const params = new URLSearchParams({
      type: "details",
      player_type: "batter",
      game_date_gt: startDate,
      game_date_lt: endDate,
      hfGT: "R|",
      min_pitches: "0",
      min_results: "0",
      group_by: "name-date"
    });

    const upstream = await fetch(`${SAVANT_CSV}?${params.toString()}`, {
      headers: {
        Accept: "text/csv,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; RealBodmonHR/6.0)"
      }
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      throw new Error(`Baseball Savant returned ${upstream.status}${detail ? `: ${detail}` : ""}`);
    }

    const rawText = await upstream.text();
    const rows = parseCSV(rawText);
    if (rows.length < 2) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0, s-maxage=0" },
        body: JSON.stringify({ startDate, endDate, days, players: [] })
      };
    }

    const header = rows[0].map(h => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const required = ["game_date", "batter", "launch_speed", "launch_angle", "launch_speed_angle", "events", "bb_type", "player_name"];
    for (const col of required) {
      if (!(col in idx)) throw new Error(`Baseball Savant CSV is missing the ${col} column.`);
    }

    const byPlayer = new Map();
    const hitEvents = new Set(["single", "double", "triple", "home_run"]);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const gameDate = normalizeGameDate(row[idx.game_date]);
      // Savant occasionally ignores or broadens query filters. Enforce the window locally.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || gameDate < startDate || gameDate > endDate) continue;

      const playerId = String(row[idx.batter] || "").trim();
      if (!playerId) continue;

      let p = byPlayer.get(playerId);
      if (!p) {
        p = {
          playerId,
          playerName: String(row[idx.player_name] || "").trim(),
          bbe: 0,
          barrels: 0,
          hardHit: 0,
          ev100: 0,
          ev105: 0,
          ev110: 0,
          hardAir: 0,
          deepAir: 0,
          maxEV: null,
          hits: 0,
          homeRuns: 0,
          extraBaseHits: 0
        };
        byPlayer.set(playerId, p);
      }

      const eventName = String(row[idx.events] || "").trim();
      if (hitEvents.has(eventName)) p.hits++;
      if (eventName === "home_run") p.homeRuns++;
      if (["double", "triple", "home_run"].includes(eventName)) p.extraBaseHits++;

      const ev = num(row[idx.launch_speed]);
      if (ev === null) continue;
      const angle = num(row[idx.launch_angle]);
      const quality = num(row[idx.launch_speed_angle]);
      const bbType = String(row[idx.bb_type] || "").trim();
      const distance = idx.hit_distance_sc !== undefined ? num(row[idx.hit_distance_sc]) : null;

      p.bbe++;
      p.maxEV = p.maxEV === null ? ev : Math.max(p.maxEV, ev);
      if (ev >= 95) p.hardHit++;
      if (ev >= 100) p.ev100++;
      if (ev >= 105) p.ev105++;
      if (ev >= 110) p.ev110++;
      if (quality === 6) p.barrels++;

      const airborne = bbType === "fly_ball" || bbType === "line_drive" || (angle !== null && angle >= 10);
      if (airborne && ev >= 95) p.hardAir++;
      if (airborne && distance !== null && distance >= 380) p.deepAir++;
    }

    const players = [...byPlayer.values()].map(p => ({
      playerId: p.playerId,
      playerName: p.playerName,
      normalizedName: normalizePersonName(p.playerName),
      bbe: p.bbe,
      barrels: p.barrels,
      barrelPct: p.bbe ? round((p.barrels / p.bbe) * 100) : null,
      hardHitPct: p.bbe ? round((p.hardHit / p.bbe) * 100) : null,
      ev100: p.ev100,
      ev105: p.ev105,
      ev110: p.ev110,
      ev105Pct: p.bbe ? round((p.ev105 / p.bbe) * 100) : null,
      hardAir: p.hardAir,
      hardAirPct: p.bbe ? round((p.hardAir / p.bbe) * 100) : null,
      deepAir: p.deepAir,
      maxEV: round(p.maxEV),
      hits: p.hits,
      homeRuns: p.homeRuns,
      extraBaseHits: p.extraBaseHits
    }));

    const sampleDates = [...new Set(rows.slice(1, 31).map(r => normalizeGameDate(r[idx.game_date])).filter(Boolean))].slice(0, 10);
    const debug = {
      source: SAVANT_CSV,
      query: params.toString(),
      contentType: upstream.headers.get("content-type"),
      bytes: rawText.length,
      parsedRows: Math.max(0, rows.length - 1),
      playerCount: players.length,
      headerCount: header.length,
      firstHeaders: header.slice(0, 15),
      sampleDates,
      samplePlayers: players.slice(0, 5).map(x => ({ playerId: x.playerId, playerName: x.playerName, normalizedName: x.normalizedName, bbe: x.bbe }))
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, max-age=0, s-maxage=0"
      },
      body: JSON.stringify({ startDate, endDate, days, players, debug })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: error?.message || "Recent Statcast request failed." })
    };
  }
};
