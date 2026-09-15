const APP_VERSION = "2026.09.14";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://www.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firebaseinstallations.googleapis.com",
  "frame-src https://accounts.google.com https://*.firebaseapp.com",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function secureResponse(response, request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("Cache-Control", "no-store, max-age=0");
    headers.set("Pragma", "no-cache");
  }
  if (new URL(request.url).pathname.endsWith("/sw.js")) {
    headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    headers.set("Service-Worker-Allowed", "/");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function methodNotAllowed() {
  return json(
    { ok: false, error: "METHOD_NOT_ALLOWED" },
    405,
    { Allow: "GET, HEAD" },
  );
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed();
    }
    return json({
      ok: true,
      application: env.APP_KIND === "admin" ? "credmais-controle" : "credmais",
      version: APP_VERSION,
    });
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ ok: false, error: "NOT_FOUND" }, 404);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  if (env.APP_KIND === "admin" && url.pathname === "/") {
    return Response.redirect(new URL("/admin/", url), 302);
  }

  const assetResponse = await env.ASSETS.fetch(request);
  return assetResponse;
}

export {
  APP_VERSION,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  handleRequest,
  secureResponse,
};

export default {
  async fetch(request, env) {
    try {
      const response = await handleRequest(request, env);
      return secureResponse(response, request);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request_failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return secureResponse(
        json({ ok: false, error: "INTERNAL_ERROR" }, 500),
        request,
      );
    }
  },
};
