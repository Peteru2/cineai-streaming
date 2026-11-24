import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { HomePage } from '../components/HomePage';
import { UploadPage } from '../components/UploadPage';
import { WatchPage } from '../components/WatchPage';

export function App() {
  return (
    <>
      <header className="site-header">
        <div className="container bar">
          <Link to="/" className="brand" aria-label="CineAI home">
            CINE<span>AI</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Films
            </NavLink>
            <NavLink to="/upload" className="btn btn-primary btn-small">
              Upload
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/watch/:id" element={<WatchPage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>

      <footer className="site-footer container">Built for creators and audiences on any connection.</footer>
    </>
  );
}