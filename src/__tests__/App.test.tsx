import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import App from '../renderer/App';

/**
 * Smoke test for the shell.
 *
 * There is no preload bridge under jsdom, so every IPC call fails with
 * `bridge_unavailable`. That is deliberate: rendering correctly against an
 * unavailable backend is the app's normal first-run state, and this test would
 * fail if a screen assumed data.
 */
describe('App', () => {
  it('renders the shell with the default Runs route', () => {
    render(<App />);

    // The primary destination, as a page heading.
    expect(screen.getByRole('heading', { name: 'Runs' })).toBeInTheDocument();

    // The persistent sidebar and its destinations.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeInTheDocument();
    ['Runs', 'Tasks', 'Schedule', 'Memory', 'Approvals', 'Settings'].forEach(
      (label) => {
        expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
      },
    );

    // The live status strip. Nothing is running, so it reads Idle.
    const strip = screen.getByRole('status', { name: 'Activity' });
    expect(strip).toHaveTextContent('Idle');
  });
});
