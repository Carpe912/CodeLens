import { Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { RepoPage } from './pages/RepoPage';
import { CallGraphPage } from './pages/CallGraphPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/repo/:id" element={<RepoPage />} />
      <Route path="/repo/:id/call-graph/:symbolName" element={<CallGraphPage />} />
    </Routes>
  );
}
