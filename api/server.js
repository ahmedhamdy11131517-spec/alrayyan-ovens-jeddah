"use strict";
const http = require("node:http");

const PIXEL_ID = process.env.TIKTOK_PIXEL_ID || "DBNR10RC77UBQ4PDO8DG";
const ACCESS_TOKEN = process.env.TIKTOK_EVENTS_TOKEN || "";
const SITE_ORIGIN = "https://alrayyan-ovens-jeddah.onrender.com";
const API_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const requestsByIp = new Map();
const RATE_LIMIT = 90;

function send(res, status, body, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Origin"
  };
  if (origin === SITE_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = SITE_ORIGIN;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
function trimmedText(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
function validateUrl(value, allowedHost) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || (allowedHost && parsed.origin !== SITE_ORIGIN)) return "";
    return parsed.toString().slice(0, 2048);
  } catch (_) { return ""; }
}
function rateLimited(ip) {
  const now = Date.now();
  if (requestsByIp.size > 5000) {
    for (const [key, entry] of requestsByIp) if (now - entry.start >= 60000) requestsByIp.delete(key);
  }
  const prior = requestsByIp.get(ip);
  if (!prior || now - prior.start >= 60000) {
    requestsByIp.set(ip, { start: now, count: 1 });
    return false;
  }
  prior.count += 1;
  return prior.count > RATE_LIMIT;
}
const server = http.createServer(async (req, res) => {
  const origin = trimmedText(req.headers.origin, 200);
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, tokenConfigured: Boolean(ACCESS_TOKEN), pixelConfigured: Boolean(PIXEL_ID) });
  }
  if (req.url !== "/event" || !["POST", "OPTIONS"].includes(req.method)) return send(res, 404, { error: "not_found" });
  if (origin !== SITE_ORIGIN) return send(res, 403, { error: "origin_denied" });
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  if (!trimmedText(req.headers["content-type"], 120).startsWith("application/json")) {
    return send(res, 415, { error: "json_only" }, origin);
  }
  if (!ACCESS_TOKEN) return send(res, 503, { error: "missing_server_credential" }, origin);
  const clientIp = trimmedText(req.headers["x-forwarded-for"], 300).split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (rateLimited(clientIp)) return send(res, 429, { error: "rate_limited" }, origin);
  let raw = "";
  try {
    for await (const chunk of req) {
      raw += chunk.toString("utf8");
      if (raw.length > 8192) return send(res, 413, { error: "too_large" }, origin);
    }
    const data = JSON.parse(raw);
    const eventName = data && data.event;
    const eventId = trimmedText(data && data.event_id, 128);
    const channel = trimmedText(data && data.channel, 20);
    const pageUrl = validateUrl(data && data.page_url, true);
    if (!["PageView", "ClickButton"].includes(eventName) ||
        !/^[a-zA-Z0-9._:-]{8,128}$/.test(eventId) || !pageUrl ||
        (eventName === "ClickButton" && !["phone", "whatsapp"].includes(channel))) {
      return send(res, 400, { error: "invalid_event" }, origin);
    }
    const user = {};
    if (clientIp !== "unknown" && clientIp.length <= 100) user.ip = clientIp;
    const userAgent = trimmedText(req.headers["user-agent"], 400);
    if (userAgent) user.user_agent = userAgent;
    const ttclid = trimmedText(data.ttclid, 512);
    if (/^[a-zA-Z0-9._-]{1,512}$/.test(ttclid)) user.ttclid = ttclid;
    const ttp = trimmedText(data.ttp, 512);
    if (/^[a-zA-Z0-9._-]{1,512}$/.test(ttp)) user.ttp = ttp;
    const entry = {
      event: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      user,
      page: { url: pageUrl }
    };
    const referrer = validateUrl(data.referrer, false);
    if (referrer) entry.page.referrer = referrer;
    if (eventName === "ClickButton") {
      entry.properties = {
        content_name: channel === "whatsapp" ? "WhatsApp" : "Phone Call",
        description: channel === "whatsapp" ? "whatsapp_click" : "phone_click"
      };
    }
    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Access-Token": ACCESS_TOKEN },
      body: JSON.stringify({ event_source: "web", event_source_id: PIXEL_ID, data: [entry] }),
      signal: AbortSignal.timeout(8000)
    });
    let response;
    try { response = await upstream.json(); } catch (_) { response = {}; }
    if (!upstream.ok || Number(response.code) !== 0) {
      console.error("TikTok Events API rejected event; HTTP", upstream.status, "code", response.code ?? "unknown");
      return send(res, 502, { error: "upstream_rejected" }, origin);
    }
    return send(res, 200, { ok: true }, origin);
  } catch (error) {
    if (error instanceof SyntaxError) return send(res, 400, { error: "invalid_json" }, origin);
    console.error("TikTok Events API relay error", error && error.name);
    return send(res, 502, { error: "forwarding_failed" }, origin);
  }
});
server.listen(Number(process.env.PORT) || 10000, "0.0.0.0", () => {
  console.log("TikTok Events API relay ready");
});
