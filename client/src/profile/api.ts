import { createApi } from '@reduxjs/toolkit/query/react';

import { apiBaseQuery, type ApiQuery } from '@/platform/api/baseQuery';
import { contractRequest } from '@shared/contract-request';

import { oauthGrantsList, oauthGrantsRevoke } from '@shared/contracts/oauth';
import { meAvatarRemove, meGet, meUpdate } from '@shared/contracts/user';

import type { ConnectedApp, Me } from './model';

export const listGrantsRequest = (): ApiQuery => contractRequest(oauthGrantsList, {});
export const revokeGrantRequest = (id: string): ApiQuery => contractRequest(oauthGrantsRevoke, { id });

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
  tagTypes: ['Me', 'Grants'],
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

export const { useGetMeQuery, useUpdateMeMutation, useUploadAvatarMutation, useRemoveAvatarMutation, useListGrantsQuery, useRevokeGrantMutation } = profileApi;
