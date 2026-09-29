
"use strict";

const express = require("express");
const http = require("http");
const https = require("https");
const httpProxy = require("http-proxy");

const app = express();
const server = http.createServer(app);

const TARGET = "https://tiktok-puanlama.onrender.com";
const TARGET_URL = new URL(TARGET);
const WORKING_ROOM = process.env.WORKING_ROOM || "MPRMBT";
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: true,
  xfwd: true
});

proxy.on("error", (err, req, res) => {
  console.error("[proxy]", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, {"Content-Type":"text/plain; charset=utf-8"});
    res.end("Çalışan TikTok sistemi şu anda yanıt vermiyor.");
  }
});

function targetPath(req) {
  // The working service uses panel.html?room=... .
  // We hide that room from the browser URL and force the known working room.
  if (req.path === "/" || req.path === "/connection" || req.path === "/panel.html") {
    return "/panel.html?room=" + encodeURIComponent(WORKING_ROOM);
  }
  return req.originalUrl || req.url;
}

function patchHtml(buffer) {
  let html = buffer.toString("utf8");

  // Force the working room inside browser-side URLSearchParams without exposing it in our URL.
  const inject = `<script>
  (() => {
    const _get = URLSearchParams.prototype.get;
    URLSearchParams.prototype.get = function(name) {
      if (name === "room") return ${JSON.stringify(WORKING_ROOM)};
      return _get.call(this, name);
    };
    const _has = URLSearchParams.prototype.has;
    URLSearchParams.prototype.has = function(name) {
      if (name === "room") return true;
      return _has.call(this, name);
    };
  })();
  </script>`;

  html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);

  // Keep navigation inside the proxy and strip the visible room parameter.
  html = html.replace(/https:\/\/tiktok-puanlama\.onrender\.com/gi, "");
  html = html.replace(/panel\.html\?room=MPRMBT/gi, "panel.html");
  html = html.replace(/\?room=MPRMBT/gi, "");

  return Buffer.from(html, "utf8");
}

function proxyHttp(req, res) {
  const path = targetPath(req);
  req.url = path;

  // Intercept only HTML pages so assets / scripts are byte-for-byte from the known working service.
  if (path.startsWith("/panel.html") || path === "/") {
    const headers = {
      ...req.headers,
      host: TARGET_URL.host
    };

    const options = {
      protocol: "https:",
      hostname: TARGET_URL.hostname,
      port: 443,
      path,
      method: req.method,
      headers
    };

    const upstream = https.request(options, (up) => {
      const chunks = [];
      up.on("data", c => chunks.push(c));
      up.on("end", () => {
        let body = Buffer.concat(chunks);
        const type = String(up.headers["content-type"] || "");
        if (type.includes("text/html")) {
          body = patchHtml(body);
        }

        const outHeaders = {...up.headers};
        delete outHeaders["content-length"];
        outHeaders["content-length"] = Buffer.byteLength(body);
        res.writeHead(up.statusCode || 200, outHeaders);
        res.end(body);
      });
    });

    upstream.on("error", (err) => {
      console.error("[html proxy]", err.message);
      if (!res.headersSent) {
        res.writeHead(502, {"Content-Type":"text/plain; charset=utf-8"});
      }
      res.end("Çalışan TikTok sistemi şu anda yanıt vermiyor.");
    });

    req.pipe(upstream);
    return;
  }

  proxy.web(req, res, {
    target: TARGET,
    prependPath: true,
    changeOrigin: true
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "working-system-proxy",
    roomHidden: true,
    workingRoomConfigured: Boolean(WORKING_ROOM)
  });
});

app.use((req, res) => proxyHttp(req, res));

server.on("upgrade", (req, socket, head) => {
  // Proxy Socket.IO/WebSocket traffic directly to the working system.
  proxy.ws(req, socket, head, {
    target: TARGET,
    changeOrigin: true,
    secure: true
  });
});

const PORT = Number(process.env.PORT || 10000);
server.listen(PORT, "0.0.0.0", () => {
  console.log("MS YAYIN proxy running on", PORT);
  console.log("Working system:", TARGET);
  console.log("Hidden working room:", WORKING_ROOM);
});
