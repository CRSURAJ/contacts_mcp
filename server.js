import { createServer } from "node:http";
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

const server = new McpServer({
  name: "contacts_mcp",
  version: "0.1.0",
});

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

const ContactsQueryInputSchema = z.object({
  mode: z.enum(["lookup", "filter", "list_companies", "list_contacts"]),
  q: z.string().optional().default(""),
  company: z.string().optional().default(""),
  sort_by: z.enum(["full_name", "associated_company", "email"]).optional().default("full_name"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("asc"),
  limit: z.number().int().min(1).max(50).optional().default(10),
  offset: z.number().int().min(0).optional().default(0),
});

server.registerTool(
  "contacts_query",
  {
    title: "Contacts query",
    description: "Search, filter, sort, and list contacts from the company contacts database.",
    inputSchema: ContactsQueryInputSchema,
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
             OR associated_company ILIKE $1
          ORDER BY full_name ASC
          LIMIT $2 OFFSET $3
        `;
        const result = await pool.query(sql, [`%${qText}%`, safeLim, safeOff]);

        return {
          content: [{ type: "text", text: `Found ${result.rows.length} matching contact(s).` }],
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
          content: [{ type: "text", text: `Found ${result.rows.length} contact(s) for company filter.` }],
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
          content: [{ type: "text", text: `Returned ${result.rows.length} compan${result.rows.length === 1 ? "y" : "ies"}.` }],
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
          content: [{ type: "text", text: `Returned ${result.rows.length} contact(s).` }],
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

const PORT = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("contacts mcp ok");
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`Contacts MCP listening on http://localhost:${PORT}${MCP_PATH}`);
});
