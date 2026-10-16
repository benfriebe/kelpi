/** Entry for `overlay.html`, the shell's corner layer (`./CornerOverlay.tsx`). */

import { createRoot } from 'react-dom/client';

import { installCornerOverlay } from './CornerOverlay';
import '../styles.css';

const container = document.getElementById('root');
if (container !== null) installCornerOverlay(globalThis as unknown as Record<string, unknown>, createRoot(container));
