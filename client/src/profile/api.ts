import { createApi } from '@reduxjs/toolkit/query/react';

import { apiBaseQuery, type ApiQuery } from '@/platform/api/baseQuery';
import { contractRequest } from '@shared/contract-request';

import { featuresMine, type MyFeatures } from '@shared/contracts/features';
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
 * consumers (useMe) stay in sync too.
 */
export const profileApi = createApi({
  reducerPath: 'profileApi',
  baseQuery: apiBaseQuery,
  tagTypes: ['Me', 'Grants', 'Features'],
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
  }),
});

export const { useGetMyFeaturesQuery, useGetMeQuery, useUpdateMeMutation, useUploadAvatarMutation, useRemoveAvatarMutation, useListGrantsQuery, useRevokeGrantMutation } = profileApi;
