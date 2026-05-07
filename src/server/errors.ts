import {
  BaseAppError,
  MissingCredentialsError,
  LoginFailedError,
  NavigationTimeoutError,
  SelectorMissingError,
  UnknownSiteError,
} from '../core/errors';

export interface SerializedError {
  error: { code: string; message: string; [k: string]: unknown };
}

export function serializeError(e: unknown): SerializedError {
  if (e instanceof MissingCredentialsError) {
    return { error: { code: e.code, message: e.message, missingEnvKeys: e.missingEnvKeys } };
  }
  if (e instanceof LoginFailedError) {
    return { error: { code: e.code, message: e.message, hint: e.hint } };
  }
  if (e instanceof NavigationTimeoutError) {
    return { error: { code: e.code, message: e.message, url: e.url } };
  }
  if (e instanceof SelectorMissingError) {
    return { error: { code: e.code, message: e.message, siteKey: e.siteKey, hint: e.hint } };
  }
  if (e instanceof UnknownSiteError) {
    return { error: { code: e.code, message: e.message, siteKey: e.siteKey, available: e.available } };
  }
  if (e instanceof BaseAppError) {
    return { error: { code: e.code, message: e.message } };
  }
  const message = e instanceof Error ? e.message : 'unknown error';
  return { error: { code: 'INTERNAL', message } };
}
