// Cloudflare Worker — Anthropic API CORS proxy
// Nasadenie: dash.cloudflare.com → Workers & Pages → Create → paste this code

export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "x-api-key, anthropic-version, content-type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": request.headers.get("x-api-key") ?? "",
        "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
        "content-type": "application/json",
      },
      body: request.body,
    });

    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  },
};
