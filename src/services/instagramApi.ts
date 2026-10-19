import axios from 'axios';
import { IG_GRAPH } from '../config/instagram';

export class InstagramApiError extends Error {
    constructor(message: string, public code?: number, public status?: number) { super(message); }
    /** Error 190 / 102: the token is invalid or expired; the user must reconnect. */
    get isAuthError() { return this.code === 190 || this.code === 102; }
}

const wrap = (err: any): never => {
    const e = err?.response?.data?.error;
    throw new InstagramApiError(e?.message || err.message || 'Instagram request failed', e?.code, err?.response?.status);
};

/** Thin helper over the Instagram Graph API. `token` is the account's decrypted access token. */
export const ig = {
    async get<T = any>(path: string, token: string, params: Record<string, any> = {}): Promise<T> {
        try {
            const { data } = await axios.get(`${IG_GRAPH}/${path}`, { params, headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
            return data;
        } catch (err) { return wrap(err); }
    },
    async post<T = any>(path: string, token: string, body: any = {}, params: Record<string, any> = {}): Promise<T> {
        try {
            const { data } = await axios.post(`${IG_GRAPH}/${path}`, body, { params, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
            return data;
        } catch (err) { return wrap(err); }
    },
    async delete<T = any>(path: string, token: string): Promise<T> {
        try {
            const { data } = await axios.delete(`${IG_GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
            return data;
        } catch (err) { return wrap(err); }
    }
};
