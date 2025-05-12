export const config = { runtime: "edge" };

async function tryFetch(url: string, init: RequestInit) {
  try {
    return await fetch(url, init);           // 1차: HTTPS
  } catch (e) {
    if (url.startsWith("https://")) {
      const httpURL = "http://" + url.slice(8);
      console.warn("HTTPS failed, retry HTTP:", httpURL);
      return await fetch(httpURL, { ...init, redirect: "follow" });  // 2차: HTTP
    }
    throw e;   // HTTP도 실패하면 상위로 예외 전파
  }
}

export default async function handler(req: Request) {
  const raw = new URL(req.url).searchParams.get("url");
  if (!raw) return new Response("Missing url", { status: 400 });

  const init: RequestInit = {
    method: req.method,
    headers: req.headers,
    body: ["POST","PUT","PATCH"].includes(req.method!) ? req.body : null,
    redirect: "follow",
    cache: "no-store"
  };

  const upstream = await tryFetch(raw, init);      // ★ 폴백 사용

  const resHeaders = new Headers(upstream.headers);
  resHeaders.set("access-control-allow-origin", "*");

  return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
}
