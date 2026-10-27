import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CalDAVClient } from "ts-caldav";
import { toAbsoluteUrl } from "./caldav-href.js";

export const listCalendarsDefinition = {
	description:
		"List all calendars returning both name and absolute URL. Pass a calendar's `url` unchanged as `calendarUrl` to the other tools.",
	inputSchema: {},
	name: "list-calendars",
	returns: "List of all available calendars",
} as const;

/**
 * Parses `CALDAV_EXTRA_CALENDARS`: a comma-separated list of names, server
 * paths, or URLs of additional collections whose calendars `list-calendars`
 * should include.
 */
export function parseExtraCalendars(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * Resolves an extra calendar entry to the collection to list. URLs and server
 * paths are used as given. A bare name (e.g. the EGroupware group `Default`)
 * is a sibling of the user's own calendar home, the layout EGroupware,
 * Nextcloud, and Radicale share: `/groupdav.php/<user>/` → `/groupdav.php/Default/`.
 */
export function resolveExtraCalendarHome(
	entry: string,
	calendarHome: string,
	baseUrl: string
): string {
	if (entry.includes("/")) {
		return new URL(entry, baseUrl).toString();
	}
	const home = new URL(calendarHome, baseUrl);
	if (!home.pathname.endsWith("/")) {
		home.pathname = `${home.pathname}/`;
	}
	return new URL(`../${encodeURIComponent(entry)}/`, home).toString();
}

type Calendar = Awaited<ReturnType<CalDAVClient["getCalendars"]>>[number];

/**
 * ts-caldav only lists the discovered calendar home, so point it at another
 * collection for one call. Callers must not run this concurrently.
 */
async function getCalendarsIn(
	client: CalDAVClient,
	collection: string
): Promise<Calendar[]> {
	const ownHome = client.calendarHome;
	client.calendarHome = collection;
	try {
		return await client.getCalendars();
	} finally {
		client.calendarHome = ownHome;
	}
}

async function collectCalendars(
	client: CalDAVClient,
	extraCalendars: readonly string[]
): Promise<Calendar[]> {
	const calendars = await client.getCalendars();
	const ownHome = client.calendarHome;
	if (!ownHome) {
		return calendars;
	}
	for (const entry of extraCalendars) {
		const collection = resolveExtraCalendarHome(entry, ownHome, client.baseUrl);
		try {
			// Sequential on purpose: getCalendarsIn swaps shared client state.
			// biome-ignore lint/performance/noAwaitInLoops: see above
			calendars.push(...(await getCalendarsIn(client, collection)));
		} catch (error) {
			console.error(
				`⚠️ Skipping extra calendar "${entry}" (${collection}):`,
				error
			);
		}
	}
	return calendars;
}

export async function registerListCalendars(
	client: CalDAVClient,
	server: McpServer,
	extraCalendars: readonly string[] = []
) {
	// ts-caldav returns server-relative hrefs; resolve them so agents don't
	// have to guess how to prefix the base URL. An extra calendar can also be
	// in the user's own home (e.g. shared via server settings), so dedupe.
	const byUrl = new Map<string, Calendar>();
	for (const calendar of await collectCalendars(client, extraCalendars)) {
		const url = toAbsoluteUrl(calendar.url, client.baseUrl);
		if (!byUrl.has(url)) {
			byUrl.set(url, { ...calendar, url });
		}
	}
	const calendars = [...byUrl.values()];

	server.registerTool(
		listCalendarsDefinition.name,
		{
			description: listCalendarsDefinition.description,
			inputSchema: listCalendarsDefinition.inputSchema,
		},
		async () => ({
			content: [{ text: JSON.stringify(calendars), type: "text" }],
		})
	);
}
