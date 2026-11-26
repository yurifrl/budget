/**
 * Wiring of the "Jev API key" screen: the saved key's status, the save / test /
 * remove mutations, the field and the inline messages. Rules live in
 * jevKey.logic.ts. The key is held only while this screen is focused, and the
 * save mutation is reset as soon as it settles so the key never stays in the
 * redux store.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import {
  useDeleteJevKeyMutation,
  useGetJevKeyQuery,
  useSaveJevKeyMutation,
  useTestJevKeyMutation,
} from '@/profile/api';

import { t } from './i18n';
import {
  jevKeyCardMode,
  keyFieldProblem,
  loadErrorMessage,
  removeErrorMessage,
  saveErrorMessage,
  testErrorMessage,
  unreadableNotice,
} from './jevKey.logic';

export function useJevKey() {
  const query = useGetJevKeyQuery();
  const [saveKey, saveState] = useSaveJevKeyMutation();
  const [testKey, testState] = useTestJevKeyMutation();
  const [removeKey, removeState] = useDeleteJevKeyMutation();
  const resetSave = saveState.reset;

  const [field, setField] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The route stays mounted in the tab navigator: leaving drops the typed key
  // and the messages, so reopening never shows them pre-filled.
  useFocusEffect(
    useCallback(() => () => {
      setField('');
      setError(null);
      setNotice(null);
      setConfirmingRemove(false);
      setReplacing(false);
    }, []),
  );

  const mode = jevKeyCardMode({
    status: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    replacing,
  });

  const editField = useCallback((value: string) => {
    setField(value);
    setError(null);
  }, []);

  const startReplace = useCallback(() => {
    setField('');
    setError(null);
    setNotice(null);
    setConfirmingRemove(false);
    setReplacing(true);
  }, []);

  const cancelReplace = useCallback(() => {
    setField('');
    setError(null);
    setReplacing(false);
  }, []);

  const save = useCallback(async () => {
    if (saveState.isLoading) return;
    const invalid = keyFieldProblem(field);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      await saveKey({ key: field.trim() }).unwrap();
      setField('');
      setReplacing(false);
      setNotice(t('hook.saved'));
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      resetSave();
    }
  }, [field, resetSave, saveKey, saveState.isLoading]);

  const test = useCallback(async () => {
    if (testState.isLoading) return;
    setError(null);
    setNotice(null);
    try {
      await testKey().unwrap();
      setNotice(t('card.tested'));
    } catch (err) {
      setError(testErrorMessage(err, query.data));
    }
  }, [query.data, testKey, testState.isLoading]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await removeKey().unwrap();
      setConfirmingRemove(false);
      setReplacing(false);
      setField('');
      setNotice(t('hook.removed'));
    } catch (err) {
      setError(removeErrorMessage(err));
    }
  }, [removeKey]);

  return {
    mode,
    replacing,
    status: query.data,
    loadError: loadErrorMessage(query.error),
    retry: () => void query.refetch(),
    field,
    setField: editField,
    error,
    /** The saved key exists but this server cannot open it: said without testing. */
    unreadable: unreadableNotice(query.data),
    notice,
    saving: saveState.isLoading,
    testing: testState.isLoading,
    removing: removeState.isLoading,
    confirmingRemove,
    setConfirmingRemove,
    startReplace,
    cancelReplace,
    save,
    test,
    remove,
  } as const;
}

export type JevKeyState = ReturnType<typeof useJevKey>;
