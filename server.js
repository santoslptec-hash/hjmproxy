const http = require("http");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const httpProxy = require("http-proxy");

const PORT = Number(process.env.PORT) || 10000;
const TARGET = process.env.TARGET_URL || "http://107.180.114.144";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "hjmintl.com";
const PROXY_HOST = process.env.PROXY_HOST || PUBLIC_HOST;
const PROXY_SECURE = process.env.PROXY_SECURE !== "false";
const PROXY_TIMEOUT = Number(process.env.PROXY_TIMEOUT_MS) || 30000;
const MAX_REWRITE_BYTES = Number(process.env.MAX_REWRITE_BYTES) || 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = Number(process.env.MAX_REQUEST_BYTES) || 10 * 1024 * 1024;
const PROXY_VERSION = "rewrite-v5";

const targetUrl = new URL(TARGET);
const renderHost = process.env.RENDER_EXTERNAL_URL
  ? new URL(process.env.RENDER_EXTERNAL_URL).hostname.toLowerCase()
  : "";
const publicHosts = new Set(
  (process.env.PUBLIC_HOSTS || `${PUBLIC_HOST},www.${PUBLIC_HOST},${renderHost}`)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
const upstreamHosts = new Set(
  [targetUrl.host, targetUrl.hostname, PROXY_HOST]
    .filter(Boolean)
    .map((host) => host.toLowerCase())
);
const rewriteHosts = new Set([...upstreamHosts, ...publicHosts]);
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20, timeout: PROXY_TIMEOUT });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 20, timeout: PROXY_TIMEOUT });

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: false,
  xfwd: true,
  secure: PROXY_SECURE,
  proxyTimeout: PROXY_TIMEOUT,
  timeout: PROXY_TIMEOUT,
  agent: targetUrl.protocol === "https:" ? httpsAgent : httpAgent,
  selfHandleResponse: true,
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRequestHost(req) {
  return (req.headers.host || PUBLIC_HOST).split(":")[0].toLowerCase();
}

function rewriteLocation(location, requestHost) {
  if (!location) return location;
  try {
    const url = new URL(location, `https://${requestHost}`);
    if (!rewriteHosts.has(url.host.toLowerCase())) return location;
    url.protocol = "https:";
    url.host = requestHost;
    return url.toString();
  } catch {
    return location;
  }
}

function rewriteRequestUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (!publicHosts.has(url.hostname.toLowerCase())) return value;
    url.protocol = targetUrl.protocol;
    url.host = PROXY_HOST;
    return url.toString();
  } catch {
    return value;
  }
}

function isTextResponse(contentType) {
  return /^(text\/|application\/(javascript|json|xml|xhtml\+xml|[\w.+-]+\+(json|xml))|image\/svg\+xml)/i.test(
    contentType || ""
  );
}

function ensureCharset(contentType) {
  if (!contentType || !isTextResponse(contentType) || /charset=/i.test(contentType)) {
    return contentType;
  }
  return `${contentType}; charset=utf-8`;
}

function rewriteBody(body, requestHost) {
  const publicBase = `https://${requestHost}`;
  const hosts = [...upstreamHosts].map(escapeRegExp).join("|");
  if (!hosts) return body;
  return body
    .replace(new RegExp(`https?:\\/\\/(?:${hosts})`, "gi"), publicBase)
    .replace(new RegExp(`\\/\\/(?:${hosts})`, "gi"), `//${requestHost}`);
}

function rewriteHeaderValue(value, requestHost) {
  if (typeof value !== "string") return value;
  return rewriteBody(value, requestHost);
}

function rewriteCookie(cookie, requestHost) {
  if (requestHost.endsWith(".onrender.com")) {
    return cookie.replace(/;\s*Domain=[^;]*/i, "");
  }
  return cookie.replace(/;\s*Domain=[^;]*/i, `; Domain=.${PUBLIC_HOST}`);
}

function decompress(encoding, buffer) {
  const value = (encoding || "").toLowerCase();
  if (!value || value === "identity") return Promise.resolve(buffer);
  const method = value.includes("br")
    ? zlib.brotliDecompress
    : value.includes("gzip")
      ? zlib.gunzip
      : value.includes("deflate")
        ? zlib.inflate
        : null;
  if (!method) return Promise.resolve(buffer);
  return new Promise((resolve, reject) => {
    method(buffer, { maxOutputLength: MAX_REWRITE_BYTES }, (error, output) =>
      error ? reject(error) : resolve(output)
    );
  });
}

function createHeaders(proxyRes, requestHost, rewritten) {
  const headers = { ...proxyRes.headers };
  if (headers.location) headers.location = rewriteLocation(headers.location, requestHost);
  if (headers["content-security-policy"]) {
    headers["content-security-policy"] = rewriteHeaderValue(headers["content-security-policy"], requestHost);
  }
  if (headers["content-security-policy-report-only"]) {
    headers["content-security-policy-report-only"] = rewriteHeaderValue(
      headers["content-security-policy-report-only"],
      requestHost
    );
  }
  if (Array.isArray(headers["set-cookie"])) {
    headers["set-cookie"] = headers["set-cookie"].map((cookie) => rewriteCookie(cookie, requestHost));
  }
  if (rewritten) {
    delete headers["content-encoding"];
    delete headers["content-length"];
    delete headers["transfer-encoding"];
  }
  delete headers.server;
  delete headers["x-powered-by"];
  headers["x-content-type-options"] = "nosniff";
  headers["referrer-policy"] = "strict-origin-when-cross-origin";
  headers["permissions-policy"] = "geolocation=(), microphone=(), camera=()";
  headers["x-hjm-proxy"] = PROXY_VERSION;
  return headers;
}

proxy.on("error", (error, _req, res) => {
  console.error("proxy error:", error.message);
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
  proxyReq.setHeader("accept-encoding", "identity");
  proxyReq.setHeader("x-request-id", req.proxyRequestId);
  if (req.headers.origin) proxyReq.setHeader("origin", rewriteRequestUrl(req.headers.origin));
  if (req.headers.referer) proxyReq.setHeader("referer", rewriteRequestUrl(req.headers.referer));
});

proxy.on("proxyReqWs", (proxyReq) => proxyReq.setHeader("host", PROXY_HOST));

proxy.on("proxyRes", (proxyRes, req, res) => {
  const requestHost = getRequestHost(req);
  const contentType = proxyRes.headers["content-type"] || "";
  const contentLength = Number(proxyRes.headers["content-length"]);
  const rewriteResponse = isTextResponse(contentType) && (!contentLength || contentLength <= MAX_REWRITE_BYTES);

  if (!rewriteResponse) {
    const headers = createHeaders(proxyRes, requestHost, false);
    res.writeHead(proxyRes.statusCode || 200, headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks = [];
  let size = 0;
  let streamed = false;

  proxyRes.on("data", (chunk) => {
    if (streamed) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES) {
      streamed = true;
      const headers = createHeaders(proxyRes, requestHost, false);
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.write(Buffer.concat(chunks));
      proxyRes.pipe(res);
    }
  });
  proxyRes.on("end", async () => {
    if (streamed) return;
    try {
      let buffer = Buffer.concat(chunks);
      buffer = await decompress(proxyRes.headers["content-encoding"], buffer);
      buffer = Buffer.from(rewriteBody(buffer.toString("utf8"), requestHost), "utf8");
      const headers = createHeaders(proxyRes, requestHost, true);
      headers["content-type"] = ensureCharset(contentType);
      headers["x-request-id"] = req.proxyRequestId;

      if (![204, 304].includes(proxyRes.statusCode || 200) && req.method !== "HEAD") {
        headers["content-length"] = String(buffer.length);
      }
      headers["x-hjm-proxy"] = PROXY_VERSION;
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(req.method === "HEAD" ? undefined : buffer);
    } catch (error) {
      console.error("rewrite error:", error.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad Gateway");
      }
    }
  });
});

const server = http.createServer((req, res) => {
  req.proxyRequestId = crypto.randomUUID();
  res.setHeader("x-request-id", req.proxyRequestId);
  if (req.url === "/__health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "x-hjm-proxy": PROXY_VERSION });
    res.end("ok");
    return;
  }

  const host = getRequestHost(req);
  if (host && !publicHosts.has(host) && !host.endsWith(".onrender.com")) {
    res.writeHead(301, { Location: `https://${PUBLIC_HOST}${req.url || "/"}` });
    res.end();
    return;
  }
  const contentLength = Number(req.headers["content-length"]);
  if (contentLength > MAX_REQUEST_BYTES) {
    res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Payload Too Large");
    return;
  }
  proxy.web(req, res);
});

server.on("upgrade", (req, socket, head) => proxy.ws(req, socket, head));
server.headersTimeout = PROXY_TIMEOUT + 5000;
server.requestTimeout = PROXY_TIMEOUT + 5000;
server.keepAliveTimeout = 65000;
server.listen(PORT, "0.0.0.0", () => console.log(`listening on ${PORT} -> ${TARGET} host=${PROXY_HOST}`));
