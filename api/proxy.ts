// /api/proxy.ts – 통합 버전 (TLS 상수 제거)
// ------------------------------------------------------------
// EIASS 프록시 (Vercel Serverless / Node.js 18)
//   • HTTPS 실패 시 HTTP(80) 폴백
//   • Keep-Alive Dispatcher 로 원본 연결 재사용
//   • HTML 혼합-콘텐츠 수정, Early-Hints, 캐싱
// ------------------------------------------------------------

import type { VercelRequest, VercelResponse } from "vercel";
import https from "node:https";
import http from "node:http";

export const config = {
  regions: ["icn1"], // 한국 POP 고정
  maxDuration: 10
};

const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

/* Keep‑Alive Dispatcher */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxFreeSockets: 64,
  minVersion: "TLSv1", // EIASS 서버 구버전 TLS 대응
  maxVersion: "TLSv1.2"
});
const httpAgent = new http.Agent({ keepAlive: true, maxFreeSockets: 64 });

async function fetchWithFallback(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("[proxy] HTTPS failed – retry HTTP", httpURL);
      return await fetch(httpURL, { ...init, dispatcher: httpAgent, redirect: "follow" });
    }
    throw e;
  }
}

function rewriteHtml(html: string) {
  let modified = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");
  if (/<base[^>]+href=/i.test(modified)) {
    modified = modified.replace(/<base[^>]+href=["'][^"']+["']\s*\/?>/i, '<base href="https://www.eiass.go.kr/" />');
  } else {
    modified = modified.replace(/<head[^>]*?>/i, m => `${m}\n  <base href="https://www.eiass.go.kr/" />`);
  }
  const early: string[] = [];
  const linkRx = /<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const scriptRx = /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRx.exec(modified)) && early.length < 5) early.push(`${m[1]}; rel=preload; as=style`);
  while ((m = scriptRx.exec(modified)) && early.length < 5) early.push(`${m[1]}; rel=preload; as=script`);
  return { html: modified, early };
}

function isStatic(ct: string | null) {
  return !!ct && (/text\/css/.test(ct) || /javascript/.test(ct) || /image\//.test(ct));
}

export default async function proxy(req: VercelRequest, res: VercelResponse) {
  const raw = (req.query.url as string) || "";
  if (!raw) return res.status(400).send("Missing url");

  const upstreamURL = new URL(raw);
  if (!ALLOW_HOST.test(upstreamURL.hostname)) return res.status(403).send("Forbidden host");

  const dispatcher = upstreamURL.protocol === "https:" ? httpsAgent : httpAgent;
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as any,
    body: ["POST", "PUT", "PATCH"].includes(req.method || "") ? req : undefined,
    redirect: "follow",
    cache: "no-store",
    dispatcher
  };

  let upstream;
  try {
    upstream = await fetchWithFallback(upstreamURL.href, init);
  } catch (e: any) {
    console.error("[proxy] upstream error", e);
    return res.status(502).json({ error: e.message });
  }

  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");

  const ct = headers.get("content-type");
  if (isStatic(ct)) headers.set("cache-control", "public,max-age=86400,immutable");

  if (ct?.includes("text/html")) {
    const text = await upstream.text();
    const { html, early } = rewriteHtml(text);
    if (early.length) res.writeHead(103, { Link: early.join(", ") });
    headers.set("content-security-policy", "upgrade-insecure-requests");
    headers.set("content-length", Buffer.byteLength(html).toString());
    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res);
  else res.end();
}
