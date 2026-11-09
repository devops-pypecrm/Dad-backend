import { getBonvoiceCredentials } from './bonvoiceService';
import { InitiateProviderCallInput, NormalizedCallEvent, ProviderCallResult, TelephonyProvider } from './telephonyProvider';

/**
 * Bonvoice adapter boundary. The credential/configuration foundation is live,
 * but request and webhook mappings intentionally remain blocked until Bonvoice
 * supplies its official API contract. This prevents guessed endpoint calls and
 * makes the eventual implementation isolated from CRM controllers.
 */
export class BonvoiceProvider implements TelephonyProvider {
    readonly name = 'bonvoice';

    async initiateCall(input: InitiateProviderCallInput): Promise<ProviderCallResult> {
        const credentials = await getBonvoiceCredentials(input.organisationId);
        if (!credentials) throw new Error('Bonvoice is not configured for this organisation');
        throw new Error('Bonvoice calling is awaiting the official click-to-call API contract');
    }

    normalizeWebhook(_payload: unknown): NormalizedCallEvent {
        throw new Error('Bonvoice webhook mapping is awaiting the official webhook contract');
    }
}
