import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./github-handler";
import { registerPulseTools } from "./pulse-tools";

// Context from the auth process, encrypted & stored in the auth token and
// provided to the DurableMCP as this.props
type Props = {
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
		if (this.props!.login !== this.env.ALLOWED_GITHUB_LOGIN) {
			return;
		}

		registerPulseTools(this.server, this.env);
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
