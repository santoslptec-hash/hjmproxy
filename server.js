const http = require("http");
const zlib = require("zlib");
const httpProxy = require("http-proxy");

const PORT = Number(process.env.PORT) || 10000;
const TARGET = process.env.TARGET_URL || "http://107.180.114.144";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hjmintl.com";
const PROXY_HOST = process.env.PROXY_HOST || PUBLIC_HOST;
const PROXY_SECURE = process.env.PROXY_SECURE !== "false";
const PROXY_VERSION = "rewrite-v2";

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

const escapedPublicHost = PUBLIC_HOST.replace(/\./g, "\\.");

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: false,
  xfwd: true,
  secure: PROXY_SECURE,
  preserveHeaderKeyCase: true,
  autoRewrite: false,
  protocolRewrite: "https",
  selfHandleResponse: true,
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

function ensureCharset(contentType) {
  if (typeof contentType !== "string") return contentType;
  const isText =
    /^text\//i.test(contentType) ||
    /^(application\/(javascript|json|xml)|image\/svg\+xml)/i.test(contentType);
  if (isText && !/charset=/i.test(contentType)) {
    return `${contentType}; charset=utf-8`;
  }
  return contentType;
}

function shouldRewriteBody(contentType) {
  if (typeof contentType !== "string") return false;
  return /text\/html|text\/css|application\/(javascript|json|xml)|image\/svg\+xml/i.test(
    contentType
  );
}

function rewriteBody(body, reqHost) {
  const host = reqHost || PUBLIC_HOST;
  const publicBase = `https://${host}`;
  return body
    .replace(new RegExp(`https?:\\/\\/(?:www\\.)?${escapedPublicHost}`, "gi"), publicBase)
    .replace(new RegExp(`\\/\\/(?:www\\.)?${escapedPublicHost}`, "gi"), `//${host}`)
    .replace(/http:\/\/(hjmproxy\.onrender\.com)/gi, "https://$1");
}

function rewriteCookie(cookie, reqHost) {
  if (reqHost.endsWith(".onrender.com")) {
    return cookie.replace(/;\s*Domain=[^;]*/i, "");
  }
  if (/;\s*Domain=/i.test(cookie)) {
    return cookie.replace(/;\s*Domain=[^;]*/i, `; Domain=.${PUBLIC_HOST}`);
  }
  return cookie;
}

function decompress(encoding, buffer) {
  return new Promise((resolve, reject) => {
    const enc = (encoding || "").toLowerCase();
    if (!enc || enc === "identity") {
      resolve(buffer);
      return;
    }
    if (enc.includes("gzip")) {
      zlib.gunzip(buffer, (err, out) => (err ? reject(err) : resolve(out)));
      return;
    }
    if (enc.includes("deflate")) {
      zlib.inflate(buffer, (err, out) => (err ? reject(err) : resolve(out)));
      return;
    }
    if (enc.includes("br")) {
      zlib.brotliDecompress(buffer, (err, out) => (err ? reject(err) : resolve(out)));
      return;
    }
    resolve(buffer);
  });
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
  proxyReq.setHeader(
    "x-real-ip",
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || ""
  );
  proxyReq.removeHeader("accept-encoding");
  proxyReq.setHeader("accept-encoding", "identity");
});

proxy.on("proxyRes", (proxyRes, req, res) => {
  const reqHost = (req.headers.host || PUBLIC_HOST).split(":")[0];
  const chunks = [];

  proxyRes.on("data", (chunk) => chunks.push(chunk));
  proxyRes.on("end", async () => {
    try {
      const raw = Buffer.concat(chunks);
      const encoding = proxyRes.headers["content-encoding"];
      let buffer = await decompress(encoding, raw);
      let contentType = ensureCharset(proxyRes.headers["content-type"]);

      if (shouldRewriteBody(contentType || "")) {
        const text = buffer.toString("utf8");
        buffer = Buffer.from(rewriteBody(text, reqHost), "utf8");
      }

      const headers = { ...proxyRes.headers };
      if (contentType) headers["content-type"] = contentType;
      delete headers["content-encoding"];
      delete headers["content-length"];
      delete headers["transfer-encoding"];

      if (headers.location) {
        headers.location = rewriteLocation(headers.location, reqHost);
      }

      if (Array.isArray(headers["set-cookie"])) {
        headers["set-cookie"] = headers["set-cookie"].map((cookie) =>
          rewriteCookie(cookie, reqHost)
        );
      }

      headers["content-length"] = String(buffer.length);
      headers["x-hjm-proxy"] = PROXY_VERSION;
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(buffer);
    } catch (err) {
      console.error("rewrite error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Gateway");
      }
    }
  });
});

const server = http.createServer((req, res) => {
  if (req.url === "/__health") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "x-hjm-proxy": PROXY_VERSION,
    });
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

