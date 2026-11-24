/**
 * Wiring of the AI key screen: the status query, detection, the model list of
 * the candidate key, and save / test / remove. The form state machine lives in
 * aiKeyForm.logic.ts; this hook only runs effects and mutations against it, so
 * every sequence is testable without a renderer. The key stays in the form
 * state while typed; save/list/detect mutations are reset once they settle so
 * the request arguments (the key) do not stay in the redux store.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { AiProviderId } from '@shared/contracts/ai';

import {
  budgetApi,
  useDeleteAiCredentialsMutation,
  useDetectAiProviderMutation,
  useGetAiCredentialsQuery,
  useListAiModelsMutation,
  useSaveAiCredentialsMutation,
  useTestAiCredentialsMutation,
  type AiCredentialStatus,
  type AiModel,
} from '@/budget/data/api';
import { useAppDispatch } from '@/state/hooks';
import {
  aiErrorView,
  aiKeysScreenMode,
  checkSaveInput,
  detectionHint,
  MIN_AI_KEY_LENGTH,
  modelListFailure,
  ownKeyUnreadable,
  providerLabel,
  runCredentialAction,
  type AiKeyFormError,
  type AiKeysScreenMode,
} from './aiKeys.logic';
import { aiKeyFormReducer, effectiveModel, initialAiKeyForm, modelToken } from './aiKeyForm.logic';
import { t } from './i18n';

/** Detection is a local, cheap guess; debounce while the key is typed or pasted. */
const DETECT_DEBOUNCE_MS = 300;
/** The list costs an upstream call with the key: wait until typing has stopped and detection settled. */
const LIST_DEBOUNCE_MS = 600;

/** Everything the AI key screen reads and calls; the component never touches the store directly. */
export interface AiKeysState {
  mode: AiKeysScreenMode;
  showForm: boolean;
  editing: boolean;
  status: AiCredentialStatus | undefined;
  retry: () => void;
  apiKey: string;
  setApiKey: (text: string) => void;
  provider: AiProviderId | null;
  detected: AiProviderId | null;
  detecting: boolean;
  /** Line under the key field: detection progress, the detected provider, or "choose one". */
  providerHint: string | null;
  chooseProvider: (id: AiProviderId) => void;
  models: readonly AiModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  /** The list failure is worth a Retry (rate limit, upstream failure, network). */
  modelsRetryable: boolean;
  /** A successful list is in hand for the current key+provider. */
  modelsLoaded: boolean;
  retryModels: () => void;
  model: string | null;
  modelQuery: string;
  chooseModel: (id: string) => void;
  editModelQuery: (text: string) => void;
  /** The id Save would store: a committed pick, or the typed text where the list cannot confirm it. */
  effectiveModel: string | null;
  /** Both the key and a provider are set: the model picker is meaningful. */
  modelsReady: boolean;
  /** The status has an own key the server cannot open: re-save it, do not present it as usable. */
  unreadable: boolean;
  error: AiKeyFormError | null;
  notice: string | null;
  saving: boolean;
  removing: boolean;
  testing: boolean;
  testResult: { provider: AiProviderId; models: number } | null;
  testError: string | null;
  confirmingRemove: boolean;
  setConfirmingRemove: (value: boolean) => void;
  startReplace: () => void;
  cancelReplace: () => void;
  save: () => Promise<void>;
  remove: () => Promise<void>;
  test: () => Promise<void>;
}

export function useAiKeys(): AiKeysState {
  const dispatch = useAppDispatch();
  const statusQuery = useGetAiCredentialsQuery();
  const [saveKey, saveState] = useSaveAiCredentialsMutation();
  const [deleteKey, deleteState] = useDeleteAiCredentialsMutation();
  const [testKey, testState] = useTestAiCredentialsMutation();
  const [detectProvider, detectState] = useDetectAiProviderMutation();
  const [listModels, listState] = useListAiModelsMutation();
  const resetSave = saveState.reset;
  const resetDelete = deleteState.reset;
  const resetTest = testState.reset;
  // Mutation triggers/resets can change identity between renders; effects read
  // them through refs so a re-render never restarts an in-flight effect.
  const detectRef = useRef({ run: detectProvider, reset: detectState.reset });
  detectRef.current = { run: detectProvider, reset: detectState.reset };
  const listRef = useRef({ run: listModels, reset: listState.reset });
  listRef.current = { run: listModels, reset: listState.reset };
  const detectSeq = useRef(0);
  const listSeq = useRef(0);
  const saveBusy = useRef(false);
  const testBusy = useRef(false);
  const removeBusy = useRef(false);

  const [form, update] = useReducer(aiKeyFormReducer, undefined, initialAiKeyForm);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<AiKeyFormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: AiProviderId; models: number } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const key = form.key.trim();
  const mode = aiKeysScreenMode({ status: statusQuery.data, isError: statusQuery.isError });
  const unreadable = statusQuery.data ? ownKeyUnreadable(statusQuery.data) : false;
  const showForm = mode === 'empty' || mode === 'shared' || ((mode === 'saved' || mode === 'blocked') && editing);
  const modelsLoaded =
    form.modelsError === null && form.modelsFor !== null && form.modelsFor === modelToken(form.provider, form.key);

  // Detection: debounced on the key; a manual choice is never overwritten. The
  // sequence id keeps a superseded answer (and its reset) away from a newer one.
  useEffect(() => {
    const trimmed = form.key.trim();
    if (trimmed.length < MIN_AI_KEY_LENGTH) return;
    const id = ++detectSeq.current;
    update({ type: 'detectStarted' });
    let request: { abort: () => void } | null = null;
    let aborted = false;
    const timer = setTimeout(() => {
      const started = detectRef.current.run({ apiKey: trimmed });
      request = started;
      void started
        .unwrap()
        .then((result) => {
          if (!aborted && detectSeq.current === id) update({ type: 'detected', provider: result.provider });
        })
        .catch(() => {
          if (!aborted && detectSeq.current === id) update({ type: 'detected', provider: null });
        })
        .finally(() => {
          if (detectSeq.current === id) detectRef.current.reset();
        });
    }, DETECT_DEBOUNCE_MS);
    return () => {
      aborted = true;
      clearTimeout(timer);
      request?.abort();
    };
  }, [form.key]);

  // Models of the candidate key: only once detection has settled for the
  // current key, after a pause, and aborting the previous request in cleanup.
  useEffect(() => {
    const token = modelToken(form.provider, form.key);
    if (token === null || form.detecting || form.modelsFor === token) return;
    const provider = form.provider;
    if (provider === null) return;
    const trimmed = form.key.trim();
    const id = ++listSeq.current;
    let request: { abort: () => void } | null = null;
    let aborted = false;
    const timer = setTimeout(() => {
      update({ type: 'modelsStarted', token });
      const started = listRef.current.run({ apiKey: trimmed, provider });
      request = started;
      void started
        .unwrap()
        .then((result) => {
          if (!aborted && listSeq.current === id) update({ type: 'modelsLoaded', token, models: result.models });
        })
        .catch((error) => {
          if (aborted || listSeq.current !== id) return;
          const failure = modelListFailure(error);
          update({ type: 'modelsFailed', token, message: failure.message, retryable: failure.retryable });
        })
        .finally(() => {
          if (listSeq.current === id) listRef.current.reset();
        });
    }, LIST_DEBOUNCE_MS);
    return () => {
      aborted = true;
      clearTimeout(timer);
      request?.abort();
    };
  }, [form.provider, form.key, form.detecting, form.modelsFor]);

  const startReplace = useCallback(() => {
    setEditing(true);
    update({ type: 'reset' });
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    setConfirmingRemove(false);
  }, []);

  const cancelReplace = useCallback(() => {
    setEditing(false);
    update({ type: 'reset' });
    setError(null);
  }, []);

  const editKey = useCallback((text: string) => {
    update({ type: 'keyEdited', key: text });
    setError((current) => (current?.field === 'key' ? null : current));
  }, []);

  const chooseProvider = useCallback((id: AiProviderId) => {
    update({ type: 'providerChosen', provider: id });
    setError((current) => (current?.field === 'form' ? null : current));
  }, []);

  const chooseModel = useCallback((id: string) => {
    update({ type: 'modelCommitted', id });
  }, []);

  const editModelQuery = useCallback((text: string) => {
    update({ type: 'modelQueryEdited', text });
    setError((current) => (current?.field === 'form' ? null : current));
  }, []);

  const retryModels = useCallback(() => {
    update({ type: 'retryModels' });
  }, []);

  const save = useCallback(async () => {
    const invalid = checkSaveInput({ apiKey: form.key, provider: form.provider });
    if (invalid) {
      setError(invalid);
      return;
    }
    const provider = form.provider;
    if (provider === null) return;
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    const model = effectiveModel(form);
    const result = await runCredentialAction(
      saveBusy,
      () => saveKey({ apiKey: form.key.trim(), provider, ...(model !== null ? { model } : {}) }),
      resetSave,
    );
    if (!result.ran) return;
    if (!result.ok) {
      setError({ field: 'form', message: aiErrorView(result.error) });
      return;
    }
    // Show the saved state before the invalidated status read lands.
    dispatch(budgetApi.util.upsertQueryData('getAiCredentials', undefined, result.value));
    update({ type: 'reset' });
    setEditing(false);
    setNotice(t('notice.saved', { provider: providerLabel(result.value.own?.provider ?? provider) }));
  }, [form, saveKey, resetSave, dispatch]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    const result = await runCredentialAction(removeBusy, () => deleteKey(), resetDelete);
    if (!result.ran) return;
    if (!result.ok) {
      setError({ field: 'form', message: aiErrorView(result.error) });
      return;
    }
    // Drop the own key from the cache at once; the invalidated status read confirms it.
    const shared = statusQuery.data?.shared ?? { available: false, provider: null, model: null };
    const next: AiCredentialStatus = { own: null, shared, effective: shared.available ? 'shared' : null };
    dispatch(budgetApi.util.upsertQueryData('getAiCredentials', undefined, next));
    setConfirmingRemove(false);
    setEditing(false);
    setNotice(t('notice.removed'));
  }, [deleteKey, resetDelete, dispatch, statusQuery.data]);

  const test = useCallback(async () => {
    setTestResult(null);
    setTestError(null);
    setNotice(null);
    const result = await runCredentialAction(testBusy, () => testKey(), resetTest);
    if (!result.ran) return;
    if (!result.ok) {
      setTestError(aiErrorView(result.error));
      return;
    }
    setTestResult(result.value);
  }, [testKey, resetTest]);

  return {
    mode,
    showForm,
    editing,
    status: statusQuery.data,
    retry: statusQuery.refetch,
    apiKey: form.key,
    setApiKey: editKey,
    provider: form.provider,
    detected: form.detected,
    detecting: form.detecting,
    providerHint: detectionHint({
      keyLength: key.length,
      detecting: form.detecting,
      provider: form.provider,
      detected: form.detected,
    }),
    chooseProvider,
    models: form.models,
    modelsLoading: form.modelsLoading,
    modelsError: form.modelsError?.message ?? null,
    modelsRetryable: form.modelsError?.retryable ?? false,
    modelsLoaded,
    retryModels,
    model: form.model,
    modelQuery: form.modelQuery,
    chooseModel,
    editModelQuery,
    effectiveModel: effectiveModel(form),
    modelsReady: form.provider !== null && key.length >= MIN_AI_KEY_LENGTH,
    unreadable,
    error,
    notice,
    saving: saveState.isLoading,
    removing: deleteState.isLoading,
    testing: testState.isLoading,
    testResult,
    testError,
    confirmingRemove,
    setConfirmingRemove,
    startReplace,
    cancelReplace,
    save,
    remove,
    test,
  };
}
