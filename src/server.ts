import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  CRAWL_BINDING: Fetcher;
  R2: R2Bucket;
  TENANTS: AiSearchNamespace;
  ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "crawl-n-store",
    version: "1.0.0",
  });

  server.registerTool(
    "crawl_and_store",
    {
      description:
        "Crawl a website using Browser Run /crawl REST API, extract structured JSON, and store results in R2 organized by tenant.",
      inputSchema: {
        url: z.string().describe("The URL to crawl"),
        tenantId: z.string().describe("Tenant identifier for data isolation in R2"),
        prompt: z
          .string()
          .optional()
          .describe("Extraction prompt for structured JSON output. Omit to skip JSON extraction."),
        limit: z.number().optional().default(50),
        render: z.boolean().optional().default(false),
        source: z
          .enum(["sitemaps", "links", "both"])
          .optional()
          .default("sitemaps"),
        includePatterns: z
          .array(z.string())
          .optional()
          .describe("URL patterns to include in the crawl"),
      },
    },
    async (args) => {
      const { url, tenantId, prompt, limit, render, source, includePatterns } =
        args;

      const crawlBody: Record<string, unknown> = {
        url,
        render,
        source,
        limit,
        formats: ["json"],
      };

      if (prompt) {
        crawlBody.jsonOptions = {
          prompt,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "collection",
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  url: { type: "string" },
                  imageUrl: { type: "string" },
                  description: { type: ["string", "null"] },
                },
              },
            },
          },
        };
      }

      if (includePatterns) {
        crawlBody.options = { includePatterns };
      }

      // Start crawl job via REST API
      const startRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/browser-run/crawl`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(crawlBody),
        }
      );
      const startData = (await startRes.json()) as { success: boolean; result: string };
      const jobId = startData.result;

      // Poll for completion
      let records: Array<{
        url: string;
        json: Record<string, unknown> | null;
      }> = [];
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/browser-run/crawl/${jobId}`,
          {
            headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          }
        );
        const pollData = (await pollRes.json()) as {
          success: boolean;
          result: {
            status: string;
            records: Array<{
              url: string;
              json: Record<string, unknown> | null;
            }>;
          };
        };
        if (pollData.result.status === "completed") {
          records = pollData.result.records || [];
          break;
        }
      }

      // Store each record in R2 under tenant path
      const stored: string[] = [];
      for (const record of records) {
        if (!record.json) continue;
        const slug =
          new URL(record.url).pathname.replace(/\//g, "_").replace(/^_|_$/g, "") ||
          "index";
        const key = `${tenantId}/collections/${slug}.json`;
        await env.R2.put(key, JSON.stringify(record.json), {
          httpMetadata: { contentType: "application/json" },
        });
        stored.push(key);
      }

      // Store manifest with all collections as an array
      const allCollections = records
        .filter((r) => r.json)
        .map((r) => r.json!);
      await env.R2.put(
        `${tenantId}/collections.json`,
        JSON.stringify(allCollections),
        { httpMetadata: { contentType: "application/json" } }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Crawled ${records.length} pages. Stored ${stored.length} collections in R2 under ${tenantId}/collections/`,
          },
        ],
      };
    }
  );
    server.registerTool(
    "get_collections",
    {
      description:
        "Retrieve stored collections for a tenant directly from R2. No crawling — instant read from the bucket.",
      inputSchema: {
        tenantId: z.string().describe("Tenant identifier (merchant folder name in R2)"),
      },
    },
    async (args) => {
      const { tenantId } = args;

      const obj = await env.R2.get(`${tenantId}/collections.json`);
      const collections = await obj.json();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(collections),
          },
        ],
      };
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Fix Accept header so clients that don't send both content types still work
    const accept = request.headers.get("Accept") || "";
    if (
      !accept.includes("text/event-stream") ||
      !accept.includes("application/json")
    ) {
      const headers = new Headers(request.headers);
      headers.set("Accept", "application/json, text/event-stream");
      request = new Request(request, { headers });
    }
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
