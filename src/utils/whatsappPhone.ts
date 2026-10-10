import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';

export const digitsOnly = (phone: string | null | undefined): string => (phone || '').replace(/\D/g, '');

export const isValidWhatsAppNumber = (digits: string): boolean => /^[1-9]\d{7,14}$/.test(digits);

/** Phone variants under which older rows may have been stored (with and without "+"). */
export const phoneVariants = (phone: string): string[] => {
    const d = digitsOnly(phone);
    return Array.from(new Set([d, `+${d}`, phone]));
};

/**
 * Best-effort conversion of a CRM lead/contact phone into WhatsApp's digits-only
 * E.164 form. Local 10-digit numbers use the lead's own country code, falling
 * back to India (the CRM's primary market).
 */
export const toWhatsAppNumber = (
    phone: string | null | undefined,
    opts: { phoneCountryCode?: string | null; countryCode?: string | null } = {}
): string | null => {
    if (!phone) return null;
    const raw = String(phone).trim();
    const country = (opts.countryCode || 'IN') as CountryCode;
    try {
        const parsed = parsePhoneNumberFromString(raw.startsWith('+') ? raw : raw, country);
        if (parsed?.isValid()) return parsed.number.replace('+', '');
    } catch { /* fall through */ }

    const d = digitsOnly(raw);
    const cc = digitsOnly(opts.phoneCountryCode);
    if (cc && d.length >= 7 && d.length <= 11 && !d.startsWith(cc)) return `${cc}${d}`;
    return isValidWhatsAppNumber(d) ? d : null;
};
