/**
 * The phone's QR camera: the rear camera into a `<video>`, a frame read every so often, and the
 * text of each code it finds handed back. It is how a phone adds a SECOND host by pointing at the
 * code the Mac draws in Settings ▸ Remote ▸ Pair a device (`settings/RemoteTab.tsx`), where the
 * first host is the page the system camera opened (`phone/hosts.ts`).
 *
 * Two readers, chosen once per start:
 *
 *   - `BarcodeDetector`, where the browser has it with `qr_code` (Chrome on Android). Native, and
 *     it reads the video element directly.
 *   - jsQR everywhere else, which is every iPhone: Safari ships no `BarcodeDetector`. It is
 *     imported only when a scan starts, so the shell's bundle does not carry a decoder for a
 *     button nobody tapped.
 *
 * `QrCamera` is the seam: the scan sheet is handed one, and a jsdom test hands it a fake that
 * reports a code (or a refusal) without a camera.
 */

export type QrCameraErrorKind = 'insecure' | 'unsupported' | 'denied' | 'no-camera' | 'failed';

/** Why the camera did not start, in words the scan sheet shows as they are. */
export class QrCameraError extends Error {
    readonly kind: QrCameraErrorKind;

    constructor(kind: QrCameraErrorKind) {
        super(QR_CAMERA_MESSAGES[kind]);
        this.name = 'QrCameraError';
        this.kind = kind;
    }
}

export const QR_CAMERA_MESSAGES: Readonly<Record<QrCameraErrorKind, string>> = {
    insecure: 'the camera needs an https page - open Kelpi through its tailnet link, or paste the link',
    unsupported: 'this browser cannot use the camera - paste the link instead',
    denied: 'camera access was refused - allow it in the browser settings, or paste the link',
    'no-camera': 'no camera was found - paste the link instead',
    failed: 'the camera could not start - paste the link instead'
};

export interface QrCamera {
    /**
     * Start the camera into `video` and call `onText` with every code read, until the returned
     * stop runs. Rejects with a `QrCameraError` when the camera cannot start.
     */
    start(video: HTMLVideoElement, onText: (text: string) => void): Promise<() => void>;
}

/** Between reads: quick enough to feel instant, slow enough to leave a phone's CPU alone. */
const SCAN_INTERVAL_MS = 150;

/** jsQR reads a downscaled frame; a pairing code at arm's length is far larger than this needs. */
const MAX_SCAN_EDGE_PX = 640;

type FrameReader = (video: HTMLVideoElement) => Promise<string | null>;

interface BarcodeDetectorLike {
    detect(source: HTMLVideoElement): Promise<readonly { readonly rawValue: string }[]>;
}

interface BarcodeDetectorConstructor {
    new (options: { formats: string[] }): BarcodeDetectorLike;
    getSupportedFormats?: () => Promise<string[]>;
}

/** What `getUserMedia` (or `video.play()`) rejected with, as one of the sheet's sentences. */
export function qrCameraError(error: unknown): QrCameraError {
    if (error instanceof QrCameraError) return error;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return new QrCameraError('denied');
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return new QrCameraError('no-camera');
    return new QrCameraError('failed');
}

async function nativeReader(): Promise<FrameReader | null> {
    const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
    if (Detector === undefined) return null;
    try {
        const formats = (await Detector.getSupportedFormats?.()) ?? ['qr_code'];
        if (!formats.includes('qr_code')) return null;
        const detector = new Detector({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
    } catch {
        return null;
    }
}

async function jsqrReader(): Promise<FrameReader> {
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new QrCameraError('unsupported');
    return (video) => {
        const { videoWidth, videoHeight } = video;
        if (videoWidth === 0 || videoHeight === 0) return Promise.resolve(null);
        const scale = Math.min(1, MAX_SCAN_EDGE_PX / Math.max(videoWidth, videoHeight));
        canvas.width = Math.round(videoWidth * scale);
        canvas.height = Math.round(videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        // Both ways round: `kelpid pair --qr --qr-invert` draws the code light-on-dark for a
        // terminal, where Settings draws it dark-on-light.
        return Promise.resolve(jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null);
    };
}

/** The real camera: `getUserMedia`'s rear camera, read until stopped. */
export const defaultQrCamera: QrCamera = {
    async start(video, onText) {
        const media = (globalThis as { navigator?: { mediaDevices?: Partial<MediaDevices> } }).navigator?.mediaDevices;
        if (media?.getUserMedia === undefined) {
            // Browsers drop `mediaDevices` entirely off a secure context, so say which it is.
            throw new QrCameraError(globalThis.isSecureContext === false ? 'insecure' : 'unsupported');
        }
        let stream: MediaStream;
        try {
            stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch (error) {
            throw qrCameraError(error);
        }

        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (): void => {
            stopped = true;
            clearTimeout(timer);
            for (const track of stream.getTracks()) track.stop();
            video.srcObject = null;
        };

        try {
            video.srcObject = stream;
            await video.play();
            const read = (await nativeReader()) ?? (await jsqrReader());
            const tick = (): void => {
                if (stopped) return;
                read(video)
                    .then(
                        (text) => {
                            if (!stopped && text !== null && text.length > 0) onText(text);
                        },
                        // One bad frame is not a failed scan; the next read gets a new one.
                        () => undefined
                    )
                    .finally(() => {
                        if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
                    });
            };
            tick();
        } catch (error) {
            stop();
            throw qrCameraError(error);
        }
        return stop;
    }
};
