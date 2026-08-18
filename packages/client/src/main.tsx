import { createRoot } from 'react-dom/client';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<div className="p-4 text-sm">nex client scaffold</div>);
}
