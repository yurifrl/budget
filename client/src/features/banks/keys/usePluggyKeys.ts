/**
 * Wiring of the "Your Pluggy keys" screen: the key status query, the save /
 * remove mutations, the form fields and the inline error. Rules live in
 * pluggyKeys.logic.ts. The secret is held only in this component's state
 * while typed; the save mutation is reset as soon as it settles so the
 * request arguments (the secret) do not stay in the redux store.
 */

import { useCallback, useState } from 'react';

import {
  useDeleteConnectionCredentialsMutation,
  useGetConnectionCredentialsQuery,
  useSaveConnectionCredentialsMutation,
} from '@/budget/data/api';
import { loadConfig } from '@/platform/config';
import { checkKeysInput, deleteErrorMessage, keysScreenMode, saveErrorView, type KeysFormError } from './pluggyKeys.logic';

export function usePluggyKeys() {
  const provider = loadConfig().connectionsProvider;
  const query = useGetConnectionCredentialsQuery({ provider });
  const [saveKeys, saveState] = useSaveConnectionCredentialsMutation();
  const [deleteKeys, deleteState] = useDeleteConnectionCredentialsMutation();
  const resetSave = saveState.reset;

  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<KeysFormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mode = keysScreenMode({
    credentials: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    replacing,
  });

  const startReplace = useCallback(() => {
    setClientId(query.data?.clientId ?? '');
    setClientSecret('');
    setError(null);
    setNotice(null);
    setConfirmingRemove(false);
    setReplacing(true);
  }, [query.data?.clientId]);

  const cancelReplace = useCallback(() => {
    setClientSecret('');
    setError(null);
    setReplacing(false);
  }, []);

  const save = useCallback(async () => {
    if (saveState.isLoading) return;
    const invalid = checkKeysInput(clientId, clientSecret);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await saveKeys({ provider, clientId: clientId.trim(), clientSecret: clientSecret.trim() }).unwrap();
      setClientSecret('');
      setReplacing(false);
      setNotice('Keys saved. Pluggy accepted them.');
    } catch (err) {
      setError(saveErrorView(err));
    } finally {
      resetSave();
    }
  }, [clientId, clientSecret, provider, resetSave, saveKeys, saveState.isLoading]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await deleteKeys({ provider }).unwrap();
      setConfirmingRemove(false);
      setReplacing(false);
      setClientId('');
      setNotice('Keys removed. Banks connected with them are paused until you save the same keys again.');
    } catch (err) {
      setError({ field: 'form', message: deleteErrorMessage(err) });
    }
  }, [deleteKeys, provider]);

  const editClientId = useCallback((v: string) => {
    setClientId(v);
    setError((e) => (e?.field === 'clientId' ? null : e));
  }, []);
  const editClientSecret = useCallback((v: string) => {
    setClientSecret(v);
    setError((e) => (e?.field === 'clientSecret' ? null : e));
  }, []);

  return {
    mode,
    credentials: query.data,
    retry: query.refetch,
    clientId,
    clientSecret,
    setClientId: editClientId,
    setClientSecret: editClientSecret,
    error,
    notice,
    saving: saveState.isLoading,
    removing: deleteState.isLoading,
    confirmingRemove,
    setConfirmingRemove,
    startReplace,
    cancelReplace,
    save,
    remove,
  } as const;
}

export type PluggyKeysState = ReturnType<typeof usePluggyKeys>;
