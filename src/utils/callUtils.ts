
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Interaction } from '../generated/client';

/**
 * Extract true duration of an audio file in seconds using ffprobe.
 */
export function getAudioDuration(filePath: string): number {
    try {
        if (!filePath || !fs.existsSync(filePath)) return 0;
        const output = execSync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
            { encoding: 'utf-8', timeout: 5000 }
        );
        const duration = parseFloat(output.trim());
        return isNaN(duration) ? 0 : Math.round(duration);
    } catch (err) {
        console.error('[CallUtils] Error getting audio duration via ffprobe:', err);
        return 0;
    }
}

/**
 * Re-encodes an uploaded call recording to AAC/.m4a so every stored
 * recording is actually playable in the web app's plain HTML5 `<audio>`
 * element (CallRecordingPlayer.tsx), regardless of what codec the source
 * device used. OEM native call recorders (budget Android/ColorOS devices
 * especially) commonly save in AMR or other codecs no major browser
 * decodes at all -- the upload/CRM pipeline otherwise stores and serves
 * whatever bytes it received untouched, so a recording can be genuinely
 * fetched and non-empty yet be silent in every browser that opens it.
 *
 * Uses execFileSync (not execSync/a shell string) specifically because
 * `inputPath` is built from a client-uploaded original filename (via
 * multer's `path.extname(file.originalname)`) -- passing that through a
 * shell string would be a command-injection vector, so this never goes
 * through a shell at all.
 *
 * Returns the new file's basename (same directory as `inputPath`) on
 * success, or null on failure/timeout/missing ffmpeg -- callers must fall
 * back to the original file rather than losing the upload, since a failed
 * transcode is not the caller's fault and an awkward-to-play original is
 * still better than no recording at all.
 */
export function transcodeToPlayableAudio(inputPath: string): string | null {
    if (!inputPath || !fs.existsSync(inputPath)) return null;
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, path.extname(inputPath));
    const finalFilename = `${base}.m4a`;
    const finalPath = path.join(dir, finalFilename);
    const tempPath = path.join(dir, `${base}.transcoding.m4a`);
    try {
        execFileSync(
            'ffmpeg',
            ['-y', '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '96k', tempPath],
            { timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'] }
        );
        if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) return null;
        if (inputPath !== finalPath) {
            try { fs.unlinkSync(inputPath); } catch { /* best-effort cleanup */ }
        }
        fs.renameSync(tempPath, finalPath);
        return finalFilename;
    } catch (err) {
        console.error('[CallUtils] Audio transcode failed, keeping original file as-is:', err);
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
        return null;
    }
}

/**
 * Utility to resolve the best duration for a call.
 *
 * Deliberately does NOT consider `recordingDuration` (how long the audio
 * recorder happened to capture) at all — it's not a reliable proxy for how
 * long the call actually lasted. The recorder can be killed/interrupted
 * mid-call (battery optimization, storage full, silence auto-stop, a
 * permission revoked mid-call, etc.), which previously made a completed
 * 20-minute call whose recorder cut out at 9 minutes get reported as a
 * 9-minute call. `duration` — sourced from the device's own
 * `CallLog.DURATION` on both sync paths (`CallLogLookup.kt` for the
 * real-time path, `CallLogReconciler.kt` for the periodic sweep, in
 * Dad-call-recorder) — is the OS's own authoritative record of the real
 * call length and is trusted on its own. `hardwareDuration`
 * (carrier-verified) still wins outright when present, being a strictly
 * more authoritative source than even the device's own CallLog.
 *
 * @returns Duration in seconds
 */
export function resolveBestDurationSeconds(interaction: Partial<Interaction> | any): number {
    if (interaction.hardwareDuration && interaction.hardwareDuration > 0) {
        return interaction.hardwareDuration;
    }
    if (interaction.duration && interaction.duration > 0) {
        return Math.round(interaction.duration * 60);
    }
    return 0;
}

/**
 * Normalizes a raw duration value.
 * Some Android apps/libraries report milliseconds instead of seconds.
 * If a duration is unrealistically high (e.g. > 10 hours for a phone call), 
 * we treat it as milliseconds.
 */
export function normalizeDuration(raw: any): number {
    let val = parseInt(raw, 10) || 0;
    // 36000 seconds = 10 hours. If it's more than that, it's likely ms.
    if (val > 36000) {
        return Math.round(val / 1000);
    }
    return val;
}

/**
 * Ensures both duration (minutes) and recordingDuration (seconds) are synchronized.
 * If one is provided but not the other, it calculates the missing one.
 */
export function synchronizeDurations(data: any) {
    // Normalize inputs first to prevent unit mismatches
    if (data.hardwareDuration !== undefined && data.hardwareDuration !== null) {
        data.hardwareDuration = normalizeDuration(data.hardwareDuration);
    }
    if (data.recordingDuration !== undefined && data.recordingDuration !== null) {
        data.recordingDuration = normalizeDuration(data.recordingDuration);
    }

    const hasHardware = data.hardwareDuration !== undefined && data.hardwareDuration !== null;
    const hasRecording = data.recordingDuration !== undefined && data.recordingDuration !== null;
    const hasDuration = data.duration !== undefined && data.duration !== null;

    if (hasHardware && !hasRecording) {
        data.recordingDuration = data.hardwareDuration;
    }

    if (hasHardware && !hasDuration) {
        data.duration = data.hardwareDuration / 60;
    } else if (hasRecording && !hasDuration) {
        data.duration = data.recordingDuration / 60;
    } else if (hasDuration && !hasRecording) {
        data.recordingDuration = Math.round(data.duration * 60);
    }

    // Round duration to 2 decimal places for DB consistency
    if (data.duration) {
        data.duration = Math.round(data.duration * 100) / 100;
    }
}

/**
 * Generates a standard human-readable description for a call duration.
 */
export function formatCallDurationDescription(seconds: number, options: { hasRecording?: boolean, isCarrierVerified?: boolean } = {}): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    let desc = `Duration: ${mins}m ${secs}s`;
    
    if (options.hasRecording) desc += ' (Recording attached)';
    if (options.isCarrierVerified) desc += ' [Carrier Verified]';
    
    return desc;
}

/**
 * Utility to calculate Indian Standard Time (IST, UTC+5:30) date boundaries.
 * Prevents UTC server skew where "today" starts at 5:30 AM IST instead of 12:00 AM IST.
 */
export function getISTDateBounds(now: Date = new Date()) {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + istOffset);
    const startOfTodayIST = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()));
    const startOfToday = new Date(startOfTodayIST.getTime() - istOffset);
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const endOfYesterday = new Date(startOfToday.getTime() - 1);
    const startOfMonthIST = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1));
    const startOfMonth = new Date(startOfMonthIST.getTime() - istOffset);
    return { startOfToday, endOfToday, startOfYesterday, endOfYesterday, startOfMonth };
}
