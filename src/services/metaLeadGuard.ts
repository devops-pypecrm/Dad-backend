/**
 * MetaLeadGuard — Idempotency & Race Condition Protection
 *
 * Problem: Meta leads can arrive from 3 different places:
 *   1. POST /api/meta/webhook  — real-time webhook from Meta
 *   2. POST /api/meta/callback — older webhook endpoint
 *   3. MetaPollingService      — cron-based fallback polling
 *
 * Without a guard, if all 3 fire for the same lead, it gets
 * processed 3 times → 3 duplicate CRM leads.
 *
 * This guard uses a two-layer dedup:
 *   Layer 1: In-memory Set (fast, prevents race conditions within same process)
 *   Layer 2: Database check (persistent, survives server restarts)
 */

import prisma from '../config/prisma';

// In-memory set of leadgenIds currently being processed
// Format: "orgId:leadgenId" for per-org isolation
const inFlightLeads = new Set<string>();

// Track processing counts for monitoring
const stats = {
    totalReceived: 0,
    totalDedupedInMemory: 0,
    totalDedupedInDB: 0,
    totalProcessed: 0,
    totalFailed: 0,
    lastReset: new Date()
};

export const MetaLeadGuard = {
    /**
     * Attempt to acquire a processing lock for a lead.
     * Returns true if processing should proceed, false if it's already being handled.
     */
    async acquireLock(leadgenId: string, orgId: string): Promise<boolean> {
        const key = `${orgId}:${leadgenId}`;
        stats.totalReceived++;

        // Layer 1: In-memory dedup (protects against concurrent webhook + polling)
        if (inFlightLeads.has(key)) {
            stats.totalDedupedInMemory++;
            console.log(`[MetaLeadGuard] ⚡ In-memory dedup: Lead ${leadgenId} already in-flight for Org ${orgId}. Skipping.`);
            return false;
        }

        // Layer 2: Database dedup (protects against server restarts / replays)
        // A submission that matched an existing phone number never creates its own lead -
        // it is recorded as a re-enquiry, and its Meta lead ID lives inside
        // sourceDetails.reEnquiries[].details, not at the top level. Checking only the
        // top level meant the 24h polling window re-processed such a submission on every
        // 30-minute run (one fake re-enquiry per run), so look in both places.
        const existsInDB = await prisma.lead.findFirst({
            where: {
                organisationId: orgId,
                OR: [
                    { sourceDetails: { path: ['metaLeadgenId'], equals: leadgenId } },
                    { sourceDetails: { path: ['reEnquiries'], array_contains: [{ details: { metaLeadgenId: leadgenId } }] } }
                ]
            },
            select: { id: true }
        });

        if (existsInDB) {
            stats.totalDedupedInDB++;
            console.log(`[MetaLeadGuard] 🗄️ DB dedup: Lead ${leadgenId} already saved for Org ${orgId} (Lead ID: ${existsInDB.id}). Skipping.`);
            return false;
        }

        // Acquire the lock
        inFlightLeads.add(key);
        console.log(`[MetaLeadGuard] ✅ Lock acquired for lead ${leadgenId} (Org: ${orgId}). In-flight count: ${inFlightLeads.size}`);
        return true;
    },

    /**
     * Release the processing lock for a lead.
     * Must always be called after acquireLock returns true — success or failure.
     */
    releaseLock(leadgenId: string, orgId: string): void {
        const key = `${orgId}:${leadgenId}`;
        inFlightLeads.delete(key);
    },

    /**
     * Mark a lead as successfully processed.
     */
    markSuccess(leadgenId: string, orgId: string): void {
        stats.totalProcessed++;
        this.releaseLock(leadgenId, orgId);
        console.log(`[MetaLeadGuard] ✅ Lead ${leadgenId} processed successfully for Org ${orgId}. Stats: +${stats.totalProcessed} total`);
    },

    /**
     * Mark a lead as failed processing.
     */
    markFailure(leadgenId: string, orgId: string, error: any): void {
        stats.totalFailed++;
        this.releaseLock(leadgenId, orgId);
        console.error(`[MetaLeadGuard] ❌ Lead ${leadgenId} FAILED for Org ${orgId}:`, error?.message || error);
    },

    /**
     * Get current processing stats for monitoring.
     */
    getStats() {
        return {
            ...stats,
            currentlyInFlight: inFlightLeads.size,
            uptimeSeconds: Math.floor((Date.now() - stats.lastReset.getTime()) / 1000)
        };
    },

    /**
     * Validate that the webhook payload is structurally valid before processing.
     * Returns null if valid, or an error message if invalid.
     */
    validateWebhookPayload(body: any): string | null {
        if (!body) return 'Empty payload';
        if (body.object !== 'page') return `Unknown object type: ${body.object}`;
        if (!Array.isArray(body.entry)) return 'Missing entry array';
        if (body.entry.length === 0) return 'Empty entry array';
        return null; // valid
    },

    /**
     * Validate a single lead's data before saving.
     * Returns null if valid, or an error message if invalid.
     */
    validateLeadData(metaLeadData: any): string | null {
        if (!metaLeadData) return 'No lead data';
        if (!metaLeadData.id) return 'Missing lead ID (leadgen_id)';
        if (!Array.isArray(metaLeadData.field_data)) return 'Missing field_data array';
        return null; // valid
    },

    /**
     * Clean up stale in-flight locks older than 5 minutes.
     * Called automatically every 5 minutes by the guard's own timer.
     */
    _startStaleLockCleaner() {
        // We store timestamps alongside keys to detect stale locks
        // For simplicity, just clear the whole set every 10 minutes
        // (locks should be milliseconds, not minutes — if still there after 10min, it's stale)
        setInterval(() => {
            const sizeBefore = inFlightLeads.size;
            if (sizeBefore > 0) {
                console.warn(`[MetaLeadGuard] ⚠️ Clearing ${sizeBefore} potentially stale in-flight locks`);
                inFlightLeads.clear();
            }
        }, 10 * 60 * 1000); // Every 10 minutes
    }
};

// Start the stale lock cleaner automatically
MetaLeadGuard._startStaleLockCleaner();

export default MetaLeadGuard;
