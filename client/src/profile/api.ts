import { createApi } from '@reduxjs/toolkit/query/react';

import { apiBaseQuery, type ApiQuery } from '@/platform/api/baseQuery';
import { budgetApi } from '@/budget/data/api';
import { contractRequest } from '@shared/contract-request';

import { featuresMine, type MyFeatures } from '@shared/contracts/features';
import { jevKeyDelete, jevKeyGet, jevKeySave, jevKeyTest, type JevKeyStatus } from '@shared/contracts/jev';
import { oauthGrantsList, oauthGrantsRevoke } from '@shared/contracts/oauth';
import { meAvatarRemove, meGet, meUpdate } from '@shared/contracts/user';
import { withFeatureDefaults, type FeatureValues } from '@shared/features';

import type { ConnectedApp, Me } from './model';

export const listGrantsRequest = (): ApiQuery => contractRequest(oauthGrantsList, {});
export const revokeGrantRequest = (id: string): ApiQuery => contractRequest(oauthGrantsRevoke, { id });
export const myFeaturesRequest = (): ApiQuery => contractRequest(featuresMine, {});

/**
 * How the features query stays fresh: refetched when the app regains focus
 * (web: tab focus / visibility; native: back to the foreground) or
 * connectivity. No push and no polling: an admin's change shows up the next
 * time the person comes back to the app.
 */
export const MY_FEATURES_REFETCH = { refetchOnFocus: true, refetchOnReconnect: true } as const;

/**
 * Profile RTK Query api: the signed-in user's own profile + avatar.
 * Every mutation returns the fresh /me payload and writes it straight into
 * the getMe cache, so every `<Avatar>` of me refreshes (new image_version ⇒
 * new URL) without a refetch round-trip; the 'Me' tag lets other modules'
 * consumers (useMe) stay in sync too. The key mutations also invalidate the
 * Budget api's Categorize run status: that cache is what decides whether the
 * card offers a run, and the saved key is what decides it on the server.
 */
export const profileApi = createApi({
  reducerPath: 'profileApi',
  baseQuery: apiBaseQuery,
  tagTypes: ['Me', 'Grants', 'Features', 'JevKey'],
  endpoints: (builder) => ({
    getMe: builder.query<Me, void>({
      query: (): ApiQuery => contractRequest(meGet, {}),
      providesTags: ['Me'],
    }),
    updateMe: builder.mutation<Me, { name?: string; avatar_seed?: string | null }>({
      query: (body): ApiQuery => contractRequest(meUpdate, body),
      // Optimistic: show the new name / look immediately, roll back on failure.
      async onQueryStarted(patch, { dispatch, queryFulfilled }) {
        const undo = dispatch(
          profileApi.util.updateQueryData('getMe', undefined, (me) => {
            if (patch.name !== undefined) me.name = patch.name.trim();
            if (patch.avatar_seed) me.avatar = { seed: patch.avatar_seed, image_version: null };
          }),
        );
        try {
          const { data } = await queryFulfilled;
          dispatch(profileApi.util.upsertQueryData('getMe', undefined, data));
        } catch {
          undo.undo();
        }
      },
    }),
    // The caller's own evaluated features, laid over the defaults in code so
    // every key this client knows has a value whatever the API version.
    getMyFeatures: builder.query<FeatureValues, void>({
      query: myFeaturesRequest,
      transformResponse: (body: MyFeatures) => withFeatureDefaults(body.features),
      providesTags: ['Features'],
    }),
    uploadAvatar: builder.mutation<Me, Blob>({
      query: (blob): ApiQuery => ({ url: '/me/avatar', method: 'PUT', body: blob }),
      invalidatesTags: ['Me'],
    }),
    listGrants: builder.query<ConnectedApp[], void>({
      query: listGrantsRequest,
      providesTags: ['Grants'],
    }),
    revokeGrant: builder.mutation<{ ok: true }, string>({
      query: revokeGrantRequest,
      invalidatesTags: ['Grants'],
    }),
    removeAvatar: builder.mutation<Me, void>({
      query: (): ApiQuery => contractRequest(meAvatarRemove, {}),
      invalidatesTags: ['Me'],
    }),
    /** The caller's own Jev key: last four characters and when it was saved. */
    getJevKey: builder.query<JevKeyStatus, void>({
      query: (): ApiQuery => contractRequest(jevKeyGet, {}),
      providesTags: ['JevKey'],
    }),
    /**
     * Save (or replace) the key; the API refuses one Jev rejects. Whether a run
     * can start depends on the saved key, and the Categorize run status lives in
     * the Budget api slice: that cache is invalidated too, so the card stops
     * saying there is no key after a key is saved or removed here.
     */
    saveJevKey: builder.mutation<JevKeyStatus, { key: string }>({
      query: ({ key }): ApiQuery => contractRequest(jevKeySave, { key }),
      invalidatesTags: ['JevKey'],
      onQueryStarted: async (_arg, api) => {
        await api.queryFulfilled.catch(() => undefined);
        api.dispatch(budgetApi.util.invalidateTags(['CategorizeRun']));
      },
    }),
    /** One call with made-up data against the saved key. */
    testJevKey: builder.mutation<{ ok: boolean }, void>({
      query: (): ApiQuery => contractRequest(jevKeyTest, {}),
      invalidatesTags: ['JevKey'],
    }),
    deleteJevKey: builder.mutation<{ ok: boolean }, void>({
      query: (): ApiQuery => contractRequest(jevKeyDelete, {}),
      invalidatesTags: ['JevKey'],
      onQueryStarted: async (_arg, api) => {
        await api.queryFulfilled.catch(() => undefined);
        api.dispatch(budgetApi.util.invalidateTags(['CategorizeRun']));
      },
    }),
  }),
});

export const { useGetMyFeaturesQuery, useGetMeQuery, useUpdateMeMutation, useUploadAvatarMutation, useRemoveAvatarMutation, useListGrantsQuery, useRevokeGrantMutation, useGetJevKeyQuery, useSaveJevKeyMutation, useTestJevKeyMutation, useDeleteJevKeyMutation } = profileApi;
