import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Missing DATABASE_URL environment variable");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

const PORT = Number(process.env.PORT || 8080);
const MCP_PATH = "/mcp";

/**
 * Optional hardening for browser-based callers.
 * Leave ALLOWED_ORIGINS unset if you only expect server-to-server traffic.
 * Example:
 * ALLOWED_ORIGINS=https://example.com,https://chat.openai.com
 */
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

// Keep one server + transport per MCP session.
const sessions = new Map();

/** ---------- helpers ---------- */

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getSessionId(req) {
  return getHeader(req, "mcp-session-id");
}

function sendJsonRpcError(res, code, message, httpStatus = 400) {
  res.writeHead(httpStatus, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    })
  );
}

function applyCors(req, res) {
  const origin = getHeader(req, "origin");

  // No Origin header is common for server-to-server calls.
  if (!origin) {
    return true;
  }

  // If you set ALLOWED_ORIGINS, enforce it.
  if (ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;

  return JSON.parse(raw);
}

function safeSortBy(value) {
  const allowed = new Set(["full_name", "associated_company", "email"]);
  return allowed.has(value) ? value : "full_name";
}

function safeSortDir(value) {
  return String(value).toLowerCase() === "desc" ? "DESC" : "ASC";
}

function safeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

function safeOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** ---------- MCP server factory ---------- */

function createMcpServer() {
  const server = new McpServer({
    name: "contacts_mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "contacts_query",
    {
      title: "Contacts query",
      description: "Search, filter, sort, and list contacts from the company contacts database.",
      inputSchema: {
        mode: z
          .enum(["lookup", "filter", "list_companies", "list_contacts"])
          .describe("Type of contact query to run"),
        q: z.string().optional().default("").describe("Name, email, phone, or general search text"),
        company: z.string().optional().default("").describe("Company name filter"),
        sort_by: z
          .enum(["full_name", "associated_company", "email"])
          .optional()
          .default("full_name")
          .describe("Field to sort by"),
        sort_dir: z
          .enum(["asc", "desc"])
          .optional()
          .default("asc")
          .describe("Sort direction"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Maximum rows to return"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .default(0)
          .describe("Pagination offset"),
      },
    },
    async ({
      mode,
      q = "",
      company = "",
      sort_by = "full_name",
      sort_dir = "asc",
      limit = 10,
      offset = 0,
    }) => {
      const qText = String(q).trim();
      const companyText = String(company).trim();
      const sortBy = safeSortBy(sort_by);
      const sortDir = safeSortDir(sort_dir);
      const safeLim = safeLimit(limit);
      const safeOff = safeOffset(offset);

      try {
        if (mode === "lookup") {
          if (!qText) {
            return {
              content: [{ type: "text", text: "Missing lookup text." }],
              structuredContent: { rows: [] },
            };
          }

          const sql = `
            SELECT full_name, email, phone_number, associated_company
            FROM public.contacts
            WHERE full_name ILIKE $1
               OR email ILIKE $1
               OR phone_number ILIKE $1
               OR associated_company ILIKE $1
            ORDER BY full_name ASC
            LIMIT $2 OFFSET $3
          `;
          const result = await pool.query(sql, [`%${qText}%`, safeLim, safeOff]);

          return {
            content: [
              { type: "text", text: `Found ${result.rows.length} matching contact(s).` },
            ],
            structuredContent: { rows: result.rows },
          };
        }

        if (mode === "filter") {
          const searchCompany = companyText || qText;
          if (!searchCompany) {
            return {
              content: [{ type: "text", text: "Missing company filter." }],
              structuredContent: { rows: [] },
            };
          }

          const sql = `
            SELECT full_name, email, phone_number, associated_company
            FROM public.contacts
            WHERE associated_company ILIKE $1
            ORDER BY ${sortBy} ${sortDir}
            LIMIT $2 OFFSET $3
          `;
          const result = await pool.query(sql, [`%${searchCompany}%`, safeLim, safeOff]);

          return {
            content: [
              { type: "text", text: `Found ${result.rows.length} contact(s) for company filter.` },
            ],
            structuredContent: { rows: result.rows },
          };
        }

        if (mode === "list_companies") {
          const sql = `
            SELECT DISTINCT associated_company
            FROM public.contacts
            WHERE associated_company IS NOT NULL
              AND associated_company <> ''
            ORDER BY associated_company ASC
            LIMIT $1 OFFSET $2
          `;
          const result = await pool.query(sql, [safeLim, safeOff]);

          return {
            content: [
              {
                type: "text",
                text: `Returned ${result.rows.length} compan${result.rows.length === 1 ? "y" : "ies"}.`,
              },
            ],
            structuredContent: { rows: result.rows },
          };
        }

        if (mode === "list_contacts") {
          const sql = `
            SELECT full_name, email, phone_number, associated_company
            FROM public.contacts
            ORDER BY ${sortBy} ${sortDir}
            LIMIT $1 OFFSET $2
          `;
          const result = await pool.query(sql, [safeLim, safeOff]);

          return {
            content: [
              { type: "text", text: `Returned ${result.rows.length} contact(s).` },
            ],
            structuredContent: { rows: result.rows },
          };
        }

        return {
          content: [{ type: "text", text: `Unknown mode: ${mode}` }],
          structuredContent: { rows: [] },
        };
      } catch (error) {
        console.error("contacts_query failed:", error);
        return {
          content: [{ type: "text", text: "Database query failed." }],
          structuredContent: { rows: [] },
        };
      }
    }
  );

  return server;
}

/** ---------- HTTP server ---------- */

const httpServer = createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (!applyCors(req, res)) {
      res.writeHead(403).end("Forbidden origin");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("contacts mcp ok");
      return;
    }

    if (url.pathname === MCP_PATH && req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404).end("Not Found");
      return;
    }

    // POST /mcp
    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJsonRpcError(res, -32700, "Parse error", 400);
        return;
      }

      const sessionId = getSessionId(req);
      let session = sessionId ? sessions.get(sessionId) : undefined;

      // New session must begin with initialize
      if (!session) {
        if (sessionId) {
          sendJsonRpcError(res, -32001, "Invalid or expired session ID", 404);
          return;
        }

        if (!body || body.method !== "initialize") {
          sendJsonRpcError(res, -32000, "Initialize request required", 400);
          return;
        }

        const server = createMcpServer();
        let transport;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server, transport });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        await server.connect(transport);
        session = { server, transport };
      }

      await session.transport.handleRequest(req, res, body);
      return;
    }

    // GET /mcp or DELETE /mcp
    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = getSessionId(req);

      if (!sessionId) {
        sendJsonRpcError(res, -32000, "Missing Mcp-Session-Id header", 400);
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        sendJsonRpcError(res, -32001, "Invalid or expired session ID", 404);
        return;
      }

      await session.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end("Method Not Allowed");
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Internal server error");
    }
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Contacts MCP listening on http://0.0.0.0:${PORT}${MCP_PATH}`);
});
