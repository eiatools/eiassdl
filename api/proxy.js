// /api/proxy.js
import http from "http";
import https from "https";
import { constants } from "crypto";

const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,
  minVersion: "TLSv1",
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  rejectUnauthorized: false      // ← ★ 검증 OFF (테스트용)
});
const httpAgent = new http.Agent({ keepAlive: true, family: 4 });

export default async function handler(req, res) {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    const host = new URL(raw).hostname.trim().replace(/\.$/, "");
    if (!host.endsWith("eiass.go.kr"))
      return res.status(403).send("Forbidden host");

    const upstream = await fetch(raw, {
      method: req.method,
      headers: { ...req.headers, host },
      body: ["POST","PUT","PATCH"].includes(req.method) ? req.body : undefined,
      agent: raw.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "follow",
      cache: "no-store"
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security")) return;
      res.setHeader(k, v);
    });

    const data = await upstream.arrayBuffer();
    res.send(Buffer.from(data));
  } catch (e) {
    console.error("proxy error:", e);
    res.status(500).send("Proxy error: " + e.message);
  }
}
