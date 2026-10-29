import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell, PageContainer } from '@/components/layout/AppShell';
import { ConfirmProvider, ToastProvider } from '@/components/ui/overlay';
import { Spinner } from '@/components/ui/primitives';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { LanguageProvider } from '@/i18n';
import { HomePage } from '@/pages/HomePage';
import { LoginPage, NotFoundPage } from '@/pages/LoginPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { TournamentPage } from '@/pages/TournamentPage';
import { TournamentsPage } from '@/pages/TournamentsPage';

// The organizer area is loaded on demand so spectators download less.
const admin = () => import('@/pages/admin/AdminPages');
const AdminDashboardPage = lazy(() => admin().then((m) => ({ default: m.AdminDashboardPage })));
const AdminNewTournamentPage = lazy(() => admin().then((m) => ({ default: m.AdminNewTournamentPage })));
const AdminTournamentPage = lazy(() => admin().then((m) => ({ default: m.AdminTournamentPage })));
const RequireOrganizerLazy = lazy(() => admin().then((m) => ({ default: m.RequireOrganizer })));

function RequireOrganizer({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<PageContainer><Spinner /></PageContainer>}>
      <RequireOrganizerLazy>{children}</RequireOrganizerLazy>
    </Suspense>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LanguageProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <AppShell>
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/tournaments" element={<TournamentsPage />} />
                  <Route path="/tournaments/:id" element={<TournamentPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/admin" element={<RequireOrganizer><AdminDashboardPage /></RequireOrganizer>} />
                  <Route path="/admin/tournaments" element={<Navigate to="/admin" replace />} />
                  <Route path="/admin/tournaments/new" element={<RequireOrganizer><AdminNewTournamentPage /></RequireOrganizer>} />
                  <Route path="/admin/tournaments/:id" element={<RequireOrganizer><AdminTournamentPage /></RequireOrganizer>} />
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </AppShell>
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
        </LanguageProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
