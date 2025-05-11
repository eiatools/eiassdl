// server.js
import express from 'express';
import fetch from 'node-fetch';

const app   = express();
const PORT  = 8080;          // 필요 시 변경

// ① 정적 파일 서빙  ──> public 폴더 안에 수정된 index.html 등 배치
app.use(express.static('public'));

// ② 프록시 엔드포인트 ──> X-Frame-Options & CSP 헤더 제거
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url 파라미터 필요');

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': req.headers['user-agent'] }
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (!/^(x-frame-options|content-security-policy)$/i.test(k))
        res.setHeader(k, v);
    });

    upstream.body.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(502).send('Proxy error');
  }
});

app.listen(PORT, () =>
  console.log(`🚀 Proxy server running →  http://localhost:${PORT}`)
);
