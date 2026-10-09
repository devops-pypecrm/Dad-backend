import { Request, Response } from 'express';
import prisma from '../config/prisma';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { synchronizeDurations, resolveBestDurationSeconds, formatCallDurationDescription, normalizeDuration, getAudioDuration, transcodeToPlayableAudio } from '../utils/callUtils';

// DB-backed, NOT in-memory: this backend runs as multiple PM2-clustered
// processes (see cronService.ts's own NODE_APP_INSTANCE guard, and the
// bulk-sync rate limiter in androidRoutes.ts, added for the exact same
// reason). An in-memory Set only serializes requests that happen to land
// on the SAME worker process — the load balancer round-robins requests
// across workers, so the real-time Tier 0 upload (uploadCallRecording) and
// a reconciler/bulk-sync fallback for the SAME call (syncCallLogs) can
// land on two different processes, each with its own empty Set, each
// seeing "no existing row" and both inserting — a real, confirmed cause of
// duplicate Interaction rows for one call (one with a recording attached,
// one without), diagnosed directly from production data. Uses the same
// atomic INSERT ... ON CONFLICT ... WHERE pattern as that rate limiter, on
// the same SystemSetting table, under a distinctly-namespaced key so the
// two lock/rate-limit purposes never collide with each other.
const LOCK_STALE_MS = 10_000; // a lock older than this is treated as abandoned (e.g. a crashed request that never released it) and reclaimable, so this can never wedge a key locked forever.
const lockSettingKey = (key: string) => `android_sync_lock:${key}`;

const acquireLock = async (key: string, maxWaitMs = 5000): Promise<boolean> => {
    const start = Date.now();
    while (true) {
        try {
            const claimed = await prisma.$queryRaw<{ id: string }[]>`
                INSERT INTO "SystemSetting" (id, key, value, "group", "createdAt", "updatedAt")
                VALUES (${randomUUID()}, ${lockSettingKey(key)}, ${String(Date.now())}, 'android_sync_lock', now(), now())
                ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, "updatedAt" = now()
                    WHERE (EXTRACT(EPOCH FROM (now() - "SystemSetting"."updatedAt")) * 1000) >= ${LOCK_STALE_MS}
                RETURNING id
            `;
            if (claimed.length > 0) return true;
        } catch (err) {
            // Fail OPEN, not closed — a broken lock mechanism must never
            // block a legitimate upload forever. Worst case on a query
            // failure is reverting to the old (rare) race, not an outage.
            console.error(`[AndroidLock] acquireLock query failed for key ${key}, proceeding without the lock`, err);
            return true;
        }
        if (Date.now() - start > maxWaitMs) {
            console.warn(`[AndroidLock] Timeout waiting for lock key: ${key}`);
            return false; // Timeout
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
};

const releaseLock = async (key: string) => {
    try {
        await prisma.systemSetting.deleteMany({ where: { key: lockSettingKey(key) } });
    } catch (err) {
        // Best-effort — a failed release just means this key self-expires
        // after LOCK_STALE_MS instead of being freed immediately.
        console.error(`[AndroidLock] releaseLock failed for key ${key} (will self-expire)`, err);
    }
};

// GET /api/android/leads
// Returns minimal lead data (phone, id, name) for the Android app to cache locally.
// Requires organization context from auth middleware.
// Simple in-memory cache and request coalescing maps to prevent duplicate request storms and db pool starvation
const leadsCache = new Map<string, { timestamp: number; data: any }>();
const activeLeadsRequests = new Map<string, Promise<any>>();
const CACHE_TTL_MS = 10000; // 10 seconds cache to prevent duplicate request storms

export const getAndroidLeads = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || !user.organisationId) {
            return res.status(401).json({ error: 'Unauthorized. Organisation ID missing.' });
        }

        const cacheKey = `${user.id}-${user.organisationId}`;

        // 1. Check if there's a cached response within the TTL
        const cached = leadsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            console.log(`[AndroidLeads] Serving cached leads response for user ${user.id}`);
            return res.status(200).json(cached.data);
        }

        // 2. Check if there is an active database query already executing for this user
        let promise = activeLeadsRequests.get(cacheKey);
        if (!promise) {
            console.log(`[AndroidLeads] Initiating database fetch for user ${user.id}`);
            promise = (async () => {
                const { getVisibleUserIds } = await import('../utils/hierarchyUtils');
                const visibleUserIds = await getVisibleUserIds(user.id);

                // Optional lastSync delta parameter support (e.g. timestamp as number)
                const lastSyncTime = req.query.lastSync ? new Date(parseInt(String(req.query.lastSync), 10)) : null;

                const leadsFilter: any = {
                    organisationId: user.organisationId,
                    isDeleted: false,
                    phone: { not: '' },
                    assignedToId: { in: visibleUserIds }
                };

                const contactsFilter: any = {
                    organisationId: user.organisationId,
                    isDeleted: false,
                    ownerId: { in: visibleUserIds }
                };

                if (lastSyncTime && !isNaN(lastSyncTime.getTime())) {
                    leadsFilter.updatedAt = { gte: lastSyncTime };
                    contactsFilter.updatedAt = { gte: lastSyncTime };
                }

                const [leads, contacts] = await Promise.all([
                    prisma.lead.findMany({
                        where: leadsFilter,
                        select: {
                            id: true,
                            phone: true,
                            secondaryPhone: true,
                            firstName: true,
                            lastName: true,
                            email: true,
                            enquiryAbout: true,
                            status: true,
                            company: true,
                            updatedAt: true
                        }
                    }),
                    prisma.contact.findMany({
                        where: contactsFilter,
                        select: {
                            id: true,
                            phones: true,
                            firstName: true,
                            lastName: true,
                            email: true,
                            updatedAt: true
                        }
                    })
                ]);

                // Normalize contacts to match lead structure for the app
                const normalizedContacts = contacts.map(c => {
                    let phone = '';
                    if (c.phones && Array.isArray(c.phones) && (c.phones as any[]).length > 0) {
                        phone = String((c.phones as any[])[0]);
                    } else if (typeof c.phones === 'string') {
                        phone = c.phones;
                    }

                    return {
                        id: c.id,
                        phone: phone,
                        firstName: c.firstName,
                        lastName: c.lastName,
                        email: c.email,
                        type: 'contact',
                        updatedAt: c.updatedAt
                    };
                });

                const responseData = { 
                    leads: leads.map(l => ({ ...l, type: 'lead' })), 
                    contacts: normalizedContacts 
                };

                // Store in cache
                leadsCache.set(cacheKey, { timestamp: Date.now(), data: responseData });
                return responseData;
            })();

            activeLeadsRequests.set(cacheKey, promise);
        } else {
            console.log(`[AndroidLeads] Coalescing request: joining active database query for user ${user.id}`);
        }

        try {
            const data = await promise;
            return res.status(200).json(data);
        } finally {
            activeLeadsRequests.delete(cacheKey);
        }
    } catch (error) {
        console.error('Error fetching android data:', error);
        res.status(500).json({ error: 'Failed to fetch data' });
    }
};

// GET /api/android/leads/:leadId/last-note
// On-demand, single-lead lookup -- deliberately NOT folded into
// getAndroidLeads' bulk response above, which syncs every visible lead for
// offline caching. A note is only ever needed for the ONE lead a call is
// currently ringing for, so batching it into every lead in every bulk sync
// would mean fetching (and the client storing) data that's used maybe once
// per lead ever, for every lead whether a call happens or not.
export const getLeadLastNote = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || !user.organisationId) {
            return res.status(401).json({ error: 'Unauthorized. Organisation ID missing.' });
        }

        const { leadId } = req.params;
        if (!leadId) {
            return res.status(400).json({ error: 'leadId is required' });
        }

        // organisationId is part of the WHERE clause itself (not just the
        // auth check above) so a leadId from another org can never leak a
        // note back, even if this endpoint is called with a guessed/stale id.
        const note = await prisma.interaction.findFirst({
            where: {
                leadId,
                organisationId: user.organisationId,
                type: 'note',
                isDeleted: false,
            },
            orderBy: { date: 'desc' },
            select: { description: true, subject: true, date: true },
        });

        if (!note) {
            return res.status(200).json({ note: null });
        }

        res.status(200).json({
            note: note.description?.trim() || note.subject || null,
            date: note.date,
        });
    } catch (error) {
        console.error('Error fetching lead last note:', error);
        res.status(500).json({ error: 'Failed to fetch last note' });
    }
};

// POST /api/android/recordings
// Handles multipart/form-data with 'audio' file and metadata fields
export const uploadCallRecording = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || !user.organisationId) {
            return res.status(401).json({ error: 'Unauthorized.' });
        }

        const { leadId, duration, callType, timestamp, phoneNumber, hardwareId: rawHardwareId, callSessionId, hardwareDuration } = req.body;
        const hardwareId = (rawHardwareId && rawHardwareId !== 'none' && !rawHardwareId.includes('_')) ? `${user.id}_${rawHardwareId}` : rawHardwareId;
        const file = req.file;

        console.log(`[AndroidUpload] Incoming request: phone=${phoneNumber}, leadId=${leadId}, duration=${duration}, type=${callType}, hasFile=${!!file}`);
        if (!file && req.body.audio) {
             console.warn('[AndroidUpload] WARNING: Found audio in body but NOT as req.file. Possible field name mismatch? Expected "audio".');
        }

        // Re-encode to AAC/.m4a so this recording is guaranteed playable in
        // the web app's plain <audio> element regardless of what codec the
        // source device's native recorder used (see transcodeToPlayableAudio's
        // doc comment) -- falls back to the original file untouched on any
        // transcode failure, so this can never turn a successful upload into
        // a failed one.
        let storedFilePath = file?.path;
        let storedFilename = file?.filename;
        if (file) {
            const transcodedFilename = transcodeToPlayableAudio(file.path);
            if (transcodedFilename) {
                storedFilename = transcodedFilename;
                storedFilePath = path.join(path.dirname(file.path), transcodedFilename);
                console.log(`[AndroidUpload] Transcoded recording to ${transcodedFilename}`);
            } else {
                console.warn('[AndroidUpload] Transcode failed or skipped -- storing original file as-is');
            }
        }

        const phoneDigits = String(phoneNumber || "").replace(/[^0-9]/g, "");
        const phoneSuffix = phoneDigits.slice(-10);
        const lockKey = (phoneSuffix && timestamp) ? `${user.id}-${phoneSuffix}-${timestamp}` : null;

        if (lockKey) {
            await acquireLock(lockKey);
        }

        try {
            // Robust leadId/contactId handling
            let targetLeadId = (leadId === 'null' || !leadId) ? null : leadId;
            let targetContactId = null;
            let finalPhone = phoneNumber;

        // Fallback: Try to find matched CRM entity (Lead or Contact) by phone number
        let matchedEntity: { id: string; type: 'lead' | 'contact'; phone?: string } | null = null;
        if (phoneNumber) {
            const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
            const last10 = cleanPhone.slice(-10);
            
            if (last10.length > 0) {
                const variations = Array.from(new Set([
                    last10,
                    `+91${last10}`,
                    `91${last10}`,
                    `0${last10}`,
                    cleanPhone,
                    phoneNumber
                ].filter(Boolean)));

                const lead = await prisma.lead.findFirst({
                    where: {
                        organisationId: user.organisationId,
                        isDeleted: false,
                        OR: [
                            { phone: { in: variations } },
                            { secondaryPhone: { in: variations } }
                        ]
                    },
                    select: { id: true, phone: true }
                });

                if (lead) {
                    matchedEntity = { id: lead.id, type: 'lead', phone: lead.phone || undefined };
                } else {
                    const contact = await prisma.contact.findFirst({
                        where: {
                            organisationId: user.organisationId,
                            isDeleted: false,
                            OR: [
                                { phones: { path: ['$[*]'], string_contains: last10 } },
                                { phones: { string_contains: last10 } }
                            ]
                        },
                        select: { id: true }
                    });
                    if (contact) {
                        matchedEntity = { id: contact.id, type: 'contact' };
                    }
                }
            }
        }

        if (!targetLeadId && matchedEntity) {
            if (matchedEntity.type === 'lead') {
                targetLeadId = matchedEntity.id;
                finalPhone = matchedEntity.phone || phoneNumber;
                console.log(`[AndroidUpload] Found CRM Lead matching phone: ${targetLeadId}`);
            } else {
                targetContactId = matchedEntity.id;
                console.log(`[AndroidUpload] Found CRM Contact matching phone: ${targetContactId}`);
            }
        } else if (targetLeadId && matchedEntity && matchedEntity.type === 'lead' && targetLeadId !== matchedEntity.id) {
            console.warn(`[AndroidUpload] Mismatch: App sent leadId=${targetLeadId}, but phone matches leadId=${matchedEntity.id}. Overriding.`);
            targetLeadId = matchedEntity.id;
            finalPhone = matchedEntity.phone || phoneNumber;
        } else if (targetLeadId && matchedEntity && matchedEntity.type === 'contact') {
            // App sent leadId, but phone belongs to a Contact. Link Contact, unlink Lead.
            console.warn(`[AndroidUpload] Mismatch: App sent leadId=${targetLeadId}, but phone matches Contact ID=${matchedEntity.id}. Overriding.`);
            targetLeadId = null;
            targetContactId = matchedEntity.id;
        } else if (targetLeadId && !matchedEntity && phoneNumber) {
            // App sent a leadId, but no lead matches this phone in DB. 
            // Check if the provided leadId is a "ghost" (no phone number).
            const providedLead = await prisma.lead.findUnique({
                where: { id: targetLeadId },
                select: { phone: true, firstName: true }
            });

            if (providedLead && (!providedLead.phone || providedLead.phone.trim() === '')) {
                console.warn(`[AndroidUpload] Strict Unlink: App sent ghost leadId=${targetLeadId} (${providedLead.firstName}) for unknown phone ${phoneNumber}. Unlinking.`);
                targetLeadId = null;
            }
        }

        if (!targetLeadId && !targetContactId && !phoneNumber) {
            console.error(`[AndroidUpload] Upload failed: No leadId/contactId and no phoneNumber`);
            return res.status(400).json({ error: 'leadId, contactId or phoneNumber is required' });
        }

        // 1. Fetch Call Settings to check if non-CRM sync is allowed
        const settings = await prisma.callSettings.findUnique({
            where: { organisationId: user.organisationId }
        });
        const canSyncUnknown = settings ? settings.syncNonCrmContacts : true; // Default to true if not set

        // Only add call data for phone numbers that exist in the CRM setup, 
        // unless syncNonCrmContacts is enabled OR it is a MISSED CALL
        const rawType = String(callType || 'UNKNOWN').toUpperCase();
        const isMissed = ['3', 'MISSED', 'MISS'].includes(rawType);

        if (!targetLeadId && !targetContactId && !canSyncUnknown && !isMissed) {
            console.warn(`[AndroidUpload] Upload skipped: Phone number ${phoneNumber} is not associated with any Lead/Contact and Contact Synchronization is OFF.`);
            return res.status(200).json({ message: 'Call dropped: Contact synchronization disabled for non-CRM numbers' });
        }

        let durationSecs = parseInt(duration, 10) || 0;
        const carrierDurationSecs = hardwareDuration ? parseInt(hardwareDuration, 10) : null;

        // HEAL ZERO DURATION: If client sends 0 duration but has a physical file, parse the true duration using ffprobe
        if (storedFilePath && (durationSecs === 0 || !durationSecs)) {
            const fileDuration = getAudioDuration(storedFilePath);
            if (fileDuration > 0) {
                console.log(`[AndroidUpload] Extracted real duration from file via ffprobe: ${fileDuration}s (client sent: ${duration}s)`);
                durationSecs = fileDuration;
            }
        }

        // Create recording record (linked to lead if found)
        console.log(`[AndroidUpload] Creating CallRecording record (targetLeadId=${targetLeadId || 'null'}, targetContactId=${targetContactId || 'null'}, isMissed=${isMissed})`);
        const recording = await prisma.callRecording.create({
            data: {
                leadId: targetLeadId,
                duration: durationSecs,
                hardwareDuration: carrierDurationSecs,
                fileUrl: storedFilename ? `/uploads/recordings/${storedFilename}` : '',
                callType: callType || 'UNKNOWN',
                timestamp: timestamp ? new Date(parseInt(timestamp, 10)) : new Date(),
            }
        });

        const tempDurationData = {
            duration: durationSecs / 60,
            recordingDuration: durationSecs,
            hardwareDuration: carrierDurationSecs
        };
        synchronizeDurations(tempDurationData);
        
        const finalizedDurationSecs = resolveBestDurationSeconds(tempDurationData);
        const durationMinutes = tempDurationData.duration;
        
        const formattedDescription = formatCallDurationDescription(finalizedDurationSecs, { 
            hasRecording: !!file,
            isCarrierVerified: carrierDurationSecs !== null
        });

        // 2. Link to existing interaction
        // PRIORITY 1: Match by callSessionId (UUID - 100% Accuracy)
        // PRIORITY 2: Match by hardwareId (Android Record ID - 100% Accuracy)
        // PRIORITY 3: Fuzzy Match (Phone + User + Time window for 'initiated' calls)
        const callDate = timestamp ? new Date(parseInt(timestamp, 10)) : new Date();
        const searchWindowStart = new Date(callDate.getTime() - 60 * 60 * 1000); // 1 hour before (covers long calls)
        const searchWindowEnd = new Date(callDate.getTime() + 5 * 60 * 1000);    // 5 mins after (covers clock skew)
        
        console.log(`[AndroidUpload] Searching for interaction to merge (Phone: ${phoneNumber}, HardwareId: ${hardwareId || 'none'}, Date: ${callDate.toISOString().split('.')[0]})...`);
        
        // Deep Normalized Suffix (last 10 digits)
        const phoneDigits = String(phoneNumber || "").replace(/[^0-9]/g, "");
        const phoneSuffix = phoneDigits.slice(-10);

        let existingInteraction = null;

        // Try exact matching first
        if (callSessionId && callSessionId.length > 0) {
            existingInteraction = await prisma.interaction.findFirst({
                where: { organisationId: user.organisationId, callSessionId },
                orderBy: { date: 'desc' }
            });
        }

        if (!existingInteraction && hardwareId && hardwareId.length > 0 && hardwareId !== "none") {
            existingInteraction = await prisma.interaction.findFirst({
                where: { organisationId: user.organisationId, hardwareId },
                orderBy: { date: 'desc' }
            });
        }

        // FUZZY RECONCILIATION: Look for 'initiated' calls if no exact match (User-restricted)
        if (!existingInteraction && phoneSuffix.length > 0) {
            console.log(`[AndroidUpload] Exact match failed. Attempting fuzzy reconciliation for phone suffix ${phoneSuffix} (User: ${user.id})...`);
            
            const variations = Array.from(new Set([
                phoneSuffix,
                `+91${phoneSuffix}`,
                `91${phoneSuffix}`,
                `0${phoneSuffix}`,
                phoneDigits,
                phoneNumber
            ].filter(Boolean)));

            // First try to find an 'initiated' call within a 24-hour window
            existingInteraction = await prisma.interaction.findFirst({
                where: {
                    organisationId: user.organisationId,
                    createdById: user.id,
                    type: 'call',
                    callStatus: 'initiated',
                    phoneNumber: { in: variations },
                    date: {
                        gte: new Date(callDate.getTime() - 24 * 60 * 60 * 1000), // 24 hours before
                        lte: searchWindowEnd
                    }
                },
                orderBy: { date: 'desc' }
            });

            // If no initiated call, fall back to the strict 1-hour window for completed/missed/failed calls
            if (!existingInteraction) {
                existingInteraction = await prisma.interaction.findFirst({
                    where: {
                        organisationId: user.organisationId,
                        createdById: user.id,
                        type: 'call',
                        callStatus: { in: ['completed', 'missed', 'failed', 'rejected'] },
                        phoneNumber: { in: variations },
                        date: {
                            gte: searchWindowStart,
                            lte: searchWindowEnd
                        }
                    },
                    orderBy: { date: 'desc' }
                });
            }
        }

        if (existingInteraction) {
            console.log(`[AndroidUpload] Healing interaction ${existingInteraction.id} (Status: ${existingInteraction.callStatus}) with official duration: ${durationSecs}s`);
            
            // SYSTEM LOG RULE: If the new duration is > 0, we ALWAYS trust it over a 2s estimate
            const shouldUpdate = durationSecs > 0 || (existingInteraction.duration || 0) === 0;

            let direction: 'inbound' | 'outbound' = existingInteraction.direction as any || 'outbound';
            let subject = existingInteraction.subject;
            let status = finalizedDurationSecs > 0 ? 'completed' : 'failed';

            const incomingIdentifiers = ['1', 'INCOMING', 'IN', 'INB'];
            const outgoingIdentifiers = ['2', 'OUTGOING', 'OUT', 'OUTB'];
            const missedIdentifiers = ['3', 'MISSED', 'MISS'];
            const rejectedIdentifiers = ['5', 'REJECTED', 'REJ'];

            if (outgoingIdentifiers.includes(rawType)) {
                direction = 'outbound';
                subject = finalizedDurationSecs > 0 ? 'Mobile Outbound Call' : 'Outbound Call Attempt (No Answer)';
                status = finalizedDurationSecs > 0 ? 'completed' : 'failed';
            } else if (missedIdentifiers.includes(rawType)) {
                direction = 'inbound';
                subject = targetLeadId ? 'Missed Call from Lead' : `Missed Call from ${phoneNumber}`;
                status = 'missed';
            } else if (rejectedIdentifiers.includes(rawType)) {
                direction = 'inbound';
                subject = targetLeadId ? 'Rejected Call from Lead' : `Rejected Call from ${phoneNumber}`;
                status = 'rejected';
            } else if (incomingIdentifiers.includes(rawType)) {
                direction = 'inbound';
                subject = 'Mobile Inbound Call';
                status = finalizedDurationSecs > 0 ? 'completed' : 'failed';
            } else {
                if (direction === 'outbound') {
                    subject = finalizedDurationSecs > 0 ? 'Mobile Outbound Call' : 'Outbound Call Attempt (No Answer)';
                } else {
                    subject = finalizedDurationSecs > 0 ? 'Mobile Inbound Call' : 'Mobile Call';
                }
            }

            if (finalizedDurationSecs > 0) {
                status = 'completed';
            }

            const formattedDescription = formatCallDurationDescription(finalizedDurationSecs, { 
                hasRecording: !!file,
                isCarrierVerified: carrierDurationSecs !== null
            });

            const updateData: any = {
                duration: shouldUpdate ? (Math.round(durationMinutes * 100) / 100) : undefined,
                recordingDuration: shouldUpdate ? durationSecs : undefined,
                recordingUrl: recording.fileUrl || undefined,
                callStatus: status,
                subject: subject,
                description: formattedDescription,
                direction: direction,
                leadId: targetLeadId,
                contactId: targetContactId,
                phoneNumber: phoneNumber || undefined,
                hardwareId: hardwareId || undefined,
                callSessionId: callSessionId || undefined,
                // Omit date: callDate to prevent phone clock skew from altering CRM initiate date
            };

            if (shouldUpdate && carrierDurationSecs !== null) {
                updateData.hardwareDuration = carrierDurationSecs;
            }

            await prisma.interaction.update({
                where: { id: existingInteraction.id },
                data: updateData
            });
        } else {
            // No existing interaction: Create a new record for lead or standalone
            
            // 3. Map Android CallLog types (Refined Mapping v2.0)
            let direction: 'inbound' | 'outbound' = 'inbound';
            let subject = 'Mobile Call';
            let status = 'completed';

            const incomingIdentifiers = ['1', 'INCOMING', 'IN', 'INB'];
            const outgoingIdentifiers = ['2', 'OUTGOING', 'OUT', 'OUTB'];
            const missedIdentifiers = ['3', 'MISSED', 'MISS'];
            const rejectedIdentifiers = ['5', 'REJECTED', 'REJ'];

            if (outgoingIdentifiers.includes(rawType)) {
                direction = 'outbound';
                subject = 'Mobile Outbound Call';
                
                // IRON VEIL RELAXED (v4.0): We no longer discard 0-sec outbound attempts. 
                // We keep them but mark them as 'failed' to ensure hardware log parity.
                if (finalizedDurationSecs === 0 && !file && !existingInteraction) {
                    console.log(`[AndroidUpload] Iron Veil v4.0: Preserving 0-sec outbound attempt for (${phoneNumber})`);
                    status = 'failed';
                    subject = 'Outbound Call Attempt (No Answer)';
                }
                
                if (finalizedDurationSecs === 0) {
                    status = 'failed';
                    subject = 'Outbound Call Attempt (No Answer)';
                }
            } else if (missedIdentifiers.includes(rawType)) {
                direction = 'inbound';
                subject = targetLeadId ? 'Missed Call from Lead' : `Missed Call from ${phoneNumber}`;
                status = 'missed';
            } else if (rejectedIdentifiers.includes(rawType)) {
                direction = 'inbound';
                subject = targetLeadId ? 'Rejected Call from Lead' : `Rejected Call from ${phoneNumber}`;
                status = 'rejected';
            } else {
                direction = 'inbound';
                if (incomingIdentifiers.includes(rawType)) {
                    subject = 'Mobile Inbound Call';
                }
            }

            // DURATION OVERRIDE (v4.0): If duration > 0, it's NEVER 'failed' or 'missed'
            if (finalizedDurationSecs > 0) {
                status = 'completed';
            }

            console.log(`[AndroidUpload] No target interaction found after fuzzy search. Creating new '${direction}' record (Lead: ${targetLeadId || 'null'})`);
            
            try {
                // LAST-SECOND ATOMIC DEDUPLICATION: Check one more time just before create
                // to prevent race conditions from simultaneous requests.
                const variations = Array.from(new Set([
                    phoneSuffix,
                    `+91${phoneSuffix}`,
                    `91${phoneSuffix}`,
                    `0${phoneSuffix}`,
                    phoneDigits,
                    phoneNumber
                ].filter(Boolean)));

                const raceCheck = await prisma.interaction.findFirst({
                    where: {
                        organisationId: user.organisationId,
                        createdById: user.id,
                        phoneNumber: { in: variations },
                        date: {
                            gte: new Date(callDate.getTime() - 10000), // 10s tight window
                            lte: new Date(callDate.getTime() + 10000)
                        }
                    }
                });

                if (raceCheck) {
                    console.log(`[AndroidUpload] Atomic race check: Merging into just-created interaction ${raceCheck.id}`);
                    // Whichever side actually connected (higher duration) is the real call — its
                    // status/subject/description should win, not just its duration number, so a
                    // "ghost" 0s failed entry doesn't leave the merged row mislabeled as failed.
                    const incomingIsBetter = finalizedDurationSecs > (raceCheck.duration || 0) * 60;
                    await prisma.interaction.update({
                        where: { id: raceCheck.id },
                        data: incomingIsBetter ? {
                            duration: Math.round(durationMinutes * 100) / 100,
                            hardwareDuration: carrierDurationSecs,
                            recordingDuration: durationSecs,
                            callStatus: status,
                            subject,
                            description: formattedDescription,
                            hardwareId: hardwareId || undefined,
                            callSessionId: callSessionId || undefined
                        } : {
                            hardwareId: hardwareId || undefined,
                            callSessionId: callSessionId || undefined
                        }
                    });
                    return res.status(201).json({ message: 'Merged into existing interaction', interactionId: raceCheck.id });
                }

                const interaction = await prisma.interaction.create({
                    data: {
                        type: 'call',
                        direction: direction,
                        subject: subject,
                        description: formattedDescription,
                        date: callDate,
                        duration: Math.round(durationMinutes * 100) / 100,
                        recordingDuration: durationSecs,
                        hardwareDuration: carrierDurationSecs,
                        recordingUrl: recording.fileUrl || undefined,
                        callStatus: status,
                        phoneNumber: phoneNumber || undefined,
                        hardwareId: hardwareId || undefined,
                        callSessionId: callSessionId || undefined,
                        leadId: targetLeadId,
                        contactId: targetContactId,
                        organisationId: user.organisationId,
                        createdById: user.id,
                        branchId: user.branchId || undefined
                    }
                });

                if (targetLeadId && (interaction.type === 'call' || interaction.type === 'meeting' || interaction.type === 'whatsapp')) {
                    const leadRecord = await prisma.lead.findUnique({ where: { id: targetLeadId }, select: { status: true } });
                    const newStatus = (leadRecord?.status === 'new') ? 'contacted' : undefined;
                    if (newStatus) {
                        await prisma.lead.update({
                            where: { id: targetLeadId },
                            data: { status: newStatus, lastContactDate: callDate }
                        }).catch(() => {});
                    }
                }
            } catch (err: any) {
                if (err.code === 'P2002') {
                    console.log(`[AndroidUpload] Duplicate report suppressed via database unique constraint (HwId: ${hardwareId}, SessId: ${callSessionId})`);
                } else {
                    throw err;
                }
            }
        }

        res.status(201).json({ message: 'Recording and Interaction uploaded successfully', recording });
        } finally {
            if (lockKey) {
                await releaseLock(lockKey);
            }
        }
    } catch (error) {
        console.error('[AndroidUpload] CRITICAL ERROR during upload:', error);
        res.status(500).json({ error: 'Failed to upload recording' });
    }
};

// POST /api/android/bulk-sync
// Accepts a JSON array of call log entries from the Android app's background worker.
// Only imports calls whose phone number matches an existing CRM Lead.
// Deduplicates against existing Interactions by phone + timestamp.
export const syncCallLogs = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || !user.organisationId) {
            return res.status(401).json({ error: 'Unauthorized. Organisation ID missing.' });
        }

        const { calls } = req.body;
        if (!Array.isArray(calls) || calls.length === 0) {
            return res.status(400).json({ error: 'Expected a non-empty "calls" array.' });
        }

        console.log(`[BulkSync] Received ${calls.length} call entries from user ${user.id}`);

        // 0. Fetch Call Settings to check if non-CRM sync is allowed
        const settings = await prisma.callSettings.findUnique({
            where: { organisationId: user.organisationId }
        });
        const canSyncUnknown = settings ? settings.syncNonCrmContacts : true;

        // 1. Fetch all CRM leads with phone numbers for this organisation
        const crmLeads = await prisma.lead.findMany({
            where: {
                organisationId: user.organisationId,
                isDeleted: false,
                phone: { not: '' }
            },
            select: { id: true, phone: true, secondaryPhone: true, firstName: true, lastName: true, status: true }
        });

        // 1.1 Fetch all CRM contacts
        const crmContacts = await prisma.contact.findMany({
            where: {
                organisationId: user.organisationId,
                isDeleted: false
            },
            select: { id: true, phones: true, firstName: true, lastName: true }
        });

        // Build a lookup map: last 10 digits of phone -> entity
        const phoneToEntity = new Map<string, { id: string; type: 'lead' | 'contact'; firstName: string | null; lastName: string | null; status?: string }>();
        
        for (const lead of crmLeads) {
            if (lead.phone) {
                const clean = lead.phone.replace(/[^0-9]/g, '').slice(-10);
                if (clean.length > 0) phoneToEntity.set(clean, { id: lead.id, type: 'lead', firstName: lead.firstName, lastName: lead.lastName, status: lead.status });
            }
            if (lead.secondaryPhone) {
                const clean = lead.secondaryPhone.replace(/[^0-9]/g, '').slice(-10);
                if (clean.length > 0 && !phoneToEntity.has(clean)) phoneToEntity.set(clean, { id: lead.id, type: 'lead', firstName: lead.firstName, lastName: lead.lastName, status: lead.status });
            }
        }

        for (const contact of crmContacts) {
            let phoneList: string[] = [];
            if (Array.isArray(contact.phones)) {
                phoneList = contact.phones.map(p => String(p));
            } else if (typeof contact.phones === 'string') {
                phoneList = [contact.phones];
            }

            for (const p of phoneList) {
                const clean = p.replace(/[^0-9]/g, '').slice(-10);
                if (clean.length > 0 && !phoneToEntity.has(clean)) {
                    phoneToEntity.set(clean, { id: contact.id, type: 'contact', firstName: contact.firstName, lastName: contact.lastName });
                }
            }
        }

        console.log(`[BulkSync] Built lookup map with ${phoneToEntity.size} phone entries from ${crmLeads.length} leads and ${crmContacts.length} contacts`);

        // 2. Process each call entry (Deduplicated in-memory to prevent duplicates within payload)
        const seenCalls = new Set<string>();
        const uniqueCalls = [];
        for (const call of calls) {
            if (!call.phoneNumber) continue;
            // Generate a unique deduplication key
            const key = call.callSessionId 
                ? `session-${call.callSessionId}` 
                : (call.hardwareId && call.hardwareId !== 'none' 
                    ? `hw-${call.hardwareId}` 
                    : `time-${call.phoneNumber.replace(/[^0-9]/g, '')}-${call.timestamp}`);
            if (!seenCalls.has(key)) {
                seenCalls.add(key);
                uniqueCalls.push(call);
            }
        }
        console.log(`[BulkSync] In-memory deduplicated incoming calls list from ${calls.length} entries to ${uniqueCalls.length} unique entries`);

        // syncedHardwareIds/failedHardwareIds echo back the client's own (un-namespaced)
        // hardwareId per entry so the caller can tell exactly which queued events actually
        // made it, instead of inferring "everything" from a bare 200 — see BackendApi.bulkSync
        // and CallSyncWorker in Dad-call-recorder's call_recording_engine, which previously
        // marked its *entire* local retry queue synced (and deleted it) off nothing more than
        // an overall 2xx, silently losing any entry this endpoint legitimately skipped.
        const results: { synced: string[]; skipped: number; errors: number; syncedHardwareIds: string[]; failedHardwareIds: string[] } = {
            synced: [],
            skipped: calls.length - uniqueCalls.length, // Pre-increment skipped counts for duplicate calls
            errors: 0,
            syncedHardwareIds: [],
            failedHardwareIds: []
        };

        const trackHardwareId = (rawId: string | undefined | null, outcome: 'synced' | 'failed') => {
            if (!rawId || rawId === 'none') return;
            (outcome === 'synced' ? results.syncedHardwareIds : results.failedHardwareIds).push(rawId);
        };

        for (const call of uniqueCalls) {
            const { phoneNumber, duration, callType, timestamp, hardwareId: rawHardwareId, callSessionId, hardwareDuration } = call;
            const hardwareId = (rawHardwareId && rawHardwareId !== 'none' && !rawHardwareId.includes('_')) ? `${user.id}_${rawHardwareId}` : rawHardwareId;
            if (!phoneNumber) {
                results.skipped++;
                trackHardwareId(rawHardwareId, 'failed');
                continue;
            }

            const phoneDigits = String(phoneNumber || "").replace(/[^0-9]/g, "");
            const phoneSuffix = phoneDigits.slice(-10);
            const lockKey = (phoneSuffix && timestamp) ? `${user.id}-${phoneSuffix}-${timestamp}` : null;

            if (lockKey) {
                await acquireLock(lockKey);
            }

            try {
                // Normalize and check against CRM leads
                const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                const last10 = cleanPhone.slice(-10);

                if (last10.length === 0) {
                    results.skipped++;
                    trackHardwareId(rawHardwareId, 'failed');
                    continue;
                }

                const entity = phoneToEntity.get(last10);
                const targetLeadId = (entity && entity.type === 'lead') ? entity.id : null;
                const targetContactId = (entity && entity.type === 'contact') ? entity.id : null;
                
                const rawType = String(callType || 'UNKNOWN').toUpperCase();
                const isMissed = ['3', 'MISSED', 'MISS'].includes(rawType);
                
                // If not matched to any CRM entity, only proceed if Contact Sync is enabled OR it is a MISSED CALL
                if (!entity && !canSyncUnknown && !isMissed) {
                    // Not a CRM number and sync disabled — skip silently
                    results.skipped++;
                    trackHardwareId(rawHardwareId, 'failed');
                    continue;
                }

                // 3. Link to existing interaction (Deduplication / Reconciliation)
                const callDate = timestamp ? new Date(parseInt(timestamp, 10)) : new Date();
                const searchWindowStart = new Date(callDate.getTime() - 60 * 60 * 1000); // 1 hour before
                const searchWindowEnd = new Date(callDate.getTime() + 5 * 60 * 1000);    // 5 mins after
                
                const phoneDigits = String(phoneNumber || "").replace(/[^0-9]/g, "");
                const phoneSuffix = phoneDigits.slice(-10);

                let existingInteraction = null;

                // Priority 1: Perfect match by callSessionId
                if (callSessionId && callSessionId.length > 0) {
                    existingInteraction = await prisma.interaction.findFirst({
                        where: { organisationId: user.organisationId, callSessionId },
                        orderBy: { date: 'desc' }
                    });
                }

                // Priority 2: Perfect match by hardwareId
                if (!existingInteraction && hardwareId && hardwareId.length > 0 && hardwareId !== "none") {
                    existingInteraction = await prisma.interaction.findFirst({
                        where: { organisationId: user.organisationId, hardwareId },
                        orderBy: { date: 'desc' }
                    });
                }

                // Priority 3: Fuzzy Match — two phases to avoid merging distinct back-to-back calls
                // ─────────────────────────────────────────────────────────────────────────────────
                // THE PROBLEM this solves:
                //   If a user calls the same number 4 times in 30 mins, the old single-query
                //   approach would find the very first call each time and either skip or overwrite it,
                //   meaning only 1 interaction ever appeared in the CRM.
                //
                // Phase 3a — Reconcile a real-time 'initiated' interaction.
                //   When a call is dialled from the CRM web app, a 'initiated' interaction is
                //   created immediately. When the Android sync arrives later, we reconcile it.
                //   No duration guard needed here — the final duration isn't known at initiation.
                //
                // Phase 3b — Reconcile an already-logged call (e.g. carrier-verified update).
                //   MUST match direction AND duration (±5 s). This prevents four back-to-back
                //   calls from all being treated as the same record.
                if (!existingInteraction && phoneSuffix.length > 0) {
                    const variations = Array.from(new Set([
                        phoneSuffix,
                        `+91${phoneSuffix}`,
                        `91${phoneSuffix}`,
                        `0${phoneSuffix}`,
                        phoneDigits,
                        phoneNumber
                    ].filter(Boolean)));

                    const fuzzyWindowStart = new Date(callDate.getTime() - 24 * 60 * 60 * 1000); // 24 hours
                    const fuzzyWindowEnd   = new Date(callDate.getTime() + 5 * 60 * 1000);

                    // Phase 3a: Real-time initiated call → reconcile unconditionally
                    existingInteraction = await prisma.interaction.findFirst({
                        where: {
                            organisationId: user.organisationId,
                            createdById: user.id,
                            type: 'call',
                            callStatus: 'initiated',
                            phoneNumber: { in: variations },
                            date: { gte: fuzzyWindowStart, lte: fuzzyWindowEnd }
                        },
                        orderBy: { date: 'desc' }
                    });

                    // Phase 3b: Already-logged call — only reconcile if it's genuinely the same call
                    if (!existingInteraction) {
                        // Derive direction early from rawType (same logic used later for CREATE path)
                        const prelimDirection: 'inbound' | 'outbound' =
                            ['2', 'OUTGOING', 'OUT', 'OUTB'].includes(rawType) ? 'outbound' : 'inbound';

                        // Use raw duration for the guard (normalizeDuration runs at line below)
                        const rawDurationSecs = parseInt(String(duration), 10) || 0;
                        const FUZZY_DUR_TOL_MIN = 5 / 60; // 5-second tolerance expressed in minutes

                        existingInteraction = await prisma.interaction.findFirst({
                            where: {
                                organisationId: user.organisationId,
                                createdById: user.id,
                                type: 'call',
                                callStatus: { in: ['completed', 'missed', 'failed', 'rejected'] },
                                direction: prelimDirection,            // direction MUST match
                                phoneNumber: { in: variations },
                                date: { gte: fuzzyWindowStart, lte: fuzzyWindowEnd },
                                duration: {                            // duration must be within ±5 s
                                    gte: Math.max(0, (rawDurationSecs / 60) - FUZZY_DUR_TOL_MIN),
                                    lte: (rawDurationSecs / 60) + FUZZY_DUR_TOL_MIN
                                }
                            },
                            orderBy: { date: 'desc' }
                        });
                    }
                }

                let durationSecs = normalizeDuration(duration);

                if (existingInteraction) {
                    // HEAL EXISTING: Only update if new duration from Log is longer/better
                    const currentDuration = (existingInteraction.duration || 0) * 60;
                    const hasCarrierTruth = hardwareDuration !== null && hardwareDuration !== undefined;
                    
                    if (hasCarrierTruth || durationSecs > currentDuration || !existingInteraction.duration || existingInteraction.callStatus === 'initiated') {
                        const carrierDurationSecs = hardwareDuration ? parseInt(hardwareDuration, 10) : null;
                        
                        const tempSyncData = {
                            duration: durationSecs / 60,
                            recordingDuration: durationSecs,
                            hardwareDuration: carrierDurationSecs
                        };
                        synchronizeDurations(tempSyncData);
                        const finalizedSyncDurationSecs = resolveBestDurationSeconds(tempSyncData);

                        let direction: 'inbound' | 'outbound' = existingInteraction.direction as any || 'outbound';
                        let subject = existingInteraction.subject;
                        let status = finalizedSyncDurationSecs > 0 ? 'completed' : 'failed';

                        const incomingIdentifiers = ['1', 'INCOMING', 'IN', 'INB'];
                        const outgoingIdentifiers = ['2', 'OUTGOING', 'OUT', 'OUTB'];
                        const missedIdentifiers = ['3', 'MISSED', 'MISS'];
                        const rejectedIdentifiers = ['5', 'REJECTED', 'REJ'];

                        if (outgoingIdentifiers.includes(rawType)) {
                            direction = 'outbound';
                            subject = finalizedSyncDurationSecs > 0 ? 'Mobile Outbound Call' : 'Outbound Call Attempt (No Answer)';
                            status = finalizedSyncDurationSecs > 0 ? 'completed' : 'failed';
                        } else if (missedIdentifiers.includes(rawType)) {
                            direction = 'inbound';
                            subject = entity ? `Missed Call from ${entity.firstName || 'CRM Contact'}` : `Missed Call from ${phoneNumber}`;
                            status = 'missed';
                        } else if (rejectedIdentifiers.includes(rawType)) {
                            direction = 'inbound';
                            subject = entity ? `Rejected Call from ${entity.firstName || 'CRM Contact'}` : `Rejected Call from ${phoneNumber}`;
                            status = 'rejected';
                        } else if (incomingIdentifiers.includes(rawType)) {
                            direction = 'inbound';
                            subject = 'Mobile Inbound Call';
                            status = finalizedSyncDurationSecs > 0 ? 'completed' : 'failed';
                        } else {
                            if (direction === 'outbound') {
                                subject = finalizedSyncDurationSecs > 0 ? 'Mobile Outbound Call' : 'Outbound Call Attempt (No Answer)';
                            } else {
                                subject = finalizedSyncDurationSecs > 0 ? 'Mobile Inbound Call' : 'Mobile Call';
                            }
                        }

                        if (finalizedSyncDurationSecs > 0) {
                            status = 'completed';
                        }

                        const formattedDescription = formatCallDurationDescription(finalizedSyncDurationSecs, {
                            isCarrierVerified: carrierDurationSecs !== null
                        });

                        const updatePayload: any = {
                            duration: Math.round((finalizedSyncDurationSecs / 60) * 100) / 100,
                            recordingDuration: durationSecs,
                            callStatus: status,
                            subject: subject,
                            description: formattedDescription,
                            direction: direction,
                        };

                        if (hardwareId) updatePayload.hardwareId = hardwareId;
                        if (callSessionId) updatePayload.callSessionId = callSessionId;
                        if (carrierDurationSecs !== null) updatePayload.hardwareDuration = carrierDurationSecs;

                        await prisma.interaction.update({
                            where: { id: existingInteraction.id },
                            data: updatePayload
                        });

                        // 4b. Update Lead/Contact stats for healed interaction
                        if (targetLeadId) {
                            const leadRecord = await prisma.lead.findUnique({ where: { id: targetLeadId }, select: { status: true } });
                            const newStatus = (leadRecord?.status === 'new' && finalizedSyncDurationSecs > 0) ? 'contacted' : undefined;
                            
                            if (newStatus) {
                                await prisma.lead.update({
                                    where: { id: targetLeadId },
                                    data: { status: newStatus, lastContactDate: callDate }
                                });
                                await prisma.leadHistory.create({
                                    data: {
                                        leadId: targetLeadId,
                                        fieldName: 'status',
                                        oldValue: 'new',
                                        newValue: newStatus,
                                        changedById: user.id,
                                        reason: 'Auto-updated via Android Sync (Heal)'
                                    }
                                });
                            }
                        }
                        if (targetContactId) {
                            await prisma.contact.update({
                                where: { id: targetContactId },
                                data: { lastActivity: callDate }
                            }).catch(() => {});
                        }

                        results.synced.push(phoneNumber);
                        trackHardwareId(rawHardwareId, 'synced');
                    } else {
                        // Not worth updating (existing record already has equal-or-better
                        // data), but the call IS already represented server-side — the
                        // caller's queue entry is done, not failed.
                        results.skipped++;
                        trackHardwareId(rawHardwareId, 'synced');
                    }
                    continue;
                }

                let direction: 'inbound' | 'outbound' = 'inbound';
                let subject = 'Mobile Call';
                let status = 'completed';

                const incomingIdentifiers = ['1', 'INCOMING', 'IN', 'INB'];
                const outgoingIdentifiers = ['2', 'OUTGOING', 'OUT', 'OUTB'];
                const missedIdentifiers = ['3', 'MISSED', 'MISS'];
                const rejectedIdentifiers = ['5', 'REJECTED', 'REJ'];

                durationSecs = parseInt(duration, 10) || 0;
                const carrierDurationSecs = hardwareDuration ? parseInt(hardwareDuration, 10) : null;
                
                const tempNewData = {
                    duration: durationSecs / 60,
                    recordingDuration: durationSecs,
                    hardwareDuration: carrierDurationSecs
                };
                synchronizeDurations(tempNewData);
                
                const finalizedNewDurationSecs = resolveBestDurationSeconds(tempNewData);
                const durationMinutes = tempNewData.duration;
                const formattedDescription = formatCallDurationDescription(finalizedNewDurationSecs, {
                    isCarrierVerified: carrierDurationSecs !== null
                });

                if (outgoingIdentifiers.includes(rawType)) {
                    direction = 'outbound';
                    subject = 'Mobile Outbound Call';

                    // IRON VEIL RELAXED (v4.0): Preserve 0-sec ghosts during bulk sync
                    if (finalizedNewDurationSecs === 0 && !existingInteraction) {
                        status = 'failed';
                        subject = 'Outbound Call Attempt (No Answer)';
                    }
                    if (finalizedNewDurationSecs === 0) {
                        status = 'failed';
                        subject = 'Outbound Call Attempt (No Answer)';
                    }
                } else if (missedIdentifiers.includes(rawType)) {
                    direction = 'inbound';
                    subject = entity ? `Missed Call from ${entity.firstName || 'CRM Contact'}` : `Missed Call from ${phoneNumber}`;
                    status = 'missed';
                } else if (rejectedIdentifiers.includes(rawType)) {
                    direction = 'inbound';
                    subject = entity ? `Rejected Call from ${entity.firstName || 'CRM Contact'}` : `Rejected Call from ${phoneNumber}`;
                    status = 'rejected';
                } else {
                    direction = 'inbound';
                    if (incomingIdentifiers.includes(rawType)) {
                        subject = 'Mobile Inbound Call';
                    }
                }

                // DURATION OVERRIDE (v4.0): If duration > 0, it's NEVER 'failed' or 'missed'
                if (finalizedNewDurationSecs > 0) {
                    status = 'completed';
                }

                // 5. CallRecording row is created AFTER the raceCheck below
                //    to avoid orphaned rows when a near-duplicate is detected.

                // 6. Create the Interaction record (makes it visible in Call Logs + Timeline)
                // LAST-SECOND ATOMIC DEDUPLICATION:
                const variations = Array.from(new Set([
                    phoneSuffix,
                    `+91${phoneSuffix}`,
                    `91${phoneSuffix}`,
                    `0${phoneSuffix}`,
                    phoneDigits,
                    phoneNumber
                ].filter(Boolean)));

                // Extra guard: if hardwareId was provided, do a final global check
                // (catches cases where /recordings already created this entry)
                if (hardwareId && hardwareId.length > 0 && hardwareId !== 'none') {
                    const hwGuard = await prisma.interaction.findFirst({
                        where: { organisationId: user.organisationId, hardwareId }
                    });
                    if (hwGuard) {
                        results.synced.push(phoneNumber);
                        trackHardwareId(rawHardwareId, 'synced');
                        continue;
                    }
                }

                // LAST-SECOND ATOMIC DEDUPLICATION (v2 — fixed)
                // Goal: catch a near-simultaneous upload or a same-batch entry that slipped
                //       through the hardwareId/callSessionId guards (e.g. SDK sent neither).
                //
                // Window: ±60 s to absorb real-world Android clock skew (typically ±30 s).
                // Constraints:
                //   - direction must match: two calls with different directions are NEVER the same call.
                //   - duration must be within ±5 s: two distinct calls to the same number back-to-back
                //     will almost always differ more than 5 s in length.
                // This combination eliminates both false-positive merges and false-negative duplicates.
                const RACE_WINDOW_MS = 60 * 1000; // 60 seconds — covers NTP/carrier clock drift
                const RACE_DURATION_TOLERANCE_S = 5; // seconds

                const raceCheck = await prisma.interaction.findFirst({
                    where: {
                        organisationId: user.organisationId,
                        createdById: user.id,
                        phoneNumber: { in: variations },
                        direction: direction, // must share same direction
                        date: {
                            gte: new Date(callDate.getTime() - RACE_WINDOW_MS),
                            lte: new Date(callDate.getTime() + RACE_WINDOW_MS)
                        },
                        OR: [
                            // A 0-duration entry on EITHER side is Android's own "ghost" call-log
                            // row — some devices double-log a single real call as an instant 0s
                            // failed attempt plus the real connected entry a second or two later.
                            // These will never be within RACE_DURATION_TOLERANCE_S of each other
                            // (that's the whole reason they need merging), so the ghost case has
                            // to bypass the duration-closeness check entirely rather than requiring it.
                            { duration: 0 },
                            ...(durationMinutes === 0 ? [{}] : []),
                            // Duration must be close — prevents merging two distinct short calls
                            {
                                duration: {
                                    gte: Math.max(0, durationMinutes - (RACE_DURATION_TOLERANCE_S / 60)),
                                    lte: durationMinutes + (RACE_DURATION_TOLERANCE_S / 60)
                                }
                            }
                        ]
                    }
                });

                if (raceCheck) {
                    console.log(`[BulkSync] Atomic race check (60s window): merging duplicate for ${phoneNumber} into interaction ${raceCheck.id}`);
                    // Whichever side actually connected (higher duration) is the real call —
                    // its status/subject/description should win, not just its duration number,
                    // so a "ghost" 0s failed entry doesn't leave the merged row mislabeled.
                    const incomingIsBetter = finalizedNewDurationSecs > (raceCheck.duration || 0) * 60;
                    await prisma.interaction.update({
                        where: { id: raceCheck.id },
                        data: incomingIsBetter ? {
                            duration: Math.round(durationMinutes * 100) / 100,
                            hardwareDuration: carrierDurationSecs,
                            recordingDuration: durationSecs,
                            callStatus: status,
                            subject,
                            description: formattedDescription,
                            hardwareId: hardwareId || undefined,
                            callSessionId: callSessionId || undefined
                        } : {
                            hardwareId: hardwareId || undefined,
                            callSessionId: callSessionId || undefined
                        }
                    });
                    results.synced.push(phoneNumber);
                    trackHardwareId(rawHardwareId, 'synced');
                    continue; // skip callRecording and interaction create below
                }

                // 5. Create the CallRecording record (no audio file for bulk sync)
                // NOTE: This is intentionally placed AFTER the raceCheck so we never
                //       create an orphaned callRecording for a duplicate that gets merged.
                await prisma.callRecording.create({
                    data: {
                        leadId: targetLeadId,
                        duration: durationSecs,
                        hardwareDuration: carrierDurationSecs,
                        fileUrl: '',
                        callType: callType || 'UNKNOWN',
                        timestamp: callDate
                    }
                });

                await prisma.interaction.create({
                    data: {
                        type: 'call',
                        direction,
                        subject,
                        description: formattedDescription,
                        date: callDate,
                        duration: Math.round(durationMinutes * 100) / 100,
                        recordingDuration: durationSecs,
                        hardwareDuration: carrierDurationSecs,
                        recordingUrl: null,
                        callStatus: status,
                        leadId: targetLeadId,
                        contactId: targetContactId,
                        organisationId: user.organisationId,
                        createdById: user.id,
                        phoneNumber: phoneNumber,
                        hardwareId: hardwareId || undefined,
                        callSessionId: callSessionId || undefined
                    }
                });

                // 6b. Update Lead/Contact stats for new interaction
                if (targetLeadId) {
                    const newStatus = (entity?.type === 'lead' && entity.status === 'new' && finalizedNewDurationSecs > 0) ? 'contacted' : null;
                    
                    await prisma.lead.update({
                        where: { id: targetLeadId },
                        data: {
                            lastContactDate: callDate,
                            ...(newStatus ? { status: newStatus } : {})
                        }
                    });

                    if (newStatus) {
                        await prisma.leadHistory.create({
                            data: {
                                leadId: targetLeadId,
                                fieldName: 'status',
                                oldValue: 'new',
                                newValue: newStatus,
                                changedById: user.id,
                                reason: 'Auto-updated via Android Sync (New)'
                            }
                        });
                    }
                }
                if (targetContactId) {
                    await prisma.contact.update({
                        where: { id: targetContactId },
                        data: { lastActivity: callDate }
                    }).catch(() => {});
                }

                results.synced.push(phoneNumber);
                trackHardwareId(rawHardwareId, 'synced');
            } catch (entryError: any) {
                if (entryError.code === 'P2002') {
                    // Unique-constraint hit — a concurrent request (e.g. the real-time
                    // Tier 0 upload) already created this same record. Already represented
                    // server-side, so this is a success for the caller's queue, not a failure.
                    results.skipped++;
                    trackHardwareId(rawHardwareId, 'synced');
                } else {
                    console.error(`[BulkSync] Error processing entry:`, entryError);
                    results.errors++;
                    trackHardwareId(rawHardwareId, 'failed');
                }
            } finally {
                if (lockKey) {
                    await releaseLock(lockKey);
                }
            }
        }

        console.log(`[BulkSync] Complete: synced=${results.synced.length}, skipped=${results.skipped}, errors=${results.errors}`);
        res.status(200).json({
            message: 'Bulk sync completed',
            synced: results.synced.length,
            skipped: results.skipped,
            errors: results.errors,
            syncedNumbers: results.synced,
            // Per-entry correlation (client's own un-namespaced hardwareId) so a caller with
            // a local retry queue can tell exactly which entries actually landed, instead of
            // assuming "all of them" from this being a 200. See Dad-call-recorder's
            // BackendApi.bulkSync/CallSyncWorker.
            syncedHardwareIds: results.syncedHardwareIds,
            failedHardwareIds: results.failedHardwareIds
        });
    } catch (error) {
        console.error('[BulkSync] CRITICAL ERROR:', error);
        res.status(500).json({ error: 'Bulk sync failed' });
    }
};

// POST /api/android/helper-logs
// Ingests a batch of EngineDebugLog entries from the PypeCRM Helper app
// (Dad-call-recorder) for the super-admin "Helper Logs" panel. Never blocks
// or fails the caller's own sync flow — this is diagnostics, not a
// data-critical path, so a bad batch here shouldn't retry-storm the device.
const MAX_HELPER_LOG_BATCH = 200;
const VALID_LEVELS = new Set(['info', 'warn', 'error']);

export const uploadHelperLogs = async (req: Request, res: Response) => {
    try {
        const user = (req as any).user;
        if (!user || !user.organisationId) {
            return res.status(401).json({ error: 'Unauthorized. Organisation ID missing.' });
        }

        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        if (events.length === 0) {
            return res.status(200).json({ message: 'No events to store', stored: 0 });
        }

        const rows = events
            .slice(0, MAX_HELPER_LOG_BATCH)
            .filter((e: any) => e && typeof e.event === 'string' && e.event.trim().length > 0)
            .map((e: any) => {
                const level = VALID_LEVELS.has(e.level) ? e.level : 'info';
                const timestampMillis = Number(e.timestampMillis);
                return {
                    organisationId: user.organisationId,
                    userId: user.id,
                    event: String(e.event).slice(0, 200),
                    detail: typeof e.detail === 'string' ? e.detail.slice(0, 2000) : null,
                    level,
                    clientTimestamp: Number.isFinite(timestampMillis) ? new Date(timestampMillis) : new Date(),
                };
            });

        if (rows.length === 0) {
            return res.status(200).json({ message: 'No valid events to store', stored: 0 });
        }

        await prisma.helperActivityLog.createMany({ data: rows });
        res.status(200).json({ message: 'Helper logs stored', stored: rows.length });
    } catch (error) {
        console.error('[HelperLogs] Upload failed:', error);
        res.status(500).json({ error: 'Failed to store helper logs' });
    }
};
