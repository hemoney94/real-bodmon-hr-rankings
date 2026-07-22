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
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = "";
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function num(value) {
  // Baseball Savant leaves untracked measurements blank. Number("") is 0,
  // which previously treated every blank launch_speed as a 0-mph batted ball
  // and dragged average EV into the teens. Ignore blank/non-numeric values.
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text.toLowerCase() === "null" || text.toLowerCase() === "nan") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
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
    const days = Math.min(7, Math.max(3, Number(event.queryStringParameters?.days) || 5));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return { statusCode: 400, body: JSON.stringify({ error: "A valid slate date is required." }) };
    }

    // Exclude the selected slate date so in-progress games cannot distort the rankings.
    const endDate = addDays(date, -1);
    const startDate = addDays(date, -days);
    const params = new URLSearchParams({
      all: "true",
      type: "batter",
      player_type: "batter",
      game_date_gt: startDate,
      game_date_lt: endDate
    });

    const upstream = await fetch(`${SAVANT_CSV}?${params.toString()}`, {
      headers: {
        Accept: "text/csv,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; RealBodmonHR/5.0)"
      }
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 300);
      throw new Error(`Baseball Savant returned ${upstream.status}${detail ? `: ${detail}` : ""}`);
    }

    const csv = await upstream.text();
    const rows = parseCSV(csv);
    if (rows.length < 2) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
        body: JSON.stringify({ startDate, endDate, days, players: [] })
      };
    }

    const header = rows[0].map(h => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const required = ["batter", "launch_speed", "launch_angle", "launch_speed_angle", "events"];
    for (const col of required) {
      if (!(col in idx)) throw new Error(`Baseball Savant CSV is missing the ${col} column.`);
    }

    const byPlayer = new Map();
    const hitEvents = new Set(["single", "double", "triple", "home_run"]);

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const playerId = String(row[idx.batter] || "").trim();
      if (!playerId) continue;

      let p = byPlayer.get(playerId);
      if (!p) {
        p = {
          playerId,
          bbe: 0,
          barrels: 0,
          hardHit: 0,
          sweetSpot: 0,
          evSum: 0,
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

      p.bbe++;
      p.evSum += ev;
      p.maxEV = p.maxEV === null ? ev : Math.max(p.maxEV, ev);
      if (ev >= 95) p.hardHit++;
      if (quality === 6) p.barrels++;
      if (angle !== null && angle >= 8 && angle <= 32) p.sweetSpot++;
    }

    const players = [...byPlayer.values()].map(p => ({
      playerId: p.playerId,
      bbe: p.bbe,
      barrels: p.barrels,
      barrelPct: p.bbe ? round((p.barrels / p.bbe) * 100) : null,
      hardHitPct: p.bbe ? round((p.hardHit / p.bbe) * 100) : null,
      avgEV: p.bbe ? round(p.evSum / p.bbe) : null,
      maxEV: round(p.maxEV),
      sweetSpotPct: p.bbe ? round((p.sweetSpot / p.bbe) * 100) : null,
      hits: p.hits,
      homeRuns: p.homeRuns,
      extraBaseHits: p.extraBaseHits
    }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=900, s-maxage=900"
      },
      body: JSON.stringify({ startDate, endDate, days, players })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "Recent Statcast request failed." })
    };
  }
};
