import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import Home from './components/Home';
import './App.css';

/**
 * Root application component that wires up client side routing
 */
export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </Router>
  );
}
