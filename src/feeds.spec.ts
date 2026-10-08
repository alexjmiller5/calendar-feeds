import { describe, expect, it } from 'vitest';
import { buildIcs, eventEvents, taskEvents, tripEvents } from './feeds';

const stamp = '2026-10-08T12:00:00.000Z';
const live = { updated_at: stamp, deleted_at: null };

describe('taskEvents', () => {
	it('keeps every dated To Do or In Progress task as an all-day event', () => {
		const events = taskEvents([
			{ ...live, id: 'a', title: 'Pay rent', status: 'To Do', due_date: '2026-10-10' },
			{ ...live, id: 'b', title: 'Ship it', status: 'In Progress', due_date: '2026-10-31' }
		]);
		expect(events).toEqual([
			{
				uid: 'a',
				summary: 'Pay rent',
				stamp,
				allDay: true,
				start: '2026-10-10',
				end: '2026-10-11'
			},
			{ uid: 'b', summary: 'Ship it', stamp, allDay: true, start: '2026-10-31', end: '2026-11-01' }
		]);
	});

	it('drops undated, Completed, Canceled and deleted tasks', () => {
		const events = taskEvents([
			{ ...live, id: 'a', title: 'No date', status: 'To Do', due_date: null },
			{ ...live, id: 'b', title: 'Done', status: 'Completed', due_date: '2026-10-10' },
			{ ...live, id: 'c', title: 'Off', status: 'Canceled', due_date: '2026-10-10' },
			{
				...live,
				id: 'd',
				title: 'Gone',
				status: 'To Do',
				due_date: '2026-10-10',
				deleted_at: stamp
			}
		]);
		expect(events).toEqual([]);
	});

	it('puts a due instant on its New York calendar day', () => {
		const [event] = taskEvents([
			{ ...live, id: 'a', title: 'Late', status: 'To Do', due_date: '2026-10-10T02:30:00.000Z' }
		]);
		expect([event.start, event.end]).toEqual(['2026-10-09', '2026-10-10']);
	});
});

describe('tripEvents', () => {
	it('spans start_on through end_on with the destination as location', () => {
		const [event] = tripEvents([
			{
				...live,
				id: 't',
				name: 'France Nov 2026',
				status: 'Planned',
				start_on: '2026-11-01',
				end_on: '2026-11-05',
				cities: '["Paris","Lyon"]',
				countries: '["France"]'
			}
		]);
		expect(event).toEqual({
			uid: 't',
			summary: 'France Nov 2026',
			location: 'Paris, Lyon',
			stamp,
			allDay: true,
			start: '2026-11-01',
			end: '2026-11-06'
		});
	});

	it('falls back to countries, and to a single day without end_on', () => {
		const [event] = tripEvents([
			{
				...live,
				id: 't',
				name: 'Spain',
				status: 'Completed',
				start_on: '2026-03-31',
				end_on: null,
				cities: null,
				countries: '["Spain"]'
			}
		]);
		expect([event.location, event.start, event.end]).toEqual(['Spain', '2026-03-31', '2026-04-01']);
	});

	it('drops Canceled, undated and deleted trips', () => {
		const events = tripEvents([
			{ ...live, id: 'a', name: 'Off', status: 'Canceled', start_on: '2026-11-01', end_on: null },
			{ ...live, id: 'b', name: 'Someday', status: 'Someday', start_on: null, end_on: null },
			{
				...live,
				id: 'c',
				name: 'Gone',
				status: 'Planned',
				start_on: '2026-11-01',
				end_on: null,
				deleted_at: stamp
			}
		]);
		expect(events).toEqual([]);
	});
});

describe('eventEvents', () => {
	it('keeps timed events timed, defaulting a missing end to one hour', () => {
		const events = eventEvents([
			{
				...live,
				id: 'a',
				title: 'Dentist',
				status: 'Planned',
				date: '2026-10-10',
				start_at: '2026-10-10T14:00:00.000Z',
				end_at: '2026-10-10T15:30:00.000Z'
			},
			{
				...live,
				id: 'b',
				title: 'Call',
				status: 'To Do',
				date: null,
				start_at: '2026-10-11T14:00:00.000Z',
				end_at: null
			}
		]);
		expect(events.map((e) => [e.allDay, e.start, e.end])).toEqual([
			[false, '2026-10-10T14:00:00.000Z', '2026-10-10T15:30:00.000Z'],
			[false, '2026-10-11T14:00:00.000Z', '2026-10-11T15:00:00.000Z']
		]);
	});

	it('makes date-only events all-day and drops Canceled, undated and deleted ones', () => {
		const events = eventEvents([
			{
				...live,
				id: 'a',
				title: 'Fair',
				status: 'Completed',
				date: '2026-10-10',
				start_at: null,
				end_at: null
			},
			{
				...live,
				id: 'b',
				title: 'Off',
				status: 'Canceled',
				date: '2026-10-10',
				start_at: null,
				end_at: null
			},
			{
				...live,
				id: 'c',
				title: 'Someday',
				status: 'To Do',
				date: null,
				start_at: null,
				end_at: null
			},
			{
				...live,
				id: 'd',
				title: 'Gone',
				status: 'Planned',
				date: '2026-10-10',
				start_at: null,
				end_at: null,
				deleted_at: stamp
			}
		]);
		expect(events).toEqual([
			{ uid: 'a', summary: 'Fair', stamp, allDay: true, start: '2026-10-10', end: '2026-10-11' }
		]);
	});
});

describe('buildIcs', () => {
	const ics = buildIcs('Trips', [
		{
			uid: 'r1',
			summary: 'Lunch; with, friends\nand more',
			location: 'Paris, Lyon',
			stamp,
			allDay: true,
			start: '2026-11-01',
			end: '2026-11-06'
		},
		{
			uid: 'r2',
			summary: 'Dentist',
			stamp,
			allDay: false,
			start: '2026-10-10T14:00:00.000Z',
			end: '2026-10-10T15:30:00.000Z'
		}
	]);
	const lines = ics.split('\r\n');

	it('is a CRLF calendar with a New York VTIMEZONE', () => {
		expect(lines[0]).toBe('BEGIN:VCALENDAR');
		expect(lines.at(-2)).toBe('END:VCALENDAR');
		expect(lines.at(-1)).toBe('');
		expect(ics).not.toMatch(/[^\r]\n/);
		expect(lines).toContain('X-WR-CALNAME:Trips');
		expect(lines).toContain('BEGIN:VTIMEZONE');
		expect(lines).toContain('TZID:America/New_York');
	});

	it('writes UID, DTSTAMP and all-day dates with an exclusive end', () => {
		expect(lines).toContain('UID:r1');
		expect(lines).toContain('DTSTAMP:20261008T120000Z');
		expect(lines).toContain('DTSTART;VALUE=DATE:20261101');
		expect(lines).toContain('DTEND;VALUE=DATE:20261106');
		expect(lines).toContain('LOCATION:Paris\\, Lyon');
	});

	it('writes timed events in New York local time', () => {
		expect(lines).toContain('DTSTART;TZID=America/New_York:20261010T100000');
		expect(lines).toContain('DTEND;TZID=America/New_York:20261010T113000');
	});

	it('escapes text values', () => {
		expect(lines).toContain('SUMMARY:Lunch\\; with\\, friends\\nand more');
	});

	it('folds lines longer than 75 octets', () => {
		const long = buildIcs('Tasks', [
			{
				uid: 'x',
				summary: 'é'.repeat(100),
				stamp,
				allDay: true,
				start: '2026-10-10',
				end: '2026-10-11'
			}
		]);
		const folded = long.split('\r\n');
		expect(folded.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
		expect(long.replace(/\r\n /g, '')).toContain('SUMMARY:' + 'é'.repeat(100));
	});
});
