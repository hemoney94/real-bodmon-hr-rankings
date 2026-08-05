const { getStore } = require("@netlify/blobs");

// Automatic Blobs context injection isn't available in this environment,
// so the store is configured manually with a Site ID and access token.
// Set BLOBS_SITE_ID and BLOBS_TOKEN in Netlify's site environment variables
// (Site configuration > Environment variables).
function backtestStore() {
  return getStore({
    name: "backtest",
    siteID: process.env.BLOBS_SITE_ID,
    token: process.env.BLOBS_TOKEN
  });
}

// Trim each row down to only what the backtest needs. Keeping this small
// matters because a full slate can be 100+ players and we're writing one
// blob per day, potentially many times as the user re-runs through the day.
function trimRow(r) {
  return {
    playerId: r.playerId,
    playerName: r.playerName,
    team: r.team,
    battingPosition: r.battingPosition,
    isBench: !!r.isBench,
    pitcherName: r.pitcherName,
    matchupPct: r.matchupPct,
    adjustedPct: r.adjustedPct,
    finalPct: r.finalPct,
    formScore: r.formScore,
    recentBarrelPct: r.recent?.barrelPct ?? null,
    recentHardHitPct: r.recent?.hardHitPct ?? null,
    pitcherAttackScore: r.pitcherRecent?.attackScore ?? null,
    parkFactor: r.parkFactor,
    lineupOfficial: !!r.lineupOfficial
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  try {
    const body = JSON.parse(event.body || "{}");
    const date = body.date;
    const rankings = Array.isArray(body.rankings) ? body.rankings : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return { statusCode: 400, body: JSON.stringify({ error: "A valid date (YYYY-MM-DD) is required." }) };
    }
    if (!rankings.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "rankings array is empty." }) };
    }

    const store = backtestStore();
    const trimmed = rankings.map(trimRow);

    // Overwrite on every save for the day. The user typically re-runs a few
    // times as lineups go official, and we only want the most complete
    // snapshot (ideally the last run before first pitch) counted for
    // grading, not every intermediate version.
    await store.set(`rankings:${date}`, JSON.stringify({
      date,
      savedAt: new Date().toISOString(),
      count: trimmed.length,
      rows: trimmed
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, date, count: trimmed.length })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "Failed to log rankings." })
    };
  }
};
