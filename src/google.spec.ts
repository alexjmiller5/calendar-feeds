import { describe, expect, it } from 'vitest';
import { googleEventId, planSync, toGoogleEvent } from './google';

const stamp = '2026-10-08T12:00:00.000Z';

describe('googleEventId', () => {
	it('is the lowercase unpadded base32hex of the row id', () => {
		expect(googleEventId('abc')).toBe('c5h66');
	});

	it('always fits the Google id charset and stays stable and distinct', () => {
		const ids = ['3f003953a8af81c5ab68c404ccb2e97a', 'xyz', 'ChIJ-weird_ID.with/symbols'];
		for (const id of ids) {
			expect(googleEventId(id)).toMatch(/^[a-v0-9]{5,1024}$/);
			expect(googleEventId(id)).toBe(googleEventId(id));
		}
		expect(new Set(ids.map(googleEventId)).size).toBe(ids.length);
	});
});

describe('toGoogleEvent', () => {
	it('maps all-day and timed events, stamping a content hash', async () => {
		const day = await toGoogleEvent({
			uid: 'abc',
			summary: 'Trip',
			location: 'Paris',
			stamp,
			allDay: true,
			start: '2026-11-01',
			end: '2026-11-06'
		});
		expect(day).toMatchObject({
			id: 'c5h66',
			summary: 'Trip',
			location: 'Paris',
			status: 'confirmed',
			start: { date: '2026-11-01' },
			end: { date: '2026-11-06' }
		});
		const timed = await toGoogleEvent({
			uid: 'abc',
			summary: 'Call',
			stamp,
			allDay: false,
			start: '2026-10-10T14:00:00.000Z',
			end: '2026-10-10T15:00:00.000Z'
		});
		expect(timed.start).toEqual({
			dateTime: '2026-10-10T14:00:00.000Z',
			timeZone: 'America/New_York'
		});
		expect(timed.extendedProperties.private.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(timed.extendedProperties.private.hash).not.toBe(day.extendedProperties.private.hash);
	});

	it('ignores the row stamp so an untouched event keeps its hash', async () => {
		const base = {
			uid: 'abc',
			summary: 'Call',
			allDay: true,
			start: '2026-10-10',
			end: '2026-10-11'
		};
		const a = await toGoogleEvent({ ...base, stamp });
		const b = await toGoogleEvent({ ...base, stamp: '2026-10-09T00:00:00.000Z' });
		expect(a.extendedProperties.private.hash).toBe(b.extendedProperties.private.hash);
	});
});

describe('planSync', () => {
	const event = (id: string, hash: string) => ({
		id,
		summary: id,
		status: 'confirmed' as const,
		start: { date: '2026-10-10' },
		end: { date: '2026-10-11' },
		extendedProperties: { private: { hash } }
	});
	const existing = (id: string, status: string, hash?: string) => ({
		id,
		status,
		extendedProperties: hash ? { private: { hash } } : undefined
	});

	it('inserts new, updates changed or cancelled, skips unchanged, removes stale', () => {
		const plan = planSync(
			[event('new', 'h'), event('same', 'h'), event('changed', 'h2'), event('revived', 'h')],
			[
				existing('same', 'confirmed', 'h'),
				existing('changed', 'confirmed', 'h1'),
				existing('revived', 'cancelled', 'h'),
				existing('stale', 'confirmed', 'h'),
				existing('long-gone', 'cancelled', 'h')
			]
		);
		expect(plan.insert.map((e) => e.id)).toEqual(['new']);
		expect(plan.update.map((e) => e.id)).toEqual(['changed', 'revived']);
		expect(plan.remove).toEqual(['stale']);
	});
});
