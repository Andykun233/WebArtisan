import React, { ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: any;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ 
          padding: '2rem', 
          color: '#e0e0e0', 
          backgroundColor: '#1c1c1c', 
          height: '100vh', 
          display: 'flex', 
          flexDirection: 'column', 
          justifyContent: 'center', 
          alignItems: 'center',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem', color: '#ff4d4d' }}>应用程序遇到错误</h1>
          <p style={{ marginBottom: '1rem' }}>请截图以下错误信息并联系开发者：</p>
          <pre style={{ 
            backgroundColor: '#000', 
            padding: '1rem', 
            borderRadius: '0.5rem', 
            border: '1px solid #333', 
            maxWidth: '90%', 
            overflow: 'auto' 
          }}>
            {this.state.error?.toString()}
          </pre>
          <button 
            onClick={() => window.location.reload()} 
            style={{ 
              marginTop: '2rem', 
              padding: '0.5rem 1rem', 
              backgroundColor: '#005fb8', 
              color: 'white', 
              border: 'none', 
              borderRadius: '0.25rem',
              cursor: 'pointer'
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);