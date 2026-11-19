import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { AdminLayout } from './layouts/AdminLayout';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { ProductsPage } from './pages/ProductsPage';
import { RecordsPage } from './pages/RecordsPage';
import { ConversationsPage, LeadsPage, TeamPage, TemplatesPage } from './pages/OperationsPages';
import { AutomationSettingsPage, UtilityPage, WhatsAppSetupPage } from './pages/UtilityPages';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AccountSecurityPage } from './pages/AccountSecurityPage';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AdminLayout />}>
                <Route index element={<DashboardPage />} />
                <Route path="products" element={<ProductsPage />} />
                <Route
                  path="customers"
                  element={<RecordsPage kind="customers" title="Customers" eyebrow="AUDIENCE / DIRECTORY" />}
                />
                <Route path="conversations" element={<ConversationsPage />} />
                <Route path="leads" element={<LeadsPage />} />
                <Route path="sales-team" element={<TeamPage />} />
                <Route path="templates" element={<TemplatesPage />} />
                <Route path="whatsapp" element={<WhatsAppSetupPage />} />
                <Route path="automation" element={<AutomationSettingsPage />} />
                <Route path="account-security" element={<AccountSecurityPage />} />
                <Route
                  path="logs"
                  element={
                    <UtilityPage
                      title="System logs"
                      eyebrow="SYSTEM / OBSERVABILITY"
                      description="Structured backend logs are emitted to the configured deployment log collector."
                    />
                  }
                />
                <Route path="*" element={<DashboardPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
