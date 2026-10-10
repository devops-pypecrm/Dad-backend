/**
 * Built-in chatbot library. Each entry compiles into a standard WhatsAppFlow
 * graph (the same nodes/edges the visual editor and flow engine already use), so
 * a cloned bot can be edited freely in the flow editor.
 */
export interface ChatbotTemplate {
    key: string;
    name: string;
    category: string;
    badge: 'High Impact' | 'Useful' | 'Essential';
    benefit: string;
    description: string;
    tags: string[];
    triggerKeywords: string[];
    greeting: string;
    menu: { title: string; reply: string }[]; // max 3 (WhatsApp reply-button limit)
    capture: { prompt: string }[]; // asked in order after the menu choice
    closing: string;
}

const T = (t: ChatbotTemplate) => t;

export const CHATBOT_TEMPLATES: ChatbotTemplate[] = [
    T({ key: 'real_estate_lead_qualifier', name: 'Real Estate Lead Qualifier', category: 'Real Estate', badge: 'High Impact', benefit: '45% more site-visit bookings',
        description: 'Responds to "interested" keywords, qualifies budget and location, and books site visits automatically.', tags: ['Property', 'Real Estate'],
        triggerKeywords: ['interested', 'property', 'flat', 'apartment', 'villa'],
        greeting: 'Hi! Thanks for your interest in our properties. What are you looking for?',
        menu: [{ title: 'Buy a home', reply: 'Great! Let us find the right home for you.' }, { title: 'Invest', reply: 'Lovely, we have strong investment options.' }, { title: 'Book site visit', reply: 'Happy to arrange a visit.' }],
        capture: [{ prompt: 'What is your budget range?' }, { prompt: 'Which location do you prefer?' }, { prompt: 'What is your name?' }],
        closing: 'Thank you! Our property advisor will call you shortly to confirm the details.' }),
    T({ key: 'resale_property_enquiry', name: 'Resale Property Enquiry Bot', category: 'Real Estate', badge: 'Useful', benefit: '38% faster seller onboarding',
        description: 'Captures resale enquiries, collects seller details and schedules valuation calls.', tags: ['Real Estate', 'Resale'],
        triggerKeywords: ['resale', 'sell my property', 'valuation'],
        greeting: 'Hello! Are you looking to sell or buy a resale property?',
        menu: [{ title: 'I want to sell', reply: 'We can help you get the best price.' }, { title: 'I want to buy', reply: 'We have verified resale listings.' }, { title: 'Get valuation', reply: 'We offer a free valuation call.' }],
        capture: [{ prompt: 'Where is the property located?' }, { prompt: 'What is the approximate size and expected price?' }, { prompt: 'Your name, please?' }],
        closing: 'Thanks! A resale specialist will contact you to schedule the next step.' }),
    T({ key: 'rental_enquiry', name: 'Rental Enquiry Bot', category: 'Real Estate', badge: 'Useful', benefit: '2x faster tenant matching',
        description: 'Collects rental requirements and matches tenants with available listings.', tags: ['Rental', 'Real Estate'],
        triggerKeywords: ['rent', 'rental', 'lease', 'pg'],
        greeting: 'Hi! Looking for a place on rent? Tell us your preference.',
        menu: [{ title: '1 BHK / Studio', reply: 'We have several compact options.' }, { title: '2 BHK', reply: 'Plenty of 2 BHK homes available.' }, { title: '3 BHK or more', reply: 'We have spacious options too.' }],
        capture: [{ prompt: 'What is your monthly budget?' }, { prompt: 'Preferred locality?' }, { prompt: 'Your name?' }],
        closing: 'Thanks! We will share matching rentals with you shortly.' }),
    T({ key: 'hospital_appointment', name: 'Hospital Appointment Bot', category: 'Healthcare', badge: 'Essential', benefit: '50% reduction in reception load',
        description: 'Patients reply with a department keyword and the bot guides them to book a doctor appointment.', tags: ['Hospital', 'Healthcare'],
        triggerKeywords: ['appointment', 'doctor', 'book consultation'],
        greeting: 'Welcome! Which department would you like to book with?',
        menu: [{ title: 'General Medicine', reply: 'Sure, general medicine consultation.' }, { title: 'Paediatrics', reply: 'Booking a paediatrics consultation.' }, { title: 'Other department', reply: 'We will note your preferred department.' }],
        capture: [{ prompt: 'Patient name?' }, { prompt: 'Preferred date and time?' }, { prompt: 'Any symptoms we should note?' }],
        closing: 'Your request is received. Our front desk will confirm your slot shortly.' }),
    T({ key: 'clinic_followup', name: 'Clinic Follow-up Bot', category: 'Healthcare', badge: 'Useful', benefit: '30% fewer missed follow-ups',
        description: 'Collects follow-up visit requests and routes them to the clinic desk.', tags: ['Clinic', 'Healthcare'],
        triggerKeywords: ['follow up', 'follow-up', 'review visit'],
        greeting: 'Hello! Would you like to schedule a follow-up visit?',
        menu: [{ title: 'Schedule follow-up', reply: 'Let us set it up.' }, { title: 'Reschedule', reply: 'No problem, we can reschedule.' }, { title: 'Talk to staff', reply: 'Connecting you with our team.' }],
        capture: [{ prompt: 'Patient name?' }, { prompt: 'Preferred date and time?' }],
        closing: 'Thank you! The clinic will confirm your appointment.' }),
    T({ key: 'dental_booking', name: 'Dental Appointment Bot', category: 'Healthcare', badge: 'Useful', benefit: '35% more booked consultations',
        description: 'Handles dental enquiries and books check-ups, cleaning and treatments.', tags: ['Dental', 'Healthcare'],
        triggerKeywords: ['dentist', 'dental', 'teeth', 'braces'],
        greeting: 'Hi! How can our dental team help you today?',
        menu: [{ title: 'Check-up / cleaning', reply: 'A routine visit is a great idea.' }, { title: 'Braces / aligners', reply: 'We offer free orthodontic consultations.' }, { title: 'Tooth pain', reply: 'We will prioritise your visit.' }],
        capture: [{ prompt: 'Your name?' }, { prompt: 'Preferred date and time?' }],
        closing: 'Thanks! We will confirm your dental appointment shortly.' }),
    T({ key: 'diagnostic_lab', name: 'Diagnostic Lab Bot', category: 'Healthcare', badge: 'Useful', benefit: '40% faster test bookings',
        description: 'Takes home-collection and lab test bookings and shares package details.', tags: ['Lab', 'Diagnostics'],
        triggerKeywords: ['blood test', 'lab test', 'sample collection', 'health checkup'],
        greeting: 'Hello! Would you like to book a test or a health package?',
        menu: [{ title: 'Home collection', reply: 'We can collect samples at home.' }, { title: 'Visit the lab', reply: 'You can walk in at your convenience.' }, { title: 'Health packages', reply: 'We have packages for every age group.' }],
        capture: [{ prompt: 'Which tests do you need?' }, { prompt: 'Your name and area?' }],
        closing: 'Thank you! Our team will confirm your booking and timing.' }),
    T({ key: 'pharmacy_order', name: 'Pharmacy Order & Support Bot', category: 'Healthcare', badge: 'Useful', benefit: '40% faster order processing',
        description: 'Handles medicine availability queries, prescription uploads and home-delivery orders.', tags: ['Pharmacy', 'Medicine'],
        triggerKeywords: ['medicine', 'pharmacy', 'prescription'],
        greeting: 'Welcome to our pharmacy! How can we help?',
        menu: [{ title: 'Order medicines', reply: 'Please share the medicine names or a prescription photo.' }, { title: 'Check availability', reply: 'We will check stock for you.' }, { title: 'Delivery status', reply: 'Let us look up your order.' }],
        capture: [{ prompt: 'Medicine names or order number?' }, { prompt: 'Delivery address?' }, { prompt: 'Your name?' }],
        closing: 'Thanks! A pharmacist will confirm availability and delivery details shortly.' }),
    T({ key: 'salon_booking', name: 'Salon & Spa Booking Bot', category: 'Beauty', badge: 'Useful', benefit: '3x more weekday bookings',
        description: 'Books salon and spa services and shares the price list.', tags: ['Salon', 'Spa'],
        triggerKeywords: ['salon', 'haircut', 'spa', 'facial'],
        greeting: 'Hi! Ready for a fresh look? What would you like?',
        menu: [{ title: 'Hair services', reply: 'Great choice!' }, { title: 'Skin & facial', reply: 'Lovely, we have several treatments.' }, { title: 'Spa & massage', reply: 'Relaxation coming up.' }],
        capture: [{ prompt: 'Preferred date and time?' }, { prompt: 'Your name?' }],
        closing: 'Thank you! We will confirm your slot shortly.' }),
    T({ key: 'restaurant_reservation', name: 'Restaurant Reservation Bot', category: 'Food & Beverage', badge: 'Useful', benefit: '25% fewer no-shows',
        description: 'Takes table reservations and answers menu and timing questions.', tags: ['Restaurant', 'Reservations'],
        triggerKeywords: ['table', 'reservation', 'book a table'],
        greeting: 'Welcome! How can we help you today?',
        menu: [{ title: 'Reserve a table', reply: 'We would love to host you.' }, { title: 'View menu', reply: 'Our menu is available on request.' }, { title: 'Timings & location', reply: 'Happy to share our details.' }],
        capture: [{ prompt: 'How many guests?' }, { prompt: 'Preferred date and time?' }, { prompt: 'Name for the booking?' }],
        closing: 'Thanks! We will confirm your reservation shortly.' }),
    T({ key: 'education_admissions', name: 'Admissions Enquiry Bot', category: 'Education', badge: 'High Impact', benefit: '50% more counselling calls booked',
        description: 'Answers course questions, captures student details and books counselling calls.', tags: ['Education', 'Admissions'],
        triggerKeywords: ['admission', 'course', 'enroll', 'fees'],
        greeting: 'Hello! Thanks for your interest. What would you like to know?',
        menu: [{ title: 'Courses offered', reply: 'We offer a range of programmes.' }, { title: 'Fees & scholarships', reply: 'We will share the fee structure.' }, { title: 'Talk to counsellor', reply: 'Our counsellor will help you.' }],
        capture: [{ prompt: 'Which course are you interested in?' }, { prompt: 'Your qualification and year of passing?' }, { prompt: 'Your name?' }],
        closing: 'Thank you! A counsellor will reach out to you soon.' }),
    T({ key: 'coaching_enrolment', name: 'Coaching Enrolment Bot', category: 'Education', badge: 'Useful', benefit: '35% higher demo-class attendance',
        description: 'Books demo classes and collects enrolment details for coaching centres.', tags: ['Coaching', 'Education'],
        triggerKeywords: ['demo class', 'coaching', 'batch'],
        greeting: 'Hi! Would you like to attend a free demo class?',
        menu: [{ title: 'Book demo class', reply: 'Great, let us schedule it.' }, { title: 'Batch timings', reply: 'We will share the available batches.' }, { title: 'Fee details', reply: 'Happy to share the fees.' }],
        capture: [{ prompt: 'Student name and grade?' }, { prompt: 'Preferred subject?' }],
        closing: 'Thanks! Our team will confirm your demo class.' }),
    T({ key: 'gym_membership', name: 'Gym Membership Bot', category: 'Fitness', badge: 'Useful', benefit: '30% more trial sign-ups',
        description: 'Shares plans, books free trials and captures membership leads.', tags: ['Gym', 'Fitness'],
        triggerKeywords: ['gym', 'membership', 'fitness', 'trial'],
        greeting: 'Hey! Ready to start your fitness journey?',
        menu: [{ title: 'Membership plans', reply: 'We have flexible plans.' }, { title: 'Free trial', reply: 'Book a free trial session.' }, { title: 'Personal training', reply: 'Our trainers are happy to help.' }],
        capture: [{ prompt: 'Your name?' }, { prompt: 'Your fitness goal?' }],
        closing: 'Thanks! Our team will get in touch to confirm.' }),
    T({ key: 'insurance_quote', name: 'Insurance Quote Bot', category: 'Finance', badge: 'High Impact', benefit: '40% more qualified quotes',
        description: 'Collects basic details and routes insurance enquiries to the right advisor.', tags: ['Insurance', 'Finance'],
        triggerKeywords: ['insurance', 'policy', 'premium', 'quote'],
        greeting: 'Hello! Which insurance are you looking for?',
        menu: [{ title: 'Health insurance', reply: 'We will compare the best plans.' }, { title: 'Life / term', reply: 'Let us find a suitable cover.' }, { title: 'Motor insurance', reply: 'We can quote your vehicle quickly.' }],
        capture: [{ prompt: 'Your age and city?' }, { prompt: 'Any existing cover?' }, { prompt: 'Your name?' }],
        closing: 'Thank you! An advisor will share quotes shortly.' }),
    T({ key: 'loan_enquiry', name: 'Loan Enquiry Bot', category: 'Finance', badge: 'Useful', benefit: '35% faster lead qualification',
        description: 'Pre-qualifies loan enquiries by amount and purpose before handing to the team.', tags: ['Loans', 'Finance'],
        triggerKeywords: ['loan', 'emi', 'finance'],
        greeting: 'Hi! What kind of loan are you interested in?',
        menu: [{ title: 'Personal loan', reply: 'We can help with quick approvals.' }, { title: 'Home loan', reply: 'We have competitive home loan options.' }, { title: 'Business loan', reply: 'Let us understand your needs.' }],
        capture: [{ prompt: 'Required loan amount?' }, { prompt: 'Your monthly income?' }, { prompt: 'Your name?' }],
        closing: 'Thanks! A loan specialist will contact you soon.' }),
    T({ key: 'travel_packages', name: 'Travel Packages Bot', category: 'Travel', badge: 'Useful', benefit: '30% more trip enquiries converted',
        description: 'Shares destinations, captures travel dates and group size, and books consultations.', tags: ['Travel', 'Holidays'],
        triggerKeywords: ['trip', 'holiday', 'tour', 'package'],
        greeting: 'Hello! Where would you like to travel?',
        menu: [{ title: 'Domestic trips', reply: 'We have lovely domestic packages.' }, { title: 'International', reply: 'Great, let us plan it.' }, { title: 'Honeymoon', reply: 'Romantic escapes coming up.' }],
        capture: [{ prompt: 'Preferred destination and travel dates?' }, { prompt: 'Number of travellers?' }, { prompt: 'Your name?' }],
        closing: 'Thanks! Our travel expert will share a custom itinerary.' }),
    T({ key: 'car_test_drive', name: 'Car Test Drive Bot', category: 'Automotive', badge: 'High Impact', benefit: '40% more test drives booked',
        description: 'Captures model interest and schedules showroom test drives.', tags: ['Automotive', 'Dealership'],
        triggerKeywords: ['test drive', 'car', 'showroom'],
        greeting: 'Hi! Interested in taking a test drive?',
        menu: [{ title: 'Book test drive', reply: 'Let us schedule it.' }, { title: 'Models & prices', reply: 'We will share the latest prices.' }, { title: 'Exchange / finance', reply: 'We have attractive offers.' }],
        capture: [{ prompt: 'Which model are you interested in?' }, { prompt: 'Preferred date and time?' }, { prompt: 'Your name?' }],
        closing: 'Thank you! The showroom will confirm your test drive.' }),
];

export const getChatbotTemplate = (key: string) => CHATBOT_TEMPLATES.find(t => t.key === key);

/** Compile a template into React-Flow style nodes/edges used by the flow editor & engine. */
export function buildFlowFromTemplate(t: ChatbotTemplate): { nodes: any[]; edges: any[] } {
    const nodes: any[] = [];
    const edges: any[] = [];
    let edgeN = 0;
    const edge = (source: string, target: string, sourceHandle?: string) =>
        edges.push({ id: `e${++edgeN}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) });

    const menu = t.menu.slice(0, 3);
    nodes.push({
        id: 'start', type: 'buttons', position: { x: 0, y: 160 },
        data: { label: 'Greeting', message: t.greeting, buttons: menu.map((m, i) => ({ id: `opt${i + 1}`, title: m.title.slice(0, 20) })) }
    });

    // each menu choice -> its reply -> shared capture chain
    const captureIds = t.capture.map((_, i) => `capture${i + 1}`);
    const firstShared = captureIds[0] || 'handoff';
    menu.forEach((m, i) => {
        const id = `reply${i + 1}`;
        nodes.push({ id, type: 'message', position: { x: 320, y: i * 160 }, data: { label: m.title, message: m.reply } });
        edge('start', id, `opt${i + 1}`);
        edge(id, firstShared);
    });

    t.capture.forEach((c, i) => {
        nodes.push({ id: captureIds[i], type: 'form_input', position: { x: 640 + i * 300, y: 160 }, data: { label: `Ask ${i + 1}`, message: c.prompt } });
        edge(captureIds[i], captureIds[i + 1] || 'handoff');
    });

    nodes.push({ id: 'handoff', type: 'agent_handoff', position: { x: 640 + t.capture.length * 300, y: 160 }, data: { label: 'Hand off to team', message: t.closing } });
    return { nodes, edges };
}
