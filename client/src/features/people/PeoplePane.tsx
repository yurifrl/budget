/**
 * People pane (Settings menu): the people the active budget is grouped by.
 * Every member sees and edits everything; this is grouping, not permission, so
 * any member may add a person, link an email or rename someone who has not
 * signed in — only the owner/admin (server-computed `can_manage`) removes.
 *
 * A person may have no email yet (a placeholder: "Gabriele" before they
 * connect). Placeholders show a "No email" badge and a "Link email" action;
 * linking an email that already belongs to a signed-in user merges the two.
 * An invited person (email, never signed in) carries "Invited"; the budget is
 * on their home page at their first sign-in (decisions.md, "Multi-user").
 *
 * Add flow: name and/or email (domain/people `checkInvite`) → request; while in
 * flight a ghost row shows the person, then swaps to the real row (the mutation
 * writes the fresh list into the cache). Enter submits and focus returns to the
 * name field so several people can be added in a row.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { Avatar } from '@/ui/avatar/Avatar';

import {
  useAddBudgetMemberMutation,
  useLinkBudgetMemberEmailMutation,
  useRemoveBudgetMemberMutation,
  useRenameBudgetMemberMutation,
} from '@/budget/data/api';
import { checkInvite, checkLinkEmail, personLabel, personStatus, toAvatarPerson, type Person } from '@/domain/people';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';
import { usePeople } from './usePeople';
import { colors } from '@/ui/theme';

const AVATAR = 34;

export function PeoplePane({ budgetId, onOpenProfile }: { budgetId: string | null; onOpenProfile: () => void }) {
  const { people, canManage } = usePeople(budgetId);
  const [addMember] = useAddBudgetMemberMutation();
  const [removeMember] = useRemoveBudgetMemberMutation();
  const [linkEmail] = useLinkBudgetMemberEmailMutation();
  const [renameMember] = useRenameBudgetMemberMutation();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ email?: string; name?: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameRef = useRef<TextInputInstance>(null);
  if (!budgetId) return <Text style={s.hint}>{t('pane.noBudget')}</Text>;

  const add = () => {
    if (adding) return;
    const check = checkInvite(email, name, people);
    if (!check.ok) return setError(check.error);
    setError(null);
    setAdding({ email: check.email, name: check.name });
    addMember({ budgetId, email: check.email, name: check.name })
      .unwrap()
      .then(() => {
        setEmail('');
        setName('');
      })
      .catch((err) => setError(apiErrorMessage(err, t('error.add'))))
      .finally(() => {
        setAdding(null);
        nameRef.current?.focus();
      });
  };
  const link = (userId: string, rawEmail: string): Promise<boolean> => {
    const check = checkLinkEmail(rawEmail);
    if (!check.ok) {
      setError(check.error);
      return Promise.resolve(false);
    }
    setError(null);
    return linkEmail({ budgetId, userId, email: check.email })
      .unwrap()
      .then(() => true)
      .catch((err) => {
        setError(apiErrorMessage(err, t('error.link')));
        return false;
      });
  };
  const rename = (userId: string, raw: string): Promise<boolean> => {
    const next = raw.trim();
    if (!next) {
      setError(t('pane.enterName'));
      return Promise.resolve(false);
    }
    setError(null);
    return renameMember({ budgetId, userId, name: next })
      .unwrap()
      .then(() => true)
      .catch((err) => {
        setError(apiErrorMessage(err, t('error.rename')));
        return false;
      });
  };
  const remove = (userId: string) => {
    setError(null);
    setConfirming(null);
    removeMember({ budgetId, userId })
      .unwrap()
      .catch((err) => setError(apiErrorMessage(err, t('error.remove'))));
  };

  return (
    <>
      <Text style={s.hint}>{t('pane.hint')}</Text>
      <View style={s.list}>
        {people.map((p) => (
          <PersonRow
            key={p.user_id}
            person={p}
            removable={canManage && !p.is_owner && !p.is_me}
            confirming={confirming === p.user_id}
            onAskRemove={() => setConfirming(p.user_id)}
            onCancelRemove={() => setConfirming(null)}
            onRemove={() => remove(p.user_id)}
            onOpenProfile={onOpenProfile}
            onLink={(v) => link(p.user_id, v)}
            onRename={(v) => rename(p.user_id, v)}
          />
        ))}
        {adding ? <GhostRow email={adding.email} name={adding.name} /> : null}
      </View>
      {people.some((p) => personStatus(p) === 'invited') ? (
        <Text style={s.hint}>
          {t('pane.invitedHint')}
        </Text>
      ) : null}
      {people.some((p) => personStatus(p) === 'placeholder') ? (
        <Text style={s.hint}>
          {t('pane.placeholderHint')}
        </Text>
      ) : null}
      <View style={s.form}>
        <Text style={s.formTitle}>{t('add.title')}</Text>
        <TextInput
          ref={nameRef}
          value={name}
          onChangeText={(v) => {
            setName(v);
            setError(null);
          }}
          placeholder={t('add.namePlaceholder')}
          placeholderTextColor={colors.faint}
          onSubmitEditing={add}
          editable={!adding}
          style={[s.input, error && s.inputError]}
          accessibilityLabel={t('add.nameLabel')}
          maxLength={80}
          returnKeyType="next"
        />
        <TextInput
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setError(null);
          }}
          placeholder={t('add.emailPlaceholder')}
          placeholderTextColor={colors.faint}
          onSubmitEditing={add}
          editable={!adding}
          style={s.input}
          accessibilityLabel={t('add.emailLabel')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          returnKeyType="done"
        />
        {error ? (
          <Text style={s.errorText} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <Pressable
          onPress={add}
          disabled={!!adding}
          accessibilityRole="button"
          accessibilityLabel={t('add.button')}
          style={({ pressed }) => [s.addBtn, (pressed || !!adding) && s.addBtnPressed]}>
          {adding ? <ActivityIndicator size="small" color={colors.white} /> : <Text style={s.addBtnText}>{t('add.button')}</Text>}
        </Pressable>
      </View>
      {!canManage ? <Text style={s.hint}>{t('pane.ownerOnly')}</Text> : null}
    </>
  );
}

function Badge({ label, tone }: { label: string; tone: 'owner' | 'you' | 'invited' }) {
  return (
    <View style={[s.badge, tone === 'owner' && s.badgeOwner, tone === 'you' && s.badgeYou, tone === 'invited' && s.badgeInvited]}>
      <Text style={[s.badgeText, tone === 'owner' && { color: colors.greenPillFg }, tone === 'you' && { color: colors.indigo3 }, tone === 'invited' && { color: colors.yellowPillFg }]}>
        {label}
      </Text>
    </View>
  );
}

function PersonRow({
  person,
  removable,
  confirming,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onOpenProfile,
  onLink,
  onRename,
}: {
  person: Person;
  removable: boolean;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  onOpenProfile: () => void;
  onLink: (email: string) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
}) {
  const label = personLabel(person);
  const status = personStatus(person);
  const [editing, setEditing] = useState<'rename' | 'link' | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (mode: 'rename' | 'link') => {
    setDraft(mode === 'rename' ? (person.name ?? '') : '');
    setEditing(mode);
  };
  const submit = () => {
    if (busy || !editing) return;
    setBusy(true);
    (editing === 'link' ? onLink(draft) : onRename(draft))
      .then((ok) => {
        if (ok) setEditing(null);
      })
      .finally(() => setBusy(false));
  };
  return (
    <View style={s.rowWrap}>
      <View style={s.row}>
        <Avatar person={toAvatarPerson(person)} size={AVATAR} ring={colors.card} />
        <View style={s.rowText}>
          <View style={s.nameLine}>
            <Text style={s.name} numberOfLines={1} ellipsizeMode={person.name?.trim() ? 'tail' : 'middle'}>
              {label}
            </Text>
            {person.is_owner ? <Badge label={t('badge.owner')} tone="owner" /> : null}
            {person.is_me ? <Badge label={t('badge.you')} tone="you" /> : null}
            {status === 'invited' ? <Badge label={t('badge.invited')} tone="invited" /> : null}
            {status === 'placeholder' ? <Badge label={t('badge.noEmail')} tone="invited" /> : null}
          </View>
          {person.email && person.name?.trim() ? (
            <Text style={s.email} numberOfLines={1} ellipsizeMode="middle">
              {person.email}
            </Text>
          ) : status === 'placeholder' ? (
            <Text style={s.email}>{t('row.notConnected')}</Text>
          ) : null}
        </View>
        {person.is_me ? (
          <Pressable onPress={onOpenProfile} accessibilityRole="link" accessibilityLabel={t('row.editProfile')} hitSlop={8}>
            <Text style={s.link}>{t('row.editProfile')}</Text>
          </Pressable>
        ) : null}
      </View>
      {!person.is_me && (person.pending || (removable && !confirming)) && !editing ? (
        <View style={s.actions}>
          {status === 'placeholder' ? (
            <Pressable onPress={() => open('link')} accessibilityRole="button" accessibilityLabel={t('row.linkEmailLabel', { name: label })} hitSlop={8}>
              <Text style={s.link}>{t('row.linkEmail')}</Text>
            </Pressable>
          ) : null}
          {person.pending ? (
            <Pressable onPress={() => open('rename')} accessibilityRole="button" accessibilityLabel={t('row.renameLabel', { name: label })} hitSlop={8}>
              <Text style={s.link}>{t('row.rename')}</Text>
            </Pressable>
          ) : null}
          {removable && !confirming ? (
            <Pressable onPress={onAskRemove} accessibilityRole="button" accessibilityLabel={t('row.removeLabel', { name: label })} hitSlop={8}>
              <Text style={s.removeText}>{tCommon('remove')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {editing ? (
        <View style={s.confirm}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={editing === 'link' ? t('edit.emailPlaceholder') : t('add.namePlaceholder')}
            placeholderTextColor={colors.faint}
            onSubmitEditing={submit}
            editable={!busy}
            autoFocus
            style={s.input}
            accessibilityLabel={editing === 'link' ? t('edit.emailLabel', { name: label }) : t('edit.nameLabel', { name: label })}
            autoCapitalize={editing === 'link' ? 'none' : 'words'}
            autoCorrect={false}
            keyboardType={editing === 'link' ? 'email-address' : 'default'}
            maxLength={editing === 'link' ? 254 : 80}
            returnKeyType="done"
          />
          {editing === 'link' ? (
            <Text style={s.confirmText}>
              {t('edit.linkWarning', { name: label })}
            </Text>
          ) : null}
          <View style={s.confirmBtns}>
            <Pressable onPress={() => setEditing(null)} accessibilityRole="button" accessibilityLabel={tCommon('cancel')} style={s.btnGhost}>
              <Text style={s.btnGhostText}>{tCommon('cancel')}</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={editing === 'link' ? t('edit.saveEmailLabel') : t('edit.saveNameLabel')}
              style={[s.btnDanger, { backgroundColor: colors.indigo }]}>
              <Text style={s.btnDangerText}>{editing === 'link' ? t('edit.link') : t('edit.save')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {confirming ? (
        <View style={s.confirm}>
          <Text style={s.confirmText}>
            {t('remove.confirm', { name: label })}
          </Text>
          <View style={s.confirmBtns}>
            <Pressable onPress={onCancelRemove} accessibilityRole="button" accessibilityLabel={t('remove.cancelLabel')} style={s.btnGhost}>
              <Text style={s.btnGhostText}>{tCommon('cancel')}</Text>
            </Pressable>
            <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={t('remove.yesLabel', { name: label })} style={s.btnDanger}>
              <Text style={s.btnDangerText}>{tCommon('remove')}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The in-flight "adding…" row: the person with the avatar they will have, dimmed. */
function GhostRow({ email, name }: { email?: string; name?: string }) {
  // The real avatar seed is the user id (known only after the server answers);
  // the email is a stable stand-in so the placeholder is already a face, not a blank.
  const key = email ?? name ?? 'new';
  const person = { id: key, avatar: { seed: key, image_version: null }, name: name ?? null, email: email ?? null };
  return (
    <View style={[s.rowWrap, { opacity: 0.55 }]}>
      <View style={s.row}>
        <Avatar person={person} size={AVATAR} ring={colors.card} />
        <View style={s.rowText}>
          <Text style={s.name} numberOfLines={1}>
            {name ?? email}
          </Text>
          <Text style={s.email}>{t('add.adding')}</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  hint: { color: colors.faint, fontSize: 12, marginTop: 10, paddingHorizontal: 4, lineHeight: 17 },
  list: { marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.card, overflow: 'hidden' },
  rowWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10 },
  actions: { flexDirection: 'row', gap: 16, paddingLeft: 10 + AVATAR + 10, paddingBottom: 9, marginTop: -3 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  email: { color: colors.faint, fontSize: 12 },
  badge: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1.5 },
  badgeOwner: { backgroundColor: colors.greenPillBg },
  badgeYou: { backgroundColor: colors.indigoSoft },
  badgeInvited: { backgroundColor: colors.yellowPillBg },
  badgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  link: { color: colors.indigo3, fontSize: 12, fontWeight: '600' },
  removeText: { color: colors.redFg, fontSize: 12, fontWeight: '600' },
  confirm: { paddingHorizontal: 10, paddingBottom: 10, gap: 8 },
  confirmText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  confirmBtns: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  btnGhost: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, borderWidth: 1, borderColor: colors.border2 },
  btnGhostText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  btnDanger: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, backgroundColor: colors.red },
  btnDangerText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  form: { marginTop: 14, gap: 8 },
  formTitle: { color: colors.faint, fontSize: 10, fontWeight: '700', letterSpacing: 1.4, paddingHorizontal: 4 },
  input: {
    backgroundColor: '#0f1219',
    borderColor: colors.border2,
    borderWidth: 1,
    borderRadius: 8,
    color: colors.text,
    paddingHorizontal: 10,
    height: 36,
    fontSize: 14,
  },
  inputError: { borderColor: colors.red },
  errorText: { color: colors.redFg, fontSize: 12, paddingHorizontal: 2 },
  addBtn: { height: 38, borderRadius: 8, backgroundColor: colors.indigo, alignItems: 'center', justifyContent: 'center' },
  addBtnPressed: { opacity: 0.7 },
  addBtnText: { color: colors.white, fontSize: 14, fontWeight: '700' },
});
