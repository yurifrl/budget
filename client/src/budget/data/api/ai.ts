/**
 * budgetApi slice: the caller's own AI key and the provider calls that support
 * choosing one (user-scoped, no budget). Injected into the one `budgetApi`
 * (see ../api.ts). The key never comes back from the server, and the save /
 * list mutations are reset by the caller once they settle so the key does not
 * stay in the redux store.
 */
import { contractRequest } from '@shared/contract-request';
import {
  aiCredentialsDelete,
  aiCredentialsGet,
  aiCredentialsSave,
  aiCredentialsTest,
  aiModelsList,
  aiProviderDetect,
  type AiProviderId,
} from '@shared/contracts/ai';
import type { OperationOutput } from '@shared/operation-contract';
import { transfersApi } from './transfers';

export type AiCredentialStatus = OperationOutput<typeof aiCredentialsGet>;
export type AiModel = OperationOutput<typeof aiModelsList>['models'][number];

export const aiApi = transfersApi.injectEndpoints({
  endpoints: (b) => ({
    /** Own credential (provider + model, never the key) and the shared-key availability. */
    getAiCredentials: b.query<AiCredentialStatus, void>({
      query: () => contractRequest(aiCredentialsGet, {}),
      providesTags: ['AiCredentials'],
    }),

    /**
     * Save or replace the own key. The server checks it with its provider
     * before storing it encrypted; the answer is the new status. The model is
     * optional: a key the provider will not let us list models with (403
     * ai_key_forbidden) can still be saved, and the card explains it.
     */
    saveAiCredentials: b.mutation<AiCredentialStatus, { apiKey: string; provider: AiProviderId; model?: string }>({
      query: ({ apiKey, provider, model }) => contractRequest(aiCredentialsSave, { api_key: apiKey, provider, model }),
      invalidatesTags: ['AiCredentials'],
    }),

    /** Remove the own key. Idempotent; the shared key may take over afterwards. */
    deleteAiCredentials: b.mutation<OperationOutput<typeof aiCredentialsDelete>, void>({
      query: () => contractRequest(aiCredentialsDelete, {}),
      invalidatesTags: ['AiCredentials'],
    }),

    /** Check the key a run would use (own first, else shared) with its provider. */
    testAiCredentials: b.mutation<OperationOutput<typeof aiCredentialsTest>, void>({
      query: () => contractRequest(aiCredentialsTest, {}),
    }),

    /** Guess the provider from the key's shape; null means "ask the user" (Z.ai is never guessed). */
    detectAiProvider: b.mutation<OperationOutput<typeof aiProviderDetect>, { apiKey: string }>({
      query: ({ apiKey }) => contractRequest(aiProviderDetect, { api_key: apiKey }),
    }),

    /** List a candidate key's models; called only with the key not yet saved. */
    listAiModels: b.mutation<OperationOutput<typeof aiModelsList>, { apiKey: string; provider: AiProviderId }>({
      query: ({ apiKey, provider }) => contractRequest(aiModelsList, { api_key: apiKey, provider }),
    }),
  }),
});
