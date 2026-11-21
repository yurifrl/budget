/**
 * "Person" field of a category (inspector + mobile detail): who owns this
 * envelope. Reuses PersonPicker (avatars + Shared glyph); a pick saves at once
 * (optimistic via setCategoryPerson) and the Plan row avatar follows.
 */
import { Text, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useSetCategoryPersonMutation } from '@/budget/data/api';
import { categoryOwnerId } from '@/domain/people';
import type { Category } from '@/domain/types';
import { PersonPicker } from '@/features/people';
import { colors } from '@/ui/theme';
import { useState } from 'react';
import { t } from './inspector/i18n';

export function CategoryPersonField({ budgetId, category }: { budgetId: string; category: Category }) {
  const [setPerson] = useSetCategoryPersonMutation();
  const [error, setError] = useState<string | null>(null);
  return (
    <View>
      <PersonPicker
        budgetId={budgetId}
        label={t('person.fieldLabel')}
        value={categoryOwnerId(category)}
        onChange={(userId) => {
          setError(null);
          setPerson({ budgetId, categoryId: category.id, userId })
            .unwrap()
            .catch((err) => setError(apiErrorMessage(err, t('person.changeFailed'))));
        }}
      />
      {error ? <Text style={{ color: colors.redFg, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}
