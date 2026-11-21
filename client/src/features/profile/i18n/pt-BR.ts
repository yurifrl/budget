import type { Translation } from '@shared/i18n';

import type en from './en';

const m: Translation<typeof en> = {
  'screen.title': 'Perfil',
  'screen.loadError': 'Não foi possível carregar seu perfil.',
  'screen.retry': 'Tentar novamente',
  'screen.adminBadge': 'ADMIN',
  'screen.connectedApps': 'Apps conectados',
  'screen.signOut': 'Sair',
  'avatarButton.label': 'Abrir perfil',

  'avatar.changePhoto': 'Alterar foto',
  'avatar.uploading': 'Enviando…',
  'avatar.removePhoto': 'Remover foto',
  'avatar.removeFailed': 'Não foi possível remover a foto.',
  'avatar.lookFailed': 'Não foi possível salvar esse visual.',
  'avatar.pickTitle': 'ESCOLHA UM VISUAL',
  'avatar.moreLooks': '↻  Mais visuais',
  'avatar.moreLooksLabel': 'Mais visuais',
  'avatar.useLook': 'Usar este visual',

  'name.title': 'NOME DE EXIBIÇÃO',
  'name.label': 'Nome de exibição',
  'name.placeholder': 'Seu nome',
  'name.saving': 'Salvando…',
  'name.saved': 'Salvo ✓',
  'name.help': 'Exibido ao lado da sua foto para todas as pessoas com quem você compartilha um orçamento.',
  'name.saveFailed': 'Não foi possível salvar seu nome.',
  'name.emailTitle': 'E-MAIL',

  'password.open': 'Alterar senha',
  'password.done': 'Senha alterada ✓',
  'password.title': 'ALTERAR SENHA',
  'password.current': 'Senha atual',
  'password.new': 'Nova senha',
  'password.repeat': 'Repita a nova senha',
  'password.save': 'Salvar senha',

  'apps.title': 'Apps conectados',
  'apps.loadError': 'Não foi possível carregar os apps conectados.',
  'apps.empty': 'Nenhum app está conectado à sua conta.',
  'apps.accessWrite': 'Leitura e gravação',
  'apps.accessRead': 'Somente leitura',
  'apps.meta': '{access} · conectado em {created} · expira em {expires}',
  'apps.metaUsed': '{access} · conectado em {created} · último uso em {lastUsed} · expira em {expires}',
  'apps.revoke': 'Revogar',
  'apps.revoking': 'Revogando…',
  'apps.revokeLabel': 'Revogar {name}',
};
export default m;
