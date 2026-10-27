import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CalDAVClient } from "ts-caldav";
import { describe, expect, test, vi } from "vitest";
import {
	listCalendarsDefinition,
	parseExtraCalendars,
	registerListCalendars,
	resolveExtraCalendarHome,
} from "./list-calendars.js";

type ToolHandler = () => Promise<{ content: { type: string; text: string }[] }>;

const calendar = (url: string, displayName = url) => ({
	displayName,
	supportedComponents: ["VEVENT"],
	url,
});

async function listCalendars(
	baseUrl: string,
	urls: string[],
	options: {
		calendarHome?: string;
		collections?: Record<string, string[]>;
		extraCalendars?: string[];
	} = {}
) {
	const ownHome = options.calendarHome ?? null;
	const mockClient = {
		baseUrl,
		calendarHome: ownHome,
		getCalendars: vi.fn(function (this: { calendarHome: string | null }) {
			if (this.calendarHome === ownHome) {
				return Promise.resolve(
					urls.map((url, i) => calendar(url, `Calendar ${i}`))
				);
			}
			const listed = options.collections?.[this.calendarHome ?? ""];
			if (!listed) {
				return Promise.reject(new Error(`404 ${this.calendarHome}`));
			}
			return Promise.resolve(listed.map((url) => calendar(url)));
		}),
	};
	let handler: ToolHandler | undefined;
	const server = {
		registerTool: (_name: string, _config: unknown, h: ToolHandler) => {
			handler = h;
		},
	};

	await registerListCalendars(
		mockClient as unknown as CalDAVClient,
		server as unknown as McpServer,
		options.extraCalendars
	);
	if (!handler) {
		throw new Error("list-calendars was not registered");
	}
	const result = await handler();
	return {
		calendars: JSON.parse(result.content[0]?.text ?? "") as {
			displayName: string;
			url: string;
		}[],
		client: mockClient,
	};
}

describe("registerListCalendars", () => {
	test("returns absolute calendar URLs resolved against the base URL", async () => {
		const { calendars } = await listCalendars(
			"https://cloud.example.com/remote.php/dav",
			[
				"/remote.php/dav/calendars/user/personal/",
				"/remote.php/dav/calendars/user/work/",
			]
		);

		expect(calendars).toEqual([
			expect.objectContaining({
				displayName: "Calendar 0",
				url: "https://cloud.example.com/remote.php/dav/calendars/user/personal/",
			}),
			expect.objectContaining({
				displayName: "Calendar 1",
				url: "https://cloud.example.com/remote.php/dav/calendars/user/work/",
			}),
		]);
	});

	test("keeps calendar URLs the server already returned as absolute", async () => {
		const url = "https://cloud.example.com/calendars/user/personal/";
		const {
			calendars: [first],
		} = await listCalendars("https://cloud.example.com", [url]);

		expect(first?.url).toBe(url);
	});

	test("tells agents to pass the URL back verbatim", () => {
		expect(listCalendarsDefinition.description).toContain("absolute URL");
		expect(listCalendarsDefinition.description).toContain("unchanged");
	});
});

const egwBase = "https://egw.example.com/egroupware/groupdav.php";
const egwHome = "https://egw.example.com/egroupware/groupdav.php/me/";

describe("extra calendars", () => {
	test("parses a comma-separated list, ignoring blanks", () => {
		expect(parseExtraCalendars(" Default, x ,,x1 ")).toEqual([
			"Default",
			"x",
			"x1",
		]);
		expect(parseExtraCalendars(undefined)).toEqual([]);
	});

	test("resolves a bare name as a sibling of the own calendar home", () => {
		expect(resolveExtraCalendarHome("Default", egwHome, egwBase)).toBe(
			"https://egw.example.com/egroupware/groupdav.php/Default/"
		);
		expect(
			resolveExtraCalendarHome(
				"Default",
				"/egroupware/groupdav.php/me",
				egwBase
			)
		).toBe("https://egw.example.com/egroupware/groupdav.php/Default/");
	});

	test("uses server paths and URLs as given", () => {
		expect(
			resolveExtraCalendarHome(
				"/egroupware/groupdav.php/Default/calendar/",
				egwHome,
				egwBase
			)
		).toBe("https://egw.example.com/egroupware/groupdav.php/Default/calendar/");
		expect(
			resolveExtraCalendarHome(
				"https://other.example.com/cal/",
				egwHome,
				egwBase
			)
		).toBe("https://other.example.com/cal/");
	});

	test("merges extra calendars into the list and dedupes them", async () => {
		const { calendars, client } = await listCalendars(
			egwBase,
			[
				"/egroupware/groupdav.php/me/calendar/",
				"/egroupware/groupdav.php/Default/calendar/",
			],
			{
				calendarHome: egwHome,
				collections: {
					"https://egw.example.com/egroupware/groupdav.php/Default/": [
						"/egroupware/groupdav.php/Default/calendar/",
					],
					"https://egw.example.com/egroupware/groupdav.php/x/": [
						"/egroupware/groupdav.php/x/calendar/",
					],
				},
				extraCalendars: ["Default", "x"],
			}
		);

		expect(calendars.map((c) => c.url)).toEqual([
			"https://egw.example.com/egroupware/groupdav.php/me/calendar/",
			"https://egw.example.com/egroupware/groupdav.php/Default/calendar/",
			"https://egw.example.com/egroupware/groupdav.php/x/calendar/",
		]);
		expect(client.calendarHome).toBe(egwHome);
	});

	test("skips an extra calendar that cannot be listed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { calendars, client } = await listCalendars(
			egwBase,
			["/egroupware/groupdav.php/me/calendar/"],
			{ calendarHome: egwHome, extraCalendars: ["missing"] }
		);

		expect(calendars).toHaveLength(1);
		expect(client.calendarHome).toBe(egwHome);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('"missing"'),
			expect.any(Error)
		);
	});
});
