// /api/proxy.ts        (Serverless Function)
import https from "node:https";

export const config = { runtime: "nodejs18.x" };   // Edge 대신 Node

const agent = new https.Agent({
  keepAlive: true,
  minVersion: "TLSv1",          // TLS1.0까지 허용
  maxVersion: "TLSv1.2",
  secureOptions: https.constants.SSL_OP_LEGACY_SERVER_CONNECT
});

export default async function handler(req, res) {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send("Missing url");

    const upstream = await fetch(raw, {
      method: req.method,
      headers: req.headers,
      body: ["POST","PUT","PATCH"].includes(req.method) ? req : null,
      redirect: "follow",
      agent                 // (▲) 커스텀 Agent 전달
    });

    // 스트리밍 전달
    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
