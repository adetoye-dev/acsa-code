/**
 * App.tsx — ACSA Code Desktop IDE
 *
 * Mounts the complete VS Code workbench layout (IdeLayout) powered by
 * DockviewReact, Monaco Editor with AI ghost-text autocomplete,
 * and the physical filesystem verification pipeline.
 *
 * Startup behaviour:
 * - Silently checks whether any model is usable. If a cloud provider has a stored
 *   key, or a non-Ollama provider is the default, it does nothing at all.
 * - Otherwise, if the local engine is not running, it offers a dismissible
 *   notice. It never opens a modal on its own: local AI is optional, and a wizard
 *   that can only fail until Ollama is installed reads as a broken app.
 */

import { useState, useEffect } from "react";
import { usePipeline } from "./hooks/usePipeline";
import { IdeLayout } from "./components/layout/IdeLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DesktopRequiredBanner } from "./components/DesktopRequiredBanner";
import { hasIpc } from "./services/engineBridge";
import {
  OllamaSetupWizard,
  OllamaNotRunningBanner,
} from "./components/ui/OllamaSetupWizard";
import {
  checkOllamaStatus,
  dismissOllamaNotice,
  isOllamaNoticeDismissed,
  openAiManagementDashboard,
} from "./services/ollamaSetup";
import {
  ensureProvidersHydrated,
  loadAllProviders,
  syncOllamaModels,
} from "./services/aiModelManager";

export function App() {
  const pipeline = usePipeline();

  const [showWizard, setShowWizard] = useState(false);
  const [showBanner, setShowBanner] = useState(false);

  // Startup model probe — runs once after mount
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      // Small delay so the IDE paints first
      await new Promise((r) => setTimeout(r, 1500));
      if (cancelled) return;

      // Decide from the hydrated registry. The old check only skipped when Ollama
      // was not the *explicitly chosen* default provider, so configuring a cloud
      // key without also changing the default left the probe running and popped a
      // setup modal on every launch.
      await ensureProvidersHydrated();
      if (cancelled) return;

      const providers = Object.values(loadAllProviders());
      const hasCloudModel = providers.some((p) => p.category === "cloud" && p.isConnected);
      const defaultP = providers.find((p) => p.isDefault);
      const prefersAnotherProvider = Boolean(defaultP && defaultP.id !== "ollama");
      if (hasCloudModel || prefersAnotherProvider) return;

      if (isOllamaNoticeDismissed()) return;

      const status = await checkOllamaStatus();
      if (cancelled) return;

      if (status.running) {
        if (status.models.length > 0) {
          syncOllamaModels(status.models, undefined, status.modelsDetails);
        }
        return;
      }

      // Offer it quietly rather than taking over the window.
      setShowBanner(true);
    }
    void probe();
    return () => { cancelled = true; };
  }, []);

  // Listen for explicit requests to open the wizard from Titlebar, Command Palette, etc.
  useEffect(() => {
    const handleOpen = () => {
      setShowBanner(false);
      setShowWizard(true);
    };
    window.addEventListener("acsa:open-ollama-wizard", handleOpen);
    return () => window.removeEventListener("acsa:open-ollama-wizard", handleOpen);
  }, []);

  return (
    <ErrorBoundary fallbackTitle="ACSA Code Workbench Error">
      <div className="flex flex-col h-screen w-screen overflow-hidden">
        {!hasIpc() && <DesktopRequiredBanner />}
        <div className="flex-1 min-h-0 flex flex-col">
          <IdeLayout {...pipeline} />
        </div>
      </div>

      {showWizard && (
        <OllamaSetupWizard
          onClose={() => setShowWizard(false)}
          onComplete={() => setShowWizard(false)}
        />
      )}

      {!showWizard && showBanner && (
        <OllamaNotRunningBanner
          onOpenSetup={() => {
            setShowBanner(false);
            dismissOllamaNotice();
            // The dashboard covers both routes — a cloud key or the local engine —
            // where the Ollama wizard only offers one of them.
            openAiManagementDashboard();
          }}
          onDismiss={() => {
            setShowBanner(false);
            dismissOllamaNotice();
          }}
        />
      )}
    </ErrorBoundary>
  );
}

export default App;
