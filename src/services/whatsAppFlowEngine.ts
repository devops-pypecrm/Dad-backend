import prisma from '../config/prisma';
import { getIO } from '../socket';
import { WhatsAppSender } from './whatsAppSender';
import { WhatsAppAssignmentService } from './whatsAppAssignmentService';
import { NotificationService } from './notificationService';

// A WhatsAppFlow's `nodes`/`edges` are stored exactly as React Flow persists them:
// nodes: [{ id, type, position, data }], edges: [{ id, source, target, sourceHandle? }].
// `sourceHandle` on an edge leaving a `buttons`/`list`/`condition` node is the
// button/option/branch id it corresponds to - that's what `handleReply` matches
// an incoming reply signal against to pick the next node.

interface FlowNode {
    id: string;
    type: string;
    data: Record<string, any>;
}

interface FlowEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
}

function getGraph(flow: { nodes: any; edges: any }) {
    const nodes = (flow.nodes as FlowNode[]) || [];
    const edges = (flow.edges as FlowEdge[]) || [];
    return { nodes, edges };
}

function findRootNode(nodes: FlowNode[], edges: FlowEdge[]): FlowNode | undefined {
    const targetIds = new Set(edges.map(e => e.target));
    return nodes.find(n => !targetIds.has(n.id)) || nodes[0];
}

function nextNodeFrom(nodes: FlowNode[], edges: FlowEdge[], nodeId: string, handle?: string | null): FlowNode | undefined {
    const edge = handle !== undefined
        ? edges.find(e => e.source === nodeId && (e.sourceHandle || null) === (handle || null))
        : edges.find(e => e.source === nodeId);
    if (!edge) return undefined;
    return nodes.find(n => n.id === edge.target);
}

export const WhatsAppFlowEngine = {
    /**
     * If this contact's most recent outbound message on this number was part of
     * a campaign that has a `flowId` set, that campaign's flow owns the reply -
     * this is what lets multiple campaigns on the same number each run their own
     * dedicated conversation, without relying on keyword matching.
     */
    async findCampaignFlow(phoneNumber: string, organisationId: string) {
        const lastOutbound = await prisma.whatsAppMessage.findFirst({
            where: {
                phoneNumber,
                organisationId,
                direction: 'outgoing',
                campaignId: { not: null }
            },
            orderBy: { createdAt: 'desc' },
            include: { campaign: { include: { flow: true } } }
        });

        const flow = lastOutbound?.campaign?.flow;
        if (!flow || !flow.isActive || flow.isDeleted) return null;
        return flow;
    },

    async findMatchingFlow(whatsappAccountId: string | null | undefined, organisationId: string, messageBody: string) {
        const flows = await prisma.whatsAppFlow.findMany({
            where: {
                organisationId,
                isActive: true,
                isDeleted: false,
                OR: [
                    { whatsappAccountId: whatsappAccountId || undefined },
                    { whatsappAccountId: null }
                ]
            }
        });

        const body = (messageBody || '').toLowerCase();
        // Prefer a keyword-matching flow scoped to this exact account over a
        // catch-all "any_message" flow, so a specific number's flow wins.
        const keywordMatch = flows.find(f =>
            f.triggerType === 'keyword' &&
            f.triggerKeywords.some(kw => body.includes(kw.toLowerCase()))
        );
        if (keywordMatch) return keywordMatch;

        return flows.find(f => f.triggerType === 'any_message');
    },

    async getActiveSession(phoneNumber: string, whatsappAccountId: string | null | undefined, organisationId: string) {
        return prisma.whatsAppFlowSession.findFirst({
            where: { phoneNumber, whatsappAccountId: whatsappAccountId || undefined, organisationId, status: 'active' },
            include: { flow: true },
            orderBy: { lastInteractionAt: 'desc' }
        });
    },

    async startFlow(
        flow: { id: string; organisationId: string; nodes: any; edges: any },
        phoneNumber: string,
        whatsappAccountId: string | null | undefined,
        organisationId: string,
        leadId?: string | null
    ) {
        const { nodes, edges } = getGraph(flow);
        const root = findRootNode(nodes, edges);
        if (!root) return null;

        const session = await prisma.whatsAppFlowSession.create({
            data: {
                flowId: flow.id,
                organisationId,
                phoneNumber,
                whatsappAccountId: whatsappAccountId || undefined,
                leadId: leadId || undefined,
                currentNodeId: root.id,
                variables: {},
                status: 'active'
            }
        });

        await this.advance(session, flow);
        return session;
    },

    async handleReply(session: { id: string; flowId: string; currentNodeId: string | null; variables: any; phoneNumber: string; organisationId: string; whatsappAccountId: string | null }, flow: { id: string; nodes: any; edges: any }, replySignal: { buttonId?: string; text?: string }) {
        const { nodes, edges } = getGraph(flow);
        const currentNode = nodes.find(n => n.id === session.currentNodeId);
        if (!currentNode) return;

        let handle: string | null | undefined;
        let variables = { ...(session.variables || {}) };

        if (currentNode.type === 'buttons' || currentNode.type === 'list') {
            handle = replySignal.buttonId || null;
        } else if (currentNode.type === 'form_input') {
            variables[currentNode.id] = replySignal.text || '';
            handle = undefined; // form_input has a single outgoing edge, no handle matching needed
        } else {
            handle = undefined;
        }

        const next = nextNodeFrom(nodes, edges, currentNode.id, handle);

        if (!next) {
            // Unmatched button/list reply - re-send the current node's prompt rather
            // than silently dropping the conversation.
            if (currentNode.type === 'buttons' || currentNode.type === 'list') {
                await this.executeNode(currentNode, session as any, flow.id);
            }
            return;
        }

        const updated = await prisma.whatsAppFlowSession.update({
            where: { id: session.id },
            data: { currentNodeId: next.id, variables, lastInteractionAt: new Date() }
        });

        await this.advance(updated, flow);
    },

    async advance(session: { id: string; flowId: string; currentNodeId: string | null; phoneNumber: string; organisationId: string; whatsappAccountId: string | null; leadId?: string | null }, flow: { id: string; nodes: any; edges: any }) {
        const { nodes, edges } = getGraph(flow);
        let currentNode = nodes.find(n => n.id === session.currentNodeId);

        // Auto-advance through nodes that don't need user input (message/media/delay/
        // condition/agent_handoff), stopping at one that does (buttons/list/form_input)
        // or at an `end` node.
        while (currentNode) {
            const requiresInput = ['buttons', 'list', 'form_input'].includes(currentNode.type);

            const handle = await this.executeNode(currentNode, session as any, flow.id);

            if (currentNode.type === 'end' || currentNode.type === 'agent_handoff') {
                await prisma.whatsAppFlowSession.update({
                    where: { id: session.id },
                    data: { status: currentNode.type === 'agent_handoff' ? 'handed_off' : 'completed', lastInteractionAt: new Date() }
                });
                return;
            }

            if (requiresInput) {
                await prisma.whatsAppFlowSession.update({
                    where: { id: session.id },
                    data: { currentNodeId: currentNode.id, lastInteractionAt: new Date() }
                });
                return;
            }

            const next = nextNodeFrom(nodes, edges, currentNode.id, handle);
            if (!next) {
                await prisma.whatsAppFlowSession.update({
                    where: { id: session.id },
                    data: { status: 'completed', lastInteractionAt: new Date() }
                });
                return;
            }

            await prisma.whatsAppFlowSession.update({
                where: { id: session.id },
                data: { currentNodeId: next.id, lastInteractionAt: new Date() }
            });
            currentNode = next;
        }
    },

    /**
     * Executes a single node's action. Returns an optional "handle" for
     * `condition` nodes so the caller can route to the matching outgoing edge.
     */
    async executeNode(node: FlowNode, session: { phoneNumber: string; organisationId: string; whatsappAccountId: string | null; leadId?: string | null; variables?: any }, flowId: string): Promise<string | null | undefined> {
        // All flow messages go through the central sender so they are logged against the
        // conversation (inbox), respect opt-outs and the 24h window, and use the right number.
        const send = (payload: { text?: string; media?: any; interactive?: any }) =>
            WhatsAppSender.send({
                organisationId: session.organisationId,
                to: session.phoneNumber,
                accountId: session.whatsappAccountId,
                leadId: session.leadId,
                source: 'flow',
                ...payload
            });

        try {
            switch (node.type) {
                case 'message': {
                    const text = node.data?.message || '';
                    if (text) await send({ text });
                    break;
                }
                case 'buttons': {
                    const text = node.data?.message || '';
                    const buttons = (node.data?.buttons || []) as { id: string; title: string }[];
                    if (text && buttons.length > 0) await send({ interactive: { kind: 'buttons', body: text, buttons } });
                    break;
                }
                case 'list': {
                    const text = node.data?.message || '';
                    const buttonText = node.data?.buttonText || 'Choose';
                    const sections = node.data?.sections || [];
                    if (text && sections.length > 0) await send({ interactive: { kind: 'list', body: text, buttonText, sections } });
                    break;
                }
                case 'media': {
                    const mediaId = node.data?.mediaId;
                    const mediaType = node.data?.mediaType || 'image';
                    if (mediaId) await send({ media: { type: mediaType, mediaId, caption: node.data?.caption } });
                    break;
                }
                case 'form_input': {
                    const text = node.data?.message || '';
                    if (text) await send({ text });
                    break;
                }
                case 'condition': {
                    const field = node.data?.field;
                    const value = node.data?.value;
                    const actual = field ? session.variables?.[field] : undefined;
                    return actual === value ? 'true' : 'false';
                }
                case 'delay': {
                    // Synchronous flows only for v1 - a delay just no-ops instead of
                    // blocking the webhook request. A queued/deferred delay (mirroring
                    // WorkflowQueue's cron-driven pattern) is a natural follow-up.
                    break;
                }
                case 'agent_handoff': {
                    const agentId = await WhatsAppAssignmentService.resolveAgent(session.whatsappAccountId, session.organisationId);
                    if (agentId) {
                        if (session.leadId) {
                            const lead = await prisma.lead.findUnique({ where: { id: session.leadId }, select: { assignedToId: true } });
                            if (lead && !lead.assignedToId) {
                                await prisma.lead.update({ where: { id: session.leadId }, data: { assignedToId: agentId } });
                            }
                        }
                        await NotificationService.send(
                            agentId,
                            'WhatsApp flow handed off to you',
                            `A WhatsApp conversation from ${session.phoneNumber} has completed a flow and needs a human agent.`,
                            'info'
                        );
                    }
                    const closing = node.data?.message || "Please wait, we're connecting you with an agent.";
                    await send({ text: closing });
                    // hand the conversation to a human: bots stay quiet and it shows as pending in the inbox
                    const convo = await prisma.whatsAppConversation.findFirst({ where: { organisationId: session.organisationId, phoneNumber: session.phoneNumber.replace(/\D/g, ''), accountKey: session.whatsappAccountId || 'default' } });
                    if (convo) {
                        await prisma.whatsAppConversation.update({ where: { id: convo.id }, data: { status: 'pending', botPausedUntil: new Date(Date.now() + 24 * 60 * 60_000), ...(agentId && !convo.assigneeId ? { assigneeId: agentId } : {}) } });
                    }
                    break;
                }
                default:
                    break;
            }
        } catch (err) {
            console.error(`[WhatsAppFlowEngine] Node execution failed (${node.type}):`, err);
        }

        const io = getIO();
        if (io) {
            io.to(`org:${session.organisationId}`).emit('whatsapp_flow_step', { flowId, phoneNumber: session.phoneNumber, nodeId: node.id, nodeType: node.type });
        }

        return null;
    }
};
