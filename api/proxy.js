// /api/proxy.js
import http from "http";
import https from "https";
import { constants } from "crypto";

const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,                                // ★ IPv4만
  minVersion: "TLSv1",                      // ★ TLS 1.0까지 허용
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  rejectUnauthorized: false                // ★ 인증서 무시(테스트용)
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
      headers: {
        ...req.headers,
        host,
        "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
      agent: raw.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "follow",
      cache: "no-store",
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower === "x-frame-options" || lower.startsWith("content-security"))
        return;
      res.setHeader(k, v);
    });

    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error("proxy error:", e);         // ★ 스택 전체 로그
    res.status(500).send("Proxy error: " + e.message);
  }
}
