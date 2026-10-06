import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, DataProvider, JobsProvider, ToastProvider, useAuth } from "./lib/store";
import { Toasts } from "./components/ui";
import { StudioPage } from "./pages/Studio";
import { LibraryPage } from "./pages/Library";
import { HistoryPage } from "./pages/History";
import { ProjectsPage } from "./pages/Projects";
import { ModelsPage } from "./pages/Models";
import { SettingsPage } from "./pages/Settings";
import { LoginPage } from "./pages/Login";

function Gate() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="auth-wrap">
        <div className="spinner" />
      </div>
    );
  if (!user) return <LoginPage />;
  return (
    <DataProvider>
      <JobsProvider>
        <Routes>
          <Route path="/" element={<StudioPage />} />
          <Route path="/image" element={<StudioPage key="image" module="image" />} />
          <Route path="/video" element={<StudioPage key="video" module="video" />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </JobsProvider>
    </DataProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <Gate />
          <Toasts />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
