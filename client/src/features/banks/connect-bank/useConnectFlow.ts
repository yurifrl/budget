/**
 * The connect-widget flow of the Linked banks screen: which row (or a new
 * bank) shows the widget, its short-lived connect token, and what each
 * widget message does (OAuth hand-off, close, re-auth refresh, register).
 */

import { useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import * as Browser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { loadConfig } from '@/platform/config';

import {
  useCreateConnectionTokenMutation,
  useRegisterConnectionMutation,
  useSyncConnectionMutation,
} from '@/budget/data/api';
import { isOwnKeysRequired, PLUGGY_KEYS_FROM_CONNECT, PLUGGY_KEYS_ROUTE } from '../keys/pluggyKeys.logic';
import { buildWidgetUrl } from '../model/connections';
import { initialFlowTarget, stepSuccessRoute, widgetStep, type ConnectFlowTarget } from './connectBank.logic';

export type ConnectFlow = ReturnType<typeof useConnectFlow>;

export function useConnectFlow({
  budgetId,
  itemId,
  connectionId,
  actionsBusy,
  setError,
}: {
  /** For cache-tag invalidation of the affected budget's accounts/transactions. */
  budgetId: string | null | undefined;
  /** Route params: set when re-authenticating an existing connection. */
  itemId?: string;
  connectionId?: string;
  /** A row action (sync / re-import / remove) is in flight. */
  actionsBusy: boolean;
  setError: (message: string | null) => void;
}) {
  const router = useRouter();
  const [createToken, tokenState] = useCreateConnectionTokenMutation();
  const [registerConnection, registerState] = useRegisterConnectionMutation();
  const [syncConnection, syncState] = useSyncConnectionMutation();

  /** Which row shows the widget inline; null = the list view. The itemId/
   *  connectionId params seed a re-auth flow: the Reconnect CTAs push here
   *  expecting the widget to open immediately. */
  const [flow, setFlow] = useState<ConnectFlowTarget>(initialFlowTarget(itemId, connectionId));
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectionIdState, setConnectionIdState] = useState<string | null>(connectionId ?? null);

  const busy = registerState.isLoading || syncState.isLoading || actionsBusy;
  const startedRef = useRef(false);

  const finish = useCallback(() => {
    setFlow(null);
    setWidgetUrl(null);
    setConnectToken(null);
  }, []);

  // One token per flow mount — the token is short-lived, frontend-only.
  useEffect(() => {
    if (flow == null || startedRef.current) return;
    startedRef.current = true;
    const run = async () => {
      setError(null);
      try {
        // A row flow passes its own itemId (re-auth); a new connection
        // leaves the item id empty so the provider creates a fresh item.
        const flowItemId = flow === 'new' ? undefined : flow;
        const token = await createToken({
          provider: loadConfig().connectionsProvider,
          ...(flowItemId ? { itemId: flowItemId } : {}),
        }).unwrap();
        if (!token.widgetUrl) throw new Error('the provider did not return a connect widget URL');
        setConnectToken(token.token);
        setWidgetUrl(buildWidgetUrl(token.widgetUrl, token.token));
      } catch (err) {
        setFlow(null);
        startedRef.current = false;
        // No usable key set (no own keys, no shared-key feature, or the own
        // keys this bank was made with are gone): the keys screen, not an error.
        if (isOwnKeysRequired(err)) {
          router.push((flow === 'new' ? PLUGGY_KEYS_FROM_CONNECT : PLUGGY_KEYS_ROUTE) as Href);
          return;
        }
        setError(apiErrorMessage(err, 'could not start the connection flow'));
      }
    };
    void run();
  }, [createToken, flow, router, setError]);

  /** End the whole flow and land on the accounts screen. A replace (not
   *  back) — this screen can be entered from anywhere (menu, account edit),
   *  so back would revisit it through stale history. */
  const landOnAccounts = useCallback(() => {
    setFlow(null);
    setWidgetUrl(null);
    setConnectToken(null);
    router.replace('/accounts' as Href);
  }, [router]);

  /** A bank was registered: end the flow and land on Connect Bank (replace,
   *  for the same stale-history reason as landOnAccounts). */
  const landOnConnectBank = useCallback(
    (route: string) => {
      setFlow(null);
      setWidgetUrl(null);
      setConnectToken(null);
      router.replace(route as Href);
    },
    [router],
  );

  const onWidgetMessage = useCallback(
    async (data: unknown) => {
      const step = widgetStep(data, { flow, connectionId: connectionIdState, busy });
      // OAuth connectors run in a separate window: open the system browser;
      // the relayed auth back comes over the app deep link, not here.
      if (step.kind === 'oauth') {
        if (!step.url) {
          setError('The bank needs its own login window — allow it to open, then try again.');
          return;
        }
        await Browser.openBrowserAsync(step.url);
        return;
      }
      if (step.kind === 'closed') {
        finish();
        return;
      }

      // Re-auth: refresh the existing connection and return to the list.
      if (step.kind === 'refresh') {
        setError(null);
        try {
          await syncConnection({ id: step.connectionId, budgetId: budgetId ?? '' }).unwrap();
          finish();
        } catch (err) {
          setError(apiErrorMessage(err, 'could not refresh the reconnected bank'));
        }
        return;
      }

      if (step.kind !== 'register') return;
      setError(null);
      try {
        // The server's register route settles the fresh item's accounts
        // itself (up to ~60s of retries), so one call suffices. Linking
        // those accounts to budget accounts happens per-account in the
        // account editor — this screen only registers the bank.
        const registered = await registerConnection({
          provider: loadConfig().connectionsProvider,
          itemId: step.itemId,
        }).unwrap();
        await syncConnection({ id: registered.connection.id, budgetId: budgetId ?? '' }).unwrap();
        const route = stepSuccessRoute(step);
        if (route) landOnConnectBank(route);
      } catch (err) {
        if (isOwnKeysRequired(err)) {
          finish();
          router.push(PLUGGY_KEYS_FROM_CONNECT as Href);
          return;
        }
        setError(apiErrorMessage(err, 'could not register the connected bank'));
      }
    },
    [budgetId, connectionIdState, finish, flow, busy, registerConnection, router, setError, syncConnection, landOnConnectBank],
  );

  /** Start the widget flow for a row (re-auth) or a new connection. */
  const startFlow = useCallback(
    async (target: 'new' | string, existingId?: string) => {
      setConnectionIdState(existingId ?? null);
      startedRef.current = false;
      setFlow(target);
    },
    [],
  );

  return {
    flow,
    widgetUrl,
    connectToken,
    /** A register / refresh / row action is in flight. */
    busy,
    tokenLoading: tokenState.isLoading,
    finish,
    landOnAccounts,
    onWidgetMessage,
    startFlow,
  };
}
