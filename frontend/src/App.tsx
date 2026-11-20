import { Link, Route, Routes } from 'react-router-dom';
import { UploadPage } from '../components/UploadPage';
import { WatchPage } from '../components/WatchPage';


export function App() {
  return (
    <div className="app">
      <header>
        <h1>
          <Link to="/">CineAI</Link>
        </h1>
        <p className="muted">Resumable upload and adaptive streaming</p>
      </header>
      <Routes>
        <Route path="/" element={<UploadPage />} />
        <Route path="/watch/:id" element={<WatchPage />} />
        <Route path="*" element={<p>Page not found.</p>} />
      </Routes>
    </div>
  );
}