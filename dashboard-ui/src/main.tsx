import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

/** a render error shows its message instead of a blank page */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidMount() {
    window.addEventListener("hashchange", () => this.state.error && this.setState({ error: null }));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-6 rounded-lg border border-bad/30 bg-bad/10 p-4 text-sm text-bad">
        <p className="font-medium">This view crashed: {this.state.error.message}</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs opacity-80">{this.state.error.stack}</pre>
        <a className="mt-3 inline-block text-info" href="#/">Back to the overview</a>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>
);
