import { HardDrive, LogIn, LogOut, Menu, Trophy, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { ApplicationNotifier } from '@/features/participants/ApplicationNotifier';
import { LANGS, t, useLanguage } from '@/i18n';
import { cn } from '@/lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('flex items-center gap-2.5 font-display font-bold tracking-tight', className)} aria-label={t('temcch tournaments home')}>
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-fg text-bg">
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden><path d="M4 4h16v4h-6v13h-4V8H4z" fill="currentColor" /></svg>
      </span>
      <span className="text-lg leading-none">temcch<span className="ml-1.5 hidden font-medium text-muted min-[400px]:inline">tournaments</span></span>
    </Link>
  );
}

/** RU / EN toggle. The choice is remembered in this browser. */
export function LanguageSwitch() {
  const { lang, setLang } = useLanguage();
  return (
    <div role="group" aria-label={t('Interface language')} className="flex h-9 items-center rounded-[var(--radius-control)] border border-line bg-surface p-0.5">
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={lang === l}
          aria-label={l === 'ru' ? 'Русский' : 'English'}
          onClick={() => setLang(l)}
          className={cn(
            'h-8 min-w-10 rounded-md px-2 text-xs font-semibold uppercase tracking-wide transition-colors',
            lang === l ? 'bg-accent text-accent-ink' : 'text-muted hover:text-fg',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const navCls = ({ isActive }: { isActive: boolean }) =>
  cn('rounded-md px-3 py-2 text-sm font-medium transition-colors', isActive ? 'text-fg bg-surface-2' : 'text-muted hover:text-fg');

export function AppShell({ children }: { children: ReactNode }) {
  const { user, isOrganizer } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => setOpen(false), [location.pathname]);

  const signOut = async () => {
    await service.auth.signOut();
    toast('info', t('Signed out.'));
    navigate('/');
  };

  const links = (
    <>
      <NavLink to="/tournaments" className={navCls}>{t('Tournaments')}</NavLink>
      {(service.mode === 'local' || user) && <NavLink to="/profile" className={navCls}>{t('My cabinet')}</NavLink>}
      {isOrganizer && <NavLink to="/admin" className={navCls}>{t('Organizer')}</NavLink>}
    </>
  );
  const account =
    service.mode === 'local' ? null : user ? (
      <div className="flex items-center gap-2">
        <Link to="/profile" className="hidden max-w-40 truncate text-sm text-muted hover:text-accent lg:inline" title={t('My cabinet')}>{user.displayName}</Link>
        <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-4 w-4" aria-hidden />{t('Sign out')}</Button>
      </div>
    ) : (
      <Button variant="outline" size="sm" onClick={() => navigate(`/login?next=${encodeURIComponent(location.pathname)}`)}><LogIn className="h-4 w-4" aria-hidden />{t('Sign in')}</Button>
    );

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">{t('Skip to content')}</a>
      {service.mode === 'local' && (
        <div className="border-b border-warning/20 bg-warning/5 px-4 py-1.5 text-center text-xs text-warning">
          <HardDrive className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
          {t('Local mode — data is saved only in this browser and there is no sign-in or access control. Configure Supabase for real use.')}
        </div>
      )}
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4">
          <div className="flex items-center gap-6">
            <Logo />
            <nav className="hidden items-center gap-1 md:flex" aria-label={t('Main')}>{links}</nav>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <div className="hidden md:block">{account}</div>
            <Button variant="ghost" size="icon" className="md:hidden" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? t('Close menu') : t('Open menu')} onClick={() => setOpen((o) => !o)}>
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>
        {open && (
          <nav id="mobile-nav" aria-label={t('Main')} className="flex flex-col gap-1 border-t border-line px-4 py-3 md:hidden">
            {links}
            {account && <div className="pt-2">{account}</div>}
          </nav>
        )}
      </header>
      <ApplicationNotifier />
      <main id="main" className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2"><Trophy className="h-4 w-4 text-accent" aria-hidden /> {t('temcch tournaments — tournament management for local and university EA SPORTS FC 27 events.')}</div>
          <p className="text-xs text-subtle">{t('Independent project. Not affiliated with or endorsed by Electronic Arts.')}</p>
        </div>
      </footer>
    </div>
  );
}

export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 py-6 sm:py-8', className)}>{children}</div>;
}
