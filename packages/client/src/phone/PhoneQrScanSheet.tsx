/**
 * "Scan pairing code": the camera over the Add host sheet (`phone/qr-camera.ts`). The first code
 * that is a pairing link (an http(s) URL carrying a `token`) is handed back and the sheet is done;
 * any other code (a menu, a Wi-Fi card) says so and the camera keeps looking.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { parsePairingURL } from './hosts';
import { defaultQrCamera, qrCameraError, type QrCamera } from './qr-camera';
import { PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneQrScanSheetProps {
    readonly open: boolean;
    /** The pairing URL read, normalised by `parsePairingURL`. */
    readonly onScan: (url: string) => void;
    readonly onClose: () => void;
    /** Injected for tests; the app uses the device camera. */
    readonly camera?: QrCamera | undefined;
}

export const NOT_A_PAIRING_CODE = 'that code is not a Kelpi pairing link';

export function PhoneQrScanSheet(props: PhoneQrScanSheetProps): ReactElement | null {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    // Read through a ref so a re-render's new closure does not restart the camera.
    const onScanRef = useRef(props.onScan);
    onScanRef.current = props.onScan;
    const camera = props.camera ?? defaultQrCamera;

    useEffect(() => {
        const video = videoRef.current;
        if (!props.open || video === null) return;
        setError(null);
        setHint(null);
        let cancelled = false;
        let stop: (() => void) | null = null;
        const release = (): void => {
            cancelled = true;
            stop?.();
            stop = null;
        };
        const onText = (text: string): void => {
            if (cancelled) return;
            const parsed = parsePairingURL(text);
            if (!parsed.ok || !parsed.hasToken) {
                setHint(NOT_A_PAIRING_CODE);
                return;
            }
            release();
            onScanRef.current(parsed.url);
        };
        camera.start(video, onText).then(
            (stopCamera) => {
                // Closed (or already scanned) while the camera was still coming up.
                if (cancelled) stopCamera();
                else stop = stopCamera;
            },
            (reason: unknown) => {
                if (!cancelled) setError(qrCameraError(reason).message);
            }
        );
        return release;
    }, [props.open, camera]);

    return (
        <PhoneSheet open={props.open} side="bottom" label="Scan pairing code" testID="phone-qr-sheet" onClose={props.onClose}>
            <PhoneSheetHeader title="Scan pairing code" testID="phone-qr-sheet-header" onClose={props.onClose} />
            <div className="flex flex-col gap-3 px-3 py-3">
                <div className="relative mx-auto aspect-square w-full max-w-[360px] overflow-hidden rounded-lg" style={{ background: '#000' }}>
                    {/* muted + playsInline: what iOS needs to play a camera inline without a tap. */}
                    <video
                        ref={videoRef}
                        data-testid="phone-qr-video"
                        className="h-full w-full object-cover"
                        autoPlay
                        muted
                        playsInline
                    />
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-[15%] rounded-md border-2"
                        style={{ borderColor: 'rgba(255, 255, 255, 0.7)' }}
                    />
                </div>
                {error === null ? (
                    <span data-testid="phone-qr-hint" className="text-[13px]" style={{ color: hint === null ? tokens.textTertiary : tokens.textSecondary }}>
                        {hint ?? 'Point at the code on the Mac: Settings ▸ Remote ▸ Pair a device, over the tailnet.'}
                    </span>
                ) : (
                    <span data-testid="phone-qr-error" role="alert" className="text-[13px]" style={{ color: '#E5484D' }}>
                        {error}
                    </span>
                )}
            </div>
        </PhoneSheet>
    );
}
