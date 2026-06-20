/**
 * HTTP mailbox endpoint (Phase 5): lets an external process inject steering
 * messages into a running orchestrator without touching files directly.
 *
 *   POST /steer   { "text": "..." }   -> 202
 *   POST /followup { "text": "..." }  -> 202
 *   GET  /state                      -> 200 (current state.json, minus runLog noise)
 *   GET  /healthz                    -> 200
 *
 * Messages are appended to `.pitm/mailbox.json`; the running orchestrator's
 * poller merges them into state and delivers via `session.steer()`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAILBOX_PATH, PITM_DIR, STATE_PATH } from "./config.ts";

export interface MailboxServerOptions {
	cwd?: string;
	port?: number;
	host?: string;
}

export interface MailboxServer {
	server: Server;
	port: number;
	close: () => Promise<void>;
}

export function startMailboxServer(opts: MailboxServerOptions = {}): Promise<MailboxServer> {
	const cwd = opts.cwd ?? process.cwd();
	const port = opts.port ?? 7331;
	const host = opts.host ?? "127.0.0.1";
	const mailboxPath = join(cwd, MAILBOX_PATH);
	const statePath = join(cwd, STATE_PATH);

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			handle(req, res, { cwd, mailboxPath, statePath }).catch((e) => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: (e as Error).message }));
			});
		});
		server.on("error", reject);
		server.listen(port, host, () => {
			resolve({
				server,
				port,
				close: () =>
					new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: { cwd: string; mailboxPath: string; statePath: string },
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "GET" && url.pathname === "/healthz") {
		return json(res, 200, { ok: true });
	}
	if (req.method === "GET" && url.pathname === "/state") {
		if (!existsSync(ctx.statePath)) return json(res, 404, { error: "no active run" });
		const raw = readFileSync(ctx.statePath, "utf8");
		return json(res, 200, JSON.parse(raw));
	}
	if (req.method === "POST" && (url.pathname === "/steer" || url.pathname === "/followup")) {
		const body = await readBody(req);
		let parsed: { text?: string };
		try {
			parsed = JSON.parse(body) as { text?: string };
		} catch {
			return json(res, 400, { error: "invalid JSON body" });
		}
		if (!parsed.text || !parsed.text.trim()) {
			return json(res, 400, { error: "missing \"text\"" });
		}
		appendMailbox(ctx.mailboxPath, ctx.cwd, parsed.text);
		return json(res, 202, { accepted: true, id: randomUUID() });
	}
	return json(res, 404, { error: "not found" });
}

function appendMailbox(mailboxPath: string, cwd: string, text: string): void {
	mkdirSync(join(cwd, PITM_DIR), { recursive: true });
	const existing = existsSync(mailboxPath)
		? (JSON.parse(readFileSync(mailboxPath, "utf8")) as unknown[])
		: [];
	existing.push({ id: randomUUID(), text, createdAt: new Date().toISOString() });
	appendFileSync(mailboxPath, JSON.stringify(existing, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c.toString()));
		req.on("end", () => resolve(data));
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
