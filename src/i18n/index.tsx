// Minimal i18n: English text is the key, `ru` maps it to Russian.
// `t()` is a plain function so it also works outside React (formatters, error messages).
// Changing the language re-mounts the app below the provider so every string re-renders.
import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { ru, ruPatterns } from './ru';

export type Lang = 'en' | 'ru';
export const LANGS: Lang[] = ['ru', 'en'];
const STORAGE_KEY = 'temcch:lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let current: Lang = typeof window === 'undefined' ? 'en' : detect();

export const getLang = () => current;
export const locale = () => (current === 'ru' ? 'ru-RU' : 'en-GB');

type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** Translate a UI string. `{name}` placeholders are replaced from `vars`. */
export function t(key: string, vars?: Vars): string {
  return fill(current === 'ru' ? ru[key] ?? key : key, vars);
}

/** Translate free-form text from the engine or the server, including messages with numbers. */
export function tr(message: string): string {
  if (current !== 'ru') return message;
  if (ru[message]) return ru[message];
  for (const [re, fn] of ruPatterns) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return message;
}

const LanguageContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang: () => undefined });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => {
    current = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* not persisted */
    }
    setLangState(l);
  };
  return (
    <LanguageContext.Provider value={{ lang, setLang }}>
      <Fragment key={lang}>{children}</Fragment>
    </LanguageContext.Provider>
  );
}

export const useLanguage = () => useContext(LanguageContext);
