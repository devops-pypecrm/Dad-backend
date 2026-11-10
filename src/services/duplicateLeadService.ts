
import prisma from '../config/prisma';

interface DuplicateCheckResult {
    isDuplicate: boolean;
    existingLead?: any;
    matchedBy?: 'phone' | 'email' | 'whatsapp';
}

interface ReEnquiryData {
    firstName: string;
    lastName: string;
    email?: string;
    phone: string;
    phoneCountryCode?: string;
    country?: string;
    countryCode?: string;
    company?: string;
    enquiryAbout?: string;
    stage?: string;
    source?: string;
    sourceDetails?: any;
    // Set only when the caller explicitly wants to move the lead to a different
    // branch/owner (e.g. a bulk import row that names a specific branch different
    // from where the existing lead already sits). When omitted, the existing
    // lead's owner and branch are left exactly as they are — the default and by
    // far the more common case, since most re-enquiries should land back with
    // whoever already has the relationship, not get silently reassigned.
    newBranchId?: string;
    newOwnerId?: string;
}

export const DuplicateLeadService = {
    /**
     * Check for duplicate leads by phone, email, or WhatsApp
     * IMPORTANT: Only considers it a duplicate if the lead is in the SAME branch
     * Same lead in different branches = NEW lead (not a re-enquiry)
     */
    async checkDuplicate(
        phone: string,
        email: string | null | undefined,
        organisationId: string,
        branchId?: string | null,
        includeAllBranches: boolean = false, // Default to false: isolate by branch
        newPhoneCountryCode?: string | null
    ): Promise<DuplicateCheckResult> {
        try {
            // Sanitize phone
            const cleanPhone = phone.toString().replace(/\D/g, '');

            // Build OR conditions for duplicate check
            const conditions: any[] = [
                { phone: cleanPhone },
                { secondaryPhone: cleanPhone },
                { phone: `+${cleanPhone}` },
                { secondaryPhone: `+${cleanPhone}` }
            ];

            // If we have at least 10 digits, we extract the last 10 digits as the core number
            // This is extremely effective for matching variations like +918086351383 vs 8086351383
            if (cleanPhone.length >= 10) {
                const core10 = cleanPhone.slice(-10);
                
                conditions.push(
                    { phone: core10 }, { secondaryPhone: core10 },
                    { phone: `+${core10}` }, { secondaryPhone: `+${core10}` },
                    { phone: `91${core10}` }, { secondaryPhone: `91${core10}` },
                    { phone: `+91${core10}` }, { secondaryPhone: `+91${core10}` },
                    { phone: `1${core10}` }, { secondaryPhone: `1${core10}` },
                    { phone: `+1${core10}` }, { secondaryPhone: `+1${core10}` },
                    { phone: { endsWith: core10 } }, { secondaryPhone: { endsWith: core10 } },
                    { phone: { contains: core10 } }, { secondaryPhone: { contains: core10 } }
                );
            }

            // Handle international variations using libphonenumber-js
            const { parsePhoneNumberFromString } = await import('libphonenumber-js');
            
            // Try to parse the phone number to handle international matches
            let phoneToParse = phone.toString().trim();
            if (!phoneToParse.startsWith('+')) {
                phoneToParse = `+${cleanPhone}`; // Assume digits include country code if no plus
            }
            
            const phoneNumber = parsePhoneNumberFromString(phoneToParse);
            if (phoneNumber) {
                const e164NoPlus = phoneNumber.format('E.164').replace('+', '');
                const national = phoneNumber.nationalNumber.toString();
                
                // Add E.164 version if different
                if (e164NoPlus !== cleanPhone) {
                    conditions.push({ phone: e164NoPlus });
                    conditions.push({ secondaryPhone: e164NoPlus });
                }
                
                // Add National version if different
                if (national !== cleanPhone && national !== e164NoPlus) {
                    conditions.push({ phone: national });
                    conditions.push({ secondaryPhone: national });
                }
            }

            if (email) {
                conditions.push({ email, organisationId });
            }

            const where: any = {
                OR: conditions,
                isDeleted: false,
                organisationId
            };

            // BRANCH ISOLATION LOGIC:
            // "in the same branch same lead should not exist twice thats it"
            // We strictly isolate the check to the provided branchId.
            if (branchId) {
                where.branchId = branchId;
            }

            console.log('[DuplicateLeadService] Checking duplicate with:', {
                phone: cleanPhone,
                email,
                organisationId,
                branchId,
                where
            });

            // Check for existing lead IN THE SAME BRANCH
            const existingLead = await prisma.lead.findFirst({
                where,
                include: {
                    assignedTo: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            email: true
                        }
                    },
                    branch: {
                        select: {
                            id: true,
                            name: true
                        }
                    }
                }
            });

            // The "last 10 digits" / "contains" conditions above are deliberately loose
            // to catch same-number variations (with/without +91, leading 0, etc.), but
            // that looseness means a brand-new international number (e.g. a Gulf
            // country lead) can coincidentally share its last 10 digits with an
            // unrelated existing lead - most often an Indian one, since the hardcoded
            // 91/1 variants above bias toward those. If the new submission explicitly
            // names a country code that conflicts with the matched lead's own stored
            // country code, this isn't a re-enquiry from the same person - it's a
            // different real number that happened to collide on digits. Without this
            // guard, treating it as a duplicate would silently attach the new
            // enquiry's details to the wrong lead and never update phone/country data
            // at all (handleReEnquiry doesn't touch those fields), leaving the org
            // admin looking at a "+91" number they never entered.
            if (existingLead && newPhoneCountryCode && existingLead.phoneCountryCode) {
                const normalize = (cc: string) => cc.replace(/\D/g, '');
                if (normalize(newPhoneCountryCode) !== normalize(existingLead.phoneCountryCode)) {
                    console.log('[DuplicateLeadService] Digit match found but country codes conflict - not a duplicate:', {
                        newPhoneCountryCode,
                        existingCountryCode: existingLead.phoneCountryCode,
                        existingLeadId: existingLead.id
                    });
                    return { isDuplicate: false };
                }
            }

            if (existingLead) {
                // Determine what matched
                let matchedBy: 'phone' | 'email' | 'whatsapp' = 'phone';
                if (email && existingLead.email === email) {
                    matchedBy = 'email';
                } else if (existingLead.phone === cleanPhone) {
                    matchedBy = 'phone';
                }

                console.log('[DuplicateLeadService] Duplicate found:', {
                    leadId: existingLead.id,
                    branch: existingLead.branch?.name,
                    matchedBy
                });

                return {
                    isDuplicate: true,
                    existingLead,
                    matchedBy
                };
            }

            console.log('[DuplicateLeadService] No duplicate found in same branch');
            return { isDuplicate: false };
        } catch (error) {
            console.error('[DuplicateLeadService] Error checking duplicate:', error);
            throw error;
        }
    },

    /**
     * Handle re-enquiry: Update existing lead and notify owner/manager
     */
    async handleReEnquiry(
        existingLead: any,
        newData: ReEnquiryData,
        organisationId: string
    ): Promise<any> {
        try {
            const now = new Date();

            // Only auto-set status to 're_enquiry' if nobody has actually worked this lead yet
            // (status is empty, still 'new', or already flagged as a re-enquiry). If a rep/admin
            // has already moved it to any other status (interested, contacted, qualified, won,
            // lost, or any org-custom status), preserve it — a re-enquiry must not clobber a
            // rep's progress. isReEnquiry/reEnquiryCount/notifications below still fire either way,
            // so the lead still surfaces on the Re-Enquiries page (which filters by isReEnquiry,
            // not status) even when status is left untouched.
            const currentStatus = existingLead.status ? existingLead.status.toLowerCase() : null;
            const noProgressYet = !currentStatus || ['new', 're_enquiry'].includes(currentStatus);
            const newStatus = noProgressYet
                ? (newData.stage ? newData.stage.toLowerCase() : 're_enquiry')
                : existingLead.status;

            // Only actually move branch/owner when the caller asked to AND it's a
            // genuine change — an explicit newBranchId equal to the current one (or a
            // newOwnerId equal to the current owner) shouldn't generate no-op history
            // entries or a "reassigned" notification for nothing changing.
            const movingBranch = !!newData.newBranchId && newData.newBranchId !== existingLead.branchId;
            const movingOwner = !!newData.newOwnerId && newData.newOwnerId !== existingLead.assignedToId;

            // A re-enquiry is matched purely by phone number (see checkDuplicate) - the
            // same number can genuinely belong to a different person re-enquiring later
            // (family member, shared/office line, a data-entry mix-up on either
            // submission, etc.), and blindly overwriting the name here silently renamed
            // an unrelated person's lead to whoever submitted the new form (reported:
            // "Athira" at Edufolio became "Arun Kumar" after a same-phone, different-name
            // re-enquiry from an unrelated ad campaign). Only take the new name when the
            // existing one looks like a placeholder (blank) or the names actually match -
            // otherwise keep the original identity untouched. The incoming name/details
            // are never lost either way - they're already captured in full under
            // sourceDetails.reEnquiries[].details below, so nothing needs inventing here,
            // just not clobbering.
            const namesMatch = (a?: string | null, b?: string | null) =>
                (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
            const keepExistingName = !!existingLead.firstName?.trim() && !namesMatch(newData.firstName, existingLead.firstName);

            // Update existing lead with latest contact info if provided
            const updatedLead = await prisma.lead.update({
                where: { id: existingLead.id },
                data: {
                    firstName: keepExistingName ? existingLead.firstName : (newData.firstName || existingLead.firstName),
                    lastName: keepExistingName ? existingLead.lastName : (newData.lastName || existingLead.lastName),
                    email: (newData.email && newData.email.trim() !== '') ? newData.email.trim() : existingLead.email,
                    // checkDuplicate already vetoes a country-code conflict as "not a
                    // duplicate" at all, so reaching here means either no conflict or the
                    // existing lead simply never had one recorded - fill it in from this
                    // submission rather than leaving it permanently blank/wrong.
                    ...(newData.phoneCountryCode ? { phoneCountryCode: newData.phoneCountryCode } : {}),
                    ...(newData.country ? { country: newData.country } : {}),
                    ...(newData.countryCode ? { countryCode: newData.countryCode } : {}),
                    company: newData.company || existingLead.company,
                    status: newStatus,
                    stage: newData.stage || existingLead.stage,
                    isReEnquiry: true,
                    ...(movingBranch ? { branchId: newData.newBranchId } : {}),
                    ...(movingOwner ? { assignedToId: newData.newOwnerId, previousOwnerId: existingLead.assignedToId } : {}),
                    isDeleted: false, // Restore if it was deleted
                    reEnquiryCount: { increment: 1 },
                    lastEnquiryDate: now,
                    enquiryAbout: newData.enquiryAbout || newData.sourceDetails?.message || existingLead.enquiryAbout,
                    // Update source details to track re-enquiry
                    sourceDetails: {
                        ...(existingLead.sourceDetails as any || {}),
                        reEnquiries: [
                            ...((existingLead.sourceDetails as any)?.reEnquiries || []),
                            {
                                date: now.toISOString(),
                                source: newData.source,
                                details: newData.sourceDetails,
                                // Snapshot of exactly what THIS submission carried, kept
                                // separately from the merged lead's current fields above -
                                // used by the "Re-Enquiry History" tab / "create as separate
                                // lead" action so a rep can tell what a given re-enquiry
                                // actually said, and split it off with real contact details
                                // instead of just a name.
                                submittedName: `${newData.firstName || ''} ${newData.lastName || ''}`.trim() || null,
                                submittedPhone: newData.phone || null,
                                submittedEmail: newData.email || null,
                                // "Course interested in" for this specific re-enquiry — distinct
                                // from the merged lead's current `enquiryAbout` above, which gets
                                // overwritten on every re-enquiry. Only present going forward;
                                // re-enquiries recorded before this field existed have none.
                                enquiryAbout: newData.enquiryAbout || newData.sourceDetails?.message || null
                            }
                        ]
                    }
                },
                include: {
                    assignedTo: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            email: true,
                            reportsToId: true
                        }
                    }
                }
            });

            // Create interaction record for timeline
            await prisma.interaction.create({
                data: {
                    type: 'other',
                    direction: 'inbound',
                    subject: 'Re-Enquiry Received',
                    description: `Lead ${existingLead.firstName} ${existingLead.lastName} has enquired again. This is re-enquiry #${updatedLead.reEnquiryCount}. Previous status: ${existingLead.status}`,
                    date: now,
                    leadId: existingLead.id,
                    createdById: existingLead.assignedToId,
                    organisationId
                }
            });

            // Log in LeadHistory for ownership history timeline — only record a "status" field
            // change when the status actually changed; otherwise log the re-enquiry as a note
            // so the timeline doesn't claim a status transition that didn't happen.
            await prisma.leadHistory.create({
                data: {
                    leadId: existingLead.id,
                    reason: newStatus !== existingLead.status
                        ? `Re-Enquiry received from ${newData.source || 'Website'}`
                        : `Re-Enquiry received from ${newData.source || 'Website'} (status kept as "${existingLead.status}")`,
                    fieldName: newStatus !== existingLead.status ? 'status' : 'reEnquiryCount',
                    oldValue: newStatus !== existingLead.status ? existingLead.status : String(existingLead.reEnquiryCount ?? 0),
                    newValue: newStatus !== existingLead.status ? newStatus : String(updatedLead.reEnquiryCount),
                    createdAt: now
                }
            });

            // A branch/owner move gets its own explicit history entry, separate from the
            // generic re-enquiry note above, so "why did this lead change hands" is
            // answerable from the timeline alone.
            if (movingOwner || movingBranch) {
                await prisma.leadHistory.create({
                    data: {
                        leadId: existingLead.id,
                        oldOwnerId: movingOwner ? existingLead.assignedToId : undefined,
                        newOwnerId: movingOwner ? newData.newOwnerId : undefined,
                        reason: `Re-enquiry moved to a different branch during import (${newData.source || 'import'})`,
                        createdAt: now
                    }
                });
            }

            if (movingOwner) {
                // Ownership actually changed — this reads as a fresh assignment to the new
                // owner, not a "your old lead enquired again" alert (they don't own it anymore).
                if (updatedLead.assignedToId) {
                    const { NotificationService } = await import('./notificationService');
                    await NotificationService.send(
                        updatedLead.assignedToId,
                        'New Lead Assigned',
                        `${updatedLead.firstName} ${updatedLead.lastName || ''} (a re-enquiry, reassigned to your branch) has been assigned to you.`,
                        'success'
                    );
                }
            } else if (updatedLead.assignedToId) {
                await this.notifyOwner(updatedLead, organisationId);
            }

            // Notify the manager if exists
            const managerId = updatedLead.assignedTo?.reportsToId;
            if (managerId) {
                await this.notifyManager(updatedLead, managerId, organisationId);
            }

            console.log(`[DuplicateLeadService] Re-enquiry handled for lead ${existingLead.id}`);
            return updatedLead;
        } catch (error) {
            console.error('[DuplicateLeadService] Error handling re-enquiry:', error);
            throw error;
        }
    },

    /**
     * Notify lead owner about re-enquiry
     */
    async notifyOwner(lead: any, organisationId: string): Promise<void> {
        try {
            const { NotificationService } = await import('./notificationService');

            const ownerId = lead.assignedToId || lead.assignedTo?.id;
            if (!ownerId) {
                console.log(`[DuplicateLeadService] No owner to notify for lead ${lead.id}`);
                return;
            }

            await NotificationService.send(
                ownerId,
                'Re-Enquiry Alert',
                `🔄 ${lead.firstName} ${lead.lastName} has enquired again! This is their ${lead.reEnquiryCount}${this.getOrdinalSuffix(lead.reEnquiryCount)} enquiry. The lead is still interested - follow up immediately.`,
                'warning'
            );

            console.log(`[DuplicateLeadService] Owner notified for lead ${lead.id}`);
        } catch (error) {
            console.error('[DuplicateLeadService] Error notifying owner:', error);
        }
    },

    /**
     * Notify manager about re-enquiry
     */
    async notifyManager(lead: any, managerId: string, organisationId: string): Promise<void> {
        try {
            const { NotificationService } = await import('./notificationService');

            const ownerName = lead.assignedTo
                ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`
                : 'Unknown';

            await NotificationService.send(
                managerId,
                'Team Re-Enquiry Alert',
                `🔄 Re-enquiry detected: ${lead.firstName} ${lead.lastName} (assigned to ${ownerName}) has enquired again. Re-enquiry count: ${lead.reEnquiryCount}`,
                'info'
            );

            console.log(`[DuplicateLeadService] Manager notified for lead ${lead.id}`);
        } catch (error) {
            console.error('[DuplicateLeadService] Error notifying manager:', error);
        }
    },

    /**
     * Get ordinal suffix for numbers (1st, 2nd, 3rd, etc.)
     */
    getOrdinalSuffix(num: number): string {
        const j = num % 10;
        const k = num % 100;
        if (j === 1 && k !== 11) return 'st';
        if (j === 2 && k !== 12) return 'nd';
        if (j === 3 && k !== 13) return 'rd';
        return 'th';
    },

    /**
     * Find all potential duplicates in the system
     */
    async findDuplicates(organisationId: string): Promise<any[]> {
        try {
            // Find leads with duplicate phone numbers WITHIN THE SAME BRANCH
            const duplicatesByPhone = await prisma.$queryRaw<any[]>`
                SELECT phone, "branchId", COUNT(*) as count, 
                       array_agg(id) as lead_ids,
                       array_agg("firstName" || ' ' || "lastName") as names
                FROM "Lead"
                WHERE "organisationId" = ${organisationId}
                  AND "isDeleted" = false
                  AND phone IS NOT NULL
                  AND phone != ''
                GROUP BY phone, "branchId"
                HAVING COUNT(*) > 1
            `;

            // Find leads with duplicate emails WITHIN THE SAME BRANCH
            const duplicatesByEmail = await prisma.$queryRaw<any[]>`
                SELECT email, "branchId", COUNT(*) as count,
                       array_agg(id) as lead_ids,
                       array_agg("firstName" || ' ' || "lastName") as names
                FROM "Lead"
                WHERE "organisationId" = ${organisationId}
                  AND "isDeleted" = false
                  AND email IS NOT NULL
                  AND email != ''
                GROUP BY email, "branchId"
                HAVING COUNT(*) > 1
            `;

            return [
                ...duplicatesByPhone.map(d => ({ 
                    ...d, 
                    count: Number(d.count),
                    type: 'phone' 
                })),
                ...duplicatesByEmail.map(d => ({ 
                    ...d, 
                    count: Number(d.count),
                    type: 'email' 
                }))
            ];
        } catch (error) {
            console.error('[DuplicateLeadService] Error finding duplicates:', error);
            return [];
        }
    },

    /**
     * Get re-enquiry leads for an organization
     */
    async getReEnquiryLeads(organisationId: string, branchId?: string, limit = 50): Promise<any[]> {
        try {
            const where: any = {
                organisationId,
                isDeleted: false,
                isReEnquiry: true
            };

            if (branchId) {
                where.branchId = branchId;
            }

            const reEnquiryLeads = await prisma.lead.findMany({
                where,
                include: {
                    assignedTo: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            email: true
                        }
                    }
                },
                orderBy: {
                    lastEnquiryDate: 'desc'
                },
                take: limit
            });

            return reEnquiryLeads;
        } catch (error) {
            console.error('[DuplicateLeadService] Error getting re-enquiry leads:', error);
            return [];
        }
    }
};

export default DuplicateLeadService;
