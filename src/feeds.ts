// Soma rows -> calendar events -> RFC 5545 text. Pure functions only.

export type Row = Record<string, any>;

/** One calendar entry. All-day: start/end are dates, end exclusive. Timed: UTC instants. */
export type CalEvent = {
	uid: string;
	summary: string;
	location?: string;
	stamp: string;
	allDay: boolean;
	start: string;
	end: string;
};

export const TZ = 'America/New_York';

const nyClock = new Intl.DateTimeFormat('en-CA', {
	timeZone: TZ,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23'
});

function newYork(instant: string) {
	const p = Object.fromEntries(
		nyClock.formatToParts(new Date(instant)).map((x) => [x.type, x.value])
	);
	return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}${p.minute}${p.second}` };
}

/** A date stays a date; an instant becomes its New York calendar day. */
const dayOf = (value: string) => (value.length === 10 ? value : newYork(value).date);

const nextDay = (date: string) =>
	new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function list(value: unknown): string[] {
	if (Array.isArray(value)) return value;
	try {
		return typeof value === 'string' ? JSON.parse(value) : [];
	} catch {
		return [];
	}
}

function allDay(
	row: Row,
	summary: string,
	first: string,
	last: string,
	location?: string
): CalEvent {
	return {
		uid: row.id,
		summary,
		...(location ? { location } : {}),
		stamp: row.updated_at,
		allDay: true,
		start: first,
		end: nextDay(last < first ? first : last)
	};
}

export const taskEvents = (rows: Row[]) =>
	rows
		.filter((r) => !r.deleted_at && ['To Do', 'In Progress'].includes(r.status) && r.due_date)
		.map((r) => allDay(r, r.title, dayOf(r.due_date), dayOf(r.due_date)));

export const tripEvents = (rows: Row[]) =>
	rows
		.filter((r) => !r.deleted_at && r.status !== 'Canceled' && r.start_on)
		.map((r) => {
			const where = list(r.cities).length ? list(r.cities) : list(r.countries);
			return allDay(r, r.name, r.start_on, r.end_on ?? r.start_on, where.join(', '));
		});

export const eventEvents = (rows: Row[]) =>
	rows
		.filter((r) => !r.deleted_at && r.status !== 'Canceled' && (r.start_at || r.date))
		.map((r): CalEvent => {
			if (!r.start_at) return allDay(r, r.title, r.date, r.date);
			const end =
				r.end_at && r.end_at > r.start_at
					? r.end_at
					: new Date(Date.parse(r.start_at) + 3_600_000).toISOString();
			return {
				uid: r.id,
				summary: r.title,
				stamp: r.updated_at,
				allDay: false,
				start: r.start_at,
				end
			};
		});

const VTIMEZONE = [
	'BEGIN:VTIMEZONE',
	`TZID:${TZ}`,
	'BEGIN:DAYLIGHT',
	'TZOFFSETFROM:-0500',
	'TZOFFSETTO:-0400',
	'TZNAME:EDT',
	'DTSTART:19700308T020000',
	'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
	'END:DAYLIGHT',
	'BEGIN:STANDARD',
	'TZOFFSETFROM:-0400',
	'TZOFFSETTO:-0500',
	'TZNAME:EST',
	'DTSTART:19701101T020000',
	'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
	'END:STANDARD',
	'END:VTIMEZONE'
];

const text = (s: string) =>
	s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const utc = (instant: string) =>
	new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

function when(name: 'DTSTART' | 'DTEND', event: CalEvent, value: string) {
	if (event.allDay) return `${name};VALUE=DATE:${value.replace(/-/g, '')}`;
	const local = newYork(value);
	return `${name};TZID=${TZ}:${local.date.replace(/-/g, '')}T${local.time}`;
}

const utf8 = new TextEncoder();

/** RFC 5545 3.1: lines over 75 octets continue on the next line after one space. */
function fold(line: string) {
	const out: string[] = [];
	let current = '';
	let octets = 0;
	for (const ch of line) {
		const n = utf8.encode(ch).length;
		if (octets + n > 75) {
			out.push(current);
			current = ' ';
			octets = 1;
		}
		current += ch;
		octets += n;
	}
	out.push(current);
	return out.join('\r\n');
}

export function buildIcs(name: string, events: CalEvent[]) {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Calendar Feeds//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${text(name)}`,
		`X-WR-TIMEZONE:${TZ}`,
		...VTIMEZONE,
		...events.flatMap((e) => [
			'BEGIN:VEVENT',
			`UID:${text(e.uid)}`,
			`DTSTAMP:${utc(e.stamp)}`,
			when('DTSTART', e, e.start),
			when('DTEND', e, e.end),
			`SUMMARY:${text(e.summary)}`,
			...(e.location ? [`LOCATION:${text(e.location)}`] : []),
			'END:VEVENT'
		]),
		'END:VCALENDAR'
	];
	return lines.map(fold).join('\r\n') + '\r\n';
}
