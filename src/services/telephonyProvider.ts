export type NormalizedCallStatus = 'initiated' | 'ringing' | 'answered' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'cancelled' | 'missed';

export interface InitiateProviderCallInput {
    organisationId: string;
    userId: string;
    customerNumber: string;
    agentNumber?: string;
    referenceId: string;
}

export interface ProviderCallResult {
    providerCallId: string;
    status: NormalizedCallStatus;
    raw?: unknown;
}

export interface NormalizedCallEvent {
    providerEventId?: string;
    providerCallId: string;
    status: NormalizedCallStatus;
    from?: string;
    to?: string;
    agentId?: string;
    startedAt?: Date;
    answeredAt?: Date;
    endedAt?: Date;
    durationSeconds?: number;
    recordingUrl?: string;
    raw: unknown;
}

export interface TelephonyProvider {
    readonly name: string;
    initiateCall(input: InitiateProviderCallInput): Promise<ProviderCallResult>;
    normalizeWebhook(payload: unknown): NormalizedCallEvent;
}
