/** Built-in Instagram keyword chatbots ("system templates"). Cloning one creates an editable copy. */
export interface IgChatbotTemplate {
    key: string;
    name: string;
    description: string;
    keywords: string[];
    matchType: 'contains' | 'exact';
    chatWindowMinutes: number;
    messages: { text: string; buttons?: { title: string; url: string }[] }[];
}

export const IG_CHATBOT_TEMPLATES: IgChatbotTemplate[] = [
    {
        key: 'pricing_enquiry', name: 'Pricing Enquiry', description: 'Answers "price / cost / rates" DMs and points people to your price list.',
        keywords: ['price', 'pricing', 'cost', 'rates', 'how much'], matchType: 'contains', chatWindowMinutes: 120,
        messages: [{ text: 'Thanks for your interest! 🙌 Our prices depend on what you need. Here is our full price list:' }, { text: 'Tap below to see it, or reply here and our team will help you pick the right option.', buttons: [{ title: 'View pricing', url: 'https://example.com/pricing' }] }]
    },
    {
        key: 'book_a_call', name: 'Book a Call', description: 'Sends a booking link when someone asks for a demo, call or appointment.',
        keywords: ['book', 'demo', 'appointment', 'call me', 'consultation'], matchType: 'contains', chatWindowMinutes: 120,
        messages: [{ text: 'Happy to help! Pick a time that suits you and we will take it from there:', buttons: [{ title: 'Book a slot', url: 'https://example.com/book' }] }]
    },
    {
        key: 'location_hours', name: 'Location & Timings', description: 'Shares your address and opening hours.',
        keywords: ['location', 'address', 'where', 'timings', 'open'], matchType: 'contains', chatWindowMinutes: 180,
        messages: [{ text: '📍 You can find us at: <your address>' }, { text: '🕘 We are open: <your timings>. See you soon!' }]
    },
    {
        key: 'product_catalogue', name: 'Product Catalogue', description: 'Sends your catalogue link when someone asks what you offer.',
        keywords: ['catalogue', 'catalog', 'products', 'menu', 'collection'], matchType: 'contains', chatWindowMinutes: 120,
        messages: [{ text: 'Here is our latest collection 👇', buttons: [{ title: 'Open catalogue', url: 'https://example.com/catalogue' }] }]
    },
    {
        key: 'collab_partnership', name: 'Collab & Partnerships', description: 'Handles collaboration and partnership requests politely.',
        keywords: ['collab', 'collaboration', 'partnership', 'sponsor'], matchType: 'contains', chatWindowMinutes: 1440,
        messages: [{ text: 'Thanks for reaching out about a collaboration! 🤝' }, { text: 'Please share a few details about your idea and reach, and our team will get back to you.' }]
    },
    {
        key: 'free_guide', name: 'Free Guide Delivery', description: 'Delivers a lead magnet when someone DMs a keyword such as GUIDE.',
        keywords: ['guide', 'free', 'link', 'send'], matchType: 'exact', chatWindowMinutes: 1440,
        messages: [{ text: 'Here is your free guide 🎁', buttons: [{ title: 'Download', url: 'https://example.com/guide' }] }]
    }
];

export const getIgChatbotTemplate = (key: string) => IG_CHATBOT_TEMPLATES.find(t => t.key === key);
