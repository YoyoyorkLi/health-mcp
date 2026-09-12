import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./github-handler";
import { registerPulseTools } from "./pulse-tools";

// Context from the auth process, encrypted & stored in the auth token and
// provided to the DurableMCP as this.props
export type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

export class PulseCoachMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Pulse Health Coach",
		version: "1.0.0",
	});

	async init() {
		// Belt-and-suspenders: github-handler.ts already refuses to complete
		// the OAuth flow for anyone but ALLOWED_GITHUB_LOGIN, so this should
		// be unreachable with a non-matching login. Checked again here so a
		// bug in that gate fails closed (no tools registered) rather than
		// open (every GitHub user gets read access to the drinking log).
		//
		// This alone isn't enough, though: init() only re-runs when the
		// Durable Object (re)starts, not on every request, so it can't revoke
		// an already-warm session if ALLOWED_GITHUB_LOGIN is rotated later.
		// registerPulseTools() re-checks on every actual tool call to close
		// that gap -- this is the fail-closed check for a session that was
		// never valid in the first place.
		if (this.props!.login !== this.env.ALLOWED_GITHUB_LOGIN) {
			return;
		}

		registerPulseTools(this.server, this.env, this.props!);
	}
}

export default new OAuthProvider({
	apiHandler: PulseCoachMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
