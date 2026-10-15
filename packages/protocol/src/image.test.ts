import { describe, expect, it } from 'vitest';

import { IMAGE_OPEN_EXTENSIONS, isImagePath } from './image.js';

describe('isImagePath (content-panes.md §12)', () => {
    it('matches every image extension, case-insensitively', () => {
        for (const extension of IMAGE_OPEN_EXTENSIONS) {
            expect(isImagePath(`/a/shot.${extension}`)).toBe(true);
            expect(isImagePath(`/a/SHOT.${extension.toUpperCase()}`)).toBe(true);
        }
    });

    it('needs a name before the dot, and an extension Chromium draws', () => {
        expect(isImagePath('/a/.png')).toBe(false);
        expect(isImagePath('/a/png')).toBe(false);
        expect(isImagePath('/a/shot.png.gz')).toBe(false);
        expect(isImagePath('/a/scan.tiff')).toBe(false);
        expect(isImagePath('/a/photo.heic')).toBe(false);
        expect(isImagePath('/pictures.png/notes.md')).toBe(false);
    });
});
