// /api/proxy.ts – EIASS 프록시 (Vercel Serverless / Node 18)
// -----------------------------------------------------------------------------
// • CORS 해결 + Keep‑Alive + HTTP 폴백
// • sessiontime.do 는 항상 200 OK 로 바이패스 (스피너 멈춤)
// • .do Ajax 경로를 자동으로 프록시 경유로 변환
// -----------------------------------------------------------------------------
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
      console.warn("[proxy] HTTPS failed → retry HTTP", httpURL);
      return await fetch(httpURL, { ...init, dispatcher: httpDispatcher, redirect: "follow" });
    }
    throw err;
  }
}

function rewriteHtml(html: string) {
  // 1) 절대 http → https
  let mod = html.replace(/http:\/\/www\.eiass\.go\.kr/gi, "https://www.eiass.go.kr");

  // 2) 상대 .do 요청을 프록시 경유로 변환 (슬래시 유무 모두)
  mod = mod.replace(/(["'])(\/?[^"']*?\.do[^"']*)\1/gi,
    (_, q, p) => `${q}/api/proxy?url=http://www.eiass.go.kr/${p.replace(/^\/?/, "")}${q}`);

  // 3) <base> 고정/삽입
  if (/<base[^>]+href=/i.test(mod))
    mod = mod.replace(/<base[^>]+href=["'][^"']+["']\s*\/?>/i,
                      '<base href="https://www.eiass.go.kr/" />');
  else
    mod = mod.replace(/<head[^>]*?>/i,
                      m => `${m}\n  <base href="https://www.eiass.go.kr/" />`);

  // 4) preload 후보 추출 (상위 5개)
  const early: string[] = [];
  const rxCSS = /<link[^>]+rel=["']?stylesheet["']?[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const rxJS  = /<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = rxCSS.exec(mod)) && early.length < 5) early.push(`<${m[1]}>; rel=preload; as=style`);
  while ((m = rxJS.exec(mod))  && early.length < 5) early.push(`<${m[1]}>; rel=preload; as=script`);

  return { html: mod, early };
}

const isStatic = (ct: string | null) => !!ct && (/text\/css|javascript|image\//.test(ct || ""));

export default async function proxy(req: VercelRequest, res: VercelResponse) {
  const raw = (req.query.url as string) || "";
  if (!raw) return res.status(400).send("Missing url");

  const upstreamURL = new URL(raw);

  // ✨ sessiontime.do 는 바로 200 OK 반환해 스피너 제거
  if (/sessiontime\.do$/i.test(upstreamURL.pathname)) {
    return res.status(200).send("OK");
  }

  if (!ALLOW_HOST.test(upstreamURL.hostname)) return res.status(403).send("Forbidden host");

  const dispatcher = upstreamURL.protocol === "https:" ? httpsDispatcher : httpDispatcher;
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
  if (isStatic(headers.get("content-type")))
    headers.set("cache-control", "public,max-age=86400,immutable");

  if ((headers.get("content-type") || "").includes("text/html")) {
    const { html, early } = rewriteHtml(await upstream.text());
    if (early.length) headers.append("link", early.join(", "));
    headers.set("content-security-policy", "upgrade-insecure-requests");
    headers.set("content-length", Buffer.byteLength(html).toString());
    res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
    return res.end(html);
  }

  res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
  if (upstream.body) upstream.body.pipe(res); else res.end();
}
