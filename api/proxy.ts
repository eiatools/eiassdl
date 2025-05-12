// /api/proxy.ts – EIASS 프록시 (Node.js 18, Vercel Serverless)
// -----------------------------------------------------------------------------
// 변경: 103 Early-Hints 제거 → 'Link' 헤더만 최종 응답에 포함하여
//        ERR_HTTP_HEADERS_SENT 문제 해결
// -----------------------------------------------------------------------------
/* 0) 최상단에 임시 응답 헬퍼 */
const ok200 = new Response("OK", {
  status: 200,
  headers: { "content-type": "text/plain" }
});

/* 1) 메인 핸들러 맨 앞쪽( fetch 호출 전에 ) */
if (/sessiontime\.do$/i.test(upstreamURL.pathname)) {
  return ok200;          // 세션 체크를 항상 통과시킴
}

import type { VercelRequest, VercelResponse } from "vercel";
import { Agent as UndiciAgent } from "undici";

export const config = {
  regions: ["icn1"],
  maxDuration: 10
};

const ALLOW_HOST = /(?:^|\.)eiass\.go\.kr$/i;

const httpsDispatcher = new UndiciAgent({ keepAliveTimeout: 60_000 });
const httpDispatcher  = new UndiciAgent({ keepAliveTimeout: 60_000 });

async function fetchWithFallback(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("[proxy] HTTPS failed – retry HTTP", httpURL);
      return await fetch(httpURL, { ...init, dispatcher: httpDispatcher, redirect: "follow" });
    }
    throw err;
  }
}

function rewriteHtml(html: string) {
  /* (1) 기존 http:// → https:// 치환 -------------------------------- */
  let modified = html.replace(/http:\/\/www\.eiass\.go\.kr/gi,
                              "https://www.eiass.go.kr");

  /* (2) .do 상대 URL을 모두 프록시 경유로 변환 ----------------------- */
  modified = modified.replace(
    // ① /search.do …   ② search.do …
    /(["'])(\/?[^"']*?\.do[^"']*)\1/gi,
    (_, q, path) =>
      `${q}/api/proxy?url=http://www.eiass.go.kr/${path.replace(/^\/?/, "")}${q}`
  );

  /* (3) <base> 태그 삽입·수정 ------------------------------------- */
  if (/<base[^>]+href=/i.test(modified)) {
    modified = modified.replace(
      /<base[^>]+href=["'][^"']+["']\s*\/?>/i,
      '<base href="https://www.eiass.go.kr/" />'
    );
  } else {
    modified = modified.replace(
      /<head[^>]*?>/i,
      m => `${m}\n  <base href="https://www.eiass.go.kr/" />`
    );
  }

  /* (4) Early-Hints용 preload 링크 추출 (그대로 유지) --------------- */
  const early: string[] = [];
  /* … (이하 기존 코드 그대로) … */

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

  const dispatcher = upstreamURL.protocol === "https:" ? httpsDispatcher : httpDispatcher;

  const init: RequestInit = {
    method:  req.method,
    headers: req.headers as any,
    body:    ["POST", "PUT", "PATCH"].includes(req.method || "") ? req : undefined,
    redirect: "follow",
    cache:    "no-store",
    dispatcher
  };

  let upstream;
  try {
    upstream = await fetchWithFallback(upstreamURL.href, init);
  } catch (e: any) {
    const msg = e.code ? `${e.code}: ${e.message}` : e.message;
    console.error("[proxy] upstream error", e);
    return res.status(502).json({ error: msg });
  }

  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");

  const ct = headers.get("content-type");
  if (isStatic(ct)) headers.set("cache-control", "public,max-age=86400,immutable");

  if (ct?.includes("text/html")) {
    const text = await upstream.text();
    const { html, early } = rewriteHtml(text);

    if (early.length) headers.append("link", early.join(", "));
    headers.set("content-security-policy", "upgrade-insecure-requests");
    headers.set("content-length", Buffer.byteLength(html).toString());

    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res);
  else res.end();
}
