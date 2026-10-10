import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

const stamp = '2026-10-08T12:00:00.000Z';
const task = (id: string) => ({
	id,
	title: `Task ${id}`,
	status: 'To Do',
	due_date: '2026-10-10',
	updated_at: stamp,
	deleted_at: null
});

type Call = { method: string; url: string; body: any; auth: string | null };
let calls: Call[];
let hubRows: Record<string, any[]>;
let googleEvents: any[];
let cache: Map<string, Response>;

function kv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v)
	};
}

function makeEnv(google = false) {
	return {
		STATE: kv(),
		SOMA_HUB_URL: 'https://hub.test',
		SOMA_HUB_TOKEN: 'life-token',
		FEED_TOKEN_TASKS: 'tasks-token',
		FEED_TOKEN_TRIPS: 'trips-token',
		FEED_TOKEN_EVENTS: 'events-token',
		GOOGLE_CLIENT_ID: google ? 'client' : 'CHANGEME',
		GOOGLE_CLIENT_SECRET: google ? 'secret' : 'CHANGEME',
		GOOGLE_REFRESH_TOKEN: google ? 'refresh' : 'CHANGEME'
	} as any;
}

function ctx() {
	const pending: Promise<unknown>[] = [];
	return {
		pending,
		waitUntil: (p: Promise<unknown>) => void pending.push(p),
		passThroughOnException() {}
	} as any;
}

// One fake upstream for the Soma hub, Google OAuth and Google Calendar.
async function upstream(input: RequestInfo | URL, init?: RequestInit) {
	const request = new Request(input, init);
	const text = await request.text();
	const body =
		text && request.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
	const url = new URL(request.url);
	calls.push({
		method: request.method,
		url: request.url,
		body,
		auth: request.headers.get('authorization')
	});
	const json = (data: unknown, status = 200) => Response.json(data, { status });

	if (url.host === 'hub.test' && url.pathname === '/v1/rows/pull') {
		// A batched pull; two-row pages so pagination is exercised.
		const [pull] = body.batch;
		const rows = hubRows[pull.table] ?? [];
		const start = pull.after ? rows.findIndex((r) => r.id === pull.after) + 1 : 0;
		const page = rows.slice(start, start + 2);
		return json({
			batch: [{ rows: page, next_cursor: start + 2 < rows.length ? page.at(-1).id : null }]
		});
	}
	if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'access' });
	if (url.pathname === '/calendar/v3/calendars' && request.method === 'POST')
		return json({ id: `cal-${body.summary.toLowerCase()}` });
	if (url.pathname.endsWith('/events') && request.method === 'GET')
		return json({ items: googleEvents });
	if (url.pathname.includes('/events'))
		return request.method === 'DELETE' ? new Response(null, { status: 204 }) : json({});
	return new Response('unexpected', { status: 500 });
}

beforeEach(() => {
	calls = [];
	hubRows = {};
	googleEvents = [];
	cache = new Map();
	vi.stubGlobal('fetch', vi.fn(upstream));
	vi.stubGlobal('caches', {
		default: {
			match: async (r: Request) => cache.get(r.url)?.clone(),
			put: async (r: Request, res: Response) => void cache.set(r.url, res)
		}
	});
});
afterEach(() => vi.unstubAllGlobals());

const get = (path: string) => new Request(`https://calendar-feeds.example${path}`) as any;

describe('feed routes', () => {
	it('rejects a missing or wrong token and unknown feeds', async () => {
		const env = makeEnv();
		expect((await worker.fetch(get('/feeds/tasks.ics'), env, ctx())).status).toBe(401);
		expect((await worker.fetch(get('/feeds/tasks.ics?token=trips-token'), env, ctx())).status).toBe(
			401
		);
		expect((await worker.fetch(get('/feeds/notes.ics?token=tasks-token'), env, ctx())).status).toBe(
			404
		);
		expect((await worker.fetch(get('/'), env, ctx())).status).toBe(404);
		expect(calls).toEqual([]);
	});

	it('serves every page of eligible rows as text/calendar', async () => {
		hubRows.tasks = [task('a'), task('b'), task('c'), { ...task('d'), status: 'Completed' }];
		const res = await worker.fetch(get('/feeds/tasks.ics?token=tasks-token'), makeEnv(), ctx());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
		const body = await res.text();
		expect(body.match(/^UID:.*$/gm)).toEqual(['UID:a', 'UID:b', 'UID:c']);
		expect(calls.map((c) => c.body.batch[0].after ?? null)).toEqual([null, 'b']);
		expect(calls[0]).toMatchObject({
			method: 'POST',
			url: 'https://hub.test/v1/rows/pull',
			auth: 'Bearer life-token',
			body: {
				batch: [
					{
						table: 'tasks',
						since: '',
						limit: 5000,
						columns: ['id', 'title', 'status', 'due_date', 'updated_at', 'deleted_at']
					}
				]
			}
		});
	});

	it('serves a repeat request from the cache for five minutes', async () => {
		hubRows.trips = [];
		const env = makeEnv();
		const first = ctx();
		const a = await worker.fetch(get('/feeds/trips.ics?token=trips-token'), env, first);
		await Promise.all(first.pending);
		const b = await worker.fetch(get('/feeds/trips.ics?token=trips-token'), env, ctx());
		expect(a.headers.get('cache-control')).toBe('public, max-age=300');
		expect(await b.text()).toBe(await a.text());
		expect(calls).toHaveLength(1);
	});
});

describe('hourly Google push', () => {
	it('does nothing while the Google OAuth secrets are unset', async () => {
		await worker.scheduled({} as any, makeEnv(false));
		expect(calls).toEqual([]);
	});

	it('creates missing calendars once, upserts eligible rows and deletes stale events', async () => {
		hubRows.tasks = [task('abc')];
		googleEvents = [{ id: 'stale0', status: 'confirmed' }];
		const env = makeEnv(true);
		await worker.scheduled({} as any, env);

		const created = calls.filter((c) => c.url.endsWith('/calendar/v3/calendars'));
		expect(created.map((c) => c.body.summary)).toEqual(['Tasks', 'Trips', 'Events']);
		expect(created.every((c) => c.auth === 'Bearer access')).toBe(true);
		expect(Object.fromEntries(env.STATE.store)).toEqual({
			'calendar:tasks': 'cal-tasks',
			'calendar:trips': 'cal-trips',
			'calendar:events': 'cal-events'
		});
		const writes = calls.filter((c) => c.method === 'POST' && c.url.includes('/events'));
		expect(writes.map((c) => [c.url, c.body.id, c.body.summary])).toEqual([
			['https://www.googleapis.com/calendar/v3/calendars/cal-tasks/events', 'c5h66', 'Task abc']
		]);
		const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
		expect(deletes).toEqual([
			'https://www.googleapis.com/calendar/v3/calendars/cal-tasks/events/stale0',
			'https://www.googleapis.com/calendar/v3/calendars/cal-trips/events/stale0',
			'https://www.googleapis.com/calendar/v3/calendars/cal-events/events/stale0'
		]);

		calls = [];
		await worker.scheduled({} as any, env);
		expect(calls.filter((c) => c.url.endsWith('/calendar/v3/calendars'))).toEqual([]);
	});
});
