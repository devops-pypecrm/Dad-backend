import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import hpp from 'hpp';
import { createServer } from 'http';
import { initSocket } from './socket';
import { generalLimiter, authLimiter } from './middleware/rateLimiter';
import { auditSecurity, detectBruteForce } from './middleware/securityAudit';
import { setCSRFToken, verifyCSRFToken } from './middleware/csrfProtection';
import { EnvironmentValidator } from './utils/envValidator';

dotenv.config();

// Validate environment variables on startup
EnvironmentValidator.initializeValidation();


import authRoutes from './routes/authRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import leadRoutes from './routes/leadRoutes';
import contactRoutes from './routes/contactRoutes';
import accountRoutes from './routes/accountRoutes';
import opportunityRoutes from './routes/opportunityRoutes';
import paymentRoutes from './routes/paymentRoutes';
import emiRoutes from './routes/emiRoutes';
import campaignRoutes from './routes/campaignRoutes';
import marketingRoutes from './routes/marketingRoutes';
import emailListRoutes from './routes/emailListRoutes';
import interactionRoutes from './routes/interactionRoutes';
import eventRoutes from './routes/eventRoutes';
import taskRoutes from './routes/taskRoutes';
import followUpRoutes from './routes/followUpRoutes';
import workflowRoutes from './routes/workflowRoutes';
import productRoutes from './routes/productRoutes';
import quoteRoutes from './routes/quoteRoutes';
import shareRoutes from './routes/shareRoutes';
import documentRoutes from './routes/documentRoutes';

import caseRoutes from './routes/caseRoutes';
import goalRoutes from './routes/goalRoutes';
import territoryRoutes from './routes/territoryRoutes';
import roleRoutes from './routes/roleRoutes';
import userRoutes from './routes/userRoutes';
import customFieldRoutes from './routes/customFieldRoutes';
import webhookRoutes from './routes/webhookRoutes';
import profileRoutes from './routes/profileRoutes';
import assignmentRuleRoutes from './routes/assignmentRuleRoutes';
import hierarchyRoutes from './routes/hierarchyRoutes';
import organisationRoutes from './routes/organisationRoutes';
import apiKeyRoutes from './routes/apiKeyRoutes';
import subscriptionPlanRoutes from './routes/subscriptionPlanRoutes';
import licenseRoutes from './routes/licenseRoutes';
import notificationRoutes from './routes/notificationRoutes';
import superAdminRoutes from './routes/superAdminRoutes';
import salesTargetRoutes from './routes/salesTargetRoutes';
import trainingRoutes from './routes/trainingRoutes';
import callRoutes from './routes/callRoutes';
import callSettingsRoutes from './routes/callSettingsRoutes';
import backupRoutes from './routes/backupRoutes';
import reportRoutes from './routes/reportRoutes';
import importRoutes from './routes/importRoutes';
import aiRoutes from './routes/aiRoutes';
import emailRoutes from './routes/emailRoutes';
import searchRoutes from './routes/searchRoutes';
import androidRoutes from './routes/androidRoutes';

import adRoutes from './routes/adRoutes';
import pipelineRoutes from './routes/pipelineRoutes';
import webFormRoutes from './routes/webFormRoutes';
import smsCampaignRoutes from './routes/smsCampaignRoutes';
import whatsAppCampaignRoutes from './routes/whatsAppCampaignRoutes';
import whatsAppRoutes from './routes/whatsAppRoutes';
import whatsAppHubRoutes from './routes/whatsAppHubRoutes';
import commissionRoutes from './routes/commissionRoutes';
import issueRoutes from './routes/issueRoutes';
import landingPageRoutes from './routes/landingPageRoutes';
import bulkRoutes from './routes/bulkRoutes';
import publicRoutes from './routes/publicRoutes';
import teamRoutes from './routes/teamRoutes';
import branchRoutes from './routes/branchRoutes';
import trashRoutes from './routes/trashRoutes';
import appReleaseRoutes from './routes/appReleaseRoutes';
import path from 'path';

// import { dataIsolation } from './middleware/dataIsolation';

import compression from 'compression';

import { initCronJobs } from './services/cronService';
import session from 'express-session';
import passport from 'passport';
import { setupPassport } from './services/ssoService';

const app = express();
const httpServer = createServer(app);
httpServer.timeout = 1800000; // 30 minutes
httpServer.keepAliveTimeout = 1810000; // Slightly more than timeout
httpServer.headersTimeout = 1820000; // Slightly more than keepAliveTimeout

// Initialize Passport/SSO
setupPassport();

// Trust Proxy for Render/Vercel
app.set('trust proxy', 1);

// Security Headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            scriptSrc: ["'self'"],
            connectSrc: ["'self'", "https://api.facebook.com", "https://graph.facebook.com"],
            frameSrc: ["'none'"],
            objectSrc: ["'self'", "data:", "blob:"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            mediaSrc: ["'self'", "blob:", "data:", "https:", "*"],
            upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
        },
    },
    crossOriginEmbedderPolicy: false, // Disable for Meta integration
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));




app.use(session({
    secret: process.env.JWT_SECRET || 'secret_sso_key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true in prod, false in dev
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 'none' requires secure:true
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));



app.use(passport.initialize());
app.use(passport.session());

// Start Cron Jobs (Only on the primary PM2 instance to avoid duplicate/starved connection pools in cluster mode)
if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
    initCronJobs();
} else {
    console.log(`[Cron] Skipping cron scheduling on clustered instance ${process.env.NODE_APP_INSTANCE}`);
}

const PORT = process.env.PORT || 5001;

// VERY EARLY Health Check for 502 Debugging
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        port: PORT,
        env: process.env.NODE_ENV,
        timestamp: new Date().toISOString()
    });
});

console.log('------------------------------------------------');
console.log(`   STARTING SERVER (NODE_ENV=${process.env.NODE_ENV})      `);
console.log(`   PORT env: ${process.env.PORT}`);
console.log(`   Internal PORT: ${PORT}`);
console.log(`   Environment Keys: ${Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('KEY') && !k.includes('TOKEN')).join(', ')}`);
console.log('------------------------------------------------');

app.use(compression()); // Enable gzip compression

// Apply rate limiting
app.use('/api/', generalLimiter);

// CORS Configuration - Allow production frontend
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://192.168.1.12:5173',
    'http://localhost:3000',
    'https://dad-frontend-psi.vercel.app',
    'https://dad-frontend.vercel.app',
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGINS,
    'https://pypecrm.com',
    'https://www.pypecrm.com'
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, Postman)
        if (!origin) {
            return callback(null, true);
        }

        // --- ENHANCEMENT: Permissive CORS for Public API ---
        // If the request is for the public API, we are more permissive
        // relative to origin because external websites connect here.
        // The security is enforced by the X-API-KEY itself.
        const isPublicApi = origin && (origin.includes('localhost') || !origin.includes('pypecrm.com'));

        // Check if origin is in allowed list
        const allowedOriginsArray = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : [];

        const allOrigins = [...allowedOrigins, ...allowedOriginsArray];

        if (allOrigins.indexOf(origin) !== -1 || isPublicApi) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS policy'), false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token', 'X-API-KEY'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400 // 24 hours
}));

// Meta / WhatsApp / Gallabox webhooks - NO AUTH, need raw body for signature verification
// This must be placed BEFORE app.use(express.json())
app.use([
    '/api/meta/callback',
    '/api/meta/webhook',
    '/api/public/meta/webhook',
    '/api/whatsapp/webhook',
    '/api/whatsapp/webhook/gallabox'
], (req, res, next) => {
    if (req.method === 'POST') {
        express.raw({ type: 'application/json' })(req, res, (err) => {
            if (err) return next(err);
            if (Buffer.isBuffer(req.body)) {
                (req as any).rawBody = req.body;
                try {
                    req.body = JSON.parse(req.body.toString());
                } catch (e) {
                    console.error('Error parsing Meta webhook body JSON:', e);
                }
            }
            next();
        });
    } else {
        next();
    }
});

// Handle preflight requests
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());
app.use(hpp());

// CRITICAL: System lock check - must be early in middleware chain
import('./middleware/superAdminProtection').then(({ checkSystemLock }) => {
    app.use(checkSystemLock);
});

// Security Middleware
app.use(auditSecurity); // Security audit logging
app.use(setCSRFToken); // CSRF token generation
app.use(generalLimiter); // General rate limiting

// Initialize Socket.io
const io = initSocket(httpServer);
app.set('io', io);

// Every request was previously logged twice, unconditionally, for the life of the
// server (this middleware plus the near-duplicate one removed above) — on a
// multi-tenant app with several polling views (e.g. Opportunities refetches every
// 5s per open tab), that's a large, ever-growing volume of routine "200 OK" lines
// with no rotation, which is exactly what fills PM2's log files on disk over time.
// Only log what's actually worth seeing: failures and unusually slow requests.
const SLOW_REQUEST_MS = 2000;
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (res.statusCode >= 400 || duration > SLOW_REQUEST_MS) {
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
        }
    });
    next();
});

const staticPath = path.join(__dirname, '../uploads');
console.log('Serving static files from:', staticPath);

// Add CORS headers for static files (images, documents, etc.)
app.use('/uploads', (req, res, next) => {
    // Set CORS headers for static files
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}, express.static(staticPath));

app.get('/health', (req, res) => {
    console.log('Health check ping received at /health');
    res.status(200).send('OK');
});

// CSRF Token endpoint
app.get('/api/csrf-token', setCSRFToken, (req: any, res) => {
    res.json({
        csrfToken: req.csrfToken || req.session?.csrfToken,
        expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
});



import sitemapRoutes from './routes/sitemapRoutes';
import { seoMiddleware } from './middleware/seoMiddleware';

// SEO & Crawlability (SSR for public routes)
app.use(seoMiddleware);
app.use('/', sitemapRoutes);
app.use('/api', sitemapRoutes);

// Auth & Core (with enhanced security)
app.use('/api/reports', verifyCSRFToken, reportRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/analytics', verifyCSRFToken, analyticsRoutes);
app.use('/api/workflow', verifyCSRFToken, workflowRoutes);
app.use('/api/import', importRoutes); // No CSRF for file uploads
app.use('/api/ai', aiRoutes); // Remove CSRF - already protected by auth
app.use('/api/email', verifyCSRFToken, emailRoutes);
import gmailRoutes from './routes/gmailRoutes';
app.use('/api/gmail', gmailRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/search', searchRoutes);

app.use('/api/profile', profileRoutes);

// Sales
app.use('/api/leads', leadRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api', paymentRoutes);
app.use('/api', emiRoutes);

// Marketing
app.use('/api/campaigns', campaignRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/marketing/lists', emailListRoutes);

// Communications
app.use('/api/interactions', interactionRoutes);
import telephonyRoutes from './routes/telephonyRoutes';
app.use('/api/calls', callRoutes);
app.use('/api/call-settings', callSettingsRoutes);
app.use('/api/telephony', telephonyRoutes);



// Operations
import checkInRoutes from './routes/checkInRoutes';
app.use('/api/checkins', checkInRoutes);
app.use('/api/calendar', eventRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/follow-ups', followUpRoutes);

// Commerce
app.use('/api/products', productRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/documents', documentRoutes);

// Field & Support

app.use('/api/cases', caseRoutes);

// Advanced
app.use('/api/goals', goalRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/pipelines', pipelineRoutes);
app.use('/api/web-forms', webFormRoutes);
app.use('/api/sms-campaigns', smsCampaignRoutes);
// WhatsApp Campaigns (re-enabled after schema fix)
app.use('/api/whatsapp-campaigns', whatsAppCampaignRoutes);
app.use('/api/whatsapp', whatsAppRoutes);
app.use('/api/whatsapp', whatsAppHubRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/issues', issueRoutes);
app.use('/api/landing-pages', landingPageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/android', androidRoutes);
app.use('/api/sales-targets', salesTargetRoutes);
app.use('/api/training', trainingRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/ads', adRoutes);

// Meta OAuth
import metaAuthRoutes from './routes/metaAuthRoutes';
app.use('/api/meta', metaAuthRoutes);

// Admin & Settings
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/territories', territoryRoutes);
app.use('/api/custom-fields', customFieldRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/assignment-rules', assignmentRuleRoutes);
app.use('/api/hierarchy', hierarchyRoutes);
app.use('/api/organisation', organisationRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/bulk', bulkRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/trash', trashRoutes);
app.use('/api/app-releases', appReleaseRoutes);

// Licensing & Multi-tenancy
app.use('/api/plans', subscriptionPlanRoutes);
app.use('/api/licenses', licenseRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/backup', backupRoutes);

import auditRoutes from './routes/auditRoutes';
app.use('/api/audit-logs', auditRoutes);

import timelineRoutes from './routes/timelineRoutes';
app.use('/api/timeline', timelineRoutes);

import apiRoutes from './routes/apiRoutes';
app.use('/api/v1', apiRoutes);

import stripeRoutes from './routes/stripeRoutes';
app.use('/api/stripe', stripeRoutes);

// --- FRONTEND SERVING & SEO ---
const clientDistPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientDistPath));

// Dynamic sitemap & robots (root level)
app.use('/', sitemapRoutes);

// Catch-all for React SPA - allows seoMiddleware to handle marketing routes
app.get('*', seoMiddleware, (req, res, next) => {
    // Only serve index.html for non-API routes
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ message: 'API route not found' });
    }

    // Explicitly handle robots and sitemap if they fell through
    if (req.path === '/robots.txt' || req.path === '/sitemap.xml') {
        return next();
    }

    const indexPath = path.join(clientDistPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        // If seoMiddleware didn't already send the response (e.g. for non-marketing routes)
        if (!res.headersSent) {
            res.sendFile(indexPath);
        }
    } else {
        res.status(404).send('Frontend not built. Please run npm build in the client directory.');
    }
});

// Debug Routes
import debugRoutes from './routes/debugRoutes';
app.use('/api/debug', debugRoutes);

import fs from 'fs';
app.get('/debug-files', (req, res) => {
    try {
        const currentDir = fs.readdirSync(__dirname);
        const parentDir = fs.readdirSync(path.join(__dirname, '..'));
        res.json({
            current: __dirname,
            files: currentDir,
            parentFiles: parentDir
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Upload Routes (Call Recordings)
import uploadRoutes from './routes/uploadRoutes';
app.use('/api/upload', uploadRoutes);

// Meeting Reminder Job
import { generateMeetingReminders } from './services/meetingReminderService';

// Debug: Log all registered routes
const logRoutes = (stack: any[], parentPath: string = '') => {
    stack.forEach(r => {
        if (r.route && r.route.path) {
            console.log(`[Route] ${Object.keys(r.route.methods).join(',').toUpperCase()} ${parentPath}${r.route.path}`);
        } else if (r.name === 'router' && r.handle.stack) {
            const nestedPath = r.regexp.source.replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
            logRoutes(r.handle.stack, parentPath + nestedPath);
        }
    });
};

// Global Error Handler Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
        console.error(`[JSON Parse Error] Malformed JSON body from IP ${req.ip} to ${req.originalUrl}:`, err.message);
        return res.status(400).json({ error: 'Invalid JSON payload format' });
    }
    console.error(`[Unhandled Error] ${req.method} ${req.originalUrl}:`, err);
    if (!res.headersSent) {
        res.status(err.status || 500).json({
            error: process.env.NODE_ENV === 'production' ? 'Internal server error occurred' : err.message
        });
    }
});



httpServer.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    // CRITICAL: Verify super admin integrity on startup
    const { verifySuperAdminIntegrity } = await import('./middleware/superAdminProtection');
    await verifySuperAdminIntegrity();

    // Initialize Global Role Templates
    const { initializeGlobalRoles } = await import('./controllers/roleController');
    await initializeGlobalRoles();

    // Log routes after short delay to ensure all are mounted
    setTimeout(() => {
        console.log('--- Registered Routes ---');
        logRoutes(app._router.stack);
        console.log('-------------------------');
    }, 1000);

    // Run meeting reminder check on startup
    generateMeetingReminders().then(count => {
        console.log(`[Startup] Checked ${count} meetings for reminders`);
    }).catch(err => {
        console.error('[Startup] Meeting reminder error:', err);
    });

});
// Forced restart v2
