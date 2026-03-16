import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
  name: "contacts-mcp",
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

server.registerTool(
  "contacts_query",
  {
    title: "Contacts query",
    description:
      "Search, filter, sort, and list contacts from the company contacts database.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["lookup", "filter", "list_companies", "list_contacts"],
          description: "Type of contact query to run",
        },
        q: {
          type: "string",
          description: "Name or general search text",
        },
        company: {
          type: "string",
          description: "Company name filter",
        },
        sort_by: {
          type: "string",
          enum: ["full_name", "associated_company", "email"],
          description: "Field to sort by",
        },
        sort_dir: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction",
        },
        limit: {
          type: "integer",
          description: "Maximum rows to return",
        },
        offset: {
          type: "integer",
          description: "Pagination offset",
        },
      },
      required: ["mode"],
    },
  },
  async ({ input }) => {
    const mode = input?.mode ?? "lookup";
    const q = String(input?.q ?? "").trim();
    const company = String(input?.company ?? "").trim();
    const sortBy = safeSortBy(input?.sort_by);
    const sortDir = safeSortDir(input?.sort_dir);
    const limit = safeLimit(input?.limit);
    const offset = safeOffset(input?.offset);

    try {
      if (mode === "lookup") {
        if (!q) {
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
        const result = await pool.query(sql, [`%${q}%`, limit, offset]);

        return {
          content: [
            {
              type: "text",
              text: `Found ${result.rows.length} matching contact(s).`,
            },
          ],
          structuredContent: { rows: result.rows },
        };
      }

      if (mode === "filter") {
        const searchCompany = company || q;
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
        const result = await pool.query(sql, [`%${searchCompany}%`, limit, offset]);

        return {
          content: [
            {
              type: "text",
              text: `Found ${result.rows.length} contact(s) for company filter.`,
            },
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
        const result = await pool.query(sql, [limit, offset]);

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
        const result = await pool.query(sql, [limit, offset]);

        return {
          content: [
            {
              type: "text",
              text: `Returned ${result.rows.length} contact(s).`,
            },
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
