import { buildIcs, eventEvents, taskEvents, tripEvents, type CalEvent, type Row } from './feeds';
import {
	accessToken,
	ensureCalendar,
	syncCalendar,
	toGoogleEvent,
	type GoogleSecrets
} from './google';

type AppEnv = Env &
	GoogleSecrets & {
		SOMA_HUB_URL: string;
		SOMA_HUB_TOKEN: string;
		FEED_TOKEN_TASKS: string;
		FEED_TOKEN_TRIPS: string;
		FEED_TOKEN_EVENTS: string;
	};

type Feed = {
	name: string;
	table: string;
	columns: string[];
	events: (rows: Row[]) => CalEvent[];
	token: 'FEED_TOKEN_TASKS' | 'FEED_TOKEN_TRIPS' | 'FEED_TOKEN_EVENTS';
};

// Columns are exactly the Soma read grant (see AGENTS.md).
const FEEDS: Record<string, Feed> = {
	tasks: {
		name: 'Tasks',
		table: 'tasks',
		columns: ['id', 'title', 'status', 'due_date', 'updated_at', 'deleted_at'],
		events: taskEvents,
		token: 'FEED_TOKEN_TASKS'
	},
	trips: {
		name: 'Trips',
		table: 'trips',
		columns: [
			'id',
			'name',
			'status',
			'start_on',
			'end_on',
			'cities',
			'countries',
			'updated_at',
			'deleted_at'
		],
		events: tripEvents,
		token: 'FEED_TOKEN_TRIPS'
	},
	events: {
		name: 'Events',
		table: 'calendar_events',
		columns: ['id', 'title', 'status', 'date', 'start_at', 'end_at', 'updated_at', 'deleted_at'],
		events: eventEvents,
		token: 'FEED_TOKEN_EVENTS'
	}
};

const unset = (value: string | undefined) => !value || value === 'CHANGEME';

// A batched pull answers up to 5,000 rows (the hub's batch budget), so a feed
// is one or two requests instead of a 200-row page walk.
const BATCH_ROWS = 5000;

async function pullRows(env: AppEnv, feed: Feed) {
	const rows: Row[] = [];
	let after: string | undefined;
	do {
		const res = await fetch(`${env.SOMA_HUB_URL.replace(/\/$/, '')}/v1/rows/pull`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${env.SOMA_HUB_TOKEN}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				batch: [
					{
						table: feed.table,
						columns: feed.columns,
						since: '',
						limit: BATCH_ROWS,
						...(after ? { after } : {})
					}
				]
			})
		});
		if (!res.ok)
			throw new Error(`Soma pull ${feed.table} failed: ${res.status} ${await res.text()}`);
		const [page] = (
			(await res.json()) as { batch: Array<{ rows: Row[]; next_cursor: string | null }> }
		).batch;
		rows.push(...page.rows);
		after = page.next_cursor ?? undefined;
	} while (after);
	return feed.events(rows);
}

/** Compare digests so the check takes the same time however much of the token matches. */
async function sameSecret(given: string, expected: string) {
	if (unset(expected)) return false;
	const [a, b] = await Promise.all(
		[given, expected].map(
			async (s) =>
				new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
		)
	);
	return a.reduce((diff, byte, i) => diff | (byte ^ b[i]), 0) === 0;
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const name = url.pathname.match(/^\/feeds\/(\w+)\.ics$/)?.[1];
		const feed = name && Object.hasOwn(FEEDS, name) ? FEEDS[name] : undefined;
		if (request.method !== 'GET' || !feed) return new Response('Not found', { status: 404 });
		if (!(await sameSecret(url.searchParams.get('token') ?? '', env[feed.token])))
			return new Response('Unauthorized', { status: 401 });

		const cached = await caches.default.match(request);
		if (cached) return cached;
		const response = new Response(buildIcs(feed.name, await pullRows(env, feed)), {
			headers: {
				'content-type': 'text/calendar; charset=utf-8',
				'cache-control': 'public, max-age=300'
			}
		});
		ctx.waitUntil(caches.default.put(request, response.clone()));
		return response;
	},

	async scheduled(_controller, env) {
		if ([env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN].some(unset)) {
			console.log('Google push disabled: the Google OAuth secrets are not set');
			return;
		}
		const token = await accessToken(env);
		const failures: string[] = [];
		for (const [key, feed] of Object.entries(FEEDS)) {
			try {
				const calendarId = await ensureCalendar(env.STATE, token, key, feed.name);
				const desired = await Promise.all((await pullRows(env, feed)).map(toGoogleEvent));
				console.log(
					JSON.stringify({ feed: key, ...(await syncCalendar(token, calendarId, desired)) })
				);
			} catch (error) {
				failures.push(`${key}: ${error}`);
			}
		}
		if (failures.length) throw new Error(failures.join('\n'));
	}
} satisfies ExportedHandler<AppEnv>;
