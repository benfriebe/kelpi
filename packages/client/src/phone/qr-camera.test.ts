import { afterEach, describe, expect, it, vi } from 'vitest';

import { QR_CAMERA_MESSAGES, QrCameraError, defaultQrCamera, qrCameraError } from './qr-camera';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('qrCameraError', () => {
    it('reads getUserMedia’s rejections as the sheet’s sentences', () => {
        expect(qrCameraError(new DOMException('no', 'NotAllowedError')).kind).toBe('denied');
        expect(qrCameraError(new DOMException('no', 'SecurityError')).kind).toBe('denied');
        expect(qrCameraError(new DOMException('none', 'NotFoundError')).kind).toBe('no-camera');
        expect(qrCameraError(new DOMException('none', 'OverconstrainedError')).kind).toBe('no-camera');
        expect(qrCameraError(new DOMException('busy', 'NotReadableError')).kind).toBe('failed');
        expect(qrCameraError('anything').message).toBe(QR_CAMERA_MESSAGES.failed);
    });

    it('passes its own error through', () => {
        const error = new QrCameraError('insecure');
        expect(qrCameraError(error)).toBe(error);
    });
});

describe('defaultQrCamera', () => {
    const video = (): HTMLVideoElement => document.createElement('video');

    it('says the page is not secure when that is why there is no camera', async () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('isSecureContext', false);
        await expect(defaultQrCamera.start(video(), () => undefined)).rejects.toMatchObject({ kind: 'insecure' });
    });

    it('says the browser cannot when a secure page still has no camera', async () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('isSecureContext', true);
        await expect(defaultQrCamera.start(video(), () => undefined)).rejects.toMatchObject({ kind: 'unsupported' });
    });

    it('asks for the rear camera and reports a refusal', async () => {
        const getUserMedia = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        await expect(defaultQrCamera.start(video(), () => undefined)).rejects.toMatchObject({ kind: 'denied' });
        expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    });

    it('lets go of the camera when the video will not play', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] } as unknown as MediaStream;
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
        const element = video();
        element.play = () => Promise.reject(new DOMException('no', 'NotAllowedError'));
        await expect(defaultQrCamera.start(element, () => undefined)).rejects.toMatchObject({ kind: 'denied' });
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(element.srcObject).toBeNull();
    });

    it('reads frames with BarcodeDetector where the browser has one, and stops on request', async () => {
        const track = { stop: vi.fn() };
        const stream = { getTracks: () => [track] } as unknown as MediaStream;
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
        const detect = vi.fn(() => Promise.resolve([{ rawValue: 'https://studio.tail.ts.net/?token=kd_x' }]));
        vi.stubGlobal(
            'BarcodeDetector',
            class {
                static getSupportedFormats(): Promise<string[]> {
                    return Promise.resolve(['qr_code']);
                }
                detect = detect;
            }
        );
        const element = video();
        element.play = () => Promise.resolve();
        const seen: string[] = [];
        const stop = await defaultQrCamera.start(element, (text) => seen.push(text));
        await vi.waitFor(() => expect(seen).toEqual(['https://studio.tail.ts.net/?token=kd_x']));
        stop();
        expect(track.stop).toHaveBeenCalledTimes(1);
        expect(element.srcObject).toBeNull();
    });
});
