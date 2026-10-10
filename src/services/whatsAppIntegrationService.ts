import prisma from '../config/prisma';
import { getIO } from '../socket';
import { GallaboxService } from './gallaboxService';

export const WhatsAppIntegrationService = {
    /**
     * Handle incoming webhook from Meta / WhatsApp Business API
     */
    async handleWebhook(payload: any): Promise<void> {
        try {
            console.log('[WhatsAppWebhook] Received Meta payload:', JSON.stringify(payload, null, 2));

            if (payload.entry) {
                for (const entry of payload.entry) {
                    if (entry.changes) {
                        for (const change of entry.changes) {
                            if (change.field === 'message_template_status_update') {
                                const { WhatsAppTemplateService } = await import('./whatsAppTemplateService');
                                await WhatsAppTemplateService.handleStatusWebhook(String(entry.id), change.value);
                            }

                            if (change.field === 'phone_number_quality_update' || change.field === 'account_update') {
                                const { WhatsAppHealthService } = await import('./whatsAppHealthService');
                                const phoneId = change.value?.phone_number_id;
                                const acct = phoneId
                                    ? await prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: phoneId, isDeleted: false } })
                                    : await prisma.whatsAppAccount.findFirst({ where: { wabaId: String(entry.id), isDeleted: false } });
                                if (acct) await WhatsAppHealthService.checkAccount(acct.id).catch(() => undefined);
                            }

                            if (change.field === 'messages') {
                                const value = change.value;

                                // Handle incoming messages
                                if (value.messages) {
                                    for (const message of value.messages) {
                                        await this.processMetaMessage(value, message);
                                    }
                                }

                                // Handle message status updates
                                if (value.statuses) {
                                    await this.processStatusUpdate(value);
                                }
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[WhatsAppWebhook] Error processing Meta webhook:', error);
        }
    },

    /**
     * Handle incoming webhook from Gallabox
     */
    async handleGallaboxWebhook(payload: any): Promise<void> {
        try {
            console.log('[GallaboxWebhook] Received payload:', JSON.stringify(payload, null, 2));

            // Gallabox event structure check
            const event = payload.event;
            if (event !== 'Message.received') {
                console.log(`[GallaboxWebhook] Ignoring event type: ${event}`);
                return;
            }

            const data = payload.data;
            if (!data || !data.phoneNumber) {
                console.warn('[GallaboxWebhook] Missing data or phone number in payload');
                return;
            }

            // Find organisation by Gallabox Channel ID
            const channelId = data.channelId;
            const orgs = await prisma.organisation.findMany({
                select: { id: true, integrations: true }
            }).then(orgs => {
                return orgs.filter(org => {
                    const integrations = org.integrations as any;
                    return integrations?.gallabox?.channelId === channelId;
                });
            });

            if (orgs.length === 0) {
                console.log('[GallaboxWebhook] No organisation found for channelId:', channelId);
                return;
            }
            const organisationId = orgs[0].id;

            // Normalize payload for generic processing
            const normalizedMessage = {
                from: data.phoneNumber,
                id: data.id || `gallabox_${Date.now()}`,
                timestamp: Math.floor(Date.now() / 1000), // Default to current time if missing
                type: data.type === 'text' ? 'text' : 'unknown',
                body: data.messageText || '',
                senderName: data.senderName || data.phoneNumber
            };

            const account = await prisma.whatsAppAccount.findFirst({
                where: { organisationId, phoneNumberId: channelId, isDeleted: false }
            });

            await this.saveIncomingMessage(organisationId, normalizedMessage, 'gallabox', account?.id);

        } catch (error) {
            console.error('[GallaboxWebhook] Error processing Gallabox webhook:', error);
        }
    },

    /**
     * Parse Meta specific structure and funnel to generic saver
     */
    async processMetaMessage(value: any, message: any) {
        const { metadata, contacts } = value;
        
        // Find the organisation that owns the receiving number: the relational
        // WhatsAppAccount table first, then the legacy Organisation.integrations JSON
        // (single-number config / whatsappAccounts array) for older connections.
        let account = await prisma.whatsAppAccount.findFirst({
            where: { phoneNumberId: metadata.phone_number_id, isDeleted: false }
        });
        let org: { id: string } | undefined = account ? { id: account.organisationId } : undefined;

        if (!org) {
            const orgs = await prisma.organisation.findMany({ select: { id: true, integrations: true } }).then(all =>
                all.filter(o => {
                    const integrations = o.integrations as any;
                    const accounts: any[] = Array.isArray(integrations?.whatsappAccounts) ? integrations.whatsappAccounts : [];
                    return (integrations?.whatsapp?.phoneNumberId === metadata.phone_number_id) ||
                        (integrations?.meta?.phoneNumberId === metadata.phone_number_id) ||
                        accounts.some((a: any) => a.phoneNumberId === metadata.phone_number_id);
                })
            );
            org = orgs[0];
        }
        if (!org) return;

        if (account) {
            prisma.whatsAppAccount.update({ where: { id: account.id }, data: { lastWebhookAt: new Date() } }).catch(() => undefined);
        }

        const contact = contacts?.find((c: any) => c.wa_id === message.from);
        
        // Interactive replies (button/list taps) carry no `text.body` - surface the
        // selected option's id/title so the flow engine can match it against a
        // node's outgoing edges, and so it still reads sensibly as `body` for the
        // keyword-automation engine and the inbox UI.
        const interactiveReply = message.interactive?.button_reply || message.interactive?.list_reply;

        // Quick-reply buttons on a template arrive as type "button"
        const templateButton = message.button;

        const normalizedMessage = {
            from: message.from,
            id: message.id,
            timestamp: parseInt(message.timestamp),
            type: message.text ? 'text' : ((interactiveReply || templateButton) ? 'interactive' : (message.image ? 'image' : (message.document ? 'document' : (message.audio ? 'audio' : (message.video ? 'video' : (message.location ? 'location' : (message.sticker ? 'image' : 'unknown'))))))),
            body: message.text?.body || interactiveReply?.title || templateButton?.text || '',
            interactiveReplyId: interactiveReply?.id,
            senderName: contact?.profile?.name || message.from,
            // Meta specific content expansion
            metaImage: message.image,
            metaDoc: message.document,
            metaAudio: message.audio,
            metaVideo: message.video,
            metaLocation: message.location
        };

        if (!account) {
            account = await prisma.whatsAppAccount.findFirst({
                where: { organisationId: org.id, phoneNumberId: metadata.phone_number_id, isDeleted: false }
            });
        }

        await this.saveIncomingMessage(org.id, normalizedMessage, 'meta', account?.id);
    },

    /**
     * Unified logic for saving messages and creating leads
     */
    async saveIncomingMessage(organisationId: string, message: any, provider: string, whatsappAccountId?: string) {
        try {
            const normalizedPhone = message.from.replace(/\D/g, '');
            const { DuplicateLeadService } = await import('./duplicateLeadService');

            // Check if message already exists (app-level check; the DB @@unique on
            // [organisationId, waMessageId] is the authoritative guard against races -
            // see the P2002 catch below on create).
            if (message.id) {
                const existingMessage = await prisma.whatsAppMessage.findFirst({
                    where: {
                        waMessageId: message.id,
                        organisationId
                    }
                });

                if (existingMessage) return;
            }

            // Determine content structure
            let messageType = message.type;
            const content: any = { text: message.body };

            // Handle Meta specific attachments if present
            if (provider === 'meta') {
                if (message.metaImage) {
                    messageType = 'image';
                    content.mediaUrl = message.metaImage.id;
                    content.caption = message.metaImage.caption;
                } else if (message.metaDoc) {
                    messageType = 'document';
                    content.mediaUrl = message.metaDoc.id;
                    content.fileName = message.metaDoc.filename;
                    content.caption = message.metaDoc.caption;
                }
                else if (message.metaAudio) {
                    messageType = 'audio';
                    content.mediaUrl = message.metaAudio.id;
                } else if (message.metaVideo) {
                    messageType = 'video';
                    content.mediaUrl = message.metaVideo.id;
                    content.caption = message.metaVideo.caption;
                } else if (message.metaLocation) {
                    messageType = 'location';
                    content.latitude = message.metaLocation.latitude;
                    content.longitude = message.metaLocation.longitude;
                    content.text = message.metaLocation.name || message.metaLocation.address || 'Shared a location';
                }
            }

            // Try to find an existing Lead anywhere in the org (not branch-scoped -
            // an inbound message should attach to whichever record already owns this
            // phone number, regardless of which branch it belongs to), using the same
            // phone-normalization/variant logic as manual duplicate detection.
            const existingLeadCheck = await DuplicateLeadService.checkDuplicate(
                normalizedPhone,
                null,
                organisationId,
                null,
                true // includeAllBranches - identification, not branch-scoped dedup
            );
            let lead = existingLeadCheck.isDuplicate ? existingLeadCheck.existingLead : null;

            const contactRecord = await prisma.$queryRawUnsafe(`
                SELECT id FROM "Contact"
                WHERE "organisationId" = $1
                AND ("phones"::text ILIKE $2 OR "phones"::text ILIKE $3)
            `, organisationId, `%${message.from}%`, `%${normalizedPhone}%`) as any[];

            const contactId = contactRecord?.[0]?.id;

            // Create WhatsApp message record. If waMessageId already exists for this
            // org (a concurrent duplicate webhook delivery slipped past the check
            // above), the DB unique constraint rejects it - treat that as "already
            // handled" and stop, same as the findFirst short-circuit above.
            let messageRecord: any;
            try {
                messageRecord = await prisma.whatsAppMessage.create({
                    data: {
                        conversationId: `${message.from}_${organisationId}`, // replaced with the conversation row id below
                        phoneNumber: message.from.replace(/\D/g, ''),
                        direction: 'incoming',
                        source: 'customer',
                        messageType,
                        content,
                        status: 'delivered',
                        waMessageId: message.id,
                        deliveredAt: new Date(message.timestamp * 1000),
                        organisationId,
                        leadId: lead?.id,
                        contactId: contactId,
                        whatsappAccountId,
                        isReadByAgent: false
                    }
                });
            } catch (createError: any) {
                if (createError?.code === 'P2002') {
                    console.warn(`[WhatsAppWebhook] Duplicate waMessageId ${message.id} for org ${organisationId} - already processed`);
                    return;
                }
                throw createError;
            }

            // Create lead if none exists and link to message
            if (!lead && !contactId) {
                const contactName = message.senderName || message.from;
                const cleanPhone = normalizedPhone; // Service handles normalization

                // Resolve target branch early to isolate duplicate check
                const { DistributionService } = await import('./distributionService');

                // Simulate distribution to find target owner and their branch
                // We use a dummy lead object for simulation
                const targetOwnerId = await DistributionService.assignLead(
                    { firstName: contactName, phone: cleanPhone, organisationId },
                    organisationId
                );

                let targetBranchId = null;
                if (targetOwnerId) {
                    const assignedUser = await prisma.user.findUnique({
                        where: { id: targetOwnerId },
                        select: { branchId: true }
                    });
                    targetBranchId = assignedUser?.branchId || null;
                }

                // Check for duplicates in the RESOLVED branch
                const duplicateCheck = await DuplicateLeadService.checkDuplicate(
                    cleanPhone,
                    null,
                    organisationId,
                    targetBranchId
                );

                let leadToLink;

                if (duplicateCheck.isDuplicate && duplicateCheck.existingLead) {
                    await DuplicateLeadService.handleReEnquiry(
                        duplicateCheck.existingLead,
                        {
                            firstName: contactName.split(' ')[0] || contactName,
                            lastName: contactName.split(' ').slice(1).join(' ') || '',
                            phone: cleanPhone,
                            source: 'whatsapp',
                            sourceDetails: { provider, messageId: message.id }
                        },
                        organisationId
                    );
                    leadToLink = duplicateCheck.existingLead;
                } else {
                    try {
                        leadToLink = await prisma.lead.create({
                            data: {
                                firstName: contactName.split(' ')[0] || contactName,
                                lastName: contactName.split(' ').slice(1).join(' ') || '',
                                phone: cleanPhone,
                                source: 'whatsapp',
                                status: 'new',
                                organisationId,
                                assignedToId: targetOwnerId || undefined,
                                branchId: targetBranchId
                            }
                        });
                    } catch (leadCreateError: any) {
                        if (leadCreateError?.code === 'P2002') {
                            // Lost a race to a concurrent inbound message from the same
                            // number - another request already created the Lead. Re-fetch
                            // and link to it instead of dropping this message unlinked.
                            console.warn(`[WhatsAppWebhook] Lost race creating Lead for phone ${cleanPhone} in org ${organisationId} - linking to concurrently-created Lead`);
                            const raceWinner = await DuplicateLeadService.checkDuplicate(
                                cleanPhone,
                                null,
                                organisationId,
                                targetBranchId
                            );
                            leadToLink = raceWinner.existingLead;
                        } else {
                            throw leadCreateError;
                        }
                    }
                }

                if (leadToLink) {
                    await prisma.whatsAppMessage.update({
                        where: { id: messageRecord.id },
                        data: { leadId: leadToLink.id }
                    });
                }
            }

            // Re-read: the lead-creation block above may have linked a lead to this message.
            messageRecord = (await prisma.whatsAppMessage.findUnique({ where: { id: messageRecord.id } })) || messageRecord;

            // Conversation bookkeeping: inbox row, unread count and the 24h window start.
            const { WhatsAppConversationService, previewFor } = await import('./whatsAppConversationService');
            const convo = await WhatsAppConversationService.touch({
                organisationId, whatsappAccountId, phoneNumber: message.from, direction: 'incoming',
                preview: previewFor(messageType, content), displayName: message.senderName,
                leadId: messageRecord.leadId, contactId: messageRecord.contactId,
                at: new Date(message.timestamp * 1000)
            });
            messageRecord = await prisma.whatsAppMessage.update({
                where: { id: messageRecord.id },
                data: { conversationId: convo.id, leadId: messageRecord.leadId || convo.leadId || undefined }
            });

            // Real-time notification
            const io = getIO();
            if (io) {
                io.to(`org:${organisationId}`).emit('whatsapp_message_received', {
                    message: messageRecord,
                    phoneNumber: message.from,
                    conversationId: convo.id
                });
            }

            // Consent: STOP / START keywords, and any reply cancels running nurture sequences.
            const { WhatsAppComplianceService } = await import('./whatsAppComplianceService');
            const { WhatsAppNurtureService } = await import('./whatsAppNurtureService');
            const keyword = WhatsAppComplianceService.classifyKeyword(message.type === 'text' ? message.body : '');
            if (keyword === 'out') {
                await WhatsAppComplianceService.optOut(organisationId, message.from, 'keyword');
                try {
                    const { WhatsAppSender } = await import('./whatsAppSender');
                    await WhatsAppSender.send({ organisationId, to: message.from, accountId: whatsappAccountId, source: 'flow', text: 'You have been unsubscribed and will no longer receive messages from us. Reply START anytime to resume.' });
                } catch (e) { /* confirmation is best-effort */ }
                return; // never trigger bots after an opt-out
            }
            if (keyword === 'in') {
                await WhatsAppComplianceService.optIn(organisationId, message.from);
            }
            await WhatsAppNurtureService.cancelOnReply(organisationId, message.from).catch(err => console.error('[WhatsAppWebhook] nurture cancel failed', err));

            // A human is already handling this conversation: record only, no bots.
            if (convo.botPausedUntil && convo.botPausedUntil > new Date()) return;

            // Flow builder dispatch takes priority over the simpler keyword
            // automation engine below: a message mid-flow is a reply to that flow,
            // not an unrelated keyword trigger. Only if no flow session is active
            // AND no flow's trigger matches does the plain automation hook run -
            // this keeps today's behavior identical for orgs not using Flows at all.
            let handledByFlow = false;
            try {
                const { WhatsAppFlowEngine } = await import('./whatsAppFlowEngine');
                const activeSession = await WhatsAppFlowEngine.getActiveSession(message.from, whatsappAccountId, organisationId);

                if (activeSession) {
                    await WhatsAppFlowEngine.handleReply(activeSession, activeSession.flow, {
                        buttonId: message.interactiveReplyId,
                        text: message.body
                    });
                    handledByFlow = true;
                } else {
                    // A reply to a specific campaign's broadcast takes priority over a
                    // generic keyword/any_message flow - multiple campaigns can run on
                    // the same number, each with its own dedicated reply flow, without
                    // depending on the recipient using a particular keyword.
                    const campaignFlow = await WhatsAppFlowEngine.findCampaignFlow(message.from, organisationId);
                    const matchingFlow = campaignFlow || await WhatsAppFlowEngine.findMatchingFlow(whatsappAccountId, organisationId, message.body);
                    if (matchingFlow) {
                        await WhatsAppFlowEngine.startFlow(matchingFlow, message.from, whatsappAccountId, organisationId, messageRecord.leadId);
                        handledByFlow = true;
                    }
                }
            } catch (flowError) {
                console.error('[WhatsAppWebhook] WhatsAppFlowEngine dispatch failed:', flowError);
            }

            // The AI agent answers anything no flow claimed, but explicit keyword
            // automations (below) run first when the org has configured any matching one.
            let handledByAI = false;
            if (!handledByFlow && message.type === 'text') {
                try {
                    const hasKeywordRule = await prisma.workflow.count({ where: { organisationId, isActive: true, isDeleted: false, triggerEntity: 'WhatsAppMessage' } }) > 0;
                    if (!hasKeywordRule) {
                        const { WhatsAppAIService } = await import('./whatsAppAIService');
                        handledByAI = await WhatsAppAIService.handleInbound({ organisationId, whatsappAccountId: whatsappAccountId || null, phoneNumber: message.from, text: message.body, leadId: messageRecord.leadId });
                    }
                } catch (aiError) {
                    console.error('[WhatsAppWebhook] AI agent failed:', aiError);
                }
            }

            // Fire any WhatsApp automation ("bot") workflows configured for this
            // account/keyword. Additive hook into the existing generic automation
            // engine - failures here must never break message ingestion above.
            if (!handledByFlow && !handledByAI) {
                try {
                    const { WorkflowEngine } = await import('./workflowEngine');
                    await WorkflowEngine.evaluate('WhatsAppMessage', 'received', {
                        id: messageRecord.id,
                        body: message.body,
                        phoneNumber: message.from,
                        whatsappAccountId,
                        leadId: messageRecord.leadId,
                        conversationId: messageRecord.conversationId,
                        organisationId
                    }, organisationId);
                } catch (workflowError) {
                    console.error('[WhatsAppWebhook] WorkflowEngine trigger failed:', workflowError);
                }
            }
        } catch (error) {
            console.error('[WhatsAppWebhook] Error in saveIncomingMessage:', error);
        }
    },

    /**
     * Handle message status updates (Meta specific but expandable)
     */
    async processStatusUpdate(value: any) {
        const { statuses } = value;
        if (!statuses || statuses.length === 0) return;

        for (const status of statuses) {
            try {
                const updateData: any = { status: status.status };
                if (status.status === 'delivered') updateData.deliveredAt = new Date(parseInt(status.timestamp) * 1000);
                else if (status.status === 'read') updateData.readAt = new Date(parseInt(status.timestamp) * 1000);
                else if (status.status === 'failed') {
                    updateData.errorCode = status.errors?.[0]?.code;
                    updateData.errorMessage = status.errors?.[0]?.title;
                }

                const updatedMessage = await prisma.whatsAppMessage.updateMany({
                    where: { waMessageId: status.id },
                    data: updateData
                });

                if (updatedMessage.count > 0) {
                    const { CampaignProcessor } = await import('./campaignProcessor');
                    const message = await prisma.whatsAppMessage.findFirst({
                        where: { waMessageId: status.id },
                        select: { id: true, organisationId: true, phoneNumber: true }
                    });

                    if (message) {
                        await CampaignProcessor.updateCampaignStats(message.id, status.status);
                        const io = getIO();
                        if (io) {
                            io.to(`org:${message.organisationId}`).emit('whatsapp_status_update', {
                                messageId: status.id,
                                dbMessageId: message.id,
                                status: status.status,
                                phoneNumber: message.phoneNumber
                            });
                        }
                    }
                }
            } catch (error) {
                console.error('[WhatsAppWebhook] Error updating status:', error);
            }
        }
    },

    /**
     * Verify Webhook (Meta GET request)
     */
    async verifyWebhook(req: any, res: any): Promise<void> {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

        if (!VERIFY_TOKEN) return res.sendStatus(500);

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
};