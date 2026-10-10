/** Shared helpers for lead-triggered WhatsApp automations (auto responder, nurturing). */

export interface ParamSpec { source: string; value?: string }

export const PARAM_SOURCES = [
    'static', 'lead.firstName', 'lead.lastName', 'lead.fullName', 'lead.source', 'lead.company', 'lead.enquiryAbout', 'org.name'
] as const;

export const resolveParams = (specs: ParamSpec[] | null | undefined, lead: any, orgName?: string): string[] =>
    (specs || []).map(s => {
        switch (s.source) {
            case 'static': return s.value || '-';
            case 'lead.firstName': return lead?.firstName || 'there';
            case 'lead.lastName': return lead?.lastName || '';
            case 'lead.fullName': return `${lead?.firstName || ''} ${lead?.lastName || ''}`.trim() || 'there';
            case 'lead.source': return String(lead?.source || '').replace(/_/g, ' ') || '-';
            case 'lead.company': return lead?.company || '-';
            case 'lead.enquiryAbout': return lead?.enquiryAbout || '-';
            case 'org.name': return orgName || '-';
            default: return s.value || '-';
        }
    });

export type WorkingHours = Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { start: string; end: string } | null>;

export const DEFAULT_WORKING_HOURS: WorkingHours = {
    mon: { start: '09:00', end: '18:00' }, tue: { start: '09:00', end: '18:00' }, wed: { start: '09:00', end: '18:00' },
    thu: { start: '09:00', end: '18:00' }, fri: { start: '09:00', end: '18:00' }, sat: { start: '09:00', end: '14:00' }, sun: null
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const localParts = (date: Date, timeZone: string) => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    const dayKey = (parts.weekday as string).slice(0, 3).toLowerCase() as typeof DAY_KEYS[number];
    const hh = parts.hour === '24' ? '00' : parts.hour;
    return { dayKey, minutes: Number(hh) * 60 + Number(parts.minute) };
};

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };

export const isWithinWorkingHours = (date: Date, hours: WorkingHours | null | undefined, timeZone: string): boolean => {
    if (!hours) return true;
    const { dayKey, minutes } = localParts(date, timeZone);
    const day = hours[dayKey];
    if (!day) return false;
    return minutes >= toMinutes(day.start) && minutes < toMinutes(day.end);
};

/** Earliest time >= `from` that falls inside working hours (searches up to 8 days in 15-minute steps). */
export const nextWorkingTime = (from: Date, hours: WorkingHours | null | undefined, timeZone: string): Date => {
    if (isWithinWorkingHours(from, hours, timeZone)) return from;
    for (let i = 1; i <= 8 * 96; i++) {
        const candidate = new Date(from.getTime() + i * 15 * 60_000);
        if (isWithinWorkingHours(candidate, hours, timeZone)) return candidate;
    }
    return from;
};
