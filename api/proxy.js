// /api/proxy.js — Vercel Serverless Function
// 1안 적용: 전역 TLS 검증 비활성화 (테스트용)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import http from "http";
import https from "https";
import { constants } from "crypto";

// -----------------------------------------------------------------------------
// HTTPS / HTTP 에이전트 설정
// -----------------------------------------------------------------------------
const httpsAgent = new https.Agent({
  keepAlive: true,
  family: 4,                       // IPv4 우선
  rejectUnauthorized: false,       // 인증서 검증 OFF (NODE_TLS_REJECT_UNAUTHORIZED 로도 끔)
  minVersion: "TLSv1",            // 구형 TLS 허용
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
  ciphers: "DEFAULT@SECLEVEL=1"    // OpenSSL 보안 레벨 1
});

const httpAgent = new http.Agent({ keepAlive: true, family: 4 });

// -----------------------------------------------------------------------------
// 메인 핸들러
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  try {
    // -------------------------------------------------------------------------
    // 0) 요청 URL 파싱 및 호스트 필터링
    // -------------------------------------------------------------------------
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url parameter");

    const host = new URL(raw).hostname.trim().replace(/\.$/, "").toLowerCase();
    if (!host.endsWith("eiass.go.kr")) {
      return res.status(403).send("Forbidden host");
    }

    // -------------------------------------------------------------------------
    // 1) Upstream 요청 전송 (HEAD, GET, POST 등 그대로 전달)
    // -------------------------------------------------------------------------
    const upstream = await fetch(raw, {
      method: req.method,
      headers: {
        ...req.headers,
        host,                       // EIASS 서버가 Host 헤더 검사할 경우 대비
      },
      body: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
      agent: raw.startsWith("https") ? httpsAgent : httpAgent,
      redirect: "follow",
      cache: "no-store",
    });

    // -------------------------------------------------------------------------
    // 2) 응답 헤더 필터링 (X‑Frame‑Options / CSP 제거)
    // -------------------------------------------------------------------------
    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "x-frame-options" || k.startsWith("content-security")) return;
      res.setHeader(key, value);
    });

    // -------------------------------------------------------------------------
    // 3) 본문 전달 (buffer)
    // -------------------------------------------------------------------------
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error("proxy error:", e);
    res.status(500).send("Proxy error: " + e.message);
  }
}
