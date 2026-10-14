import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workspace error', error, info);
  }
  render() {
    return this.state.error ? (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="panel p-8 max-w-md">
          <h1 className="text-xl font-semibold mb-3">Your workspace could not open</h1>
          <p className="text-[#85918f] mb-6">
            Reload the page to try again. Your saved records remain on this browser.
          </p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload workspace
          </button>
        </div>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
