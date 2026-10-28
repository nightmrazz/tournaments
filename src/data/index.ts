import { createLocalService } from './local';
import type { DataService } from './service';
import { createSupabaseService } from './supabase';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Supabase when both public env vars are set, otherwise the browser-only local mode. */
export const service: DataService = url && key ? createSupabaseService(url, key) : createLocalService();

export * from './service';
