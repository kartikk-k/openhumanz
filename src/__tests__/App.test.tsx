import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import App from '../renderer/App';
import { APP_NAME } from '../renderer/constants';

describe('App', () => {
  it('renders the home screen', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: APP_NAME })).toBeInTheDocument();
  });
});
