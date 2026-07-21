const BASE = "https://www.ballparkpal.com/api/v1";
const ALLOWED = [
  /^\/games\?/, 
  /^\/matchups\?/, 
  /^\/projections\/averages\?/, 
  /^\/projections\/probabilities\?/, 
  /^\/parkfactors\/hitters\?/
];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { path, apiKey } = JSON.parse(event.body || "{}");
    if (!apiKey || typeof apiKey !== "string") {
      return { statusCode: 400, body: JSON.stringify({ error: "API key is required." }) };
    }
    if (!path || typeof path !== "string" || !ALLOWED.some(r => r.test(path))) {
      return { statusCode: 400, body: JSON.stringify({ error: "Unsupported Ballpark Pal path." }) };
    }

    const separator = path.includes("?") ? "&" : "?";
    const upstream = await fetch(`${BASE}${path}${separator}apiKey=${encodeURIComponent(apiKey)}`, {
      headers: { Accept: "application/json" }
    });
    const body = await upstream.text();

    return {
      statusCode: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store"
      },
      body
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: error?.message || "Proxy failed." })
    };
  }
};
