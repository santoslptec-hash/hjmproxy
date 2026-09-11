const http = require("http");
const httpProxy = require("http-proxy");

const PORT = Number(process.env.PORT) || 10000;
const TARGET = process.env.TARGET_URL || "http://107.180.114.144";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hjmintl.com";
const PROXY_HOST = process.env.PROXY_HOST || PUBLIC_HOST;
const PROXY_SECURE = process.env.PROXY_SECURE !== "false";

const targetUrl = new URL(TARGET);
const publicHosts = new Set(
  (process.env.PUBLIC_HOSTS || `${PUBLIC_HOST},www.${PUBLIC_HOST}`)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

const rewriteHosts = new Set(
  [
    targetUrl.host,
    targetUrl.hostname,
    PROXY_HOST,
    PUBLIC_HOST,
    `www.${PUBLIC_HOST}`,
  ]
    .filter(Boolean)
    .map((h) => h.toLowerCase())
);

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: false,
  xfwd: true,
  secure: PROXY_SECURE,
  preserveHeaderKeyCase: true,
  autoRewrite: false,
  protocolRewrite: "https",
  headers: {
    host: PROXY_HOST,
  },
});

function rewriteLocation(location, reqHost) {
  if (!location) return location;
  try {
    const base = `https://${reqHost || PUBLIC_HOST}`;
    const url = new URL(location, base);
    if (rewriteHosts.has(url.host.toLowerCase())) {
      url.protocol = "https:";
      url.host = reqHost || PUBLIC_HOST;
      return url.toString();
    }
  } catch {
    return location;
  }
  return location;
}

proxy.on("error", (err, _req, res) => {
  console.error("proxy error:", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Gateway");
  } else if (res && typeof res.destroy === "function") {
    res.destroy();
  }
});

proxy.on("proxyReq", (proxyReq, req) => {
  proxyReq.setHeader("host", PROXY_HOST);
  proxyReq.setHeader("x-forwarded-host", req.headers.host || PUBLIC_HOST);
  proxyReq.setHeader("x-forwarded-proto", "https");
  proxyReq.setHeader("x-real-ip", req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");
});

proxy.on("proxyRes", (proxyRes, req) => {
  const reqHost = (req.headers.host || PUBLIC_HOST).split(":")[0];
  const location = proxyRes.headers.location;
  if (location) {
    proxyRes.headers.location = rewriteLocation(location, reqHost);
  }

  const cookies = proxyRes.headers["set-cookie"];
  if (Array.isArray(cookies)) {
    proxyRes.headers["set-cookie"] = cookies.map((cookie) => {
      if (/;\s*Domain=/i.test(cookie)) {
        return cookie.replace(/;\s*Domain=[^;]*/i, `; Domain=.${PUBLIC_HOST}`);
      }
      return cookie;
    });
  }
});

const server = http.createServer((req, res) => {
  if (req.url === "/__health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (host && !publicHosts.has(host) && !host.endsWith(".onrender.com")) {
    res.writeHead(301, {
      Location: `https://${PUBLIC_HOST}${req.url || "/"}`,
    });
    res.end();
    return;
  }

  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => {
  proxy.ws(req, socket, head);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on ${PORT} -> ${TARGET} host=${PROXY_HOST}`);
});
