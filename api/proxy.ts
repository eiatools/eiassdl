// /api/proxy.ts  ─ EIASS 프록시 (Vercel Serverless / Node 18)
// -----------------------------------------------------------------
// ▸ 103 Early-Hints 제거            ▸ sessiontime.do 항상 200 패스
// -----------------------------------------------------------------

import type { VercelRequest, VercelResponse } from "vercel";
import { Agent as UndiciAgent } from "undici";

/* ── 0) 200 OK 응답 템플릿 ───────────────────────────────── */
const ok200 = new Response("OK", {
  status: 200,
  headers: { "content-type": "text/plain" }
});

/* ── 1) 기본 설정 ──────────────────────────────────────── */
export const config = { regions: ["icn1"], maxDuration: 10 };

const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;
const httpsDispatcher = new UndiciAgent({ keepAliveTimeout: 60_000 });
const httpDispatcher  = new UndiciAgent({ keepAliveTimeout: 60_000 });

/* ── 2) HTTPS 실패 → HTTP(80) 폴백 ───────────────────────── */
async function fetchWithFallback(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("[proxy] HTTPS failed → retry HTTP", httpURL);
      return await fetch(httpURL, { ...init, dispatcher: httpDispatcher, redirect: "follow" });
    }
    throw;
  }
}

/* ── 3) HTML 수정 + preload 링크 수집 ────────────────────── */
function rewriteHtml(html: string) {
  // 3-1) 절대 http:// → https://
  let mod = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");

  // 3-2) 상대 .do 경로 모두 프록시 경유로 변환
  mod = mod.replace(
    /(["'])(\/?[^"']*?\.do[^"']*)\1/gi,
    (_, q, p) => `${q}/api/proxy?url=http://www.eiass.go.kr/${p.replace(/^\/?/, "")}${q}`
  );

  // 3-3) <base> 고정/삽입
  if (/<base[^>]+href=/i.test(mod))
    mod = mod.replace(/<base[^>]+href=["'][^"']+["']\s*\/?>/i,
                      '<base href="https://www.eiass.go.kr/" />');
  else
    mod = mod.replace(/<head[^>]*?>/i,
                      m => `${m}\n  <base href="https://www.eiass.go.kr/" />`);

  // 3-4) preload 후보(상위 5개 CSS/JS)
  const early: string[] = [];
  const rxCSS = /<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const rxJS  = /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = rxCSS.exec(mod)) && early.length < 5) early.push(`<${m[1]}>; rel=preload; as=style`);
  while ((m = rxJS.exec(mod))  && early.length < 5) early.push(`<${m[1]}>; rel=preload; as=script`);

  return { html: mod, early };
}

/* ── 4) 유틸 ─────────────────────────────────────────────── */
const isStatic = (ct: string | null) =>
  !!ct && (/text\/css|javascript|image\//.test(ct || ""));

/* ── 5) 메인 핸들러 ──────────────────────────────────────── */
export default async function proxy(req: VercelRequest, res: VercelResponse) {
  const raw = (req.query.url as string) || "";
  if (!raw) return res.status(400).send("Missing url");

  const upstreamURL = new URL(raw);

  /* ★ sessiontime.do 는 바로 200 OK 반환 */
  if (/sessiontime\.do$/i.test(upstreamURL.pathname)) {
    return res.status(200).send("OK");   // (Response 객체 대신 Express 스타일)
  }

  if (!ALLOW_HOST.test(upstreamURL.hostname))
    return res.status(403).send("Forbidden host");

  const dispatcher = upstreamURL.protocol === "https:" ? httpsDispatcher : httpDispatcher;
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as any,
    body: ["POST","PUT","PATCH"].includes(req.method || "") ? req : undefined,
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
  if (isStatic(headers.get("content-type")))
    headers.set("cache-control", "public,max-age=86400,immutable");

  /* ─ HTML ─ */
  if ((headers.get("content-type") || "").includes("text/html")) {
    const { html, early } = rewriteHtml(await upstream.text());
    if (early.length) headers.append("link", early.join(", "));
    headers.set("content-security-policy", "upgrade-insecure-requests");
    headers.set("content-length", Buffer.byteLength(html).toString());

    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  /* ─ 그 외 형식 스트리밍 ─ */
  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res); else res.end();
}
