/**
 * The public shared-product page is fully configurable per product. The shape is stored as
 * JSON on `Product.pageConfig`; this module is the single place that validates/normalises it
 * so a malformed or oversized payload from the admin UI can never reach the database.
 */
export interface ProductPageConfig {
    gallery: { url: string; caption?: string; w?: number; h?: number }[];
    highlights: { title: string; text?: string }[];
    details: { label: string; value: string }[];
    sections: { title: string; body: string }[];
    faqs: { q: string; a: string }[];
    priceLabel?: string;
    showPrice: boolean;
    ctaTitle?: string;
    ctaText?: string;
    accentColor?: string;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v: unknown, max: number): any[] => (Array.isArray(v) ? v.slice(0, max) : []);
const dim = (v: unknown): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < 20000 ? Math.round(n) : undefined;
};

export function sanitizePageConfig(input: unknown): ProductPageConfig {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>;

    const gallery = arr(raw.gallery, 24)
        .map((g) => ({ url: str(g?.url, 500), caption: str(g?.caption, 160) || undefined, w: dim(g?.w), h: dim(g?.h) }))
        .filter((g) => g.url);

    const highlights = arr(raw.highlights, 12)
        .map((h) => ({ title: str(h?.title, 100), text: str(h?.text, 400) || undefined }))
        .filter((h) => h.title);

    const details = arr(raw.details, 16)
        .map((d) => ({ label: str(d?.label, 60), value: str(d?.value, 160) }))
        .filter((d) => d.label && d.value);

    const sections = arr(raw.sections, 10)
        .map((s) => ({ title: str(s?.title, 100), body: str(s?.body, 4000) }))
        .filter((s) => s.title && s.body);

    const faqs = arr(raw.faqs, 15)
        .map((f) => ({ q: str(f?.q, 200), a: str(f?.a, 1500) }))
        .filter((f) => f.q && f.a);

    const color = str(raw.accentColor, 9);
    return {
        gallery,
        highlights,
        details,
        sections,
        faqs,
        priceLabel: str(raw.priceLabel, 40) || undefined,
        showPrice: raw.showPrice !== false,
        ctaTitle: str(raw.ctaTitle, 120) || undefined,
        ctaText: str(raw.ctaText, 300) || undefined,
        accentColor: /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined,
    };
}
