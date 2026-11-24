/**
 * Wiring of the AI key screen: the status query, provider detection, the
 * model list of the candidate key, and save / test / remove. Rules live in
 * aiKeys.logic.ts. The key stays in this component's state while typed; the
 * save and list mutations are reset as soon as they settle so the request
 * arguments (the key) do not stay in the redux store. Nothing is persisted
 * on the device: the server stores the key encrypted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  ownKeyUnreadable,
  providerLabel,
  type AiKeyFormError,
  type AiKeysScreenMode,
} from './aiKeys.logic';
import { t } from './i18n';

/** Detection is a local, cheap guess; debounce while the key is typed or pasted. */
const DETECT_DEBOUNCE_MS = 300;

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
  retryModels: () => void;
  model: string | null;
  modelQuery: string;
  chooseModel: (id: string) => void;
  editModelQuery: (text: string) => void;
  /** Free-text model id while the provider's list cannot be fetched; empty clears the model. */
  editManualModel: (text: string) => void;
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
  // The mutation triggers/resets can change identity between renders. The
  // effects below must not restart mid-request (a restart drops the answer and
  // leaves "Detecting provider…" forever), so they read them through refs and
  // depend only on the data.
  const detectRef = useRef({ run: detectProvider, reset: detectState.reset });
  detectRef.current = { run: detectProvider, reset: detectState.reset };
  const listRef = useRef({ run: listModels, reset: listState.reset });
  listRef.current = { run: listModels, reset: listState.reset };

  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AiProviderId | null>(null);
  /** A provider the user picked by hand: detection must not overwrite it. */
  const providerChosen = useRef(false);
  const [detected, setDetected] = useState<AiProviderId | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [models, setModels] = useState<AiModel[]>([]);
  /** `${provider}\n${key}` of the model list in hand: prevents refetching the same pair. */
  const [modelsFor, setModelsFor] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  /** `${provider}\n${key}` of the last list attempt: a retry of the same pair keeps a chosen model. */
  const attemptedToken = useRef<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const modelRef = useRef<string | null>(null);
  modelRef.current = model;
  const [modelQuery, setModelQuery] = useState('');
  const [error, setError] = useState<AiKeyFormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: AiProviderId; models: number } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const key = apiKey.trim();
  const mode = aiKeysScreenMode({ status: statusQuery.data, isError: statusQuery.isError });
  const unreadable = statusQuery.data ? ownKeyUnreadable(statusQuery.data) : false;
  const showForm = mode === 'empty' || mode === 'shared' || (mode === 'saved' && editing);

  // Detection: debounced on the key; a manual choice is never overwritten.
  useEffect(() => {
    if (key.length < MIN_AI_KEY_LENGTH) {
      setDetecting(false);
      setDetected(null);
      if (!providerChosen.current) setProvider(null);
      return;
    }
    let cancelled = false;
    setDetecting(true);
    const timer = setTimeout(() => {
      void detectRef.current
        .run({ apiKey: key })
        .unwrap()
        .then((result) => {
          if (cancelled) return;
          setDetected(result.provider);
          if (result.provider !== null && !providerChosen.current) setProvider(result.provider);
        })
        .catch(() => {
          if (!cancelled) setDetected(null);
        })
        .finally(() => {
          if (!cancelled) setDetecting(false);
          detectRef.current.reset();
        });
    }, DETECT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  // Models of the candidate key: loaded once both the key and a provider are set.
  useEffect(() => {
    if (provider === null || key.length < MIN_AI_KEY_LENGTH) {
      setModels([]);
      setModelsFor(null);
      setModelsLoading(false);
      setModelsError(null);
      attemptedToken.current = null;
      return;
    }
    const token = `${provider}\n${key}`;
    if (modelsFor === token) return;
    let cancelled = false;
    // Retrying the same pair keeps a chosen or typed model; a new pair starts clean.
    const retry = attemptedToken.current === token;
    attemptedToken.current = token;
    setModels([]);
    setModelsLoading(true);
    setModelsError(null);
    if (!retry) {
      setModel(null);
      setModelQuery('');
    }
    void listRef.current
      .run({ apiKey: key, provider })
      .unwrap()
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        setModelsFor(token);
        // A model kept across a retry must still exist on this provider.
        const kept = modelRef.current;
        if (kept !== null && !result.models.some((model) => model.id === kept)) {
          setModel(null);
          setModelQuery('');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setModelsFor(token);
        setModelsError(aiErrorView(err));
      })
      .finally(() => {
        if (cancelled) return;
        setModelsLoading(false);
        listRef.current.reset();
      });
    return () => {
      cancelled = true;
    };
  }, [provider, key, modelsFor]);

  const startReplace = useCallback(() => {
    setEditing(true);
    setApiKey('');
    setProvider(null);
    providerChosen.current = false;
    setDetected(null);
    setModel(null);
    setModelQuery('');
    setModels([]);
    setModelsFor(null);
    setModelsError(null);
    attemptedToken.current = null;
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    setConfirmingRemove(false);
  }, []);

  const cancelReplace = useCallback(() => {
    setEditing(false);
    setApiKey('');
    setProvider(null);
    providerChosen.current = false;
    setDetected(null);
    setModel(null);
    setModelQuery('');
    setModels([]);
    setModelsFor(null);
    setModelsError(null);
    attemptedToken.current = null;
    setError(null);
  }, []);

  const editKey = useCallback((text: string) => {
    setApiKey(text);
    setError((current) => (current?.field === 'key' ? null : current));
  }, []);

  const chooseProvider = useCallback((id: AiProviderId) => {
    setProvider(id);
    providerChosen.current = true;
    setError((current) => (current?.field === 'form' ? null : current));
  }, []);

  const chooseModel = useCallback(
    (id: string) => {
      const label = models.find((m) => m.id === id)?.name ?? id;
      setModel(id);
      setModelQuery(label);
    },
    [models],
  );

  const editModelQuery = useCallback(
    (text: string) => {
      setModelQuery(text);
      setModel((current) => {
        if (current === null) return null;
        const label = models.find((m) => m.id === current)?.name ?? current;
        return label === text ? current : null;
      });
    },
    [models],
  );

  /** Free-text model id while the list is unavailable; the server validates it on save. */
  const editManualModel = useCallback((text: string) => {
    setModelQuery(text);
    setModel(text.trim() === '' ? null : text.trim());
    setError((current) => (current?.field === 'form' ? null : current));
  }, []);

  const retryModels = useCallback(() => {
    setModelsFor(null);
    setModelsError(null);
  }, []);

  const save = useCallback(async () => {
    if (saveState.isLoading) return;
    const invalid = checkSaveInput({ apiKey: key, provider });
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    const chosen = model !== null && model.trim() !== '' ? model.trim() : null;
    try {
      const status = await saveKey({ apiKey: key, provider: provider!, ...(chosen ? { model: chosen } : {}) }).unwrap();
      // Show the saved state before the invalidated status read lands.
      dispatch(budgetApi.util.upsertQueryData('getAiCredentials', undefined, status));
      setApiKey('');
      setProvider(null);
      providerChosen.current = false;
      setDetected(null);
      setModel(null);
      setModelQuery('');
      setModels([]);
      setModelsFor(null);
      setEditing(false);
      setNotice(t('notice.saved', { provider: providerLabel(status.own?.provider ?? provider!) }));
    } catch (err) {
      setError({ field: 'form', message: aiErrorView(err) });
    } finally {
      resetSave();
    }
  }, [key, provider, model, saveKey, saveState.isLoading, resetSave, dispatch]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    try {
      await deleteKey().unwrap();
      // Drop the own key from the cache at once; the invalidated status read confirms it.
      const shared = statusQuery.data?.shared ?? { available: false, provider: null, model: null };
      const next: AiCredentialStatus = { own: null, shared, effective: shared.available ? 'shared' : null };
      dispatch(budgetApi.util.upsertQueryData('getAiCredentials', undefined, next));
      setConfirmingRemove(false);
      setEditing(false);
      setNotice(t('notice.removed'));
    } catch (err) {
      setError({ field: 'form', message: aiErrorView(err) });
    }
  }, [deleteKey, dispatch, statusQuery.data]);

  const test = useCallback(async () => {
    if (testState.isLoading) return;
    setTestResult(null);
    setTestError(null);
    setNotice(null);
    try {
      const result = await testKey().unwrap();
      setTestResult(result);
    } catch (err) {
      setTestError(aiErrorView(err));
    }
  }, [testKey, testState.isLoading]);

  return {
    mode,
    showForm,
    editing,
    status: statusQuery.data,
    retry: statusQuery.refetch,
    apiKey,
    setApiKey: editKey,
    provider,
    detected,
    detecting,
    providerHint: detectionHint({ keyLength: key.length, detecting, provider, detected }),
    chooseProvider,
    models,
    modelsLoading,
    modelsError,
    retryModels,
    model,
    modelQuery,
    chooseModel,
    editModelQuery,
    editManualModel,
    modelsReady: provider !== null && key.length >= MIN_AI_KEY_LENGTH,
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
