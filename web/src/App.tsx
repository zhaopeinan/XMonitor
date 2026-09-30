import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import { ConfirmProvider } from './components/ConfirmDialog';
import { AuthProvider, useAuth } from './auth';
import Alerts from './pages/Alerts';
import AnalyzeWizard from './pages/AnalyzeWizard';
import Dashboard from './pages/Dashboard';
import LlmChannelDetail from './pages/LlmChannelDetail';
import LlmMonitorWizard from './pages/LlmMonitorWizard';
import Login from './pages/Login';
import Screen from './pages/Screen';
import Settings from './pages/Settings';
import SystemDetail from './pages/SystemDetail';
import Users from './pages/Users';
import SystemStatus from './pages/SystemStatus';
import { Spinner } from './components/ui';

function Guard() {
  const { user, loading, hasPermission } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Spinner className="h-6 w-6 border-slate-300 border-t-slate-600" />
      </div>
    );
  }
  if (!user) return <Login />;
  const canLlm = hasPermission('systems.manage') || hasPermission('settings.manage');
  const isAdmin = user.role === 'admin';
  return (
    <Routes>
      <Route path="/screen" element={<Screen />} />
      <Route path="/screen/systems/:systemId" element={<Screen />} />
      <Route path="/screen/llm/:channelId" element={<Screen />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/analyze" element={hasPermission('analyze') ? <AnalyzeWizard /> : <Navigate to="/" replace />} />
        <Route path="/llm/new" element={canLlm ? <LlmMonitorWizard /> : <Navigate to="/" replace />} />
        <Route path="/llm/channels/:id" element={<LlmChannelDetail />} />
        <Route path="/systems/:id" element={<SystemDetail />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/settings" element={hasPermission('settings.manage') ? <Settings /> : <Navigate to="/" replace />} />
        <Route path="/users" element={hasPermission('users.manage') ? <Users /> : <Navigate to="/" replace />} />
        <Route path="/system-status" element={isAdmin ? <SystemStatus /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ConfirmProvider>
        <Guard />
      </ConfirmProvider>
    </AuthProvider>
  );
}
