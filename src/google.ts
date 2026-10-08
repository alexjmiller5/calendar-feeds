// One-way push of calendar events into Google Calendar (fetch-based, no SDK).
import { TZ, type CalEvent } from './feeds';

const API = 'https://www.googleapis.com/calendar/v3';
const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

export type GoogleEvent = {
	id: string;
	summary: string;
	location?: string;
	start: { date: string } | { dateTime: string; timeZone: string };
	end: { date: string } | { dateTime: string; timeZone: string };
	status: 'confirmed';
	extendedProperties: { private: { hash: string } };
};

export type ExistingEvent = {
	id: string;
	status: string;
	extendedProperties?: { private?: { hash?: string } };
};

export type GoogleSecrets = {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REFRESH_TOKEN: string;
};

/** Google event ids allow only base32hex (a-v, 0-9): encode the row id's UTF-8 bytes. */
export function googleEventId(rowId: string) {
	let out = '';
	let value = 0;
	let bits = 0;
	for (const byte of new TextEncoder().encode(rowId)) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32HEX[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	return bits ? out + BASE32HEX[(value << (5 - bits)) & 31] : out;
}

export async function toGoogleEvent(event: CalEvent): Promise<GoogleEvent> {
	const time = (value: string) =>
		event.allDay ? { date: value } : { dateTime: value, timeZone: TZ };
	const body = {
		id: googleEventId(event.uid),
		summary: event.summary,
		...(event.location ? { location: event.location } : {}),
		start: time(event.start),
		end: time(event.end),
		status: 'confirmed' as const
	};
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify(body))
	);
	const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return { ...body, extendedProperties: { private: { hash } } };
}

/** Cancelled events are Google's tombstones: revive them by update, never delete them again. */
export function planSync(desired: GoogleEvent[], existing: ExistingEvent[]) {
	const current = new Map(existing.map((e) => [e.id, e]));
	const wanted = new Set(desired.map((e) => e.id));
	return {
		insert: desired.filter((e) => !current.has(e.id)),
		update: desired.filter((e) => {
			const now = current.get(e.id);
			return (
				now &&
				(now.status === 'cancelled' ||
					now.extendedProperties?.private?.hash !== e.extendedProperties.private.hash)
			);
		}),
		remove: existing.filter((e) => e.status !== 'cancelled' && !wanted.has(e.id)).map((e) => e.id)
	};
}

export async function accessToken(env: GoogleSecrets) {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: 'refresh_token'
		})
	});
	if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { access_token: string }).access_token;
}

function send(token: string, method: string, path: string, body?: unknown) {
	return fetch(API + path, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body ? { 'content-type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
}

async function ok(res: Response, what: string) {
	if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
	return res;
}

/** The calendar id lives in KV; the first run creates the calendar. */
export async function ensureCalendar(
	state: KVNamespace,
	token: string,
	feed: string,
	name: string
) {
	const key = `calendar:${feed}`;
	const known = await state.get(key);
	if (known) return known;
	const res = await ok(
		await send(token, 'POST', '/calendars', {
			summary: name,
			timeZone: TZ,
			description:
				'Read-only mirror of Life Data, managed by Calendar Feeds. Edits here are overwritten.'
		}),
		`create calendar ${name}`
	);
	const { id } = (await res.json()) as { id: string };
	await state.put(key, id);
	return id;
}

export async function syncCalendar(token: string, calendarId: string, desired: GoogleEvent[]) {
	const events = `/calendars/${encodeURIComponent(calendarId)}/events`;
	const existing: ExistingEvent[] = [];
	let pageToken = '';
	do {
		const query = new URLSearchParams({
			showDeleted: 'true',
			maxResults: '2500',
			fields: 'items(id,status,extendedProperties),nextPageToken',
			...(pageToken ? { pageToken } : {})
		});
		const res = await ok(await send(token, 'GET', `${events}?${query}`), 'list events');
		const page = (await res.json()) as { items?: ExistingEvent[]; nextPageToken?: string };
		existing.push(...(page.items ?? []));
		pageToken = page.nextPageToken ?? '';
	} while (pageToken);

	const plan = planSync(desired, existing);
	for (const event of plan.insert) {
		let res = await send(token, 'POST', events, event);
		// An id Google still remembers (but did not list) takes an update instead.
		if (res.status === 409) res = await send(token, 'PUT', `${events}/${event.id}`, event);
		await ok(res, `insert ${event.id}`);
	}
	for (const event of plan.update)
		await ok(await send(token, 'PUT', `${events}/${event.id}`, event), `update ${event.id}`);
	for (const id of plan.remove) {
		const res = await send(token, 'DELETE', `${events}/${id}`);
		if (res.status !== 404 && res.status !== 410) await ok(res, `delete ${id}`);
	}
	return { inserted: plan.insert.length, updated: plan.update.length, removed: plan.remove.length };
}
